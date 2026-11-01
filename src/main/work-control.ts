import { randomUUID } from "node:crypto";
import type {
  AgentLimitPreference,
  AgentProviderId,
  AgentSummary,
  AutoRecoveryPreference,
  AutoRecoveryState,
  ChannelCommand,
  ChannelTask,
  ReassignStoppedWorkInput,
  ResumeStoppedWorkInput,
  RunningWork,
  StoppedWork,
  StoppedWorkBulkInput,
  StoppedWorkBulkResult,
  StoppedWorkEntry,
  StoppedWorkFailure,
  StoppedWorkItem,
  StoppedWorkList,
  StoppedWorkOrphan,
  StopWorkInput,
  TaskWatchPreference,
  TaskWatchState,
  WaitingWork,
} from "@openbot/contracts/ipc";
import {
  DEFAULT_TASK_WATCH_PREFERENCE,
  LOAD_WORK_LIST_LIMIT,
  STOPPED_WORK_PAGE_LIMIT,
  STOPPED_WORK_UNDO_MS,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { ChannelQueueHold } from "../backend/channel-service";
import {
  AutoRecovery,
  autoReassignee,
  type MemberInfo,
  type ReassignCandidate,
  RecoveryLedger,
  reassignCandidates,
  resumable,
  type StoppedRef,
} from "./auto-recovery";
import {
  AUTO_OPERATION_PREFIX,
  CHANNEL_START_FAILED,
  DeliberateStops,
  runningQuiet,
  TaskWatch,
  type TaskWatchDeps,
  type TaskWatchJudge,
  type WatchedTask,
  type WatchHold,
  type WatchObservation,
} from "./task-watch";
import {
  buildRunningWork,
  buildStoppedWork,
  countStoppedWork,
  duplicateStoppedTasks,
  type RunningTurnRecord,
  runningAgentCount,
  type StoppedChannelInput,
  type StoppedRun,
  stoppedRow,
  stoppedRuns,
} from "./work-overview";

const TICK_MS = 60_000;
/** The messages of a tab that the task reviewer reads back to find the agent's last words. */
const LAST_WORDS_MESSAGES = 40;
/** The states of a channel assignment that hold its agent. */
const ACTIVE_ASSIGNMENT_STATES: ReadonlySet<string> = new Set(["queued", "starting", "running"]);

/** What the task reviewer needs besides the channels. */
export interface WorkControlTaskWatchOptions {
  preference: () => TaskWatchPreference;
  /**
   * When the provider last sent an event for an agent, whether the agent waits for the person, and
   * whether a running turn of the agent has a work step that started and did not end.
   */
  signals: (agentId: string) => { lastEventAt: number | null; waitsOnPerson: boolean; stepOpen: boolean };
  /** What macOS says about the memory. */
  memoryLevel: () => "ok" | "low" | "critical";
  /** The model of the Guard, or null for the local rules only. */
  judge: TaskWatchJudge | null;
  /** The file of its last actions (`TaskWatchDeps.history`). Omitted, they are in memory only. */
  history?: TaskWatchDeps["history"];
}

export interface WorkControlOptions {
  /** `runningTurns` is the one record of the turns that run, also the ones in a channel or a side thread. */
  service: Pick<AgentService, "listAgents" | "channels" | "interrupt" | "runningTurns" | "slotWaitingAgents">;
  /** The cap on the agents that run at the same time. */
  agentLimit: () => AgentLimitPreference;
  channelActor: () => { id: string; name: string };
  preference: () => AutoRecoveryPreference;
  onFailure: (action: string, cause: unknown) => void;
  now?: () => number;
  /** The task reviewer. Omitted, it never looks. */
  taskWatch?: WorkControlTaskWatchOptions;
  /**
   * The routine that posted each of these requests of a channel, and whether it still exists
   * (`AgentService.channelRequestOrigins`). Omitted, no request is a routine's.
   */
  requestOrigins?: (
    channelId: string,
    requestMessageIds: readonly string[],
  ) => ReadonlyMap<string, { routineName: string; exists: boolean }>;
  /** Changes the model of one agent, as its settings do (`AgentService.updateAgent`). Omitted, `model` fails. */
  setAgentModel?: (agentId: string, provider: AgentProviderId, model: string) => Promise<void>;
}

/** A removal that the person can undo for `STOPPED_WORK_UNDO_MS`: the tasks as they were, by channel. */
interface PendingUndo {
  previous: Map<string, ChannelTask[]>;
  items: StoppedWorkItem[];
  timer: NodeJS.Timeout;
}

type WorkCommand = {
  type: "stop" | "resume" | "reassign";
  channelId: string;
  taskId: string;
  recipientAgentId: string | null;
};

/** The active channel tasks that a Stop on `taskId` has to end: the top of its run. */
export function topActiveTask(tasks: readonly ChannelTask[], taskId: string): string | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = (task: ChannelTask | undefined): task is ChannelTask =>
    task?.state === "queued" || task?.state === "running" || task?.state === "waiting";
  let top = byId.get(taskId);
  if (!active(top)) return null;
  for (let guard = 0; guard < 64; guard += 1) {
    const parent: ChannelTask | undefined = top.parentTaskId ? byId.get(top.parentTaskId) : undefined;
    if (!active(parent)) break;
    top = parent;
  }
  return top.id;
}

/**
 * What the load panel lets a person do about work: see who runs and stop it, see what stopped and why,
 * start it again or give it to another agent, and let the app do that by itself, within fixed tries.
 * The task reviewer (`task-watch.ts`) looks after the automatic recovery, with the same tries.
 * It reads the channels each time it is asked, so it holds nothing that could go stale.
 */
export class WorkControl {
  readonly #options: WorkControlOptions;
  readonly #ledger = new RecoveryLedger();
  readonly #recovery: AutoRecovery;
  readonly #watch: TaskWatch | null;
  readonly #stops = new DeliberateStops();
  /** The operation ids of the commands that the app sends by itself now, until each one applies. */
  readonly #ownOperations = new Set<string>();
  /** The removals that the person can still undo, by their id. */
  readonly #undo = new Map<string, PendingUndo>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: WorkControlOptions) {
    this.#options = options;
    const now = options.now ?? Date.now;
    this.#recovery = new AutoRecovery({
      preference: options.preference,
      // Every stopped run, not only the rows that the panel lists: past them, a stopped run was never
      // tried, while the first rows took the actions of each look. While the task reviewer looks, a
      // failed start is its own: it goes to another agent sooner.
      stopped: () => {
        const watching = this.#watchActive();
        return this.#stoppedRefs().filter((ref) => !watching || ref.reason !== CHANNEL_START_FAILED);
      },
      candidate: (channelId, taskId, tried) => {
        const task = this.#options.service.channels.store.exists(channelId)
          ? this.#options.service.channels.store.tasks(channelId).find((entry) => entry.id === taskId)
          : undefined;
        const stopped = (task?.state === "paused" || task?.state === "failed") && Boolean(task.error);
        return stopped ? autoReassignee(this.#candidatesFor(channelId, taskId, new Set(tried))) : null;
      },
      resume: (channelId, taskId) =>
        this.#command({ type: "resume", channelId, taskId, recipientAgentId: null }, "auto").then(() => undefined),
      reassign: (channelId, taskId, recipientAgentId) =>
        this.#command({ type: "reassign", channelId, taskId, recipientAgentId }, "auto").then(() => undefined),
      agentNameOf: (agentId) => this.#agentName(agentId),
      now,
      onFailure: (kind, channelId, taskId, cause) => options.onFailure(`${kind} ${channelId}/${taskId}`, cause),
      ledger: this.#ledger,
    });
    const watch = options.taskWatch;
    this.#watch = watch
      ? new TaskWatch({
          preference: watch.preference,
          recovery: options.preference,
          observe: () => this.#observe(watch),
          ledger: this.#ledger,
          // Only a free agent: a task given to an agent that runs or waits would wait again behind it.
          candidate: (channelId, taskId, tried) => {
            const free = this.#freeAgents();
            return autoReassignee(
              this.#candidatesFor(channelId, taskId, new Set(tried)).filter((entry) => free(entry.agentId)),
            );
          },
          command: (type, task, recipientAgentId) =>
            this.#command({ type, channelId: task.channelId, taskId: task.taskId, recipientAgentId }, "auto", () =>
              this.#unchanged(task, watch),
            ),
          judge: watch.judge,
          texts: (task) => this.#texts(task),
          load: () => {
            const limit = options.agentLimit();
            return {
              activeAgents: runningAgentCount(options.service.runningTurns()),
              agentLimit: limit.enabled ? limit.max : null,
            };
          },
          agentNameOf: (agentId) => this.#agentName(agentId),
          now,
          onFailure: (kind, channelId, taskId, cause) =>
            options.onFailure(`task reviewer ${kind} ${channelId}/${taskId}`, cause),
          ...(watch.history ? { history: watch.history } : {}),
        })
      : null;
    // A stop that the app did not send is a person's: the task reviewer never touches that task. The
    // ids that the app sent tell it, not the text of the id, which a client of the Team API chooses.
    options.service.channels.observeCommands((command) =>
      this.#stops.note(command, this.#ownOperations.has(command.operationId)),
    );
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#look(), TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const pending of this.#undo.values()) clearTimeout(pending.timer);
    this.#undo.clear();
  }

  /**
   * The parts of the load snapshot that this class owns. The count and the list come from one read of
   * the running turns, so the number of the ring and the rows of the panel cannot disagree.
   */
  overview(): {
    running: RunningWork[];
    activeAgents: number;
    waiting: WaitingWork[];
    stopped: StoppedWork[];
    stoppedTotal: number;
    recovery: AutoRecoveryState;
    agentLimit: AgentLimitPreference;
    taskWatch: TaskWatchState;
  } {
    const preference = this.#options.preference();
    const turns = this.#options.service.runningTurns();
    const agentLimit = this.#options.agentLimit();
    const channels = this.#channelInputs();
    return {
      running: this.#withQuiet(this.#running(turns)),
      activeAgents: runningAgentCount(turns),
      waiting: agentLimit.enabled ? this.#waiting() : [],
      agentLimit,
      stopped: this.#stoppedRows(channels),
      stoppedTotal: countStoppedWork(channels),
      recovery: { ...preference, recent: this.#recovery.recent() },
      taskWatch: this.#taskWatchState(),
    };
  }

  /** Stops one run: a channel run through its channel, a chat turn through the agent. Answers whether a stop was sent. */
  async stopWork(input: StopWorkInput): Promise<boolean> {
    if (input.channelId !== null && input.taskId !== null) {
      const tasks = this.#options.service.channels.store.tasks(input.channelId);
      const top = topActiveTask(tasks, input.taskId);
      if (!top) return false;
      await this.#command({ type: "stop", channelId: input.channelId, taskId: top, recipientAgentId: null }, "person");
      return true;
    }
    await Effect.runPromise(this.#options.service.interrupt(input.agentId, input.turnId));
    return true;
  }

  /** Starts stopped work again. Only a task that is stopped now is touched; any other id is ignored. */
  async resumeStopped(input: ResumeStoppedWorkInput): Promise<number> {
    const rows = this.#stoppedRows();
    const wanted =
      "all" in input
        ? rows
        : rows.filter((row) =>
            input.items.some((item) => item.channelId === row.channelId && item.taskId === row.taskId),
          );
    let started = 0;
    for (const row of wanted.slice(0, LOAD_WORK_LIST_LIMIT)) {
      try {
        await this.#command(
          { type: "resume", channelId: row.channelId, taskId: row.taskId, recipientAgentId: null },
          "person",
        );
        started += 1;
      } catch (cause) {
        this.#options.onFailure(`resume ${row.channelId}/${row.taskId}`, cause);
      }
    }
    return started;
  }

  /** Gives one stopped task to another agent. The agent has to be one the panel offered for that task. */
  async reassignStopped(input: ReassignStoppedWorkInput): Promise<boolean> {
    const row = this.#stoppedRows().find(
      (entry) => entry.channelId === input.channelId && entry.taskId === input.taskId,
    );
    if (!row?.candidates.some((candidate) => candidate.agentId === input.recipientAgentId)) return false;
    await this.#command(
      {
        type: "reassign",
        channelId: input.channelId,
        taskId: input.taskId,
        recipientAgentId: input.recipientAgentId,
      },
      "person",
    );
    return true;
  }

  /**
   * The stopped work page: every stopped run, up to `STOPPED_WORK_PAGE_LIMIT`, with what posted it and
   * whether what it belongs to was deleted. One read of each channel serves all of its rows.
   */
  listStopped(): StoppedWorkList {
    const channels = this.#channelInputs();
    const agents = this.#agents();
    const runs = stoppedRuns(channels, STOPPED_WORK_PAGE_LIMIT);
    const origins = new Map<string, ReadonlyMap<string, { routineName: string; exists: boolean }>>();
    const duplicates = new Map<string, Set<string>>();
    const members = new Map<string, MemberInfo[]>();
    for (const channel of channels) {
      if (channel.archived) continue;
      const requests = [
        ...new Set(runs.filter((run) => run.channel.id === channel.id).map((run) => run.task.requestMessageId)),
      ];
      if (!requests.length) continue;
      origins.set(channel.id, this.#options.requestOrigins?.(channel.id, requests) ?? new Map());
      duplicates.set(channel.id, duplicateStoppedTasks(channel.tasks));
      members.set(channel.id, this.#members(channel.id, agents));
    }
    const items = runs.map((run): StoppedWorkEntry => {
      const { channel, task } = run;
      const origin = origins.get(channel.id)?.get(task.requestMessageId) ?? null;
      const row = stoppedRow(run, (agentId) => agents.get(agentId)?.name ?? null);
      return {
        ...row,
        ...this.#enrich(channel.id, task, members.get(channel.id) ?? [], agents),
        topicId: task.topicId ?? null,
        agentId: task.ownerAgentId,
        origin: origin ? "routine" : "request",
        routineName: origin?.routineName ?? null,
        orphan: this.#orphan(run, {
          routineDeleted: origin !== null && !origin.exists,
          agentDeleted: task.ownerAgentId !== null && !agents.has(task.ownerAgentId),
          duplicate: duplicates.get(channel.id)?.has(task.id) ?? false,
        }),
      };
    });
    return {
      items,
      total: countStoppedWork(channels),
      agents: [...agents.values()].map(({ id, name, title, provider, model }) => ({
        id,
        name,
        title,
        provider,
        model,
      })),
      channels: [...members].map(([id, list]) => ({ id, memberIds: list.map((member) => member.agentId) })),
    };
  }

  /**
   * One action of the stopped work page on many rows. Each row is done or refused on its own, so one
   * refusal does not stop the others, and the answer says which ones failed and why. Only a row that is
   * stopped now is touched. A removal closes the runs of each channel in one write, and can be undone
   * for `STOPPED_WORK_UNDO_MS`.
   */
  async bulkStopped(input: StoppedWorkBulkInput): Promise<StoppedWorkBulkResult> {
    const failed: StoppedWorkBulkResult["failed"] = [];
    const fail = (item: StoppedWorkItem, reason: StoppedWorkFailure) =>
      failed.push({ channelId: item.channelId, taskId: item.taskId, reason });
    let done = 0;
    let undoId: string | null = null;
    const changedAgents: string[] = [];
    if (input.action === "undo") {
      const pending = this.#undo.get(input.undoId);
      if (!pending) {
        return { done, failed, undoId, agents: changedAgents, list: this.listStopped() };
      }
      clearTimeout(pending.timer);
      this.#undo.delete(input.undoId);
      for (const [channelId, previous] of pending.previous) {
        try {
          await Effect.runPromise(this.#options.service.channels.reopenClosed(channelId, previous));
        } catch (cause) {
          this.#options.onFailure(`undo removal ${channelId}`, cause);
        }
      }
      const stoppedNow = new Set(this.#stoppedKeys());
      for (const item of pending.items) {
        if (stoppedNow.has(itemKey(item))) done += 1;
        else fail(item, "expired");
      }
      return { done, failed, undoId, agents: changedAgents, list: this.listStopped() };
    }
    const items = uniqueItems(input.items);
    const stoppedNow = new Set(this.#stoppedKeys());
    const wanted = items.filter((item) => {
      if (stoppedNow.has(itemKey(item))) return true;
      fail(item, "gone");
      return false;
    });
    if (input.action === "remove") {
      const previous = new Map<string, ChannelTask[]>();
      const removed: StoppedWorkItem[] = [];
      for (const [channelId, group] of groupByChannel(wanted)) {
        try {
          const result = await Effect.runPromise(
            this.#options.service.channels.closeStopped(
              channelId,
              group.map((item) => item.taskId),
            ),
          );
          if (result.previous.length) previous.set(channelId, result.previous);
          for (const taskId of result.closed) removed.push({ channelId, taskId });
          for (const refusal of result.refused) fail({ channelId, taskId: refusal.taskId }, refusal.reason);
        } catch (cause) {
          this.#options.onFailure(`remove ${channelId}`, cause);
          for (const item of group) fail(item, "failed");
        }
      }
      done = removed.length;
      if (previous.size) {
        undoId = randomUUID();
        const id = undoId;
        const timer = setTimeout(() => this.#undo.delete(id), STOPPED_WORK_UNDO_MS);
        timer.unref();
        this.#undo.set(id, { previous, items: removed, timer });
      }
    } else if (input.action === "resume") {
      for (const item of wanted) {
        try {
          await this.#command({ type: "resume", ...item, recipientAgentId: null }, "person");
          done += 1;
        } catch (cause) {
          this.#options.onFailure(`resume ${item.channelId}/${item.taskId}`, cause);
          fail(item, "failed");
        }
      }
    } else if (input.action === "reassign") {
      const agents = this.#agents();
      const members = new Map<string, MemberInfo[]>();
      const taskOf = this.#taskReader();
      for (const item of wanted) {
        let list = members.get(item.channelId);
        if (!list) {
          list = this.#members(item.channelId, agents);
          members.set(item.channelId, list);
        }
        const task = taskOf(item);
        const member = list.find((entry) => entry.agentId === input.recipientAgentId);
        if (!task || !member?.available || task.ownerAgentId === input.recipientAgentId) {
          fail(item, "not-member");
          continue;
        }
        try {
          await this.#command({ type: "reassign", ...item, recipientAgentId: input.recipientAgentId }, "person");
          done += 1;
        } catch (cause) {
          this.#options.onFailure(`reassign ${item.channelId}/${item.taskId}`, cause);
          fail(item, "failed");
        }
      }
    } else if (input.action === "model") {
      // The model belongs to the agent: each agent that had a selected row changes once, for all its work.
      const setModel = this.#options.setAgentModel;
      const owners = new Map<string, StoppedWorkItem[]>();
      const agents = this.#agents();
      const taskOf = this.#taskReader();
      for (const item of wanted) {
        const owner = taskOf(item)?.ownerAgentId ?? null;
        if (owner === null || !agents.has(owner)) {
          fail(item, "no-agent");
          continue;
        }
        const group = owners.get(owner);
        if (group) group.push(item);
        else owners.set(owner, [item]);
      }
      for (const [agentId, group] of owners) {
        try {
          if (!setModel) throw new Error("This process cannot change the model of an agent.");
          await setModel(agentId, input.provider, input.model);
          done += group.length;
          changedAgents.push(this.#agentName(agentId) ?? agentId);
        } catch (cause) {
          this.#options.onFailure(`model ${agentId}`, cause);
          for (const item of group) fail(item, "failed");
        }
      }
    }
    return { done, failed, undoId, agents: changedAgents, list: this.listStopped() };
  }

  /** One look of the automatic recovery, then of the task reviewer, for the timer and for a test. */
  tick(): Promise<void> {
    return this.#look();
  }

  async #look(): Promise<void> {
    await this.#recovery.tick();
    await this.#watch?.tick();
  }

  /**
   * Sends one command to a channel. A command of the app keeps its operation id in `#ownOperations`
   * until it applies, so the observer of the commands tells it from a person's. `stillDue` runs when
   * the command's turn in the channel queue comes: false drops it. Answers whether it applied.
   */
  async #command(
    command: WorkCommand,
    origin: "person" | "auto",
    stillDue: () => boolean = () => true,
  ): Promise<boolean> {
    const { channels } = this.#options.service;
    let applied = false;
    const operationId = `${origin === "auto" ? AUTO_OPERATION_PREFIX : "work:"}${randomUUID()}`;
    if (origin === "auto") this.#ownOperations.add(operationId);
    try {
      await Effect.runPromise(
        channels.command({ ...command, operationId }, this.#options.channelActor(), (queued: ChannelCommand) => {
          applied = stillDue();
          return applied ? queued : null;
        }),
      );
    } finally {
      this.#ownOperations.delete(operationId);
    }
    return applied;
  }

  #watchActive(): boolean {
    return this.#watch?.active() ?? false;
  }

  #taskWatchState(): TaskWatchState {
    const watch = this.#options.taskWatch;
    return {
      ...(watch?.preference() ?? DEFAULT_TASK_WATCH_PREFERENCE),
      active: this.#watchActive(),
      modelReady: watch?.judge?.ready() ?? false,
      recent: this.#watch?.recent() ?? [],
      waits: this.#watch?.waits() ?? [],
    };
  }

  /** While the task reviewer looks, each run that gives no sign shows its minutes with no sign. */
  #withQuiet(rows: RunningWork[]): RunningWork[] {
    const watch = this.#options.taskWatch;
    if (!watch || !this.#watchActive()) return rows;
    const now = (this.#options.now ?? Date.now)();
    const thresholdMs = watch.preference().quietMinutes * 60_000;
    return rows.map((row) => {
      if (row.channelId === null || row.taskId === null) return row;
      const signals = watch.signals(row.agentId);
      if (signals.waitsOnPerson) return row;
      const quiet = runningQuiet(Date.parse(row.startedAt), signals.lastEventAt, now, thresholdMs, signals.stepOpen);
      return quiet ? { ...row, quiet } : row;
    });
  }

  /**
   * The channel tasks that the task reviewer watches: runs and requests of channels that are not
   * archived, and the stopped rows with a failed start, each with the reason to leave it alone. A
   * request counts only when the drain would start it now (`ChannelService.queuedHolds`). It also
   * forgets the tries of each task that completed.
   */
  #observe(watch: WorkControlTaskWatchOptions): WatchObservation[] {
    const { service } = this.#options;
    const { channels } = service;
    const turns = service.runningTurns();
    const agents = this.#agents();
    const runningAgents = new Set(turns.map((turn) => turn.agentId));
    const queueHolds = channels.queuedHolds();
    // The start of the turn of each agent in each tab: an agent can run a turn in several tabs at once.
    const turnStarts = new Map<string, number>();
    for (const turn of turns) {
      const context = channels.store.contextOfThread(turn.threadId);
      if (!context) continue;
      const key = `${context.channelId}\u0000${context.topicId}\u0000${turn.agentId}`;
      const startedAt = Date.parse(turn.startedAt);
      turnStarts.set(key, Math.min(turnStarts.get(key) ?? startedAt, startedAt));
    }
    const slotWaiting = new Set(service.slotWaitingAgents());
    const lane = channels.laneSnapshot();
    // The lane holds a waiting channel while another one works, or while another one is next. The
    // first of the waiting channels is next (`nextLaneChannel`): it is not held when none works.
    const laneHeld = new Set(
      lane.enabled ? lane.queued.filter((_id, index) => lane.running.length > 0 || index > 0) : [],
    );
    const memory = watch.memoryLevel();
    const limit = this.#options.agentLimit();
    const limitReached = limit.enabled && runningAgentCount(turns) >= limit.max;
    // One read of each channel. Archived channels are not watched, as the panel does not list them.
    const open = channels.store.ids().flatMap((id) => {
      if (!channels.store.exists(id)) return [];
      const channel = channels.store.get(id);
      return channel.archived ? [] : [{ id, name: channel.name, archived: false, tasks: channels.store.tasks(id) }];
    });
    // A failed start counts by the stopped runs: the root of a run when the root stopped. All of them,
    // not only the rows that the panel lists.
    const startFailed = new Set(
      stoppedRuns(
        open.map((channel) => ({ ...channel, topicName: () => null })),
        Number.POSITIVE_INFINITY,
      )
        .filter((run) => run.task.error === CHANNEL_START_FAILED)
        .map((run) => `${run.channel.id}\u0000${run.task.id}`),
    );
    const observations: WatchObservation[] = [];
    for (const { id: channelId, name: channelName, tasks } of open) {
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const parentOf = (taskId: string) => byId.get(taskId)?.parentTaskId ?? null;
      const assignments = channels.store.assignments(channelId);
      const working = new Map(
        assignments
          .filter((assignment) => assignment.state === "starting" || assignment.state === "running")
          .map((assignment) => [assignment.taskId, assignment.agentId]),
      );
      const ownAssignment = new Map(
        assignments
          .filter((assignment) => ACTIVE_ASSIGNMENT_STATES.has(assignment.state))
          .map((assignment) => [assignment.taskId, assignment.id]),
      );
      // The tasks with a task below them that is not done: a resume of one would start that work again.
      const busyAbove = new Set<string>();
      for (const task of tasks) {
        if (task.state !== "queued" && task.state !== "running" && task.state !== "waiting") continue;
        let parent = task.parentTaskId;
        for (let depth = 0; parent !== null && depth < 64; depth += 1) {
          busyAbove.add(parent);
          parent = parentOf(parent);
        }
      }
      for (const task of tasks) {
        if (task.state === "completed") this.#ledger.forget(channelId, task.id);
        const kind =
          task.state === "running"
            ? "running"
            : task.state === "queued"
              ? "queued"
              : startFailed.has(`${channelId}\u0000${task.id}`)
                ? "start-failed"
                : null;
        if (!kind) continue;
        const agentId = kind === "running" ? (working.get(task.id) ?? null) : task.ownerAgentId;
        // A run with no active assignment has no agent to watch.
        if (kind === "running" && agentId === null) continue;
        const agent = agentId ? agents.get(agentId) : undefined;
        const signals = agentId ? watch.signals(agentId) : { lastEventAt: null, waitsOnPerson: false, stepOpen: false };
        // A request that the map does not list belongs to a channel that the drain does not serve now.
        const queue = kind !== "queued" ? null : queueHolds.has(task.id) ? (queueHolds.get(task.id) ?? null) : "waits";
        const hold = this.#hold({
          kind,
          person: this.#stops.covers(channelId, task.id, parentOf),
          memory,
          waitsOnPerson: signals.waitsOnPerson,
          busyBelow: busyAbove.has(task.id),
          plan: agentId !== null && channels.hooks.usageLimited?.(agentId) === true,
          lane: laneHeld.has(channelId),
          slot: limitReached || (agentId !== null && slotWaiting.has(agentId)),
          agentBusy: agentId !== null && runningAgents.has(agentId),
          queue,
        });
        observations.push({
          channelId,
          channelName,
          taskId: task.id,
          revision: task.revision,
          kind,
          agentId,
          agentName: agent?.name ?? null,
          provider: agent?.provider ?? null,
          turnStartedAt:
            kind === "running" && agentId
              ? (turnStarts.get(
                  `${channelId}\u0000${task.topicId ?? channels.store.firstTopicId(channelId)}\u0000${agentId}`,
                ) ?? null)
              : null,
          lastEventAt: kind === "running" ? signals.lastEventAt : null,
          stepOpen: kind === "running" && signals.stepOpen,
          startingAssignmentId: queue === "starting" ? (ownAssignment.get(task.id) ?? null) : null,
          hold,
        });
      }
    }
    return observations;
  }

  /** The first reason to leave a task alone, or null. See `WatchHold`. */
  #hold(state: {
    kind: WatchedTask["kind"];
    person: boolean;
    memory: "ok" | "low" | "critical";
    waitsOnPerson: boolean;
    busyBelow: boolean;
    plan: boolean;
    lane: boolean;
    slot: boolean;
    agentBusy: boolean;
    /** For a request: why the drain would not start it now (`ChannelService.queuedHolds`). */
    queue: ChannelQueueHold | null;
  }): WatchHold | null {
    if (state.person) return "person";
    // New turns wait while memory is low, so a request waits too. A run is left alone only when it is critical.
    if (state.memory === "critical" || (state.kind === "queued" && state.memory === "low")) return "memory";
    if (state.waitsOnPerson) return "attention";
    if (state.busyBelow) return "children";
    if (state.plan) return "plan";
    if (state.kind !== "queued") return null;
    // The app tries the start again itself (`start-retry.ts`): the reviewer's clock waits for it.
    if (state.queue === "retrying") return "retrying";
    if (state.lane) return "lane";
    if (state.slot) return "slot";
    // A start under way waits for its agent's queue, which `owner-busy` cannot tell from other work.
    // So it is held only while its agent runs a turn; else it has its own clock (`watchClass`).
    if (state.agentBusy || state.queue === "owner-busy") return "agent-busy";
    return state.queue === "waits" ? "waits-for-work" : null;
  }

  /** Whether a task is still what the task reviewer judged: the same state and revision, and no new sign of a run. */
  #unchanged(task: WatchedTask, watch: WorkControlTaskWatchOptions): boolean {
    const current = this.#options.service.channels.store
      .tasks(task.channelId)
      .find((entry) => entry.id === task.taskId);
    if (!current || current.revision !== task.revision) return false;
    if (task.kind === "queued") return current.state === "queued";
    if (task.kind === "start-failed") return current.state === "failed" && current.error === CHANNEL_START_FAILED;
    if (current.state !== "running") return false;
    return task.agentId === null || (watch.signals(task.agentId).lastEventAt ?? 0) <= task.lastSignAt;
  }

  /** The request of a task and the last words of its agent in the channel, raw, for the model of the Guard. */
  #texts(task: WatchedTask): { request: string; lastWords: string } {
    const { store } = this.#options.service.channels;
    const current = store.tasks(task.channelId).find((entry) => entry.id === task.taskId);
    if (!current) return { request: "", lastWords: "" };
    const topicId = current.topicId ?? store.firstTopicId(task.channelId);
    const last = store
      .messages(task.channelId, topicId, Number.MAX_SAFE_INTEGER, LAST_WORDS_MESSAGES)
      .findLast((message) => message.taskId === task.taskId && message.author.kind === "agent");
    return { request: current.instruction, lastWords: last?.message.text ?? "" };
  }

  /**
   * Whether an agent can take a task now: it runs no turn, waits for no place under the cap, holds no
   * channel assignment, and the channels find it free (no turn of its chat, no queue, no spent plan).
   * One read of the turns and the assignments serves every agent of a look.
   */
  #freeAgents(): (agentId: string) => boolean {
    const { service } = this.#options;
    const { channels } = service;
    const busy = new Set([...service.runningTurns().map((turn) => turn.agentId), ...service.slotWaitingAgents()]);
    for (const id of channels.store.ids())
      for (const assignment of channels.store.assignments(id))
        if (ACTIVE_ASSIGNMENT_STATES.has(assignment.state)) busy.add(assignment.agentId);
    return (agentId) => !busy.has(agentId) && !channels.hooks.busy(agentId);
  }

  #agents(): Map<string, AgentSummary> {
    return new Map(this.#options.service.listAgents().map((agent) => [agent.id, agent]));
  }

  #agentName(agentId: string): string | null {
    return this.#agents().get(agentId)?.name ?? null;
  }

  /** The agents whose next turn waits for a free place under the cap, by name. */
  #waiting(): WaitingWork[] {
    const agents = this.#agents();
    return this.#options.service
      .slotWaitingAgents()
      .slice(0, LOAD_WORK_LIST_LIMIT)
      .map((agentId) => ({ agentId, agentName: agents.get(agentId)?.name ?? agentId }));
  }

  #running(turns: readonly RunningTurnRecord[]): RunningWork[] {
    const { channels } = this.#options.service;
    const agents = this.#agents();
    return buildRunningWork(turns, {
      agentName: (agentId) => agents.get(agentId)?.name ?? null,
      channelOfThread: (threadId) => {
        const channelId = channels.store.channelForThread(threadId);
        if (!channelId || !channels.store.exists(channelId)) return null;
        return { id: channelId, name: channels.store.get(channelId).name };
      },
      taskOf: (channelId, agentId, turnId) => {
        const working = channels.store
          .assignments(channelId)
          .filter((assignment) => assignment.agentId === agentId && ["starting", "running"].includes(assignment.state));
        // The assignment of this turn: the agent can work in several tabs of the channel at once. A
        // start that has no turn id yet is the only other one it can be.
        const active =
          working.find((assignment) => assignment.turnId === turnId) ??
          working.find((assignment) => assignment.turnId === null);
        const task = active ? channels.store.tasks(channelId).find((entry) => entry.id === active.taskId) : undefined;
        return task ? { taskId: task.id, title: task.instruction, topicId: task.topicId ?? null } : null;
      },
      topicName: (channelId, topicId) => this.#topicName(channelId, topicId),
    });
  }

  #topicName(channelId: string, topicId: string): string | null {
    return this.#options.service.channels.store.topic(channelId, topicId)?.name ?? null;
  }

  #members(channelId: string, agents: ReadonlyMap<string, AgentSummary> = this.#agents()): MemberInfo[] {
    const { channels } = this.#options.service;
    if (!channels.store.exists(channelId)) return [];
    return channels.store.get(channelId).members.flatMap((member) => {
      const agent = agents.get(member.agentId);
      if (!agent) return [];
      const hooks = channels.hooks;
      return [
        {
          agentId: agent.id,
          name: agent.name,
          provider: agent.provider,
          model: agent.model,
          available: !hooks.hidden?.(agent.id) && !hooks.usageLimited?.(agent.id),
        },
      ];
    });
  }

  #candidatesFor(channelId: string, taskId: string, exclude: ReadonlySet<string>): ReassignCandidate[] {
    const task = this.#options.service.channels.store.tasks(channelId).find((entry) => entry.id === taskId);
    const members = this.#members(channelId);
    const owner = members.find((member) => member.agentId === task?.ownerAgentId) ?? null;
    return reassignCandidates(owner, members, exclude);
  }

  /** The channels for the stopped rows: one read of each channel and of its tasks. */
  #channelInputs(): StoppedChannelInput[] {
    const { channels } = this.#options.service;
    return channels.store.ids().flatMap((id) => {
      if (!channels.store.exists(id)) return [];
      const channel = channels.store.get(id);
      return [
        {
          id,
          name: channel.name,
          archived: channel.archived,
          tasks: channel.archived ? [] : channels.store.tasks(id),
          topicName: (topicId: string) => this.#topicName(id, topicId),
        },
      ];
    });
  }

  /** Finds a task of a row, with one read of the tasks of each channel. The reader serves one action. */
  #taskReader(): (item: StoppedWorkItem) => ChannelTask | undefined {
    const { store } = this.#options.service.channels;
    const byChannel = new Map<string, Map<string, ChannelTask>>();
    return (item) => {
      let tasks = byChannel.get(item.channelId);
      if (!tasks) {
        tasks = new Map(
          store.exists(item.channelId) ? store.tasks(item.channelId).map((task) => [task.id, task] as const) : [],
        );
        byChannel.set(item.channelId, tasks);
      }
      return tasks.get(item.taskId);
    };
  }

  /** The keys of the stopped rows now, with no limit. */
  #stoppedKeys(): string[] {
    return stoppedRuns(this.#channelInputs(), Number.POSITIVE_INFINITY).map((run) =>
      itemKey({ channelId: run.channel.id, taskId: run.task.id }),
    );
  }

  /**
   * Reassign, the state of the automatic recovery of one stopped task, and what the app does next with
   * it and when: the task reviewer for a failed start while it looks, else "Resume by itself".
   */
  #enrich(
    channelId: string,
    task: ChannelTask,
    members: readonly MemberInfo[],
    agents: ReadonlyMap<string, AgentSummary>,
  ): Pick<StoppedWork, "candidates" | "auto" | "plan"> {
    const owner = members.find((member) => member.agentId === task.ownerAgentId) ?? null;
    const recoveryOn = this.#options.preference().enabled;
    const error = task.error ?? "";
    const now = (this.#options.now ?? Date.now)();
    // While the reviewer looks, a failed start is its own, also before its first look saw it.
    const plan =
      error === CHANNEL_START_FAILED && this.#watchActive()
        ? (this.#watch?.planOf(channelId, task.id, now) ?? null)
        : this.#recovery.planOf(
            channelId,
            task.id,
            resumable(error, task.ownerAgentId !== null && !agents.has(task.ownerAgentId)),
            () => {
              const tried = new Set(this.#ledger.peek(channelId, task.id)?.tried ?? []);
              return autoReassignee(reassignCandidates(owner, members, tried)) !== null;
            },
            now,
          );
    return {
      candidates: reassignCandidates(owner, members, new Set()).map(({ agentId, name, sameModel }) => ({
        agentId,
        name,
        sameModel,
      })),
      auto: recoveryOn ? this.#recovery.statusOf(channelId, task.id) : null,
      ...(plan ? { plan } : {}),
    };
  }

  /**
   * Every stopped run of the channels that are not archived, for "Resume by itself": its channel, task,
   * reason, and whether a resume can fix it. No limit, and none of the reads that only the panel needs.
   */
  #stoppedRefs(): (StoppedRef & { reason: string })[] {
    const agents = this.#agents();
    return stoppedRuns(this.#channelInputs(), Number.POSITIVE_INFINITY).map(({ channel, task }) => ({
      channelId: channel.id,
      taskId: task.id,
      channelName: channel.name,
      agentName: task.ownerAgentId ? (agents.get(task.ownerAgentId)?.name ?? null) : null,
      reason: task.error,
      resumable: resumable(task.error, task.ownerAgentId !== null && !agents.has(task.ownerAgentId)),
    }));
  }

  /** Why a stopped run has nothing left that it belongs to. The deleted source first. */
  #orphan(
    run: StoppedRun,
    found: { routineDeleted: boolean; agentDeleted: boolean; duplicate: boolean },
  ): StoppedWorkOrphan | null {
    if (found.routineDeleted) return "routine-deleted";
    if (run.task.topicId && run.channel.topicName(run.task.topicId) === null) return "topic-deleted";
    if (found.agentDeleted) return "agent-deleted";
    return found.duplicate ? "duplicate" : null;
  }

  #stoppedRows(channels: readonly StoppedChannelInput[] = this.#channelInputs()): StoppedWork[] {
    const agents = this.#agents();
    const members = new Map<string, MemberInfo[]>();
    return buildStoppedWork(
      channels,
      (agentId) => agents.get(agentId)?.name ?? null,
      (channelId, task) => {
        let list = members.get(channelId);
        if (!list) {
          list = this.#members(channelId, agents);
          members.set(channelId, list);
        }
        return this.#enrich(channelId, task, list, agents);
      },
    );
  }
}

function itemKey(item: StoppedWorkItem): string {
  return `${item.channelId}\u0000${item.taskId}`;
}

function uniqueItems(items: readonly StoppedWorkItem[]): StoppedWorkItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupByChannel(items: readonly StoppedWorkItem[]): Map<string, StoppedWorkItem[]> {
  const groups = new Map<string, StoppedWorkItem[]>();
  for (const item of items) {
    const group = groups.get(item.channelId);
    if (group) group.push(item);
    else groups.set(item.channelId, [item]);
  }
  return groups;
}
