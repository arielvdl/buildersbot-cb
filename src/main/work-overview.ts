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

/** The task of each stopped run of one channel: the root when the root stopped, else the task that did. */
function stoppedRunTasks(
  tasks: readonly ChannelTask[],
): (ChannelTask & { state: "paused" | "failed"; error: string })[] {
  const entries = new Map<string, ChannelTask>();
  for (const task of tasks) {
    if (!stopped(task)) continue;
    const known = entries.get(task.rootTaskId);
    if (!known || task.id === task.rootTaskId) entries.set(task.rootTaskId, task);
  }
  return [...entries.values()].filter(stopped);
}

/** How many stopped runs the channels that are not archived have, with no limit. */
export function countStoppedWork(channels: readonly Pick<StoppedChannelInput, "archived" | "tasks">[]): number {
  let count = 0;
  for (const channel of channels) if (!channel.archived) count += stoppedRunTasks(channel.tasks).length;
  return count;
}

/**
 * The stopped root tasks of one channel that repeat a request: another root of the same request
 * completed, runs or waits, with the same agent or after the lead routed it (a stopped root with no
 * agent); or an older root of the same request with the same agent stopped too. A routine request
 * that each start of the app posted again left such roots, one for each start.
 */
export function duplicateStoppedTasks(tasks: readonly ChannelTask[]): Set<string> {
  const groups = new Map<string, ChannelTask[]>();
  for (const task of tasks) {
    if (task.id !== task.rootTaskId || task.state === "cancelled") continue;
    const group = groups.get(task.requestMessageId);
    if (group) group.push(task);
    else groups.set(task.requestMessageId, [task]);
  }
  const duplicates = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const live = group.filter((task) => task.state !== "paused" && task.state !== "failed");
    const seen = new Set<string | null>();
    for (const task of group) {
      if (task.state !== "paused" && task.state !== "failed") continue;
      const owner = task.ownerAgentId;
      if (seen.has(owner) || live.some((other) => owner === null || other.ownerAgentId === owner)) {
        duplicates.add(task.id);
      } else {
        seen.add(owner);
      }
    }
  }
  return duplicates;
}

/** A stopped run: its channel and the task of its row. */
export interface StoppedRun {
  channel: StoppedChannelInput;
  task: ChannelTask & { state: "paused" | "failed"; error: string };
}

/**
 * The stopped runs of the channels that are not archived, one for each run: the root when the root
 * stopped, else the task that did. This is the rule of the Continue button of a channel, and a resume
 * of this task starts the run again. At most `limit` runs.
 */
export function stoppedRuns(channels: readonly StoppedChannelInput[], limit: number): StoppedRun[] {
  const runs: StoppedRun[] = [];
  for (const channel of channels) {
    if (channel.archived) continue;
    for (const task of stoppedRunTasks(channel.tasks)) {
      if (runs.length >= limit) return runs;
      runs.push({ channel, task });
    }
  }
  return runs;
}

/** The fields of a stopped row that the channel and the task give. */
export function stoppedRow(
  { channel, task }: StoppedRun,
  agentName: (agentId: string) => string | null,
): Omit<StoppedWork, "candidates" | "auto"> {
  return {
    channelId: channel.id,
    channelName: channel.name,
    topicName: task.topicId ? channel.topicName(task.topicId) : null,
    taskId: task.id,
    title: clipText(task.instruction, TITLE_LIMIT),
    reason: clipText(task.error, REASON_LIMIT),
    agentName: task.ownerAgentId ? agentName(task.ownerAgentId) : null,
    state: task.state,
  };
}

/** The rows of the load panel: the first `LOAD_WORK_LIST_LIMIT` stopped runs. */
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
  return stoppedRuns(channels, LOAD_WORK_LIST_LIMIT).map((run) => ({
    ...stoppedRow(run, agentName),
    ...enrich(run.channel.id, run.task),
  }));
}
