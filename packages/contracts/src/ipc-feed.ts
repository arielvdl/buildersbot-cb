/**
 * The feed: one card for each run of an agent, on every server the app is joined to, as the main
 * process sees it. Main keeps the cards in memory (`src/main/feed/`) and sends only what changed, and
 * only to a window that shows the feed page. A card holds summaries only: the step text that the turn
 * shows already (`turn-progress`), the program name of an approval, a clipped and redacted question.
 * Never the text of a conversation, the arguments of a tool, or a secret.
 *
 * Version 1. A new field is always optional. Removing a field, making one required or changing what
 * one means needs `v: 2` and a new decoder; the version 1 decoder stays. See
 * `docs/architecture/feed.md`.
 */

import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier, isNullableBoundedString, isRequestId } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isNumber, isOneOf } from "./runtime-values";

export const FEED_CONTRACT_VERSION = 1;
/** The steps a card keeps, the newest last. Older steps count in `stepCount` only. */
export const FEED_STEP_LIMIT = 20;
/** The longest text of a step, a stop reason or an error. */
export const FEED_TEXT_LIMIT = 200;
/** The longest title of a card. */
export const FEED_TITLE_LIMIT = 140;
/** The longest label of a request that waits for the person. */
export const FEED_LABEL_LIMIT = 120;
/** The most cards the main process keeps, and the most a full read sends. */
export const FEED_SNAPSHOT_LIMIT = 5_000;
/** The most cards one delta sends. The rest go in the next delta. */
export const FEED_DELTA_LIMIT = 200;
/** The most deltas the main process sends in one second. */
export const FEED_DELTAS_PER_SECOND = 10;
/** The longest card id: a server id, an agent id and a thread id with their separators. */
export const FEED_ID_LIMIT = 512;
/** The longest name of a project, which is a section of the sidebar. */
const FEED_PROJECT_NAME_LIMIT = INPUT_LIMITS.sidebarSectionName;

/**
 * - `working`: a turn runs.
 * - `waiting`: messages wait in the queue of the agent, or the agent waits for something.
 * - `needs-you`: an approval or a question waits for the person.
 * - `stopped`: the run stopped with a reason: a stopped task, a plan limit, the task reviewer.
 * - `done`: the run ended.
 * - `failed`: the run ended with an error.
 */
export const FEED_ITEM_STATES = ["working", "waiting", "needs-you", "stopped", "done", "failed"] as const;
export type FeedItemState = (typeof FEED_ITEM_STATES)[number];

/** What a window can offer on a card. Version 1 offers only `open`; the others are for later. */
export const FEED_ACTIONS = ["open", "approve", "deny", "answer", "resume", "reassign", "stop"] as const;
export type FeedAction = (typeof FEED_ACTIONS)[number];

export const FEED_STEP_KINDS = ["progress", "status", "subtask"] as const;

export interface FeedStep {
  /** ISO time. */
  at: string;
  kind: (typeof FEED_STEP_KINDS)[number];
  /** A summary, clipped to `FEED_TEXT_LIMIT` and redacted. */
  text: string;
}

export const FEED_APPROVAL_KINDS = ["command", "file-change", "permissions"] as const;

export interface FeedNeed {
  kind: "approval" | "prompt";
  requestId: string | number;
  /** What an approval is for. Absent on a prompt. */
  approvalKind?: (typeof FEED_APPROVAL_KINDS)[number];
  /**
   * What waits, never the whole request: the kind and the program name of an approval, or the first
   * question, clipped and redacted.
   */
  label: string;
  /** A question of the Guard: a window never offers "Always allow" for it. */
  guard?: true;
  /** The questions of a prompt. */
  questionCount?: number;
  since: string;
}

/** `interrupted`: the turn was stopped before its end, by the person or by the app. */
export const FEED_STOP_SOURCES = ["stopped-work", "usage-limit", "task-watch", "error", "interrupted"] as const;

export interface FeedStop {
  /** Clipped and redacted. Empty when no reason was given. */
  reason: string;
  source: (typeof FEED_STOP_SOURCES)[number];
  /** When a plan limit resets, ISO time. */
  resetsAt?: string;
}

export interface FeedQuiet {
  state: "slow" | "stalled";
  minutes: number;
}

export interface FeedSubtasks {
  done: number;
  total: number;
}

export interface FeedItem {
  v: 1;
  /** Stable for the run: `<server>:t:<agent>:<thread>`, `<server>:task:<task>` or `<server>:q:<agent>`. */
  id: string;
  serverId: string;
  agentId: string;
  agentName: string;
  /** The sidebar section of the agent. Null: the agent is in no section. */
  projectId: string | null;
  projectName: string | null;
  threadId: string | null;
  channelId: string | null;
  taskId: string | null;
  /** The title of the task or the channel. Empty: a window names the run after its agent. */
  title: string;
  state: FeedItemState;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  lastStep: FeedStep | null;
  /** The newest `FEED_STEP_LIMIT` steps, the newest last. */
  steps: FeedStep[];
  /** Every step, also the ones that left `steps`. */
  stepCount: number;
  need: FeedNeed | null;
  stop: FeedStop | null;
  /** The task reviewer finds the run slow or stalled. */
  quiet?: FeedQuiet;
  subtasks?: FeedSubtasks;
  /** Messages that wait in the queue of the agent, for a `waiting` card. */
  queued?: number;
  actions: FeedAction[];
  /** Goes up at each change of the card. */
  revision: number;
}

export interface FeedSnapshot {
  v: 1;
  /** The cursor of the last delta that the snapshot includes. */
  cursor: number;
  items: FeedItem[];
  /** True when more cards exist than the read sends. */
  truncated: boolean;
}

/**
 * The cards that changed since the last delta. `cursor` goes up by one at each delta: a window that
 * sees a gap reads the snapshot again.
 */
export interface FeedDelta {
  v: 1;
  cursor: number;
  upserts: FeedItem[];
  removes: string[];
}

export interface FeedSnapshotInput {
  /** The most cards to send, up to `FEED_SNAPSHOT_LIMIT`. */
  limit?: number;
}

export interface FeedWatchInput {
  /** True while the window shows the feed page. Main sends deltas only to such a window. */
  watching: boolean;
}

function isIsoTime(value: unknown): value is string {
  return isBoundedString(value, 64) && value.length > 0;
}

function isCount(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isCursor(value: unknown): value is number {
  return isCount(value);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

export function isFeedStep(value: unknown): value is FeedStep {
  return (
    isDynamicRecord(value) &&
    isIsoTime(value.at) &&
    isOneOf(FEED_STEP_KINDS, value.kind) &&
    isBoundedString(value.text, FEED_TEXT_LIMIT)
  );
}

function isFeedNeed(value: unknown): value is FeedNeed {
  return (
    isDynamicRecord(value) &&
    (value.kind === "approval" || value.kind === "prompt") &&
    isRequestId(value.requestId) &&
    (value.approvalKind === undefined || isOneOf(FEED_APPROVAL_KINDS, value.approvalKind)) &&
    isBoundedString(value.label, FEED_LABEL_LIMIT) &&
    (value.guard === undefined || value.guard === true) &&
    (value.questionCount === undefined || isCount(value.questionCount)) &&
    isIsoTime(value.since)
  );
}

function isFeedStop(value: unknown): value is FeedStop {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.reason, FEED_TEXT_LIMIT) &&
    isOneOf(FEED_STOP_SOURCES, value.source) &&
    (value.resetsAt === undefined || isIsoTime(value.resetsAt))
  );
}

function isFeedQuiet(value: unknown): value is FeedQuiet {
  return isDynamicRecord(value) && (value.state === "slow" || value.state === "stalled") && isCount(value.minutes);
}

function isFeedSubtasks(value: unknown): value is FeedSubtasks {
  return isDynamicRecord(value) && isCount(value.done) && isCount(value.total) && value.done <= value.total;
}

/**
 * A version 1 card. A card of another version, an unknown state or a field over its limit is not one:
 * a decoder drops that card and keeps the others.
 */
export function isFeedItem(value: unknown): value is FeedItem {
  return (
    isDynamicRecord(value) &&
    value.v === FEED_CONTRACT_VERSION &&
    isBoundedString(value.id, FEED_ID_LIMIT) &&
    value.id.length > 0 &&
    isIdentifier(value.serverId) &&
    isIdentifier(value.agentId) &&
    isBoundedString(value.agentName, INPUT_LIMITS.agentName) &&
    isNullableIdentifier(value.projectId) &&
    isNullableBoundedString(value.projectName, FEED_PROJECT_NAME_LIMIT) &&
    isNullableIdentifier(value.threadId) &&
    isNullableIdentifier(value.channelId) &&
    isNullableIdentifier(value.taskId) &&
    isBoundedString(value.title, FEED_TITLE_LIMIT) &&
    isOneOf(FEED_ITEM_STATES, value.state) &&
    isIsoTime(value.startedAt) &&
    isIsoTime(value.updatedAt) &&
    (value.endedAt === null || isIsoTime(value.endedAt)) &&
    (value.lastStep === null || isFeedStep(value.lastStep)) &&
    Array.isArray(value.steps) &&
    value.steps.length <= FEED_STEP_LIMIT &&
    value.steps.every(isFeedStep) &&
    isCount(value.stepCount) &&
    (value.need === null || isFeedNeed(value.need)) &&
    (value.stop === null || isFeedStop(value.stop)) &&
    (value.quiet === undefined || isFeedQuiet(value.quiet)) &&
    (value.subtasks === undefined || isFeedSubtasks(value.subtasks)) &&
    (value.queued === undefined || isCount(value.queued)) &&
    Array.isArray(value.actions) &&
    value.actions.length <= FEED_ACTIONS.length &&
    value.actions.every((action) => isOneOf(FEED_ACTIONS, action)) &&
    isCount(value.revision)
  );
}

/** The envelope of a full read. Each card is checked on its own, so one bad card does not drop the rest. */
export function isFeedSnapshotEnvelope(
  value: unknown,
): value is { v: 1; cursor: number; items: unknown[]; truncated: boolean } {
  return (
    isDynamicRecord(value) &&
    value.v === FEED_CONTRACT_VERSION &&
    isCursor(value.cursor) &&
    Array.isArray(value.items) &&
    value.items.length <= FEED_SNAPSHOT_LIMIT &&
    isBoolean(value.truncated)
  );
}

/** The envelope of a delta. Each card is checked on its own, as in a full read. */
export function isFeedDeltaEnvelope(
  value: unknown,
): value is { v: 1; cursor: number; upserts: unknown[]; removes: unknown[] } {
  return (
    isDynamicRecord(value) &&
    value.v === FEED_CONTRACT_VERSION &&
    isCursor(value.cursor) &&
    Array.isArray(value.upserts) &&
    value.upserts.length <= FEED_DELTA_LIMIT &&
    Array.isArray(value.removes) &&
    value.removes.length <= FEED_SNAPSHOT_LIMIT
  );
}

export function isFeedSnapshotInput(value: unknown): value is FeedSnapshotInput {
  return (
    isDynamicRecord(value) &&
    (value.limit === undefined || (isCount(value.limit) && value.limit > 0 && value.limit <= FEED_SNAPSHOT_LIMIT))
  );
}

export function isFeedWatchInput(value: unknown): value is FeedWatchInput {
  return isDynamicRecord(value) && isBoolean(value.watching);
}

/** The id of a removed card, as a delta carries it. */
export function isFeedItemId(value: unknown): value is string {
  return isBoundedString(value, FEED_ID_LIMIT) && value.length > 0;
}
