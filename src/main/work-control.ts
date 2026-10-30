import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentSummary,
  AutoRecoveryPreference,
  AutoRecoveryState,
  ChannelTask,
  ReassignStoppedWorkInput,
  ResumeStoppedWorkInput,
  RunningWork,
  StoppedWork,
  StopWorkInput,
} from "@openbot/contracts/ipc";
import { LOAD_WORK_LIST_LIMIT } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import {
  AutoRecovery,
  autoReassignee,
  type MemberInfo,
  type ReassignCandidate,
  reassignCandidates,
} from "./auto-recovery";
import { ActiveTurnTracker, buildRunningWork, buildStoppedWork } from "./work-overview";

const TICK_MS = 60_000;

export interface WorkControlOptions {
  service: Pick<AgentService, "listAgents" | "channels" | "interrupt">;
  channelActor: () => { id: string; name: string };
  preference: () => AutoRecoveryPreference;
  onFailure: (action: string, cause: unknown) => void;
  now?: () => number;
}

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
 * It reads the channels each time it is asked, so it holds nothing that could go stale.
 */
export class WorkControl {
  readonly #options: WorkControlOptions;
  readonly #turns = new ActiveTurnTracker();
  readonly #recovery: AutoRecovery;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: WorkControlOptions) {
    this.#options = options;
    this.#recovery = new AutoRecovery({
      preference: options.preference,
      stopped: () => this.#stoppedRows().map((row) => row),
      candidate: (channelId, taskId, tried) => {
        const row = this.#stoppedRows().find((entry) => entry.channelId === channelId && entry.taskId === taskId);
        return row ? autoReassignee(this.#candidatesFor(channelId, taskId, new Set(tried))) : null;
      },
      resume: (channelId, taskId) => this.#command({ type: "resume", channelId, taskId, recipientAgentId: null }),
      reassign: (channelId, taskId, recipientAgentId) =>
        this.#command({ type: "reassign", channelId, taskId, recipientAgentId }),
      agentNameOf: (agentId) => this.#agentName(agentId),
      now: options.now ?? Date.now,
      onFailure: (kind, channelId, taskId, cause) => options.onFailure(`${kind} ${channelId}/${taskId}`, cause),
    });
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#recovery.tick(), TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  observeAgentEvent(event: AgentEvent): void {
    this.#turns.observe(event);
  }

  /** The three parts of the load snapshot that this class owns. */
  overview(): { running: RunningWork[]; stopped: StoppedWork[]; recovery: AutoRecoveryState } {
    const preference = this.#options.preference();
    return {
      running: this.#running(),
      stopped: this.#stoppedRows(),
      recovery: { ...preference, recent: this.#recovery.recent() },
    };
  }

  /** Stops one run: a channel run through its channel, a chat turn through the agent. Answers whether a stop was sent. */
  async stopWork(input: StopWorkInput): Promise<boolean> {
    if (input.channelId !== null && input.taskId !== null) {
      const tasks = this.#options.service.channels.store.tasks(input.channelId);
      const top = topActiveTask(tasks, input.taskId);
      if (!top) return false;
      await this.#command({ type: "stop", channelId: input.channelId, taskId: top, recipientAgentId: null });
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
        await this.#command({ type: "resume", channelId: row.channelId, taskId: row.taskId, recipientAgentId: null });
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
    await this.#command({
      type: "reassign",
      channelId: input.channelId,
      taskId: input.taskId,
      recipientAgentId: input.recipientAgentId,
    });
    return true;
  }

  /** One look of the automatic recovery, for the timer and for a test. */
  tick(): Promise<void> {
    return this.#recovery.tick();
  }

  #command(command: {
    type: "stop" | "resume" | "reassign";
    channelId: string;
    taskId: string;
    recipientAgentId: string | null;
  }): Promise<void> {
    const { channels } = this.#options.service;
    return Effect.runPromise(
      channels.command({ ...command, operationId: `work:${randomUUID()}` }, this.#options.channelActor()),
    ).then(() => undefined);
  }

  #agents(): Map<string, AgentSummary> {
    return new Map(this.#options.service.listAgents().map((agent) => [agent.id, agent]));
  }

  #agentName(agentId: string): string | null {
    return this.#agents().get(agentId)?.name ?? null;
  }

  #running(): RunningWork[] {
    const { channels } = this.#options.service;
    const agents = this.#agents();
    return buildRunningWork(this.#turns.list(), {
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
        return task ? { taskId: task.id, title: task.instruction } : null;
      },
    });
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
      return [{ id, name: channel.name, archived: channel.archived, tasks: channels.store.tasks(id) }];
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
