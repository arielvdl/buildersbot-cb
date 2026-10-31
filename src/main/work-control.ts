import { randomUUID } from "node:crypto";
import type {
  AgentLimitPreference,
  AgentSummary,
  AutoRecoveryPreference,
  AutoRecoveryState,
  ChannelCommand,
  ChannelTask,
  ReassignStoppedWorkInput,
  ResumeStoppedWorkInput,
  RunningWork,
  StoppedWork,
  StopWorkInput,
  TaskWatchPreference,
  TaskWatchState,
  WaitingWork,
} from "@openbot/contracts/ipc";
import { DEFAULT_TASK_WATCH_PREFERENCE, LOAD_WORK_LIST_LIMIT } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import {
  AutoRecovery,
  autoReassignee,
  type MemberInfo,
  type ReassignCandidate,
  RecoveryLedger,
  reassignCandidates,
} from "./auto-recovery";
import {
  AUTO_OPERATION_PREFIX,
  CHANNEL_START_FAILED,
  DeliberateStops,
  runningQuiet,
  TaskWatch,
  type TaskWatchJudge,
  type WatchedTask,
  type WatchHold,
  type WatchObservation,
} from "./task-watch";
import { buildRunningWork, buildStoppedWork, type RunningTurnRecord, runningAgentCount } from "./work-overview";

const TICK_MS = 60_000;
/** The messages of a tab that the task reviewer reads back to find the agent's last words. */
const LAST_WORDS_MESSAGES = 40;

/** What the task reviewer needs besides the channels. */
export interface WorkControlTaskWatchOptions {
  preference: () => TaskWatchPreference;
  /** When the provider last sent an event for an agent, and whether the agent waits for the person. */
  signals: (agentId: string) => { lastEventAt: number | null; waitsOnPerson: boolean };
  /** What macOS says about the memory. */
  memoryLevel: () => "ok" | "low" | "critical";
  /** The model of the Guard, or null for the local rules only. */
  judge: TaskWatchJudge | null;
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
  #timer: NodeJS.Timeout | null = null;

  constructor(options: WorkControlOptions) {
    this.#options = options;
    const now = options.now ?? Date.now;
    this.#recovery = new AutoRecovery({
      preference: options.preference,
      // While the task reviewer looks, a failed start is its own: it goes to another agent sooner.
      stopped: () =>
        this.#watchActive()
          ? this.#stoppedRows().filter((row) => row.reason !== CHANNEL_START_FAILED)
          : this.#stoppedRows(),
      candidate: (channelId, taskId, tried) => {
        const row = this.#stoppedRows().find((entry) => entry.channelId === channelId && entry.taskId === taskId);
        return row ? autoReassignee(this.#candidatesFor(channelId, taskId, new Set(tried))) : null;
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
          candidate: (channelId, taskId, tried) =>
            autoReassignee(this.#candidatesFor(channelId, taskId, new Set(tried))),
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
        })
      : null;
    // A stop that the app did not send is a person's: the task reviewer never touches that task.
    options.service.channels.observeCommands((command) => this.#stops.note(command));
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#look(), TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
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
    recovery: AutoRecoveryState;
    agentLimit: AgentLimitPreference;
    taskWatch: TaskWatchState;
  } {
    const preference = this.#options.preference();
    const turns = this.#options.service.runningTurns();
    const agentLimit = this.#options.agentLimit();
    return {
      running: this.#withQuiet(this.#running(turns)),
      activeAgents: runningAgentCount(turns),
      waiting: agentLimit.enabled ? this.#waiting() : [],
      agentLimit,
      stopped: this.#stoppedRows(),
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

  /** One look of the automatic recovery, then of the task reviewer, for the timer and for a test. */
  tick(): Promise<void> {
    return this.#look();
  }

  async #look(): Promise<void> {
    await this.#recovery.tick();
    await this.#watch?.tick();
  }

  /**
   * Sends one command to a channel. The operation id tells a person's command from the app's own
   * (`AUTO_OPERATION_PREFIX`). `stillDue` runs when the command's turn in the channel queue comes:
   * false drops it. Answers whether it applied.
   */
  async #command(
    command: WorkCommand,
    origin: "person" | "auto",
    stillDue: () => boolean = () => true,
  ): Promise<boolean> {
    const { channels } = this.#options.service;
    let applied = false;
    const operationId = `${origin === "auto" ? AUTO_OPERATION_PREFIX : "work:"}${randomUUID()}`;
    await Effect.runPromise(
      channels.command({ ...command, operationId }, this.#options.channelActor(), (queued: ChannelCommand) => {
        applied = stillDue();
        return applied ? queued : null;
      }),
    );
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
      const quiet = runningQuiet(Date.parse(row.startedAt), signals.lastEventAt, now, thresholdMs);
      return quiet ? { ...row, quiet } : row;
    });
  }

  /**
   * The channel tasks that the task reviewer watches: runs and requests of channels that are not
   * archived, and the stopped rows with a failed start, each with the reason to leave it alone.
   */
  #observe(watch: WorkControlTaskWatchOptions): WatchObservation[] {
    const { service } = this.#options;
    const { channels } = service;
    const turns = service.runningTurns();
    const agents = this.#agents();
    const runningAgents = new Set(turns.map((turn) => turn.agentId));
    // The start of the turn of each agent in each channel.
    const turnStarts = new Map<string, number>();
    for (const turn of turns) {
      const channelId = channels.store.channelForThread(turn.threadId);
      if (!channelId) continue;
      const key = `${channelId}\u0000${turn.agentId}`;
      const startedAt = Date.parse(turn.startedAt);
      turnStarts.set(key, Math.min(turnStarts.get(key) ?? startedAt, startedAt));
    }
    const slotWaiting = new Set(service.slotWaitingAgents());
    const lane = channels.laneSnapshot();
    const laneHeld = new Set(lane.enabled ? lane.queued : []);
    const memory = watch.memoryLevel();
    const limit = this.#options.agentLimit();
    const limitReached = limit.enabled && runningAgentCount(turns) >= limit.max;
    // One read of each channel. Archived channels are not watched, as the panel does not list them.
    const open = channels.store.ids().flatMap((id) => {
      if (!channels.store.exists(id)) return [];
      const channel = channels.store.get(id);
      return channel.archived ? [] : [{ id, name: channel.name, archived: false, tasks: channels.store.tasks(id) }];
    });
    // A failed start counts by the rows of the panel: the root of a run when the root stopped.
    const startFailed = new Set(
      buildStoppedWork(
        open.map((channel) => ({ ...channel, topicName: () => null })),
        () => null,
      )
        .filter((row) => row.reason === CHANNEL_START_FAILED)
        .map((row) => `${row.channelId}\u0000${row.taskId}`),
    );
    const observations: WatchObservation[] = [];
    for (const { id: channelId, name: channelName, tasks } of open) {
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const parentOf = (taskId: string) => byId.get(taskId)?.parentTaskId ?? null;
      const working = new Map(
        channels.store
          .assignments(channelId)
          .filter((assignment) => assignment.state === "starting" || assignment.state === "running")
          .map((assignment) => [assignment.taskId, assignment.agentId]),
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
        const signals = agentId ? watch.signals(agentId) : { lastEventAt: null, waitsOnPerson: false };
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
            kind === "running" && agentId ? (turnStarts.get(`${channelId}\u0000${agentId}`) ?? null) : null,
          lastEventAt: kind === "running" ? signals.lastEventAt : null,
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
  }): WatchHold | null {
    if (state.person) return "person";
    // New turns wait while memory is low, so a request waits too. A run is left alone only when it is critical.
    if (state.memory === "critical" || (state.kind === "queued" && state.memory === "low")) return "memory";
    if (state.waitsOnPerson) return "attention";
    if (state.busyBelow) return "children";
    if (state.plan) return "plan";
    if (state.kind !== "queued") return null;
    if (state.lane) return "lane";
    if (state.slot) return "slot";
    return state.agentBusy ? "agent-busy" : null;
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
      taskOf: (channelId, agentId) => {
        const active = channels.store
          .assignments(channelId)
          .find((assignment) => assignment.agentId === agentId && ["starting", "running"].includes(assignment.state));
        const task = active ? channels.store.tasks(channelId).find((entry) => entry.id === active.taskId) : undefined;
        return task ? { taskId: task.id, title: task.instruction, topicId: task.topicId ?? null } : null;
      },
      topicName: (channelId, topicId) => this.#topicName(channelId, topicId),
    });
  }

  #topicName(channelId: string, topicId: string): string | null {
    return this.#options.service.channels.store.topic(channelId, topicId)?.name ?? null;
  }

  #members(channelId: string): MemberInfo[] {
    const { channels } = this.#options.service;
    const agents = this.#agents();
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

  #stoppedRows(): StoppedWork[] {
    const { channels } = this.#options.service;
    const agents = this.#agents();
    const inputs = channels.store.ids().flatMap((id) => {
      if (!channels.store.exists(id)) return [];
      const channel = channels.store.get(id);
      return [
        {
          id,
          name: channel.name,
          archived: channel.archived,
          tasks: channels.store.tasks(id),
          topicName: (topicId: string) => this.#topicName(id, topicId),
        },
      ];
    });
    return buildStoppedWork(
      inputs,
      (agentId) => agents.get(agentId)?.name ?? null,
      (channelId, task) => ({
        candidates: this.#candidatesFor(channelId, task.id, new Set()).map(({ agentId, name, sameModel }) => ({
          agentId,
          name,
          sameModel,
        })),
        auto: this.#options.preference().enabled ? this.#recovery.statusOf(channelId, task.id) : null,
      }),
    );
  }
}
