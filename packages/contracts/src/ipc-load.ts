/**
 * The load of this computer, and the one-channel-at-a-time mode that keeps it low. The window reads
 * a snapshot of both and changes the mode; the main process owns the preference and the sampling.
 */

import { type AgentProviderId, type AgentProviderRef, isAgentProvider, isAgentProviderRef } from "./agent-providers";
import { type AgentModelId, isAgentModel } from "./ipc-agent-identity";
import { isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/** The most rows the load panel lists for work that runs, and for work that stopped. */
export const LOAD_WORK_LIST_LIMIT = 50;

/** `ok`: nothing is held. `low`: a new turn waits. `critical`: a new turn waits and idle provider threads close. */
export interface MemoryPressure {
  level: "ok" | "low" | "critical";
  /** The share of memory that macOS says is free, from 0 to 100. */
  freePercent: number;
  swapUsedMb: number;
}

function isMemoryPressure(value: unknown): value is MemoryPressure {
  return (
    isDynamicRecord(value) &&
    (value.level === "ok" || value.level === "low" || value.level === "critical") &&
    isNumber(value.freePercent) &&
    value.freePercent >= 0 &&
    value.freePercent <= 100 &&
    isNumber(value.swapUsedMb)
  );
}

/** An agent turn that runs now. A channel turn names its channel and, when it is found, its task. */
export interface RunningWork {
  turnId: string;
  agentId: string;
  agentName: string;
  channelId: string | null;
  channelName: string | null;
  /** The name of the tab of the channel that holds the task. Null when the task or its tab is not found. */
  topicName: string | null;
  taskId: string | null;
  /** The request of the task, clipped. Empty for a turn in the chat of an agent. */
  title: string;
  startedAt: string;
  /**
   * The minutes with no sign of life, when the task reviewer finds the run slow or stalled. Absent
   * while the run gives signs, and while the task reviewer is off.
   */
  quiet?: RunningWorkQuiet;
}

/** Why the task reviewer watches a run: it gave no sign of life for `minutes`. */
export interface RunningWorkQuiet {
  state: "slow" | "stalled";
  minutes: number;
}

/** An agent of the channel that can take a stopped task. The same model comes first. */
export interface StoppedWorkCandidate {
  agentId: string;
  name: string;
  sameModel: boolean;
}

/** A channel task that stopped with a reason, and that the person can start again. */
export interface StoppedWork {
  channelId: string;
  channelName: string;
  /** The name of the tab of the channel that holds the task. Null when its tab is not found. */
  topicName: string | null;
  taskId: string;
  /** The request, clipped. */
  title: string;
  /** Why it stopped, clipped. */
  reason: string;
  agentName: string | null;
  state: "paused" | "failed";
  /** The agents that can take it, for Reassign. Never the owner. */
  candidates: StoppedWorkCandidate[];
  /** What the automatic recovery does with it: it waits its turn, or it gave up after its tries. Null: it is off. */
  auto: "waiting" | "gave-up" | null;
}

/** The automatic recovery of stopped work, as it is stored and as it crosses IPC. */
export interface AutoRecoveryPreference {
  enabled: boolean;
  /** Minutes a task stays stopped before it is started again, from 5 to 1440. */
  intervalMinutes: number;
  /** After the tries on the same agent, give the task to another agent of the channel. */
  reassign: boolean;
}

export const AUTO_RECOVERY_MIN_MINUTES = 5;
export const AUTO_RECOVERY_MAX_MINUTES = 1440;
export const DEFAULT_AUTO_RECOVERY_PREFERENCE: AutoRecoveryPreference = {
  enabled: false,
  intervalMinutes: 30,
  reassign: false,
};

export function isAutoRecoveryPreference(value: unknown): value is AutoRecoveryPreference {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.enabled) &&
    isBoolean(value.reassign) &&
    isNumber(value.intervalMinutes) &&
    Number.isInteger(value.intervalMinutes) &&
    value.intervalMinutes >= AUTO_RECOVERY_MIN_MINUTES &&
    value.intervalMinutes <= AUTO_RECOVERY_MAX_MINUTES
  );
}

/** What the automatic recovery did lately. */
export interface RecoveryEvent {
  at: string;
  channelName: string;
  action: "resumed" | "reassigned" | "gave-up";
  agentName: string | null;
}

export interface AutoRecoveryState extends AutoRecoveryPreference {
  recent: RecoveryEvent[];
}

/**
 * The task reviewer ("Fiscal" in Portuguese), as it is stored and as it crosses IPC. It is
 * experimental and off by default, and it looks only while "Resume by itself" is on too. See
 * `docs/architecture/task-reviewer.md`.
 */
export interface TaskWatchPreference {
  enabled: boolean;
  /** Minutes with no sign of life before a task is slow, from 5 to 120. At twice this, it is stalled. */
  quietMinutes: number;
}

export const TASK_WATCH_MIN_MINUTES = 5;
export const TASK_WATCH_MAX_MINUTES = 120;
export const DEFAULT_TASK_WATCH_PREFERENCE: TaskWatchPreference = { enabled: false, quietMinutes: 15 };

export function isTaskWatchPreference(value: unknown): value is TaskWatchPreference {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.enabled) &&
    isNumber(value.quietMinutes) &&
    Number.isInteger(value.quietMinutes) &&
    value.quietMinutes >= TASK_WATCH_MIN_MINUTES &&
    value.quietMinutes <= TASK_WATCH_MAX_MINUTES
  );
}

/** The most actions of the task reviewer that the panel lists. */
export const TASK_WATCH_RECENT_LIMIT = 5;

/** What the task reviewer did with one task. */
export interface TaskWatchEvent {
  at: string;
  channelName: string;
  /**
   * `waited`: it gave the task more time. `resumed`: it put the task in the queue again.
   * `reassigned`: it gave the task to `agentName`. `stopped`: it stopped a run that gave no sign and
   * left it. `gave-up`: it left the task after its tries.
   */
  action: "waited" | "resumed" | "reassigned" | "stopped" | "gave-up";
  agentName: string | null;
  /** `no-sign`: a run with no sign of life. `queued`: a request that waits. `start-failed`: a start that failed again. */
  reason: "no-sign" | "queued" | "start-failed";
  /** The minutes with no sign or in the queue. Null for a failed start. */
  minutes: number | null;
  /** Who decided: the local rules, or the model of the Guard. */
  by: "local" | "model";
}

export interface TaskWatchState extends TaskWatchPreference {
  /** It looks now: its switch and "Resume by itself" are both on. */
  active: boolean;
  /** The model of the Guard can run now. False: the local rules decide alone. */
  modelReady: boolean;
  recent: TaskWatchEvent[];
}

/** The most channels the user's order holds. A longer list is cut, not refused. */
export const LOAD_LANE_ORDER_LIMIT = 500;

/** The mode as it is stored and as it crosses IPC. The order is the channels the user chose first. */
export interface LoadLanePreference {
  enabled: boolean;
  order: string[];
}

export const DEFAULT_LOAD_LANE_PREFERENCE: LoadLanePreference = { enabled: false, order: [] };

export function isLoadLanePreference(value: unknown): value is LoadLanePreference {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.enabled) &&
    Array.isArray(value.order) &&
    value.order.length <= LOAD_LANE_ORDER_LIMIT &&
    value.order.every(isIdentifier)
  );
}

/**
 * The cap on the agents that run at the same time, as it is stored and as it crosses IPC. It is off
 * until the person turns it on: then a new turn waits while `max` agents run, and starts by itself
 * when a place frees.
 */
export interface AgentLimitPreference {
  enabled: boolean;
  /** The most agents that run at the same time, from 1 to 64. */
  max: number;
}

export const AGENT_LIMIT_MIN = 1;
export const AGENT_LIMIT_MAX = 64;
export const DEFAULT_AGENT_LIMIT_PREFERENCE: AgentLimitPreference = { enabled: false, max: 10 };

export function isAgentLimitPreference(value: unknown): value is AgentLimitPreference {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.enabled) &&
    isNumber(value.max) &&
    Number.isInteger(value.max) &&
    value.max >= AGENT_LIMIT_MIN &&
    value.max <= AGENT_LIMIT_MAX
  );
}

/** An agent whose next turn waits for a free place under the cap. */
export interface WaitingWork {
  agentId: string;
  agentName: string;
}

/** The channels the lane shows: the ones that work, and the ones that wait, in start order. */
export interface LoadLaneState extends LoadLanePreference {
  running: string[];
  queued: string[];
}

export interface LoadSnapshot {
  /** When memory was last sampled, or null before the first sample. */
  sampledAt: string | null;
  /** Memory in MB: all of Builders Bot and its agents, the agents' part of it, and the computer's. */
  memory: {
    usedMb: number | null;
    agentsMb: number | null;
    totalMb: number;
    /** What macOS says about the memory, and whether new agent turns are held for it. Absent where nothing reads it. */
    pressure?: MemoryPressure;
  };
  /** Agents that run a turn now. */
  activeAgents: number;
  /** Processes the agents' providers run. */
  providerProcesses: number;
  lane: LoadLaneState;
  running: RunningWork[];
  /** The agents whose turn waits for a free place under the cap. Empty while the cap is off. */
  waiting: WaitingWork[];
  stopped: StoppedWork[];
  /**
   * How many runs stopped, also above `LOAD_WORK_LIST_LIMIT`: the ring and its tooltip count them all.
   * Absent from an older main process: `stopped` holds them all.
   */
  stoppedTotal?: number;
  recovery: AutoRecoveryState;
  agentLimit: AgentLimitPreference;
  taskWatch: TaskWatchState;
}

function isIdentifierList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= LOAD_LANE_ORDER_LIMIT && value.every(isIdentifier);
}

function isRunningWork(value: unknown): value is RunningWork {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.turnId) &&
    isIdentifier(value.agentId) &&
    isString(value.agentName) &&
    (value.channelId === null || isIdentifier(value.channelId)) &&
    (value.channelName === null || isString(value.channelName)) &&
    (value.topicName === null || isString(value.topicName)) &&
    (value.taskId === null || isIdentifier(value.taskId)) &&
    isString(value.title) &&
    isString(value.startedAt) &&
    (value.quiet === undefined || isRunningWorkQuiet(value.quiet))
  );
}

function isRunningWorkQuiet(value: unknown): value is RunningWorkQuiet {
  return (
    isDynamicRecord(value) &&
    (value.state === "slow" || value.state === "stalled") &&
    isNumber(value.minutes) &&
    Number.isInteger(value.minutes) &&
    value.minutes >= 0
  );
}

function isWaitingWork(value: unknown): value is WaitingWork {
  return isDynamicRecord(value) && isIdentifier(value.agentId) && isString(value.agentName);
}

function isStoppedWork(value: unknown): value is StoppedWork {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.channelId) &&
    isString(value.channelName) &&
    (value.topicName === null || isString(value.topicName)) &&
    isIdentifier(value.taskId) &&
    isString(value.title) &&
    isString(value.reason) &&
    (value.agentName === null || isString(value.agentName)) &&
    (value.state === "paused" || value.state === "failed") &&
    isBoundedList(value.candidates, 8, isStoppedWorkCandidate) &&
    (value.auto === null || value.auto === "waiting" || value.auto === "gave-up")
  );
}

function isStoppedWorkCandidate(value: unknown): value is StoppedWorkCandidate {
  return isDynamicRecord(value) && isIdentifier(value.agentId) && isString(value.name) && isBoolean(value.sameModel);
}

function isRecoveryEvent(value: unknown): value is RecoveryEvent {
  return (
    isDynamicRecord(value) &&
    isString(value.at) &&
    isString(value.channelName) &&
    (value.action === "resumed" || value.action === "reassigned" || value.action === "gave-up") &&
    (value.agentName === null || isString(value.agentName))
  );
}

function isAutoRecoveryState(value: unknown): value is AutoRecoveryState {
  return isAutoRecoveryPreference(value) && isDynamicRecord(value) && isBoundedList(value.recent, 5, isRecoveryEvent);
}

const TASK_WATCH_ACTIONS = [
  "waited",
  "resumed",
  "reassigned",
  "stopped",
  "gave-up",
] as const satisfies readonly TaskWatchEvent["action"][];
const TASK_WATCH_REASONS = ["no-sign", "queued", "start-failed"] as const satisfies readonly TaskWatchEvent["reason"][];

function isTaskWatchEvent(value: unknown): value is TaskWatchEvent {
  return (
    isDynamicRecord(value) &&
    isString(value.at) &&
    isString(value.channelName) &&
    isOneOf(TASK_WATCH_ACTIONS, value.action) &&
    (value.agentName === null || isString(value.agentName)) &&
    isOneOf(TASK_WATCH_REASONS, value.reason) &&
    (value.minutes === null || (isNumber(value.minutes) && Number.isInteger(value.minutes) && value.minutes >= 0)) &&
    (value.by === "local" || value.by === "model")
  );
}

export function isTaskWatchState(value: unknown): value is TaskWatchState {
  return (
    isTaskWatchPreference(value) &&
    isDynamicRecord(value) &&
    isBoolean(value.active) &&
    isBoolean(value.modelReady) &&
    isBoundedList(value.recent, TASK_WATCH_RECENT_LIMIT, isTaskWatchEvent)
  );
}

function isBoundedList<T>(value: unknown, limit: number, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= limit && value.every(guard);
}

function isBoundedWorkList<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= LOAD_WORK_LIST_LIMIT && value.every(guard);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

export function isLoadSnapshot(value: unknown): value is LoadSnapshot {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.memory) || !isDynamicRecord(value.lane)) return false;
  return (
    (value.sampledAt === null || typeof value.sampledAt === "string") &&
    isNullableNumber(value.memory.usedMb) &&
    isNullableNumber(value.memory.agentsMb) &&
    isNumber(value.memory.totalMb) &&
    (value.memory.pressure === undefined || isMemoryPressure(value.memory.pressure)) &&
    isNumber(value.activeAgents) &&
    isNumber(value.providerProcesses) &&
    isBoolean(value.lane.enabled) &&
    isIdentifierList(value.lane.order) &&
    isIdentifierList(value.lane.running) &&
    isIdentifierList(value.lane.queued) &&
    isBoundedWorkList(value.running, isRunningWork) &&
    isBoundedWorkList(value.waiting, isWaitingWork) &&
    isBoundedWorkList(value.stopped, isStoppedWork) &&
    (value.stoppedTotal === undefined ||
      (isNumber(value.stoppedTotal) && Number.isInteger(value.stoppedTotal) && value.stoppedTotal >= 0)) &&
    isAutoRecoveryState(value.recovery) &&
    isAgentLimitPreference(value.agentLimit) &&
    isTaskWatchState(value.taskWatch)
  );
}

export interface RunChannelNowInput {
  channelId: string;
}

export function isRunChannelNowInput(value: unknown): value is RunChannelNowInput {
  return isDynamicRecord(value) && isIdentifier(value.channelId);
}

/** What to stop: a turn that runs. A channel turn also names its channel and task, because a channel stops its run, not its turn. */
export interface StopWorkInput {
  turnId: string;
  agentId: string;
  channelId: string | null;
  taskId: string | null;
}

export function isStopWorkInput(value: unknown): value is StopWorkInput {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.turnId) &&
    isIdentifier(value.agentId) &&
    (value.channelId === null) === (value.taskId === null) &&
    (value.channelId === null || (isIdentifier(value.channelId) && isIdentifier(value.taskId)))
  );
}

/** Which stopped work to start again: every one the panel lists, or the ones the person picked. */
export type ResumeStoppedWorkInput = { all: true } | { items: { channelId: string; taskId: string }[] };

export function isResumeStoppedWorkInput(value: unknown): value is ResumeStoppedWorkInput {
  if (!isDynamicRecord(value)) return false;
  if (value.all === true) return Object.keys(value).length === 1;
  return (
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= LOAD_WORK_LIST_LIMIT &&
    value.items.every((item) => isDynamicRecord(item) && isIdentifier(item.channelId) && isIdentifier(item.taskId))
  );
}

/** Give one stopped task to another agent. The channel checks that the agent can take it. */
export interface ReassignStoppedWorkInput {
  channelId: string;
  taskId: string;
  recipientAgentId: string;
}

export function isReassignStoppedWorkInput(value: unknown): value is ReassignStoppedWorkInput {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.channelId) &&
    isIdentifier(value.taskId) &&
    isIdentifier(value.recipientAgentId)
  );
}

/** The most rows the stopped work page of Settings lists, and that one of its actions takes. */
export const STOPPED_WORK_PAGE_LIMIT = 2_000;
/** How long a removal of stopped work can be undone. */
export const STOPPED_WORK_UNDO_MS = 10_000;

/** What posted the request of stopped work: a routine of the channel, or a person or agent. */
export type StoppedWorkOrigin = "routine" | "request";

/**
 * Why stopped work has nothing left that it belongs to, so it can only wait for ever:
 * - `routine-deleted`: the routine that posted the request was deleted.
 * - `duplicate`: the same request has another task that completed, runs or waits, or an older one
 *   that stopped too. A routine request that each start posted again made these.
 * - `agent-deleted`: the agent that had it was deleted.
 * - `topic-deleted`: the tab that holds it was deleted.
 */
export type StoppedWorkOrphan = "routine-deleted" | "duplicate" | "agent-deleted" | "topic-deleted";

const STOPPED_WORK_ORPHANS = ["routine-deleted", "duplicate", "agent-deleted", "topic-deleted"] as const;

/** One row of the stopped work page: a row of the load panel, and what the page filters and acts on. */
export interface StoppedWorkEntry extends StoppedWork {
  topicId: string | null;
  /** The agent that had the task. Null when no agent took it, such as a request the lead could not route. */
  agentId: string | null;
  origin: StoppedWorkOrigin;
  /** The name of the routine that posted the request, for `origin: "routine"`. */
  routineName: string | null;
  orphan: StoppedWorkOrphan | null;
}

/** An agent that the page can name: the owner of a row, or an agent that Reassign can choose. */
export interface StoppedWorkAgent {
  id: string;
  name: string;
  title: string;
  provider: AgentProviderRef;
  model: string;
}

/** A channel of the rows: its members, the agents that Reassign can give its work to. */
export interface StoppedWorkChannel {
  id: string;
  memberIds: string[];
}

/** The stopped work page: every stopped run, up to `STOPPED_WORK_PAGE_LIMIT`. */
export interface StoppedWorkList {
  items: StoppedWorkEntry[];
  /** Every stopped run, also above the limit. */
  total: number;
  agents: StoppedWorkAgent[];
  channels: StoppedWorkChannel[];
}

export interface StoppedWorkItem {
  channelId: string;
  taskId: string;
}

/**
 * One action of the stopped work page on many rows. `remove` cancels each run for good (`undo` with
 * its `undoId` opens them again within `STOPPED_WORK_UNDO_MS`). `model` changes the model of each
 * agent that had a selected row: the model belongs to the agent, not to the task or the routine.
 */
export type StoppedWorkBulkInput =
  | { action: "resume" | "remove"; items: StoppedWorkItem[] }
  | { action: "reassign"; items: StoppedWorkItem[]; recipientAgentId: string }
  | { action: "model"; items: StoppedWorkItem[]; provider: AgentProviderId; model: AgentModelId }
  | { action: "undo"; undoId: string };

/**
 * Why one row was not done:
 * - `gone`: it is not stopped now, or not found.
 * - `running`: a task of its run runs; stop it first.
 * - `not-member`: the agent is not a member of its channel, is the agent that has it, or cannot take work now.
 * - `no-agent`: no agent had it, so there is no model to change.
 * - `expired`: the time to undo ended.
 * - `failed`: the channel or the agent refused the change.
 */
export type StoppedWorkFailure = "gone" | "running" | "not-member" | "no-agent" | "expired" | "failed";

const STOPPED_WORK_FAILURES = ["gone", "running", "not-member", "no-agent", "expired", "failed"] as const;

export interface StoppedWorkBulkResult {
  done: number;
  failed: { channelId: string; taskId: string; reason: StoppedWorkFailure }[];
  /** After `remove`: the id that `undo` takes, until `STOPPED_WORK_UNDO_MS` ends. */
  undoId: string | null;
  /** After `model`: the names of the agents whose model changed. */
  agents: string[];
  list: StoppedWorkList;
}

function isStoppedWorkEntry(value: unknown): value is StoppedWorkEntry {
  return (
    isStoppedWork(value) &&
    isDynamicRecord(value) &&
    (value.topicId === null || isIdentifier(value.topicId)) &&
    (value.agentId === null || isIdentifier(value.agentId)) &&
    (value.origin === "routine" || value.origin === "request") &&
    (value.routineName === null || isString(value.routineName)) &&
    (value.orphan === null || isOneOf(STOPPED_WORK_ORPHANS, value.orphan))
  );
}

function isStoppedWorkAgent(value: unknown): value is StoppedWorkAgent {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isString(value.name) &&
    isString(value.title) &&
    isAgentProviderRef(value.provider) &&
    isString(value.model)
  );
}

function isStoppedWorkChannel(value: unknown): value is StoppedWorkChannel {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    Array.isArray(value.memberIds) &&
    value.memberIds.every(isIdentifier)
  );
}

export function isStoppedWorkList(value: unknown): value is StoppedWorkList {
  return (
    isDynamicRecord(value) &&
    isBoundedList(value.items, STOPPED_WORK_PAGE_LIMIT, isStoppedWorkEntry) &&
    isNumber(value.total) &&
    Number.isInteger(value.total) &&
    value.total >= 0 &&
    Array.isArray(value.agents) &&
    value.agents.every(isStoppedWorkAgent) &&
    Array.isArray(value.channels) &&
    value.channels.every(isStoppedWorkChannel)
  );
}

function isStoppedWorkItems(value: unknown): value is StoppedWorkItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= STOPPED_WORK_PAGE_LIMIT &&
    value.every((item) => isDynamicRecord(item) && isIdentifier(item.channelId) && isIdentifier(item.taskId))
  );
}

export function isStoppedWorkBulkInput(value: unknown): value is StoppedWorkBulkInput {
  if (!isDynamicRecord(value)) return false;
  switch (value.action) {
    case "resume":
    case "remove":
      return isStoppedWorkItems(value.items);
    case "reassign":
      return isStoppedWorkItems(value.items) && isIdentifier(value.recipientAgentId);
    case "model":
      return isStoppedWorkItems(value.items) && isAgentProvider(value.provider) && isAgentModel(value.model);
    case "undo":
      return isIdentifier(value.undoId);
    default:
      return false;
  }
}

export function isStoppedWorkBulkResult(value: unknown): value is StoppedWorkBulkResult {
  return (
    isDynamicRecord(value) &&
    isNumber(value.done) &&
    Number.isInteger(value.done) &&
    value.done >= 0 &&
    Array.isArray(value.failed) &&
    value.failed.length <= STOPPED_WORK_PAGE_LIMIT &&
    value.failed.every(
      (item) =>
        isDynamicRecord(item) &&
        isIdentifier(item.channelId) &&
        isIdentifier(item.taskId) &&
        isOneOf(STOPPED_WORK_FAILURES, item.reason),
    ) &&
    (value.undoId === null || isIdentifier(value.undoId)) &&
    Array.isArray(value.agents) &&
    value.agents.every(isString) &&
    isStoppedWorkList(value.list)
  );
}
