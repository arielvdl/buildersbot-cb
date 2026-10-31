import type { ChannelTask, RunningWork, StoppedWork, StoppedWorkCandidate } from "@openbot/contracts/ipc";
import { LOAD_WORK_LIST_LIMIT } from "@openbot/contracts/ipc";

/** The panel shows one line of the request, and the whole request when the person expands it. */
const TITLE_LIMIT = 1_000;
const REASON_LIMIT = 200;

/** One line of text: spaces collapsed, and cut with an ellipsis at `limit` characters. */
export function clipText(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/** A turn that runs now, as `AgentService.runningTurns` gives it. */
export interface RunningTurnRecord {
  turnId: string;
  agentId: string;
  threadId: string;
  startedAt: string;
}

/**
 * How many agents run now: the number of the load ring, of its panel and of its labels. An agent
 * with two turns, for example in its chat and in a channel, is one agent.
 */
export function runningAgentCount(turns: readonly { agentId: string }[]): number {
  return new Set(turns.map((turn) => turn.agentId)).size;
}

export interface RunningContext {
  /** The name of an agent, or null when it was deleted. */
  agentName(agentId: string): string | null;
  /** The channel that owns an execution thread, or null for the chat of an agent. */
  channelOfThread(threadId: string): { id: string; name: string } | null;
  /** The task that an agent works on in a channel, or null when none is found. */
  taskOf(channelId: string, agentId: string): { taskId: string; title: string; topicId: string | null } | null;
  /** The name of a tab of a channel, or null when the tab is not found. */
  topicName(channelId: string, topicId: string): string | null;
}

/** The work that runs now, each turn with where it runs. */
export function buildRunningWork(turns: readonly RunningTurnRecord[], context: RunningContext): RunningWork[] {
  return turns.slice(0, LOAD_WORK_LIST_LIMIT).map((turn): RunningWork => {
    const channel = context.channelOfThread(turn.threadId);
    const task = channel ? context.taskOf(channel.id, turn.agentId) : null;
    return {
      turnId: turn.turnId,
      agentId: turn.agentId,
      agentName: context.agentName(turn.agentId) ?? turn.agentId,
      channelId: channel?.id ?? null,
      channelName: channel?.name ?? null,
      topicName: channel && task?.topicId ? context.topicName(channel.id, task.topicId) : null,
      taskId: task?.taskId ?? null,
      title: task ? clipText(task.title, TITLE_LIMIT) : "",
      startedAt: turn.startedAt,
    };
  });
}

function stopped(task: ChannelTask): task is ChannelTask & { state: "paused" | "failed"; error: string } {
  return (task.state === "paused" || task.state === "failed") && Boolean(task.error);
}

export interface StoppedChannelInput {
  id: string;
  name: string;
  archived: boolean;
  tasks: readonly ChannelTask[];
  /** The name of a tab of this channel, or null when the tab is not found. Called only for a stopped task. */
  topicName(topicId: string): string | null;
}

/**
 * The stopped runs of the channels, one row for each run: the root when the root stopped, else the task
 * that did. This is the rule of the Continue button of a channel, and a resume of this task starts the run again.
 */
export function buildStoppedWork(
  channels: readonly StoppedChannelInput[],
  agentName: (agentId: string) => string | null,
  enrich: (
    channelId: string,
    task: ChannelTask,
  ) => { candidates: StoppedWorkCandidate[]; auto: StoppedWork["auto"] } = () => ({
    candidates: [],
    auto: null,
  }),
): StoppedWork[] {
  const rows: StoppedWork[] = [];
  for (const channel of channels) {
    if (channel.archived) continue;
    const entries = new Map<string, ChannelTask>();
    for (const task of channel.tasks) {
      if (!stopped(task)) continue;
      const known = entries.get(task.rootTaskId);
      if (!known || task.id === task.rootTaskId) entries.set(task.rootTaskId, task);
    }
    for (const task of entries.values()) {
      if (!stopped(task)) continue;
      rows.push({
        channelId: channel.id,
        channelName: channel.name,
        topicName: task.topicId ? channel.topicName(task.topicId) : null,
        taskId: task.id,
        title: clipText(task.instruction, TITLE_LIMIT),
        reason: clipText(task.error ?? "", REASON_LIMIT),
        agentName: task.ownerAgentId ? agentName(task.ownerAgentId) : null,
        state: task.state,
        ...enrich(channel.id, task),
      });
      if (rows.length >= LOAD_WORK_LIST_LIMIT) return rows;
    }
  }
  return rows;
}
