import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { type ConversationMessage, isConversationMessage } from "./ipc-conversation-messages";
import { optionalHistoryExtent } from "./ipc-decoding";
import { isStartRetryView, type StartRetryView } from "./ipc-start-retry-view";
import { type DynamicRecord, isDynamicRecord, isOneOf, isString } from "./runtime-values";

export const CHANNEL_CHATS_CAPABILITY = "channel-chats-v1";
export const CHANNEL_DELETE_CAPABILITY = "channel-delete-v1";
/**
 * The id a channel row carries for the reader, and for its own author, while no account is signed
 * in. The person behind it does not change when they sign in, so their read cursors follow them and
 * their own messages stay their own in the transcript.
 */
export const SIGNED_OUT_CHANNEL_MEMBER_ID = "local";
export const CHANNEL_PARALLEL_LIMIT = 2;
/**
 * The parallel conversations of one channel, as tabs beside each other. A tab has its own messages,
 * its own work and its own agent sessions; the channel's memory, members and lead are the same in
 * every one of them, which is the reason to have tabs rather than a second channel.
 */
export const CHANNEL_TOPICS_CAPABILITY = "channel-topics-v1";
/** The most tabs a channel holds. */
export const CHANNEL_TOPIC_LIMIT = 12;
/** The name of the tab every channel starts with. It is not translated: it is a saved name. */
export const CHANNEL_DEFAULT_TOPIC_NAME = "Main";
export const CHANNEL_ASSIGNMENT_LIMIT = 8;

export interface ChannelMember {
  agentId: string;
}

export interface ChannelDraft {
  name: string;
  title: string;
  instructions: string;
  members: ChannelMember[];
  leadAgentId: string | null;
}

export interface Channel extends ChannelDraft {
  id: string;
  archived: boolean;
  revision: number;
  createdAt: string;
}

export type ChannelTaskState = "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";

/** One conversation of a channel, shown as a tab. */
export interface ChannelTopic {
  id: string;
  channelId: string;
  name: string;
  createdAt: string;
  revision: number;
  /**
   * When the tab last changed: its newest message, or its creation for a tab nobody wrote in. In a
   * channel summary only, for the tab list's age.
   */
  updatedAt?: string;
  /** Counted for a channel summary only, against this tab's own read cursor. Absent elsewhere. */
  unreadCount?: number;
  /** Its running tasks, in a channel summary only. */
  activeTasks?: number;
  /** Its queued, waiting and running tasks, in a channel summary only. */
  openTasks?: number;
  /** The messages a person would see in it, in a channel summary only; 0 means nothing to lose. */
  messageCount?: number;
  /**
   * The first message with text that a person sent in the tab, cut to an excerpt, in a channel
   * summary only. It stays after a rename. Empty when nobody wrote; absent from an older host.
   */
  firstMessage?: string;
  /** The last message with text that a person sent in the tab, as `firstMessage` is. */
  lastUserMessage?: string;
}

export interface ChannelTask {
  id: string;
  channelId: string;
  /** The tab the task belongs to. Like a message, it is written by the store and optional here. */
  topicId?: string;
  parentTaskId: string | null;
  rootTaskId: string;
  ownerAgentId: string | null;
  requestMessageId: string;
  instruction: string;
  attachmentDraftIds: string[];
  expectedResult: string;
  sourceMessageIds: string[];
  dependencies: string[];
  resources: string[];
  state: ChannelTaskState;
  revision: number;
  assignmentCount: number;
  error: string | null;
  /**
   * The provider did not start the task, and the app tries again. Absent otherwise. The channel shows
   * it in place of the card of a stopped task.
   */
  startRetry?: StartRetryView;
  /** For a start that failed after its tries: how many starts ran. Absent otherwise. */
  startAttempts?: number;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  /**
   * The tab the message belongs to. The store always writes one; it is optional here because a
   * fixture, and a message stored before tabs, can arrive without it.
   */
  topicId?: string;
  sequence: number;
  author: { kind: "member" | "agent" | "coordinator"; id: string; name: string };
  taskId: string | null;
  superseded: boolean;
  message: ConversationMessage;
}

/** One ellipsised sidebar line: enough to preview a channel, never a whole message body. */
export interface ChannelPreview {
  authorName: string;
  /** Who wrote it. Absent from a host without channel-attention-v1. */
  author?: { kind: ChannelMessage["author"]["kind"]; id: string };
  /** Whether it is still streaming. Absent from a host without channel-attention-v1. */
  status?: ConversationMessage["status"];
  text: string;
  at: string;
}

/** The execution thread of one member agent in a channel. A prompt on it belongs to the channel. */
export interface ChannelThread {
  agentId: string;
  threadId: string;
}

export const CHANNEL_PREVIEW_LIMIT = 160;

export interface ChannelSummary extends Channel {
  unreadCount: number;
  activeTasks: number;
  /** Its queued, waiting and running tasks; `activeTasks` counts only running ones. Absent from a host without channel-attention-v1. */
  openTasks?: number;
  lastMessage: ChannelPreview | null;
  /** One for each member agent that has worked here. Absent from a host without channel-attention-v1. */
  threads?: ChannelThread[];
  /** The tabs of the channel, in the order they were made. Absent from a host without channel-topics-v1. */
  topics?: ChannelTopic[];
}

export interface ChannelPage {
  channel: Channel;
  /** The tab this page is of. */
  topicId: string;
  messages: ChannelMessage[];
  tasks: ChannelTask[];
  olderCursor: number | null;
  throughSequence: number;
  /** As in `ConversationPageInfo`: the unloaded length, for the scroll rail. Absent from a remote host. */
  olderCount?: number;
  oldestAt?: string;
}

export type ChannelCommand =
  | {
      type: "save";
      operationId: string;
      channelId: string;
      draft: ChannelDraft;
      /**
       * The save edits a channel that the sender has open. A save without it creates the channel
       * when its id is unknown, which is how a channel is made, and how every released client
       * still saves. Settings save on every field and a save can arrive after a deletion, so the
       * settings panel sets this and the service refuses to bring the channel back.
       */
      update?: boolean;
    }
  | { type: "restore"; operationId: string; channelId: string }
  | { type: "archive"; operationId: string; channelId: string }
  | {
      type: "send";
      operationId: string;
      channelId: string;
      text: string;
      recipientAgentId: string | null;
      replyToMessageId: string | null;
      attachmentDraftIds: string[];
      /** The tab to write in. Absent writes in the first tab, which is what a client without tabs sends. */
      topicId?: string | undefined;
    }
  | {
      /**
       * A routine firing into the channel. It is a `send` without the continuation heuristic: a
       * schedule must start its own task rather than fold itself into whatever a member is doing.
       * The `requestMessageId` is minted by the caller and persisted on its run row before the
       * command is issued, so a replay after a crash lands on the same message.
       */
      type: "request";
      operationId: string;
      channelId: string;
      text: string;
      recipientAgentId: string | null;
      requestMessageId: string;
      topicId?: string | undefined;
      origin: { kind: "routine"; routineId: string; routineName: string; runId: string };
    }
  | {
      type: "stop" | "resume" | "reassign";
      operationId: string;
      channelId: string;
      taskId: string;
      recipientAgentId: string | null;
    }
  | { type: "read"; operationId: string; channelId: string; topicId?: string; throughSequence: number }
  | { type: "topic-create"; operationId: string; channelId: string; topicId: string; name?: string | undefined }
  | { type: "topic-rename"; operationId: string; channelId: string; topicId: string; name: string }
  /** Deletes a tab with its messages and work. The last tab of a channel cannot go. */
  | { type: "topic-delete"; operationId: string; channelId: string; topicId: string };

export interface ChannelReadInput {
  channelId: string;
  /** The tab to read. Absent reads the first tab, which is what a client without topics sends. */
  topicId?: string | undefined;
  beforeSequence?: number | undefined;
}

/**
 * A channel used to hold one `purpose`. It now holds a `title` and `instructions`, the way an agent
 * does, and the guards below are strict about both - so every row written before the rename has to
 * pass through here on the way in. This is the only place that knows the old key: the store reads
 * `channel_json` through `decodeChannel` (`channel-store.ts`), and a strict guard at the call sites
 * would make every one of those rows unreadable instead.
 */
export function normalizeChannelDraft(value: unknown): DynamicRecord | undefined {
  if (!isDynamicRecord(value)) return undefined;
  if (!("purpose" in value)) return value;
  const { purpose, ...rest } = value;
  return { title: "", instructions: isString(purpose) ? purpose : "", ...rest };
}

export function isChannelDraft(value: unknown): value is ChannelDraft {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    value.name.trim().length > 0 &&
    isBoundedString(value.title, INPUT_LIMITS.agentTitle) &&
    isBoundedString(value.instructions, INPUT_LIMITS.agentDescription) &&
    Array.isArray(value.members) &&
    value.members.length <= INPUT_LIMITS.agents &&
    value.members.every(isChannelMember) &&
    new Set(value.members.map((member) => member.agentId)).size === value.members.length &&
    (value.leadAgentId === null ||
      (isIdentifier(value.leadAgentId) && value.members.some((member) => member.agentId === value.leadAgentId)))
  );
}

function isChannelMember(value: unknown): value is ChannelMember {
  return isDynamicRecord(value) && isIdentifier(value.agentId);
}

function identifiers(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= INPUT_LIMITS.agents &&
    value.every(isIdentifier) &&
    new Set(value).size === value.length
  );
}

function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isChannel(value: unknown): value is Channel {
  return (
    isDynamicRecord(value) &&
    isChannelDraft(value) &&
    isIdentifier(value.id) &&
    typeof value.archived === "boolean" &&
    sequence(value.revision) &&
    isBoundedString(value.createdAt, 80)
  );
}

export function isChannelTask(value: unknown): value is ChannelTask {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.channelId) &&
    (value.topicId === undefined || isIdentifier(value.topicId)) &&
    isIdentifier(value.rootTaskId) &&
    (value.parentTaskId === null || isIdentifier(value.parentTaskId)) &&
    (value.ownerAgentId === null || isIdentifier(value.ownerAgentId)) &&
    isIdentifier(value.requestMessageId) &&
    identifiers(value.attachmentDraftIds) &&
    isBoundedString(value.instruction, INPUT_LIMITS.messageText) &&
    isBoundedString(value.expectedResult, INPUT_LIMITS.messageText) &&
    identifiers(value.sourceMessageIds) &&
    identifiers(value.dependencies) &&
    Array.isArray(value.resources) &&
    value.resources.length <= 64 &&
    value.resources.every((resource) => isBoundedString(resource, INPUT_LIMITS.path)) &&
    isOneOf(["queued", "running", "waiting", "paused", "completed", "failed", "cancelled"] as const, value.state) &&
    sequence(value.revision) &&
    sequence(value.assignmentCount) &&
    (value.error === null || isBoundedString(value.error, INPUT_LIMITS.messageText)) &&
    (value.startRetry === undefined || isStartRetryView(value.startRetry)) &&
    (value.startAttempts === undefined || sequence(value.startAttempts))
  );
}

export function isChannelMessage(value: unknown): value is ChannelMessage {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.channelId) &&
    // A message written before tabs has none; the store puts it in the channel's first tab.
    (value.topicId === undefined || isIdentifier(value.topicId)) &&
    sequence(value.sequence) &&
    isDynamicRecord(value.author) &&
    isOneOf(["member", "agent", "coordinator"] as const, value.author.kind) &&
    isIdentifier(value.author.id) &&
    // The author of a channel message can be a person, and an account name is bounded there, not
    // by the agent name. A name this validator refuses is a stored message no read can decode.
    isBoundedString(value.author.name, INPUT_LIMITS.accountName) &&
    (value.taskId === null || isIdentifier(value.taskId)) &&
    typeof value.superseded === "boolean" &&
    isConversationMessage(value.message)
  );
}

export function decodeChannel(value: unknown): Channel {
  const channel = normalizeChannelDraft(value);
  if (!isChannel(channel)) throw new Error("Invalid channel response.");
  return channel;
}

export function decodeChannelPage(value: unknown): ChannelPage {
  const channel = isDynamicRecord(value) ? normalizeChannelDraft(value.channel) : undefined;
  if (
    !isDynamicRecord(value) ||
    !isChannel(channel) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isChannelMessage) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(isChannelTask) ||
    !(value.olderCursor === null || sequence(value.olderCursor)) ||
    !sequence(value.throughSequence)
  ) {
    throw new Error("Invalid channel conversation response.");
  }
  return {
    channel,
    topicId: isIdentifier(value.topicId) ? value.topicId : "",
    messages: value.messages,
    tasks: value.tasks,
    olderCursor: value.olderCursor,
    throughSequence: value.throughSequence,
    ...optionalHistoryExtent(value),
  };
}

export function decodeChannelSummaries(value: unknown): ChannelSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid channel list response.");
  const summaries: unknown[] = value.map(normalizeChannelDraft);
  if (!summaries.every(isChannelSummary)) throw new Error("Invalid channel list response.");
  return summaries;
}

function isChannelSummary(value: unknown): value is ChannelSummary {
  return (
    isDynamicRecord(value) &&
    isChannel(value) &&
    sequence(value.unreadCount) &&
    sequence(value.activeTasks) &&
    (value.openTasks === undefined || sequence(value.openTasks)) &&
    (value.lastMessage === null || isChannelPreview(value.lastMessage)) &&
    (value.threads === undefined ||
      (Array.isArray(value.threads) &&
        value.threads.length <= INPUT_LIMITS.agents &&
        value.threads.every(isChannelThread))) &&
    hasValidTopicMessages(value.topics)
  );
}

/**
 * The tabs are not checked one by one, as before. Only the message texts that a tab shows on hover
 * and in its details must be text when present: no released host sends them.
 */
function hasValidTopicMessages(topics: unknown): boolean {
  const text = (value: unknown) => value === undefined || isBoundedString(value, INPUT_LIMITS.messageText);
  return (
    !Array.isArray(topics) ||
    topics.every((topic) => !isDynamicRecord(topic) || (text(topic.firstMessage) && text(topic.lastUserMessage)))
  );
}

function isChannelThread(value: unknown): value is ChannelThread {
  return isDynamicRecord(value) && isIdentifier(value.agentId) && isIdentifier(value.threadId);
}

function isChannelPreview(value: unknown): value is ChannelPreview {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.authorName, INPUT_LIMITS.accountName) &&
    (value.author === undefined ||
      (isDynamicRecord(value.author) &&
        (value.author.kind === "member" || value.author.kind === "agent" || value.author.kind === "coordinator") &&
        isIdentifier(value.author.id))) &&
    (value.status === undefined ||
      value.status === "streaming" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "interrupted") &&
    isBoundedString(value.text, CHANNEL_PREVIEW_LIMIT) &&
    isBoundedString(value.at, 80)
  );
}

export function parseChannelRead(value: unknown): ChannelReadInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.channelId) ||
    !(value.beforeSequence === undefined || sequence(value.beforeSequence))
  ) {
    throw new Error("Provide a valid channel and message cursor.");
  }
  return {
    channelId: value.channelId,
    ...(isIdentifier(value.topicId) ? { topicId: value.topicId } : {}),
    beforeSequence: value.beforeSequence,
  };
}

/** The tab a command names, when it names one. Absent leaves the command in the channel's first tab. */
function topicOf(value: DynamicRecord): { topicId?: string } {
  return isIdentifier(value.topicId) ? { topicId: value.topicId } : {};
}

export function parseChannelCommand(value: unknown): ChannelCommand {
  if (!isDynamicRecord(value) || !isIdentifier(value.operationId) || !isIdentifier(value.channelId))
    throw new Error("Provide a valid channel command.");
  const common = { operationId: value.operationId, channelId: value.channelId };
  const draft = normalizeChannelDraft(value.draft);
  if (value.type === "save" && isChannelDraft(draft))
    return { ...common, type: value.type, draft, ...(value.update === true ? { update: true } : {}) };
  if (value.type === "archive" || value.type === "restore") return { ...common, type: value.type };
  if (
    value.type === "read" &&
    sequence(value.throughSequence) &&
    (value.topicId === undefined || isIdentifier(value.topicId))
  )
    return { ...common, type: value.type, throughSequence: value.throughSequence, ...topicOf(value) };
  if (value.type === "topic-create" && isIdentifier(value.topicId)) {
    if (value.name !== undefined && !isBoundedString(value.name, INPUT_LIMITS.agentName))
      throw new Error("The tab name is too long.");
    return {
      ...common,
      type: value.type,
      topicId: value.topicId,
      ...(isString(value.name) ? { name: value.name } : {}),
    };
  }
  if (
    value.type === "topic-rename" &&
    isIdentifier(value.topicId) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName)
  )
    return { ...common, type: value.type, topicId: value.topicId, name: value.name };
  if (value.type === "topic-delete" && isIdentifier(value.topicId))
    return { ...common, type: value.type, topicId: value.topicId };
  if (
    (value.type === "stop" || value.type === "resume" || value.type === "reassign") &&
    isIdentifier(value.taskId) &&
    (value.recipientAgentId === null || isIdentifier(value.recipientAgentId))
  ) {
    return { ...common, type: value.type, taskId: value.taskId, recipientAgentId: value.recipientAgentId };
  }
  if (
    value.type === "send" &&
    isBoundedString(value.text, INPUT_LIMITS.messageText) &&
    (value.recipientAgentId === null || isIdentifier(value.recipientAgentId)) &&
    (value.replyToMessageId === null || isIdentifier(value.replyToMessageId)) &&
    identifiers(value.attachmentDraftIds) &&
    (value.text.trim().length > 0 || value.attachmentDraftIds.length > 0)
  ) {
    return {
      ...common,
      type: value.type,
      text: value.text,
      recipientAgentId: value.recipientAgentId,
      replyToMessageId: value.replyToMessageId,
      attachmentDraftIds: value.attachmentDraftIds,
      ...topicOf(value),
    };
  }
  if (
    value.type === "request" &&
    isBoundedString(value.text, INPUT_LIMITS.messageText) &&
    value.text.trim().length > 0 &&
    (value.recipientAgentId === null || isIdentifier(value.recipientAgentId)) &&
    isIdentifier(value.requestMessageId) &&
    isDynamicRecord(value.origin) &&
    value.origin.kind === "routine" &&
    isIdentifier(value.origin.routineId) &&
    isBoundedString(value.origin.routineName, INPUT_LIMITS.routineName) &&
    isIdentifier(value.origin.runId)
  ) {
    return {
      ...common,
      type: value.type,
      text: value.text,
      recipientAgentId: value.recipientAgentId,
      requestMessageId: value.requestMessageId,
      ...topicOf(value),
      origin: {
        kind: "routine",
        routineId: value.origin.routineId,
        routineName: value.origin.routineName,
        runId: value.origin.runId,
      },
    };
  }
  throw new Error("Provide a valid channel command.");
}
