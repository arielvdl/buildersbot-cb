/**
 * The task reviewer ("Revisor" in the panel): it watches the tasks of the channels for work that is
 * parked too long, and tries to move it, one task in each look. It covers what the automatic
 * recovery does not see: a run that gives no sign of life while it holds a place, a request that
 * waits in the queue with nothing to hold it, and a start that fails again. Local rules decide
 * first; for a slow task only, the model of the Guard can decide. It uses the tries of the automatic
 * recovery (`RecoveryLedger`), so nothing loops. See `docs/architecture/task-reviewer.md`.
 */

import type {
  AutoRecoveryPreference,
  ChannelCommand,
  RunningWorkQuiet,
  TaskWatchEvent,
  TaskWatchPreference,
} from "@openbot/contracts/ipc";
import { TASK_WATCH_RECENT_LIMIT } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger } from "@openbot/logging";
import { type LedgerRecord, MAX_REASSIGNS, MAX_RESUMES, type RecoveryLedger } from "./auto-recovery";
import type { TaskWatchDecision, TaskWatchJudge } from "./task-watch-judge";

export type { TaskWatchJudge } from "./task-watch-judge";

/** The start of the operation id of each command that the app sends by itself, not a person. */
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

/** `running`: Working. `queued`: Requested. `start-failed`: Failed, because the provider did not start it. */
export type WatchKind = "running" | "queued" | "start-failed";

/**
 * Why the reviewer leaves a task alone now. `person`: the person stopped it. `attention`: its agent
 * waits for the person. `memory`: the Mac is low on memory. `children`: tasks below it work. `plan`:
 * its agent has a spent plan. For a request only: `lane` (the one-channel-at-a-time lane holds its
 * channel), `slot` (the cap on agents or the turn places hold it), `agent-busy` (its agent runs
 * another turn).
 */
export type WatchHold = "person" | "attention" | "memory" | "children" | "plan" | "lane" | "slot" | "agent-busy";

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
  hold: WatchHold | null;
}

/** A task with the clock of the reviewer. */
export interface WatchedTask extends WatchObservation {
  startedAt: number;
  /** The newest sign of life. For a request: when the reviewer first saw it queued at this revision. */
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

/** The class of a task from its time with no sign: healthy below `N`, slow up to `2 × N`, then stalled. */
export function classifyQuiet(quietMs: number, thresholdMs: number): WatchClass {
  if (quietMs < thresholdMs) return "healthy";
  return quietMs < 2 * thresholdMs ? "slow" : "stalled";
}

/** The mark of a running row in the panel, or undefined while it is healthy. */
export function runningQuiet(
  startedAt: number,
  lastEventAt: number | null,
  now: number,
  thresholdMs: number,
): RunningWorkQuiet | undefined {
  const quiet = now - Math.max(startedAt, lastEventAt ?? 0);
  const state = classifyQuiet(quiet, thresholdMs);
  return state === "healthy" ? undefined : { state, minutes: Math.floor(quiet / MINUTE_MS) };
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
 * look that saw it, as the automatic recovery does.
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
      if (context.now - since >= context.intervalMs) candidates.push({ task, class: "due", minutes: 0 });
      continue;
    }
    if (record && record.lastActionAt !== null && context.now - record.lastActionAt < context.intervalMs) continue;
    const quiet = context.now - task.lastSignAt;
    const state = classifyQuiet(quiet, context.thresholdMs);
    if (state !== "healthy") candidates.push({ task, class: state, minutes: Math.floor(quiet / MINUTE_MS) });
  }
  return candidates.sort((left, right) => rank(left) - rank(right) || right.minutes - left.minutes);
}

/**
 * What to do with a task that the reviewer acts on, from the tries in the ledger. A failed start gets
 * one resume, because the same agent failed to start it already; a run or a request gets the resumes
 * of the ledger. Then it goes to another agent when the person allows it. At the end a run is
 * stopped, so it frees its place; a request or a failed start is left as it is.
 */
export function watchAction(
  kind: WatchKind,
  record: Pick<LedgerRecord, "resumes" | "reassigns"> | undefined,
  reassign: boolean,
  pick: () => string | null,
): WatchAction {
  const resumes = record?.resumes ?? 0;
  const reassigns = record?.reassigns ?? 0;
  if (resumes < (kind === "start-failed" ? 1 : MAX_RESUMES)) return { type: "resume" };
  if (reassign && reassigns < MAX_REASSIGNS) {
    const agentId = pick();
    if (agentId) return { type: "reassign", agentId };
  }
  return kind === "running" ? { type: "stop" } : { type: "give-up" };
}

/**
 * The tasks that a person stopped on purpose, in this run of the app. The stored task cannot tell: a
 * Stop and a turn that ends interrupted both set `paused` with the reason `channelTaskStopped`. So the
 * reviewer reads the commands (`ChannelService.observeCommands`): a `stop` that the app did not send
 * by itself (`AUTO_OPERATION_PREFIX`) is a person's. A `resume` or a `reassign` by a person removes
 * the mark of that task.
 */
export class DeliberateStops {
  readonly #marks = new Set<string>();

  note(command: ChannelCommand): void {
    if (command.type !== "stop" && command.type !== "resume" && command.type !== "reassign") return;
    if (command.operationId.startsWith(AUTO_OPERATION_PREFIX)) return;
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
  /** The agent to give a task to, given the agents that it was given to already, or null. */
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
}

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
  /** When a look first saw each task in its state and revision. */
  #firstSeen = new Map<string, number>();
  /** The slow periods that got their one answer. */
  #answered = new Set<string>();
  /** The times of the model calls in the last hour. */
  #calls: number[] = [];
  #ticking = false;

  constructor(deps: TaskWatchDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? createBuildersBotLogger("task-watch");
  }

  /** It looks only while its switch and "Resume by itself" are both on. */
  active(): boolean {
    return this.#deps.preference().enabled && this.#deps.recovery().enabled;
  }

  recent(): TaskWatchEvent[] {
    return [...this.#recent];
  }

  /** One look. It does not overlap itself, it never throws, and it decides about one task at most. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    if (!this.active()) {
      // A clock does not run while the reviewer is off: turned on again, a request waits anew.
      this.#firstSeen.clear();
      this.#answered.clear();
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
    const tasks = this.#clock(this.#deps.observe(), now);
    for (const task of tasks)
      if (task.kind === "start-failed" || ledger.peek(task.channelId, task.taskId))
        ledger.see(task.channelId, task.taskId, now);
    const candidates = watchCandidates(tasks, context, (task) => ledger.peek(task.channelId, task.taskId));
    const answered = new Set<string>();
    for (const task of tasks) {
      const key = periodKey(task);
      if (this.#answered.has(key)) answered.add(key);
    }
    this.#answered = answered;
    for (const candidate of candidates) {
      if (candidate.class !== "slow") {
        await this.#act(candidate, recovery.reassign, "local");
        return;
      }
      const period = periodKey(candidate.task);
      // One answer for each slow period: an answer to wait holds until the task is stalled.
      if (this.#answered.has(period)) continue;
      this.#answered.add(period);
      const answer = await this.#ask(candidate, now);
      if (answer.decision === "act") await this.#act(candidate, recovery.reassign, answer.by);
      else this.#note(now, candidate, "waited", candidate.task.agentName, answer.by);
      return;
    }
  }

  /** The start and the last sign of each task, from the turn, the provider clock and the first look. */
  #clock(observations: readonly WatchObservation[], now: number): WatchedTask[] {
    const firstSeen = new Map<string, number>();
    const tasks = observations.map((observation): WatchedTask => {
      const key = `${taskKey(observation.channelId, observation.taskId)}\u0000${observation.kind}\u0000${observation.revision}`;
      const seen = this.#firstSeen.get(key) ?? now;
      firstSeen.set(key, seen);
      const startedAt = observation.turnStartedAt ?? seen;
      return {
        ...observation,
        startedAt,
        lastSignAt: observation.kind === "running" ? Math.max(startedAt, observation.lastEventAt ?? 0) : startedAt,
      };
    });
    this.#firstSeen = firstSeen;
    return tasks;
  }

  /** The decision for a slow task: the model of the Guard when it can run and the budget allows, else wait. */
  async #ask(candidate: WatchCandidate, now: number): Promise<{ decision: TaskWatchDecision; by: "local" | "model" }> {
    const local = { decision: "wait", by: "local" } as const;
    const { judge } = this.#deps;
    if (!judge?.ready() || !this.#spend(now)) return local;
    const { task } = candidate;
    const record = this.#deps.ledger.peek(task.channelId, task.taskId);
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

  async #act(candidate: WatchCandidate, reassign: boolean, by: "local" | "model"): Promise<void> {
    const now = this.#deps.now();
    const { task } = candidate;
    const record = this.#deps.ledger.see(task.channelId, task.taskId, now);
    const action = watchAction(task.kind, record, reassign, () =>
      this.#deps.candidate(task.channelId, task.taskId, record.tried),
    );
    if (action.type === "give-up") {
      record.gaveUp = true;
      record.lastActionAt = now;
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
    record.lastActionAt = now;
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
    this.#log.info("The task reviewer decided.", {
      action: event.action,
      kind: task.kind,
      by,
      minutes: event.minutes ?? -1,
    });
  }
}

function taskKey(channelId: string, taskId: string): string {
  return `${channelId}\u0000${taskId}`;
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
