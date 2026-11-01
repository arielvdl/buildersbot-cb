/**
 * The task reviewer ("Fiscal" in Portuguese): it watches the tasks of the channels for work that is
 * parked too long, and tries to move it, one task in each look. It covers what the automatic
 * recovery does not see: a run that gives no sign of life while it holds a place, a request that
 * the drain would start now but that did not start, and a start that fails again. Local rules decide
 * first; for a slow task only, the model of the Guard can decide, and it can only ask for a resume.
 * It uses the tries of the automatic recovery (`RecoveryLedger`), so nothing loops. See
 * `docs/architecture/task-reviewer.md`.
 */

import type {
  AutoRecoveryPreference,
  ChannelCommand,
  RunningWorkQuiet,
  StoppedWorkPlan,
  TaskWatchEvent,
  TaskWatchHold,
  TaskWatchPreference,
  TaskWatchWait,
} from "@openbot/contracts/ipc";
import { TASK_WATCH_RECENT_LIMIT, TASK_WATCH_WAIT_LIMIT } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger } from "@openbot/logging";
import { type LedgerRecord, MAX_REASSIGNS, MAX_RESUMES, type RecoveryLedger } from "./auto-recovery";
import type { TaskWatchDecision, TaskWatchJudge } from "./task-watch-judge";

export type { TaskWatchJudge } from "./task-watch-judge";

/**
 * The start of the operation id of each command that the app sends by itself. It makes the logs and
 * the receipts easy to read. It proves nothing: a client can send any operation id, so `WorkControl`
 * keeps the ids that it sent itself.
 */
export const AUTO_OPERATION_PREFIX = "work-auto:";
/** The reason that a channel stores when the provider did not start a task. */
export const CHANNEL_START_FAILED = sourceText("error.backend.channelStartFailed");
/** The most model calls in one hour. */
export const TASK_WATCH_MODEL_CALLS_PER_HOUR = 12;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A safety deadline around one model call, past the deadline that the call has itself. */
const JUDGE_SAFETY_MS = 15_000;
/** The most stops by a person that the reviewer keeps. The oldest goes first. */
const DELIBERATE_STOP_LIMIT = 500;
/** The deepest parent chain that a check walks. */
const PARENT_DEPTH = 64;
/** A run with an open work step, such as a long command with no output, is stalled only at this many times `N`. */
export const OPEN_STEP_STALL_FACTOR = 4;
/** A run or a request is stalled at this many times `N`. */
const STALL_FACTOR = 2;

/** `running`: Working. `queued`: Requested. `start-failed`: Failed, because the provider did not start it. */
export type WatchKind = "running" | "queued" | "start-failed";

/**
 * Why the reviewer leaves a task alone now. `person`: the person stopped it. `attention`: its agent
 * waits for the person. `memory`: the Mac is low on memory. `children`: tasks below it work. `plan`:
 * its agent has a spent plan. For a request only: `lane` (the one-channel-at-a-time lane holds its
 * channel), `slot` (the cap on agents or the turn places hold it), `agent-busy` (its agent runs
 * another turn or has a queue), `waits-for-work` (the drain holds it for another reason: a dependency
 * that is not complete, a full tab, a resource or an assignment of its owner in another run, a root
 * that stopped, an owner that is hidden; see `ChannelQueueHold`).
 */
export type WatchHold = TaskWatchHold;

export type WatchClass = "healthy" | "slow" | "stalled";

/** One task as the reviewer reads it in one look. */
export interface WatchObservation {
  channelId: string;
  channelName: string;
  taskId: string;
  revision: number;
  kind: WatchKind;
  agentId: string | null;
  agentName: string | null;
  provider: string | null;
  /** For a run: when its turn started, or null when it has no turn yet. */
  turnStartedAt: number | null;
  /** For a run: when the provider last sent an event for its agent, or null. */
  lastEventAt: number | null;
  /** For a run: its agent has a work step that started and did not end, such as a long command. */
  stepOpen: boolean;
  /**
   * For a request: the id of its own active assignment, when the drain started it and the turn did not
   * start yet. Null when it has none.
   */
  startingAssignmentId: string | null;
  hold: WatchHold | null;
}

/** A task with the clock of the reviewer. */
export interface WatchedTask extends WatchObservation {
  startedAt: number;
  /**
   * The newest sign of life. For a request: when the reviewer first saw it queued at this revision.
   * A hold stops the clock: a look that finds a hold counts as a sign.
   */
  lastSignAt: number;
}

/** A task that the reviewer can act on now. `due`: a failed start whose interval ended. */
export interface WatchCandidate {
  task: WatchedTask;
  class: "slow" | "stalled" | "due";
  minutes: number;
}

export interface WatchContext {
  now: number;
  /** The threshold `N`: slow from `N`, stalled from `2 × N`. */
  thresholdMs: number;
  /** The interval of "Resume by itself": the least time between two actions on one task. */
  intervalMs: number;
}

export type WatchAction =
  | { type: "resume" }
  | { type: "reassign"; agentId: string }
  | { type: "stop" }
  | { type: "give-up" };

/**
 * The class of a task from its time with no sign: healthy below `N`, slow up to `stallFactor × N`
 * (`2 × N` by default), then stalled.
 */
export function classifyQuiet(quietMs: number, thresholdMs: number, stallFactor = STALL_FACTOR): WatchClass {
  if (quietMs < thresholdMs) return "healthy";
  return quietMs < stallFactor * thresholdMs ? "slow" : "stalled";
}

/**
 * The class of a watched task. A run with an open work step stays slow up to `4 × N`. A request whose
 * start is under way (`startingAssignmentId`) has no slow band: it is stalled only at `2 × N`.
 */
export function watchClass(
  task: Pick<WatchObservation, "kind" | "stepOpen" | "startingAssignmentId">,
  quietMs: number,
  thresholdMs: number,
): WatchClass {
  if (task.kind === "running" && task.stepOpen) return classifyQuiet(quietMs, thresholdMs, OPEN_STEP_STALL_FACTOR);
  const state = classifyQuiet(quietMs, thresholdMs);
  return task.kind === "queued" && task.startingAssignmentId !== null && state === "slow" ? "healthy" : state;
}

/** The mark of a running row in the panel, or undefined while it is healthy. */
export function runningQuiet(
  startedAt: number,
  lastEventAt: number | null,
  now: number,
  thresholdMs: number,
  stepOpen = false,
): RunningWorkQuiet | undefined {
  const quiet = now - Math.max(startedAt, lastEventAt ?? 0);
  const state = classifyQuiet(quiet, thresholdMs, stepOpen ? OPEN_STEP_STALL_FACTOR : STALL_FACTOR);
  return state === "healthy" ? undefined : { state, minutes: Math.floor(quiet / MINUTE_MS) };
}

/**
 * The most actions on one failed start: with `N` at 5 and an interval of 30, about two hours. Then the
 * person decides. The count lasts as long as the record: the task completes, or no look sees it for
 * `RECORD_RETENTION_MS`.
 */
export const TASK_WATCH_START_ACTIONS = 6;

/**
 * How long a failed start waits before the reviewer acts on it again: `N` for the first action, then
 * twice as long for each action that it took already (`N`, `2 × N`, `4 × N` …), at most the interval of
 * "Resume by itself". A failed start is a clear stop, and the app already tried it again with its start
 * retry: with `N` at 5 minutes, the reviewer acts after 5, 10, 20 and then each 30 minutes.
 */
export function startFailedWaitMs(context: Pick<WatchContext, "thresholdMs" | "intervalMs">, actions = 0): number {
  return Math.min(context.intervalMs, context.thresholdMs * 2 ** Math.max(0, actions));
}

/** The actions on a task so far: its resumes and reassigns, by this reviewer or "Resume by itself". */
function actionsOf(record: Pick<LedgerRecord, "resumes" | "reassigns"> | undefined): number {
  return (record?.resumes ?? 0) + (record?.reassigns ?? 0);
}

function rank(candidate: WatchCandidate): 0 | 1 | 2 | 3 | 4 {
  if (candidate.class === "stalled") return candidate.task.kind === "running" ? 0 : 1;
  if (candidate.class === "due") return 2;
  return candidate.task.kind === "running" ? 3 : 4;
}

/**
 * The tasks that the reviewer can act on now, the most urgent first: stalled runs (they hold a place),
 * stalled requests, failed starts that are due, then slow runs and slow requests, each group by the
 * longest time with no sign. A healthy task is not in the list, nor a held one, nor a task that it gave
 * up on or acted on less than one interval ago. A failed start waits one interval from the first
 * look that saw it, as the automatic recovery does. See `watchClass` for the classes.
 */
export function watchCandidates(
  tasks: readonly WatchedTask[],
  context: WatchContext,
  recordOf: (task: WatchedTask) => LedgerRecord | undefined,
): WatchCandidate[] {
  const candidates: WatchCandidate[] = [];
  for (const task of tasks) {
    if (task.hold) continue;
    const record = recordOf(task);
    if (record?.gaveUp) continue;
    if (task.kind === "start-failed") {
      const since = record ? (record.lastActionAt ?? record.seenAt) : context.now;
      if (context.now - since >= startFailedWaitMs(context, actionsOf(record)))
        candidates.push({ task, class: "due", minutes: 0 });
      continue;
    }
    if (record && record.lastActionAt !== null && context.now - record.lastActionAt < context.intervalMs) continue;
    const quiet = context.now - task.lastSignAt;
    const state = watchClass(task, quiet, context.thresholdMs);
    if (state !== "healthy") candidates.push({ task, class: state, minutes: Math.floor(quiet / MINUTE_MS) });
  }
  return candidates.sort((left, right) => rank(left) - rank(right) || right.minutes - left.minutes);
}

/** What the reviewer will do with one watched task, and from when (`actsAt`, null while held or after it gave up). */
export interface WatchOutlook {
  task: WatchedTask;
  state: TaskWatchWait["state"];
  actsAt: number | null;
}

/**
 * When the reviewer can act on each watched task, by the local rules of `watchCandidates`: a held task
 * waits for its hold; a task that it gave up on is left; a failed start waits `startFailedWaitMs` from the
 * first look or the last action; a run or a request is stalled at `2 × N` with no sign (`4 × N` with an
 * open work step), and never sooner than one interval after the last action. A slow task can get a
 * resume sooner when the model of the Guard says so; this is not shown.
 */
export function watchOutlook(
  tasks: readonly WatchedTask[],
  context: WatchContext,
  recordOf: (task: WatchedTask) => LedgerRecord | undefined,
  gaveUp: (task: WatchedTask) => boolean,
): WatchOutlook[] {
  return tasks.map((task): WatchOutlook => {
    if (task.hold) return { task, state: "held", actsAt: null };
    const record = recordOf(task);
    if (record?.gaveUp || gaveUp(task)) return { task, state: "gave-up", actsAt: null };
    if (task.kind === "start-failed") {
      const since = record ? (record.lastActionAt ?? record.seenAt) : context.now;
      const actsAt = since + startFailedWaitMs(context, actionsOf(record));
      const state = actsAt <= context.now ? "due" : record?.lastActionAt != null ? "cooldown" : "watching";
      return { task, state, actsAt };
    }
    const factor = task.kind === "running" && task.stepOpen ? OPEN_STEP_STALL_FACTOR : STALL_FACTOR;
    const stallAt = task.lastSignAt + factor * context.thresholdMs;
    const cooldownUntil = record?.lastActionAt != null ? record.lastActionAt + context.intervalMs : 0;
    const actsAt = Math.max(stallAt, cooldownUntil);
    if (actsAt <= context.now) return { task, state: "due", actsAt };
    return { task, state: cooldownUntil >= stallAt ? "cooldown" : "watching", actsAt };
  });
}

const WAIT_ORDER: Record<TaskWatchWait["state"], number> = { due: 0, watching: 1, cooldown: 1, held: 2, "gave-up": 3 };

/** Whole minutes from `now` to `at`, never below zero. */
function minutesUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / MINUTE_MS));
}

/**
 * What to do with a task that the reviewer acts on, from the tries in the ledger. A run or a request
 * gets the resumes of the ledger, then goes to another agent when the person allows it. At the end a
 * run is stopped, so it frees its place; a request is left as it is. A failed start has its own ladder
 * (`startFailedAction`).
 */
export function watchAction(
  kind: WatchKind,
  record: Pick<LedgerRecord, "resumes" | "reassigns" | "startActions"> | undefined,
  reassign: boolean,
  pick: () => string | null,
): WatchAction {
  if (kind === "start-failed") return startFailedAction(record, reassign, pick);
  const resumes = record?.resumes ?? 0;
  const reassigns = record?.reassigns ?? 0;
  let picked: string | null | undefined;
  const target = (): string | null => {
    if (picked === undefined) picked = reassign && reassigns < MAX_REASSIGNS ? pick() : null;
    return picked;
  };
  if (resumes < MAX_RESUMES) return { type: "resume" };
  const agentId = target();
  if (agentId) return { type: "reassign", agentId };
  return kind === "running" ? { type: "stop" } : { type: "give-up" };
}

/**
 * What to do with a failed start, which the reviewer follows until it starts: a resume first; then, by
 * turns, a reassign to a free agent (the same model, else the same provider, else any agent of the
 * channel that can take it; `pick` chooses) and a resume, while "Give to another agent" allows it. A
 * reassigned task that fails again stays on this ladder, because the record is the task's, not the
 * agent's. After `TASK_WATCH_START_ACTIONS` actions, it gives up: the
 * person decides.
 */
export function startFailedAction(
  record: Pick<LedgerRecord, "resumes" | "reassigns" | "startActions"> | undefined,
  reassign: boolean,
  pick: () => string | null,
): WatchAction {
  if ((record?.startActions ?? []).length >= TASK_WATCH_START_ACTIONS) return { type: "give-up" };
  const done = actionsOf(record);
  if (done % 2 === 1 && reassign) {
    const agentId = pick();
    if (agentId) return { type: "reassign", agentId };
  }
  return { type: "resume" };
}

/**
 * The tasks that a person stopped on purpose, in this run of the app. The stored task cannot tell: a
 * Stop and a turn that ends interrupted both set `paused` with the reason `channelTaskStopped`. So the
 * reviewer reads the commands (`ChannelService.observeCommands`): a `stop` that the app did not send
 * by itself is a person's. `byApp` comes from the ids that `WorkControl` sent, never from the text of
 * the operation id, which a client chooses. A `resume` or a `reassign` by a person removes the mark of
 * that task.
 */
export class DeliberateStops {
  readonly #marks = new Set<string>();

  note(command: ChannelCommand, byApp: boolean): void {
    if (command.type !== "stop" && command.type !== "resume" && command.type !== "reassign") return;
    if (byApp) return;
    const key = taskKey(command.channelId, command.taskId);
    this.#marks.delete(key);
    if (command.type !== "stop") return;
    this.#marks.add(key);
    for (const oldest of this.#marks) {
      if (this.#marks.size <= DELIBERATE_STOP_LIMIT) break;
      this.#marks.delete(oldest);
    }
  }

  /** Whether the person stopped this task, or a task above it, and did not start it again. */
  covers(channelId: string, taskId: string, parentOf: (taskId: string) => string | null): boolean {
    if (this.#marks.size === 0) return false;
    let current: string | null = taskId;
    for (let depth = 0; current !== null && depth < PARENT_DEPTH; depth += 1) {
      if (this.#marks.has(taskKey(channelId, current))) return true;
      current = parentOf(current);
    }
    return false;
  }
}

/** The log of the reviewer: actions, kinds and minutes, never the text of a task. */
export interface TaskWatchLog {
  info(message: string, fields: Record<string, string | number | boolean>): void;
}

export interface TaskWatchDeps {
  preference(): TaskWatchPreference;
  recovery(): AutoRecoveryPreference;
  /** The tasks to watch now, with their holds. */
  observe(): readonly WatchObservation[];
  ledger: RecoveryLedger;
  /**
   * The agent to give a task to, given the agents that it was given to already, or null. It is a free
   * agent: one that runs no turn, waits for no place and has no queue.
   */
  candidate(channelId: string, taskId: string, tried: readonly string[]): string | null;
  /**
   * Sends one command for the task. It is dropped when the task changed since the look: its state, its
   * revision, or a new sign of a run. Answers whether it applied.
   */
  command(type: "resume" | "reassign" | "stop", task: WatchedTask, recipientAgentId: string | null): Promise<boolean>;
  /** The model of the Guard, or null for the local rules only. */
  judge: TaskWatchJudge | null;
  /** The raw text that the model reads about a task: its request and the agent's last words. */
  texts(task: WatchedTask): { request: string; lastWords: string };
  /** The agents that run now, and the cap or null when it is off. */
  load(): { activeAgents: number; agentLimit: number | null };
  agentNameOf(agentId: string): string | null;
  now(): number;
  /** A failed command, a model call that failed, or a look that failed (`look`, with empty ids). */
  onFailure(
    kind: "resume" | "reassign" | "stop" | "judge" | "look",
    channelId: string,
    taskId: string,
    cause: unknown,
  ): void;
  log?: TaskWatchLog;
  /**
   * The file of the last actions, so they stay after a restart. `read` gives them as the file holds them,
   * the newest first; `write` saves the list after each action. Omitted, they are in memory only.
   */
  history?: { read(): readonly TaskWatchEvent[]; write(events: readonly TaskWatchEvent[]): void };
}

/** A look that waits writes its summary to the log again after this long, also with no change, so the log shows that it looks. */
const WAIT_LOG_REPEAT_MS = 10 * MINUTE_MS;

const ACTION_EVENT = {
  resume: "resumed",
  reassign: "reassigned",
  stop: "stopped",
  "give-up": "gave-up",
} as const satisfies Record<WatchAction["type"], TaskWatchEvent["action"]>;

const KIND_REASON = {
  running: "no-sign",
  queued: "queued",
  "start-failed": "start-failed",
} as const satisfies Record<WatchKind, TaskWatchEvent["reason"]>;

export class TaskWatch {
  readonly #deps: TaskWatchDeps;
  readonly #log: TaskWatchLog;
  readonly #recent: TaskWatchEvent[] = [];
  /** When a look first saw each task in its state and revision (`clockKey`). */
  #firstSeen = new Map<string, number>();
  /** When a look last found a hold on each task (`clockKey`): the clock counts from there. */
  #heldAt = new Map<string, number>();
  /** The slow periods that got their one answer. */
  #answered = new Set<string>();
  /**
   * The requests that the reviewer gave up on, by task and revision (`revisionKey`). This mark is the
   * reviewer's own: the shared ledger does not get it, so "Resume by itself" still tries the task when
   * it stops later.
   */
  #gaveUp = new Set<string>();
  /** The times of the model calls in the last hour. */
  #calls: number[] = [];
  #ticking = false;
  /** What the last look found: when the reviewer can act on each watched task. */
  #outlook: WatchOutlook[] = [];
  /** Whether the last look ran, so the log says once when the reviewer starts or stops looking. */
  #wasActive: boolean | null = null;
  /** The last summary of a look that waited, and when it went to the log. */
  #waitLog: { summary: string; at: number } | null = null;

  constructor(deps: TaskWatchDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? createBuildersBotLogger("task-watch");
    this.#recent.push(...(deps.history?.read() ?? []).slice(0, TASK_WATCH_RECENT_LIMIT));
  }

  /** It looks only while its switch and "Resume by itself" are both on. */
  active(): boolean {
    return this.#deps.preference().enabled && this.#deps.recovery().enabled;
  }

  recent(): TaskWatchEvent[] {
    return [...this.#recent];
  }

  /**
   * The tasks of the last look and why the reviewer does not act on them yet, the soonest first: the
   * tasks that it acts on in some minutes, then the held ones, then the ones that it gave up on.
   */
  waits(now = this.#deps.now()): TaskWatchWait[] {
    if (!this.active()) return [];
    return this.#outlook
      .map(
        (entry): TaskWatchWait => ({
          channelName: entry.task.channelName,
          kind: entry.task.kind,
          state: entry.actsAt !== null && entry.actsAt <= now && entry.state !== "gave-up" ? "due" : entry.state,
          hold: entry.task.hold,
          minutes: entry.actsAt === null ? null : minutesUntil(entry.actsAt, now),
        }),
      )
      .sort(
        (left, right) => WAIT_ORDER[left.state] - WAIT_ORDER[right.state] || (left.minutes ?? 0) - (right.minutes ?? 0),
      )
      .slice(0, TASK_WATCH_WAIT_LIMIT);
  }

  /**
   * What the reviewer does next with a failed start, for its stopped row, or null when the reviewer is
   * off or did not see the task yet.
   */
  planOf(channelId: string, taskId: string, now = this.#deps.now()): StoppedWorkPlan | null {
    if (!this.active()) return null;
    const entry = this.#outlook.find(
      (candidate) =>
        candidate.task.kind === "start-failed" &&
        candidate.task.channelId === channelId &&
        candidate.task.taskId === taskId,
    );
    if (!entry) return null;
    const record = this.#deps.ledger.peek(channelId, taskId);
    const tries = (record?.resumes ?? 0) + (record?.reassigns ?? 0);
    const base = { by: "reviewer", action: null, minutes: null, hold: null, tries } as const;
    if (entry.state === "held") return { ...base, state: "held", hold: entry.task.hold };
    // A failed start that the reviewer followed to its cap waits for the person.
    if (record?.needsYou) return { ...base, state: "needs-you" };
    if (entry.state === "gave-up" || entry.actsAt === null) return { ...base, state: "gave-up" };
    const next = watchAction("start-failed", record, this.#deps.recovery().reassign, () =>
      this.#deps.candidate(channelId, taskId, record?.tried ?? []),
    );
    // A stop is only for a run; a failed start that has no try left is left to the person.
    if (next.type === "give-up" || next.type === "stop") return { ...base, state: "needs-you" };
    return { ...base, state: "due", action: next.type, minutes: minutesUntil(entry.actsAt, now) };
  }

  /** One look. It does not overlap itself, it never throws, and it decides about one task at most. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    const active = this.active();
    if (active !== this.#wasActive) {
      this.#wasActive = active;
      const preference = this.#deps.preference();
      this.#log.info(active ? "The task reviewer looks." : "The task reviewer does not look.", {
        enabled: preference.enabled,
        resumeByItself: this.#deps.recovery().enabled,
        quietMinutes: preference.quietMinutes,
      });
    }
    if (!active) {
      // A clock does not run while the reviewer is off: turned on again, a request waits anew.
      this.#firstSeen.clear();
      this.#heldAt.clear();
      this.#answered.clear();
      this.#gaveUp.clear();
      this.#outlook = [];
      this.#waitLog = null;
      return;
    }
    this.#ticking = true;
    try {
      await this.#look();
    } catch (cause) {
      this.#deps.onFailure("look", "", "", cause);
    } finally {
      this.#ticking = false;
    }
  }

  async #look(): Promise<void> {
    const now = this.#deps.now();
    const recovery = this.#deps.recovery();
    const context: WatchContext = {
      now,
      thresholdMs: this.#deps.preference().quietMinutes * MINUTE_MS,
      intervalMs: Math.max(1, recovery.intervalMinutes) * MINUTE_MS,
    };
    const { ledger } = this.#deps;
    const observed = this.#clock(this.#deps.observe(), now);
    // A failed start is a stopped row, as for "Resume by itself": the first look starts its interval.
    // A run or a request does not renew its record here. The record keeps the tries for the
    // retention time after the last action or stop, and a task that then works well for hours
    // starts again with new tries.
    for (const task of observed) if (task.kind === "start-failed") ledger.see(task.channelId, task.taskId, now);
    const live = new Set(observed.map(revisionKey));
    for (const key of this.#gaveUp) if (!live.has(key)) this.#gaveUp.delete(key);
    const tasks = observed.filter((task) => !this.#gaveUp.has(revisionKey(task)));
    const candidates = watchCandidates(tasks, context, (task) => ledger.peek(task.channelId, task.taskId));
    const answered = new Set<string>();
    for (const task of observed) {
      const key = periodKey(task);
      if (this.#answered.has(key)) answered.add(key);
    }
    this.#answered = answered;
    let decided = false;
    try {
      decided = await this.#decide(candidates, recovery.reassign, now);
    } finally {
      // After the decision, so the tries of a task that it acted on count.
      this.#outlook = watchOutlook(
        observed,
        context,
        (task) => ledger.peek(task.channelId, task.taskId),
        (task) => this.#gaveUp.has(revisionKey(task)),
      );
    }
    if (!decided) this.#logWait(now);
  }

  /** Decides about one candidate at most. Answers whether it decided, to act or to wait. */
  async #decide(candidates: readonly WatchCandidate[], reassign: boolean, now: number): Promise<boolean> {
    for (const candidate of candidates) {
      if (candidate.class !== "slow") {
        await this.#act(candidate, reassign, "local", false);
        return true;
      }
      const period = periodKey(candidate.task);
      // One answer for each slow period: an answer to wait holds until the task is stalled.
      if (this.#answered.has(period)) continue;
      this.#answered.add(period);
      const answer = await this.#ask(candidate, now);
      // The model can only ask for a resume. A reassign or a stop needs a stalled task.
      if (answer.decision === "act") await this.#act(candidate, reassign, answer.by, true);
      else this.#note(now, candidate, "waited", candidate.task.agentName, answer.by);
      return true;
    }
    return false;
  }

  /**
   * One line for a look that decided nothing: how many tasks it watches, held by what, and the minutes
   * until the next one is due. It goes to the log when it changes, and again every `WAIT_LOG_REPEAT_MS`,
   * so at most one line each look. It has no name, request or words of a task.
   */
  #logWait(now: number): void {
    const counts = new Map<string, number>();
    const holds = new Map<string, number>();
    let next: number | null = null;
    for (const entry of this.#outlook) {
      counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
      if (entry.task.hold) holds.set(entry.task.hold, (holds.get(entry.task.hold) ?? 0) + 1);
      if (entry.actsAt !== null && entry.state !== "gave-up") {
        const minutes = minutesUntil(entry.actsAt, now);
        next = next === null ? minutes : Math.min(next, minutes);
      }
    }
    const holdText = [...holds].map(([hold, count]) => `${hold}:${count}`).join(",");
    const summary = `${[...counts].map(([state, count]) => `${state}:${count}`).join(",")}|${holdText}`;
    const last = this.#waitLog;
    if (last && last.summary === summary && now - last.at < WAIT_LOG_REPEAT_MS) return;
    this.#waitLog = { summary, at: now };
    this.#log.info("The task reviewer waits.", {
      watched: this.#outlook.length,
      watching: counts.get("watching") ?? 0,
      cooldown: counts.get("cooldown") ?? 0,
      held: counts.get("held") ?? 0,
      gaveUp: counts.get("gave-up") ?? 0,
      holds: holdText || "none",
      nextMinutes: next ?? -1,
    });
  }

  /**
   * The start and the last sign of each task, from the turn, the provider clock and the first look. A
   * hold stops the clock: the time with no sign counts from the last look that found a hold. So a
   * request that a full cap, a busy agent or a dependency held for an hour is not stalled at once when
   * the hold ends, while the drain starts it.
   */
  #clock(observations: readonly WatchObservation[], now: number): WatchedTask[] {
    const firstSeen = new Map<string, number>();
    const heldAt = new Map<string, number>();
    const tasks = observations.map((observation): WatchedTask => {
      const key = clockKey(observation);
      const seen = this.#firstSeen.get(key) ?? now;
      firstSeen.set(key, seen);
      const held = observation.hold ? now : this.#heldAt.get(key);
      if (held !== undefined) heldAt.set(key, held);
      const startedAt = observation.turnStartedAt ?? seen;
      const sign = observation.kind === "running" ? Math.max(startedAt, observation.lastEventAt ?? 0) : startedAt;
      return { ...observation, startedAt, lastSignAt: Math.max(sign, held ?? 0) };
    });
    this.#firstSeen = firstSeen;
    this.#heldAt = heldAt;
    return tasks;
  }

  /** The decision for a slow task: the model of the Guard when it can run and the budget allows, else wait. */
  async #ask(candidate: WatchCandidate, now: number): Promise<{ decision: TaskWatchDecision; by: "local" | "model" }> {
    const local = { decision: "wait", by: "local" } as const;
    const { judge } = this.#deps;
    const { task } = candidate;
    const record = this.#deps.ledger.peek(task.channelId, task.taskId);
    // The model can only ask for a resume, so with no resume left there is no question.
    if ((record?.resumes ?? 0) >= MAX_RESUMES || !judge?.ready() || !this.#spend(now)) return local;
    const load = this.#deps.load();
    try {
      const texts = this.#deps.texts(task);
      const decision = await withDeadline(
        judge.decide({
          kind: task.kind === "queued" ? "queued" : "running",
          minutesSinceStart: (now - task.startedAt) / MINUTE_MS,
          minutesQuiet: candidate.minutes,
          resumes: record?.resumes ?? 0,
          reassigns: record?.reassigns ?? 0,
          maxResumes: MAX_RESUMES,
          maxReassigns: MAX_REASSIGNS,
          activeAgents: load.activeAgents,
          agentLimit: load.agentLimit,
          provider: task.provider,
          stepOpen: task.kind === "running" && task.stepOpen,
          request: texts.request,
          lastWords: texts.lastWords,
        }),
        JUDGE_SAFETY_MS,
      );
      return decision ? { decision, by: "model" } : local;
    } catch (cause) {
      this.#deps.onFailure("judge", task.channelId, task.taskId, cause);
      return local;
    }
  }

  /** Takes one call from the budget of the hour, or answers false when it is spent. */
  #spend(now: number): boolean {
    this.#calls = this.#calls.filter((at) => now - at < HOUR_MS);
    if (this.#calls.length >= TASK_WATCH_MODEL_CALLS_PER_HOUR) return false;
    this.#calls.push(now);
    return true;
  }

  /**
   * Acts on one task by the tries of the ledger. `resumeOnly` (an answer of the model for a slow task)
   * allows a resume only: when the next action is another one, the reviewer waits.
   */
  async #act(candidate: WatchCandidate, reassign: boolean, by: "local" | "model", resumeOnly: boolean): Promise<void> {
    const now = this.#deps.now();
    const { task } = candidate;
    const { ledger } = this.#deps;
    const tries = ledger.peek(task.channelId, task.taskId);
    const action = watchAction(task.kind, tries, reassign, () =>
      this.#deps.candidate(task.channelId, task.taskId, tries?.tried ?? []),
    );
    if (resumeOnly && action.type !== "resume") {
      this.#note(now, candidate, "waited", task.agentName, "local");
      return;
    }
    if (action.type === "give-up") {
      if (task.kind === "queued") this.#gaveUp.add(revisionKey(task));
      else {
        const record = ledger.see(task.channelId, task.taskId, now);
        record.gaveUp = true;
        record.lastActionAt = now;
        // A failed start that the reviewer followed to its cap waits for the person.
        if (task.kind === "start-failed") record.needsYou = true;
      }
      this.#note(now, candidate, "give-up", task.agentName, by);
      return;
    }
    const recipient = action.type === "reassign" ? action.agentId : null;
    let applied = true;
    let failed = false;
    try {
      applied = await this.#deps.command(action.type, task, recipient);
    } catch (cause) {
      // A failed request counts as a try, as in the automatic recovery.
      failed = true;
      this.#deps.onFailure(action.type, task.channelId, task.taskId, cause);
    }
    // The task changed since the look, so the command did nothing and counts as nothing.
    if (!applied) return;
    const record = ledger.see(task.channelId, task.taskId, now);
    record.lastActionAt = now;
    if (task.kind === "start-failed")
      record.startActions = [...(record.startActions ?? []), now].slice(-TASK_WATCH_START_ACTIONS);
    if (action.type === "resume") record.resumes += 1;
    if (action.type === "reassign") {
      record.reassigns += 1;
      record.tried.push(action.agentId);
    }
    if (action.type === "stop") record.gaveUp = true;
    if (failed) return;
    this.#note(
      now,
      candidate,
      action.type,
      recipient ? (this.#deps.agentNameOf(recipient) ?? recipient) : task.agentName,
      by,
    );
  }

  #note(
    now: number,
    candidate: WatchCandidate,
    action: WatchAction["type"] | "waited",
    agentName: string | null,
    by: "local" | "model",
  ): void {
    const { task } = candidate;
    const event: TaskWatchEvent = {
      at: new Date(now).toISOString(),
      channelName: task.channelName,
      action: action === "waited" ? "waited" : ACTION_EVENT[action],
      agentName,
      reason: KIND_REASON[task.kind],
      minutes: task.kind === "start-failed" ? null : candidate.minutes,
      by,
    };
    this.#recent.unshift(event);
    this.#recent.length = Math.min(this.#recent.length, TASK_WATCH_RECENT_LIMIT);
    this.#deps.history?.write(this.#recent);
    const record = this.#deps.ledger.peek(task.channelId, task.taskId);
    this.#log.info("The task reviewer decided.", {
      action: event.action,
      kind: task.kind,
      reason: event.reason,
      by,
      minutes: event.minutes ?? -1,
      // Counts only: the tries of the task so far.
      actions: actionsOf(record),
      reassigns: record?.reassigns ?? 0,
    });
  }
}

function taskKey(channelId: string, taskId: string): string {
  return `${channelId}\u0000${taskId}`;
}

/** One task at one revision. */
function revisionKey(task: Pick<WatchObservation, "channelId" | "taskId" | "revision">): string {
  return `${taskKey(task.channelId, task.taskId)}\u0000${task.revision}`;
}

/** One clock of a task: its state and revision, and for a request the assignment that starts it. */
function clockKey(task: WatchObservation): string {
  return `${revisionKey(task)}\u0000${task.kind}\u0000${task.startingAssignmentId ?? ""}`;
}

/** One slow period of a task: a new sign of life, or a new revision, starts another one. */
function periodKey(task: WatchedTask): string {
  return `${taskKey(task.channelId, task.taskId)}\u0000${task.kind}\u0000${task.revision}\u0000${task.lastSignAt}`;
}

/** The answer of `promise`, or an error after `ms`. The timer never holds the process open. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The task reviewer's model did not answer in time.")), ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
