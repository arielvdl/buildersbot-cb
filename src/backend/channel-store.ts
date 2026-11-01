import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CHANNEL_DEFAULT_TOPIC_NAME,
  CHANNEL_PREVIEW_LIMIT,
  CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX,
  type Channel,
  type ChannelDraft,
  type ChannelMessage,
  type ChannelPage,
  type ChannelSummary,
  type ChannelTask,
  type ChannelThread,
  type ChannelTopic,
  decodeChannel,
  isChannelMessage,
  isChannelTask,
  isStartRetryView,
  SIGNED_OUT_CHANNEL_MEMBER_ID,
  type StartRetryView,
} from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { deleteAggregateHistory, deleteReceiptsOf, deleteThreadAttachments } from "./database/database-core";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database/database-rows";
import { messageExcerpt } from "./message-excerpt";
import type { BuildersBotDatabase } from "./openbot-database";
import { revokeRoutineWebhooks } from "./webhook-route-store";

export interface ChannelAssignment {
  id: string;
  channelId: string;
  taskId: string;
  agentId: string;
  taskRevision: number;
  /**
   * The request the task served when this assignment started. A task can be reused for a newer
   * request, so its id alone does not tie an assignment to the request it worked on. Null for an
   * assignment written before this was stored.
   */
  requestMessageId: string | null;
  /**
   * The resources this assignment holds, copied from the task when the assignment starts. A task
   * record can change owner and resources while its previous owner still runs, so the task is not
   * a safe place to read a live reservation from.
   */
  resources: string[];
  deliveryId: string | null;
  turnId: string | null;
  state: "queued" | "starting" | "running" | "completed" | "failed" | "interrupted";
  throughSequence: number;
  summaryVersion: number;
  awaitedTaskIds: string[];
  pendingRevision: number | null;
  pendingOutcome: string | null;
  /** The provider did not start it, and the drain tries again (`start-retry.ts`). Absent otherwise. */
  startRetry?: StartRetryView;
  /** Why its start failed after every try: the catalog key and the class, never the provider text. */
  startFailure?: ChannelStartFailure;
}

/** The end of a start retry that did not start the assignment. */
export interface ChannelStartFailure {
  cause: string;
  errorKey: string | null;
  /** The starts that failed, on every model. */
  attempts: number;
  fallbackTried: boolean;
}

function isChannelStartFailure(value: unknown): value is ChannelStartFailure {
  return (
    isDynamicRecord(value) &&
    isString(value.cause) &&
    value.cause.length <= 64 &&
    (value.errorKey === null || (isString(value.errorKey) && value.errorKey.length <= 200)) &&
    typeof value.attempts === "number" &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 0 &&
    value.attempts <= 100 &&
    typeof value.fallbackTried === "boolean"
  );
}

export interface ChannelContext {
  threadId: string;
  sessionId: string | null;
  throughSequence: number;
  summaryVersion: number;
}

export interface ChannelHistorySummary {
  version: number;
  throughSequence: number;
  text: string;
}

export interface ChannelChange {
  channel: Channel;
  messages: ChannelMessage[];
  tasks: ChannelTask[];
  assignments: ChannelAssignment[];
  /** The tabs of the channel, whole: a tab missing here is deleted. Absent leaves them alone. */
  topics?: ChannelTopic[];
}

/**
 * The tab a message or task belongs to: the one it carries, or the first tab for a row written
 * before tabs or replayed from an older event. `messages` and `tasks` read those rows the same way.
 */
const FIRST_TOPIC_OF = (jsonColumn: string, channel: string) =>
  `COALESCE(json_extract(${jsonColumn}, '$.topicId'), (SELECT ft.topic_id FROM projection_channel_topics AS ft
     WHERE ft.channel_id = ${channel} ORDER BY ft.created_at, ft.topic_id LIMIT 1))`;

/**
 * A message that a person sent, with text. Its first and last one tell what a tab is for: the tab
 * shows them on hover and in its details. A rename does not change them.
 */
const PERSON_TEXT = (column: string) =>
  `json_extract(${column}, '$.author.kind') = 'member'
     AND trim(COALESCE(json_extract(${column}, '$.message.text'), ''), char(9, 10, 13, 32)) != ''`;

/** The messages a person sees in a tab: no plan, subagent step, activity marker or thinking. */
const VISIBLE_MESSAGE_FILTER = (column: string) =>
  `COALESCE(json_extract(${column}, '$.message.itemType'), '') NOT IN
     ('plan', 'subagents', 'channel-change', 'commentary')
   AND COALESCE(json_extract(${column}, '$.message.itemType'), '') NOT LIKE ?`;

/**
 * Owns durable channel records. Every change and its retry receipt commit together.
 */
export class ChannelStore {
  /** By channel: how many times a message changed in place after it was complete, in this process. */
  readonly #completedMessageChanges = new Map<string, number>();

  constructor(readonly database: BuildersBotDatabase) {}

  /** A packet built before this count changed can show a message as it was before. */
  completedMessageChanges(channelId: string): number {
    return this.#completedMessageChanges.get(channelId) ?? 0;
  }

  get(channelId: string): Channel {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT channel_json FROM projection_channels WHERE channel_id = ?")
        .get(channelId),
    );
    if (!row) throw new Error(sourceText("error.backend.channelNotFound"));
    return decodeChannel(JSON.parse(requiredStringColumn(row, "channel_json")));
  }

  /**
   * Only the ids, in one query. Placing channels in the sidebar layout needs the set of ids that
   * exist - archived ones included, so an archived channel keeps its section - and the scheduler
   * works by id as well. `list` would read every message of every channel to answer either. The order
   * is the order of `list`: the layout places the channels it has no order for in it, as the sidebar does.
   */
  ids(): string[] {
    return databaseRows(
      this.database.connection.prepare("SELECT channel_id FROM projection_channels ORDER BY rowid").all(),
    ).map((row) => requiredStringColumn(row, "channel_id"));
  }

  /**
   * The archived ids, in one query. An archived channel must not fire a routine and must not wake
   * the shared timer, and `list` would read every message of every channel to answer that.
   */
  archivedIds(): ReadonlySet<string> {
    return new Set(
      databaseRows(
        this.database.connection
          .prepare("SELECT channel_id FROM projection_channels WHERE json_extract(channel_json, '$.archived') = 1")
          .all(),
      ).map((row) => requiredStringColumn(row, "channel_id")),
    );
  }

  /**
   * @param signedOutMessagesAreTheirs true only when `memberId` is the host user of this computer.
   * Their messages from before they signed in carry `SIGNED_OUT_CHANNEL_MEMBER_ID`, so those
   * messages are their own and are never unread for them. A remote member is a different person:
   * the host's signed-out messages are unread for them until they read them.
   */
  list(memberId: string, signedOutMessagesAreTheirs = false): ChannelSummary[] {
    // The sidebar is rebuilt on every `channels-changed`, and a streaming reply emits those while
    // it arrives. One query returns every summary: the previous per-channel latest-message, unread,
    // and task queries made this O(channels x queries) per stream frame. A member's thinking is not
    // unread, as in an agent chat: it folds into the steps of the member's answer.
    const excludedId = signedOutMessagesAreTheirs ? SIGNED_OUT_CHANNEL_MEMBER_ID : memberId;
    const rows = databaseRows(
      this.database.connection
        .prepare(
          `SELECT c.channel_json AS channel_json,
            (SELECT m.message_json FROM projection_channel_messages AS m
              WHERE m.channel_id = c.channel_id
                AND COALESCE(json_extract(m.message_json, '$.message.itemType'), '') != 'plan'
                AND COALESCE(json_extract(m.message_json, '$.message.itemType'), '') != 'subagents'
              ORDER BY m.sequence DESC, m.message_id DESC LIMIT 1) AS latest_json,
            (SELECT COUNT(*) FROM projection_channel_messages AS m
              WHERE m.channel_id = c.channel_id
                -- Each tab counts against its own cursor; a message with no tab is the first tab's.
                AND m.sequence > COALESCE(
                  (SELECT r.through_sequence FROM projection_channel_reads AS r
                    WHERE r.channel_id = c.channel_id AND r.member_id = ?
                      AND r.topic_id = COALESCE(
                        json_extract(m.message_json, '$.topicId'),
                        (SELECT t.topic_id FROM projection_channel_topics AS t
                          WHERE t.channel_id = c.channel_id ORDER BY t.created_at, t.topic_id LIMIT 1))), 0)
                AND json_extract(m.message_json, '$.author.id') IS NOT ?
                AND json_extract(m.message_json, '$.author.id') IS NOT ?
                AND COALESCE(json_extract(m.message_json, '$.message.itemType'), '') != 'plan'
                AND COALESCE(json_extract(m.message_json, '$.message.itemType'), '') != 'subagents'
                AND COALESCE(json_extract(m.message_json, '$.message.itemType'), '') != 'channel-change'
                AND COALESCE(json_extract(m.message_json, '$.message.itemType'), '') != 'commentary'
                AND COALESCE(json_extract(m.message_json, '$.message.itemType'), '') NOT LIKE ?) AS unread,
            (SELECT COUNT(*) FROM projection_channel_tasks AS t
              WHERE t.channel_id = c.channel_id
                AND json_extract(t.task_json, '$.state') = 'running') AS running,
            (SELECT COUNT(*) FROM projection_channel_tasks AS t
              WHERE t.channel_id = c.channel_id
                AND json_extract(t.task_json, '$.state') IN ('queued', 'waiting', 'running')) AS open
            FROM projection_channels AS c ORDER BY c.rowid`,
        )
        .all(memberId, memberId, excludedId, `${CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX}%`),
    );
    const threads = new Map<string, ChannelThread[]>();
    for (const row of databaseRows(
      this.database.connection
        .prepare(
          "SELECT channel_id, agent_id, thread_id FROM projection_channel_contexts ORDER BY channel_id, agent_id",
        )
        .all(),
    )) {
      const channelId = requiredStringColumn(row, "channel_id");
      const thread = {
        agentId: requiredStringColumn(row, "agent_id"),
        threadId: requiredStringColumn(row, "thread_id"),
      };
      threads.set(channelId, [...(threads.get(channelId) ?? []), thread]);
    }
    const topics = new Map<string, ChannelTopic[]>();
    // The per-tab counters of the summary: one grouped query each, never one per channel. A message
    // or a task with no tab belongs to the first one, as `messages` and `tasks` read it.
    const perTopicMessages = this.#perTopicCounts(
      `SELECT m.channel_id AS channel_id, ${FIRST_TOPIC_OF("m.message_json", "m.channel_id")} AS topic_key,
         COUNT(*) AS messages,
         MAX(json_extract(m.message_json, '$.message.createdAt')) AS last_at,
         SUM(CASE WHEN m.sequence > COALESCE(r.through_sequence, 0)
               AND json_extract(m.message_json, '$.author.id') IS NOT ?
               AND json_extract(m.message_json, '$.author.id') IS NOT ?
             THEN 1 ELSE 0 END) AS unread,
         MIN(CASE WHEN ${PERSON_TEXT("m.message_json")} THEN m.sequence END) AS first_person,
         MAX(CASE WHEN ${PERSON_TEXT("m.message_json")} THEN m.sequence END) AS last_person
       FROM projection_channel_messages AS m
       LEFT JOIN projection_channel_reads AS r
         ON r.channel_id = m.channel_id AND r.member_id = ?
        AND r.topic_id = ${FIRST_TOPIC_OF("m.message_json", "m.channel_id")}
       WHERE ${VISIBLE_MESSAGE_FILTER("m.message_json")}
       GROUP BY m.channel_id, topic_key`,
      [memberId, excludedId, memberId, `${CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX}%`],
    );
    const perTopicTasks = this.#perTopicCounts(
      `SELECT t.channel_id AS channel_id, ${FIRST_TOPIC_OF("t.task_json", "t.channel_id")} AS topic_key,
         SUM(CASE WHEN json_extract(t.task_json, '$.state') = 'running' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN json_extract(t.task_json, '$.state') IN ('queued', 'waiting', 'running') THEN 1 ELSE 0 END) AS open
       FROM projection_channel_tasks AS t
       GROUP BY t.channel_id, topic_key`,
    );
    // The texts of the first and the last message of a person in each tab: one indexed read each,
    // by the place that the grouped query above found.
    const textAt = this.database.connection.prepare(
      "SELECT json_extract(message_json, '$.message.text') AS text FROM projection_channel_messages WHERE channel_id = ? AND sequence = ?",
    );
    const personText = (channelId: string, sequence: unknown): string => {
      if (typeof sequence !== "number") return "";
      const text = databaseRow(textAt.get(channelId, sequence))?.text;
      return typeof text === "string" ? messageExcerpt(text) : "";
    };
    for (const topic of databaseRows(
      this.database.connection
        .prepare("SELECT * FROM projection_channel_topics ORDER BY channel_id, created_at, topic_id")
        .all(),
    ).map((row) => decodeTopic(row))) {
      const counts = perTopicMessages.get(`${topic.channelId}\u0000${topic.id}`);
      const tasks = perTopicTasks.get(`${topic.channelId}\u0000${topic.id}`);
      const firstMessage = personText(topic.channelId, counts?.first_person);
      topics.set(topic.channelId, [
        ...(topics.get(topic.channelId) ?? []),
        {
          ...topic,
          updatedAt: counts?.last_at ? String(counts.last_at) : topic.createdAt,
          unreadCount: Number(counts?.unread ?? 0),
          activeTasks: Number(tasks?.active ?? 0),
          openTasks: Number(tasks?.open ?? 0),
          messageCount: Number(counts?.messages ?? 0),
          firstMessage,
          lastUserMessage:
            counts?.last_person === counts?.first_person
              ? firstMessage
              : personText(topic.channelId, counts?.last_person),
        },
      ]);
    }
    return rows.map((row) => {
      const channel = decodeChannel(JSON.parse(requiredStringColumn(row, "channel_json")));
      const latestJson = row.latest_json;
      const latest =
        typeof latestJson === "string" && latestJson.length > 0
          ? (() => {
              const value = JSON.parse(latestJson);
              if (!isChannelMessage(value)) throw new Error("Invalid stored channel message.");
              return value;
            })()
          : undefined;
      return {
        ...channel,
        unreadCount: Number(row.unread ?? 0),
        activeTasks: Number(row.running ?? 0),
        openTasks: Number(row.open ?? 0),
        lastMessage: latest
          ? {
              authorName: latest.author.name,
              author: { kind: latest.author.kind, id: latest.author.id },
              status: latest.message.status,
              text: previewText(latest),
              at: latest.message.createdAt,
            }
          : null,
        // A former member keeps its thread, but its prompts are no longer the channel's. The members
        // are at most 100, which is the bound of channel-attention-v1.
        threads: (threads.get(channel.id) ?? []).filter((thread) =>
          channel.members.some((item) => item.agentId === thread.agentId),
        ),
        topics: topics.get(channel.id) ?? [],
      };
    });
  }

  /** One grouped count query, keyed by `channelId` and tab id, for the summary of each tab. */
  #perTopicCounts(sql: string, params: readonly string[] = []): Map<string, DynamicRecord> {
    const counts = new Map<string, DynamicRecord>();
    for (const row of databaseRows(this.database.connection.prepare(sql).all(...params)))
      counts.set(`${requiredStringColumn(row, "channel_id")}\u0000${requiredStringColumn(row, "topic_key")}`, row);
    return counts;
  }

  create(channelId: string, draft: ChannelDraft): Channel {
    return { ...draft, id: channelId, archived: false, revision: 0, createdAt: new Date().toISOString() };
  }

  topics(channelId: string): ChannelTopic[] {
    return databaseRows(
      this.database.connection
        .prepare("SELECT * FROM projection_channel_topics WHERE channel_id = ? ORDER BY created_at, topic_id")
        .all(channelId),
    ).map((row) => decodeTopic(row));
  }

  /** The id of the first tab, which every channel has. */
  firstTopicId(channelId: string): string {
    return this.firstTopic(channelId)?.id ?? "";
  }

  /** The first tab of the channel: where a client without tabs, and a new channel, lands. */
  firstTopic(channelId: string): ChannelTopic | null {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT * FROM projection_channel_topics WHERE channel_id = ? ORDER BY created_at, topic_id LIMIT 1")
        .get(channelId),
    );
    return row ? decodeTopic(row) : null;
  }

  /**
   * The tab a read names, or the first one. A tab that is not in the channel is refused, as `send`
   * refuses it: an empty page for it would keep the reader on a tab of another channel.
   */
  readTopicId(channelId: string, requested?: string): string {
    const topic = requested === undefined ? this.firstTopic(channelId) : this.topic(channelId, requested);
    if (!topic) throw new Error(sourceText("error.backend.channelTopicNotFound"));
    return topic.id;
  }

  topic(channelId: string, topicId: string): ChannelTopic | null {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT * FROM projection_channel_topics WHERE channel_id = ? AND topic_id = ?")
        .get(channelId, topicId),
    );
    return row ? decodeTopic(row) : null;
  }

  /**
   * Adds a tab. It is written with the channel in the same command, so a channel and its first tab
   * cannot exist apart.
   */
  addTopic(topic: ChannelTopic): void {
    this.database.connection
      .prepare(
        "INSERT INTO projection_channel_topics(topic_id, channel_id, name, created_at, revision) VALUES (?, ?, ?, ?, ?)",
      )
      .run(topic.id, topic.channelId, topic.name, topic.createdAt, topic.revision);
  }

  renameTopic(channelId: string, topicId: string, name: string): void {
    const updated = this.database.connection
      .prepare(
        "UPDATE projection_channel_topics SET name = ?, revision = revision + 1 WHERE channel_id = ? AND topic_id = ?",
      )
      .run(name, channelId, topicId);
    if (updated.changes === 0) throw new Error(sourceText("error.backend.channelTopicNotFound"));
  }

  /**
   * Removes a tab with everything that belongs to it, in one transaction and in the order the
   * foreign keys demand: assignments before tasks, contexts and summaries and cursors before the
   * tab itself. The threads of its sessions go after, which is why the caller reads them first.
   */
  deleteTopic(channelId: string, topicId: string, operationId: string): void {
    this.database.dispatch(
      operationId,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.topic-deleted",
          payload: { topicId },
        },
      ],
      (db) => {
        // A message or task written before tabs, or replayed from an older event, carries none and
        // belongs to the first tab. It goes with it, as `messages` and `tasks` read it there.
        const legacy = this.firstTopicId(channelId) === topicId ? " OR json_extract({row}, '$.topicId') IS NULL" : "";
        const ofTopic = (row: string) => `json_extract(${row}, '$.topicId') = ?${legacy.replaceAll("{row}", row)}`;
        db.prepare(
          `DELETE FROM projection_channel_assignments WHERE channel_id = ? AND task_id IN (
             SELECT task_id FROM projection_channel_tasks WHERE channel_id = ? AND ${ofTopic("task_json")})`,
        ).run(channelId, channelId, topicId);
        for (const table of ["projection_channel_contexts", "projection_channel_summaries", "projection_channel_reads"])
          db.prepare(`DELETE FROM ${table} WHERE channel_id = ? AND topic_id = ?`).run(channelId, topicId);
        db.prepare(`DELETE FROM projection_channel_tasks WHERE channel_id = ? AND ${ofTopic("task_json")}`).run(
          channelId,
          topicId,
        );
        db.prepare(`DELETE FROM projection_channel_messages WHERE channel_id = ? AND ${ofTopic("message_json")}`).run(
          channelId,
          topicId,
        );
        const deleted = db
          .prepare("DELETE FROM projection_channel_topics WHERE channel_id = ? AND topic_id = ?")
          .run(channelId, topicId);
        if (deleted.changes === 0) throw new Error(sourceText("error.backend.channelTopicNotFound"));
      },
    );
  }

  /** The execution threads of one tab, for the caller that deletes it. */
  topicThreads(channelId: string, topicId: string): string[] {
    return databaseRows(
      this.database.connection
        .prepare("SELECT thread_id FROM projection_channel_contexts WHERE channel_id = ? AND topic_id = ?")
        .all(channelId, topicId),
    ).map((row) => requiredStringColumn(row, "thread_id"));
  }

  exists(channelId: string): boolean {
    return (
      this.database.connection.prepare("SELECT 1 FROM projection_channels WHERE channel_id = ?").get(channelId) !==
      undefined
    );
  }

  messages(channelId: string, topicId: string, before = Number.MAX_SAFE_INTEGER, limit?: number): ChannelMessage[] {
    // A message written before tabs, or replayed from an older event, carries none: it belongs to
    // the first tab, which is where the channel opened before.
    const first = this.firstTopicId(channelId) === topicId;
    const rows = databaseRows(
      this.database.connection
        .prepare(
          `SELECT message_json FROM projection_channel_messages
            WHERE channel_id = ? AND sequence < ?
              AND (json_extract(message_json, '$.topicId') = ?${first ? " OR json_extract(message_json, '$.topicId') IS NULL" : ""})
            ORDER BY sequence DESC, message_id DESC LIMIT ?`,
        )
        .all(channelId, before, topicId, limit ?? -1),
    );
    return rows.reverse().map((row) => {
      const value = JSON.parse(requiredStringColumn(row, "message_json"));
      if (!isChannelMessage(value)) throw new Error("Invalid stored channel message.");
      return { ...value, topicId: value.topicId ?? topicId };
    });
  }

  /** One message by id, read through the primary key rather than the whole history. */
  message(channelId: string, messageId: string): ChannelMessage | null {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT message_json FROM projection_channel_messages WHERE channel_id = ? AND message_id = ?")
        .get(channelId, messageId),
    );
    if (!row) return null;
    const value = JSON.parse(requiredStringColumn(row, "message_json"));
    if (!isChannelMessage(value)) throw new Error("Invalid stored channel message.");
    return value;
  }

  /** The tasks of one tab, or of the whole channel when no tab is named. */
  tasks(channelId: string, topicId?: string): ChannelTask[] {
    const first = topicId !== undefined && this.firstTopicId(channelId) === topicId;
    return databaseRows(
      this.database.connection
        .prepare(
          topicId === undefined
            ? "SELECT task_json FROM projection_channel_tasks WHERE channel_id = ? ORDER BY rowid"
            : `SELECT task_json FROM projection_channel_tasks
                WHERE channel_id = ? AND (json_extract(task_json, '$.topicId') = ?${first ? " OR json_extract(task_json, '$.topicId') IS NULL" : ""})
                ORDER BY rowid`,
        )
        .all(...(topicId === undefined ? [channelId] : [channelId, topicId])),
    ).map((row) => {
      const value = JSON.parse(requiredStringColumn(row, "task_json"));
      if (!isChannelTask(value)) throw new Error("Invalid stored channel task.");
      return { ...value, topicId: value.topicId ?? topicId };
    });
  }

  /**
   * The tasks with the start retry of their assignment, for the screen: `startRetry` while the drain
   * tries the start again, and `startAttempts` on a task whose start failed after its tries. Read from
   * the assignments, so a task that changed since shows neither.
   */
  withStartRetries(channelId: string, tasks: ChannelTask[]): ChannelTask[] {
    const assignments = this.assignments(channelId).filter(
      (assignment) => assignment.startRetry !== undefined || assignment.startFailure !== undefined,
    );
    if (!assignments.length) return tasks;
    return tasks.map((task) => {
      const own = assignments.filter(
        (assignment) => assignment.taskId === task.id && assignment.taskRevision === task.revision,
      );
      const retrying = task.state === "queued" ? own.find((assignment) => assignment.startRetry) : undefined;
      if (retrying?.startRetry) return { ...task, startRetry: retrying.startRetry };
      const failed = task.state === "failed" ? own.findLast((assignment) => assignment.state === "failed") : undefined;
      return failed?.startFailure ? { ...task, startAttempts: failed.startFailure.attempts } : task;
    });
  }

  assignments(channelId: string): ChannelAssignment[] {
    return databaseRows(
      this.database.connection
        .prepare("SELECT assignment_json FROM projection_channel_assignments WHERE channel_id = ? ORDER BY rowid")
        .all(channelId),
    ).map((row) => decodeAssignment(JSON.parse(requiredStringColumn(row, "assignment_json"))));
  }

  /**
   * Does any channel hold an assignment in one of these states?
   *
   * Walking the channel list to answer this parses every stored message of every channel to build
   * summaries that nothing here reads, so the question is answered by one query over the
   * assignment rows.
   */
  hasAssignmentInState(states: readonly ChannelAssignment["state"][]): boolean {
    if (!states.length) return false;
    const placeholders = states.map(() => "?").join(", ");
    return (
      this.database.connection
        .prepare(
          `SELECT 1 FROM projection_channel_assignments WHERE json_extract(assignment_json, '$.state') IN (${placeholders}) LIMIT 1`,
        )
        .get(...states) !== undefined
    );
  }

  /** `hasAssignmentInState` for the assignments of one agent. `mayDrain` asks this on every queue check. */
  hasAgentAssignmentInState(agentId: string, states: readonly ChannelAssignment["state"][]): boolean {
    if (!states.length) return false;
    const placeholders = states.map(() => "?").join(", ");
    return (
      this.database.connection
        .prepare(
          `SELECT 1 FROM projection_channel_assignments
            WHERE json_extract(assignment_json, '$.agentId') = ?
              AND json_extract(assignment_json, '$.state') IN (${placeholders}) LIMIT 1`,
        )
        .get(agentId, ...states) !== undefined
    );
  }

  /**
   * The assignment of this agent that holds its queue right now, with the channel it belongs to.
   *
   * `hasAgentAssignmentInState` answers the drain question with a yes or a no; the queue the user
   * reads has to name the cause as well. The same reason keeps this to one query: reaching a
   * channel through `list` parses every stored message of every channel. States are tried in the
   * order given, so a running assignment is reported before one that is only queued.
   */
  agentAssignment(
    agentId: string,
    states: readonly ChannelAssignment["state"][],
  ): { assignment: ChannelAssignment; channel: Channel } | null {
    if (!states.length) return null;
    const placeholders = states.map(() => "?").join(", ");
    const ranking = states.map((_, index) => `WHEN ? THEN ${index}`).join(" ");
    const row = databaseRow(
      this.database.connection
        .prepare(
          `SELECT assignments.assignment_json AS assignment_json, channels.channel_json AS channel_json
             FROM projection_channel_assignments AS assignments
             JOIN projection_channels AS channels ON channels.channel_id = assignments.channel_id
            WHERE json_extract(assignments.assignment_json, '$.agentId') = ?
              AND json_extract(assignments.assignment_json, '$.state') IN (${placeholders})
            ORDER BY CASE json_extract(assignments.assignment_json, '$.state') ${ranking} END,
                     assignments.rowid
            LIMIT 1`,
        )
        .get(agentId, ...states, ...states),
    );
    if (!row) return null;
    return {
      assignment: decodeAssignment(JSON.parse(requiredStringColumn(row, "assignment_json"))),
      channel: decodeChannel(JSON.parse(requiredStringColumn(row, "channel_json"))),
    };
  }

  assignmentForDelivery(deliveryId: string): ChannelAssignment | null {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT assignment_json FROM projection_channel_assignments WHERE delivery_id = ?")
        .get(deliveryId),
    );
    return row ? decodeAssignment(JSON.parse(requiredStringColumn(row, "assignment_json"))) : null;
  }

  page(channelId: string, topicId: string, before?: number): ChannelPage {
    const messages = this.messages(channelId, topicId, before, 101);
    const hasOlder = messages.length > 100;
    if (hasOlder) messages.shift();
    const olderCursor = hasOlder ? (messages[0]?.sequence ?? null) : null;
    return {
      channel: this.get(channelId),
      topicId,
      tasks: this.withStartRetries(channelId, this.tasks(channelId, topicId)),
      messages,
      olderCursor,
      throughSequence: this.messages(channelId, topicId, undefined, 1)[0]?.sequence ?? 0,
      ...(olderCursor === null ? {} : this.olderExtent(channelId, topicId, olderCursor)),
    };
  }

  /**
   * How many messages are older than a page, and when the first one was written: the day rail draws
   * the unloaded part from it. The time is only in the message JSON, so only the oldest row is read.
   */
  private olderExtent(channelId: string, topicId: string, before: number): { olderCount: number; oldestAt?: string } {
    const row = databaseRow(
      this.database.connection
        .prepare(
          `SELECT COUNT(*) AS older_count,
             (SELECT json_extract(message_json, '$.message.createdAt') FROM projection_channel_messages
              WHERE channel_id = ? AND json_extract(message_json, '$.topicId') = ? ORDER BY sequence LIMIT 1) AS oldest_at
           FROM projection_channel_messages
            WHERE channel_id = ? AND json_extract(message_json, '$.topicId') = ? AND sequence < ?`,
        )
        .get(channelId, topicId, channelId, topicId, before),
    );
    const oldestAt = row ? optionalStringColumn(row, "oldest_at") : null;
    return { olderCount: row ? requiredNumberColumn(row, "older_count") : 0, ...(oldestAt ? { oldestAt } : {}) };
  }

  commit(operationId: string, change: ChannelChange): Channel {
    const commandId = `channels:${operationId}`;
    const previous = this.database.commandResult(commandId);
    if (previous !== undefined) return decodeChannel(previous);
    if (!change.tasks.every(isChannelTask)) throw new Error("Invalid channel task.");
    const channel = { ...change.channel, revision: change.channel.revision + 1 };
    const payload = { ...change, channel };
    return this.database.dispatch(
      commandId,
      [{ aggregateType: "channel", aggregateId: channel.id, eventType: "channel.changed", payload }],
      (db) => {
        this.project(db, payload);
        pruneChannelEvents(db, channel.id);
        return channel;
      },
    );
  }

  /**
   * Drops the older `channel.changed` events of this channel, with their receipts. Each one holds the
   * whole channel and only the newest is ever read, so the log grew by a channel per change: 11k
   * rows and 27 MB on a profile with 1.6k channel messages. The projection rows keep their own
   * `last_event_sequence`, so a pruned sequence still reads as the revision it was.
   */
  private project(db: DatabaseSync, change: ChannelChange): void {
    db.prepare(
      "INSERT INTO projection_channels VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET channel_json = excluded.channel_json",
    ).run(change.channel.id, JSON.stringify(change.channel));
    if (change.topics) {
      const kept = new Set(change.topics.map((topic) => topic.id));
      for (const row of databaseRows(
        db.prepare("SELECT topic_id FROM projection_channel_topics WHERE channel_id = ?").all(change.channel.id),
      ))
        if (!kept.has(requiredStringColumn(row, "topic_id")))
          db.prepare("DELETE FROM projection_channel_topics WHERE topic_id = ?").run(
            requiredStringColumn(row, "topic_id"),
          );
      for (const topic of change.topics)
        db.prepare(
          "INSERT INTO projection_channel_topics(topic_id, channel_id, name, created_at, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET name = excluded.name, revision = excluded.revision",
        ).run(topic.id, topic.channelId, topic.name, topic.createdAt, topic.revision);
    } else if (
      !db.prepare("SELECT 1 FROM projection_channel_topics WHERE channel_id = ? LIMIT 1").get(change.channel.id)
    ) {
      // A caller that writes a channel without tabs — a seed, a migration replay — still gets the one
      // tab a channel needs, with the id the service gives the tab of a new channel.
      db.prepare(
        "INSERT INTO projection_channel_topics(topic_id, channel_id, name, created_at, revision) VALUES (?, ?, ?, ?, 0)",
      ).run(
        `openbot-topic-${change.channel.id}`,
        change.channel.id,
        CHANNEL_DEFAULT_TOPIC_NAME,
        new Date().toISOString(),
      );
    }
    for (const message of change.messages) {
      const existing = databaseRow(
        db
          .prepare(
            "SELECT sequence, json_extract(message_json, '$.message.status') AS status FROM projection_channel_messages WHERE channel_id = ? AND message_id = ?",
          )
          .get(change.channel.id, message.id),
      );
      const last = databaseRow(
        db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM projection_channel_messages WHERE channel_id = ?",
          )
          .get(change.channel.id),
      );
      const assigned = existing
        ? requiredNumberColumn(existing, "sequence")
        : last
          ? requiredNumberColumn(last, "next")
          : 1;
      db.prepare(
        "INSERT INTO projection_channel_messages VALUES (?, ?, ?, ?) ON CONFLICT(channel_id, message_id) DO UPDATE SET message_json = excluded.message_json",
      ).run(
        change.channel.id,
        message.id,
        assigned,
        JSON.stringify({
          ...message,
          topicId: message.topicId ?? this.#firstTopicId(db, change.channel.id),
          sequence: assigned,
        }),
      );
      if (existing) {
        // A streaming message changes on each part of its text; a packet already leaves it unread.
        if (existing.status !== "streaming")
          this.#completedMessageChanges.set(change.channel.id, this.completedMessageChanges(change.channel.id) + 1);
        db.prepare(
          "UPDATE projection_channel_summaries SET version = version + 1, through_sequence = 0, text = '' WHERE channel_id = ? AND topic_id = ? AND through_sequence >= ?",
        ).run(change.channel.id, message.topicId ?? this.#firstTopicId(db, change.channel.id), assigned);
        // A member read this message before it changed, as when a correction supersedes a result. A
        // packet with only later messages would not show the change, so the next one is complete.
        db.prepare(
          "UPDATE projection_channel_contexts SET through_sequence = 0, summary_version = 0 WHERE channel_id = ? AND topic_id = ? AND through_sequence >= ?",
        ).run(change.channel.id, message.topicId ?? this.#firstTopicId(db, change.channel.id), assigned);
      }
    }
    for (const task of change.tasks)
      db.prepare(
        "INSERT INTO projection_channel_tasks VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET task_json = excluded.task_json",
      ).run(
        task.id,
        change.channel.id,
        JSON.stringify({ ...task, topicId: task.topicId ?? this.#firstTopicId(db, change.channel.id) }),
      );
    for (const assignment of change.assignments)
      db.prepare(
        "INSERT INTO projection_channel_assignments VALUES (?, ?, ?, ?, ?) ON CONFLICT(assignment_id) DO UPDATE SET delivery_id = excluded.delivery_id, assignment_json = excluded.assignment_json",
      ).run(assignment.id, change.channel.id, assignment.taskId, assignment.deliveryId, JSON.stringify(assignment));
  }

  update(
    channel: Channel,
    changes: Partial<Omit<ChannelChange, "channel">> = {},
    operationId: string = randomUUID(),
  ): Channel {
    return this.commit(operationId, { channel, messages: [], tasks: [], assignments: [], ...changes });
  }

  context(channelId: string, topicId: string, agentId: string): ChannelContext {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT * FROM projection_channel_contexts WHERE channel_id = ? AND topic_id = ? AND agent_id = ?")
        .get(channelId, topicId, agentId),
    );
    if (row)
      return {
        threadId: requiredStringColumn(row, "thread_id"),
        sessionId: isString(row.session_id) ? row.session_id : null,
        throughSequence: requiredNumberColumn(row, "through_sequence"),
        summaryVersion: requiredNumberColumn(row, "summary_version"),
      };
    const threadId = `openbot-thread-${randomUUID()}`;
    return this.database.dispatch(
      `channel-context:${channelId}:${topicId}:${agentId}`,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.context-created",
          payload: { agentId, threadId, topicId },
        },
      ],
      (db, sequences) => {
        const now = new Date().toISOString();
        db.prepare("INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?, ?)").run(
          threadId,
          agentId,
          this.get(channelId).name,
          now,
          now,
          sequences[0] ?? 0,
        );
        db.prepare(
          "INSERT INTO projection_channel_contexts(channel_id, topic_id, agent_id, thread_id) VALUES (?, ?, ?, ?)",
        ).run(channelId, topicId, agentId, threadId);
        return { threadId, sessionId: null, throughSequence: 0, summaryVersion: 0 };
      },
    );
  }

  executionThreads(): Array<{ id: string; threadId: string }> {
    return databaseRows(
      this.database.connection.prepare("SELECT agent_id, thread_id FROM projection_channel_contexts").all(),
    ).map((row) => ({ id: requiredStringColumn(row, "agent_id"), threadId: requiredStringColumn(row, "thread_id") }));
  }

  contextThreads(channelId: string): string[] {
    return databaseRows(
      this.database.connection
        .prepare("SELECT thread_id FROM projection_channel_contexts WHERE channel_id = ? ORDER BY agent_id")
        .all(channelId),
    ).map((row) => requiredStringColumn(row, "thread_id"));
  }

  /** The execution threads of one agent, one for each channel it works in. */
  contextThreadsForAgent(agentId: string): string[] {
    return databaseRows(
      this.database.connection
        .prepare("SELECT thread_id FROM projection_channel_contexts WHERE agent_id = ? ORDER BY channel_id")
        .all(agentId),
    ).map((row) => requiredStringColumn(row, "thread_id"));
  }

  /**
   * The execution threads of every channel, in one query. Deleting an agent asks for this: a file
   * the agent generated in a channel thread belongs to the shared transcript, so it stays with the
   * channel rather than leaving with the agent.
   */
  allContextThreads(): string[] {
    return databaseRows(
      this.database.connection.prepare("SELECT thread_id FROM projection_channel_contexts").all(),
    ).map((row) => requiredStringColumn(row, "thread_id"));
  }

  /** Permanently removes a channel and its execution threads from every local projection. */
  delete(channelId: string, operationId: string = randomUUID()): void {
    if (!this.exists(channelId)) throw new Error(sourceText("error.backend.channelNotFound"));
    const threadIds = this.contextThreads(channelId);
    this.database.dispatch(
      `channel-delete:${operationId}`,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.deleted",
          payload: { threadIds },
        },
      ],
      (db) => {
        const memoryIds = databaseRows(
          db.prepare("SELECT memory_id FROM projection_channel_memories WHERE channel_id = ?").all(channelId),
        ).map((row) => requiredStringColumn(row, "memory_id"));
        const routineIds = channelRoutineIds(db, channelId);
        revokeRoutineWebhooks(db, "channel", routineIds, { forget: true });
        deleteAggregateHistory(db, "channel", [channelId]);
        deleteAggregateHistory(db, "channel-memory", memoryIds);
        deleteAggregateHistory(db, "channel-routine", routineIds);
        // Routine run events use the routine id as their aggregate id; one routine can own many runs.
        deleteAggregateHistory(db, "channel-routine-run", routineIds);
        if (routineIds.length) {
          const placeholders = routineIds.map(() => "?").join(", ");
          db.prepare(`DELETE FROM projection_channel_routine_triggers WHERE routine_id IN (${placeholders})`).run(
            ...routineIds,
          );
        }

        for (const table of [
          "projection_channel_contexts",
          "projection_channel_summaries",
          "projection_channel_reads",
          "projection_channel_assignments",
          "projection_channel_tasks",
          "projection_channel_messages",
          "projection_channel_routine_runs",
          "projection_channel_routines",
          "projection_channel_memories",
          "projection_channel_topics",
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE channel_id = ?`).run(channelId);
        }
        db.prepare("DELETE FROM projection_channels WHERE channel_id = ?").run(channelId);

        for (const threadId of threadIds) {
          deleteAggregateHistory(db, "thread", [threadId]);
          deleteThreadAttachments(db, threadId);
          db.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run(threadId);
        }
        return null;
      },
    );
  }

  /** Forgets threads whose tab was deleted, with the history and files of their turns. */
  deleteThreads(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      deleteAggregateHistory(this.database.connection, "thread", [threadId]);
      deleteThreadAttachments(this.database.connection, threadId);
      this.database.connection.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run(threadId);
    }
  }

  channelForThread(threadId: string): string | null {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT channel_id FROM projection_channel_contexts WHERE thread_id = ?")
        .get(threadId),
    );
    return row ? requiredStringColumn(row, "channel_id") : null;
  }

  acceptContext(
    channelId: string,
    agentId: string,
    sessionId: string,
    throughSequence: number,
    summaryVersion: number,
  ): void {
    const current = databaseRow(
      this.database.connection
        .prepare(
          "SELECT session_id, through_sequence, summary_version FROM projection_channel_contexts WHERE channel_id = ? AND agent_id = ?",
        )
        .get(channelId, agentId),
    );
    if (
      current &&
      current.session_id === sessionId &&
      current.through_sequence === throughSequence &&
      current.summary_version === summaryVersion
    )
      return;
    // Each change has its own operation: after a compaction reset, the cursor can come back to a value
    // that an earlier operation set, and a key made from the values would skip it as a repeat.
    this.database.dispatch(
      `channel-context-accepted:${randomUUID()}`,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.context-accepted",
          payload: { agentId, sessionId, throughSequence, summaryVersion },
        },
      ],
      (db) => {
        db.prepare(
          "UPDATE projection_channel_contexts SET session_id = ?, through_sequence = ?, summary_version = ? WHERE channel_id = ? AND agent_id = ?",
        ).run(sessionId, throughSequence, summaryVersion, channelId, agentId);
      },
    );
  }

  /**
   * The provider compacted this session, so its summary can leave out channel messages that it
   * read. A cursor at zero makes the next packet complete. It is the acceptance event, not a new
   * event type, so an earlier version still rebuilds the channel.
   */
  resetContextsForSession(sessionId: string): void {
    const rows = databaseRows(
      this.database.connection
        .prepare(
          "SELECT channel_id, agent_id FROM projection_channel_contexts WHERE session_id = ? AND through_sequence > 0",
        )
        .all(sessionId),
    );
    for (const row of rows)
      this.acceptContext(
        requiredStringColumn(row, "channel_id"),
        requiredStringColumn(row, "agent_id"),
        sessionId,
        0,
        0,
      );
  }

  summary(channelId: string, topicId: string): ChannelHistorySummary {
    const row = databaseRow(
      this.database.connection
        .prepare("SELECT * FROM projection_channel_summaries WHERE channel_id = ? AND topic_id = ?")
        .get(channelId, topicId),
    );
    return row
      ? {
          version: requiredNumberColumn(row, "version"),
          throughSequence: requiredNumberColumn(row, "through_sequence"),
          text: requiredStringColumn(row, "text"),
        }
      : { version: 0, throughSequence: 0, text: "" };
  }

  saveSummary(channelId: string, topicId: string, summary: ChannelHistorySummary): void {
    this.database.dispatch(
      `channel-summary:${channelId}:${topicId}:${summary.version}`,
      [{ aggregateType: "channel", aggregateId: channelId, eventType: "channel.summarized", payload: summary }],
      (db) => {
        db.prepare(
          "INSERT INTO projection_channel_summaries VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id, topic_id) DO UPDATE SET version = excluded.version, through_sequence = excluded.through_sequence, text = excluded.text",
        ).run(channelId, topicId, summary.version, summary.throughSequence, summary.text);
      },
    );
  }

  /**
   * Channel read cursors follow the reader when an account signs in.
   *
   * `HostService.channelActor` answers `local` while no account is signed in and the team member
   * id after it, so without this every channel the reader already read turns unread on sign-in.
   * Direct threads already adopt their cursors this way. A target that read a channel under its
   * own id keeps that position, and the shared operation id makes a repeated adoption a no-op.
   */
  adoptReads(sourceMemberId: string, targetMemberId: string): void {
    if (sourceMemberId === targetMemberId) return;
    const rows = databaseRows(
      this.database.connection
        .prepare("SELECT channel_id, topic_id, through_sequence FROM projection_channel_reads WHERE member_id = ?")
        .all(sourceMemberId),
    );
    for (const row of rows) {
      const channelId = requiredStringColumn(row, "channel_id");
      const topicId = requiredStringColumn(row, "topic_id");
      if (this.#hasReadCursor(channelId, topicId, targetMemberId)) continue;
      const throughSequence = requiredNumberColumn(row, "through_sequence");
      // The command key holds the target member and this operation id, not the channel. Without the
      // channel here, every channel after the first would answer with the first channel's receipt.
      this.markRead(
        channelId,
        topicId,
        targetMemberId,
        throughSequence,
        `adopt:${sourceMemberId}:${channelId}:${topicId}`,
      );
    }
  }

  markRead(
    channelId: string,
    topicId: string,
    memberId: string,
    throughSequence: number,
    operationId: string,
  ): Channel {
    const maximum = this.page(channelId, topicId).throughSequence;
    if (throughSequence > maximum) throw new Error("The read position exceeds the channel history.");
    return this.database.dispatch(
      `channel-read:${memberId}:${operationId}`,
      [
        {
          aggregateType: "channel",
          aggregateId: channelId,
          eventType: "channel.read",
          payload: { memberId, throughSequence, topicId },
        },
      ],
      (db) => {
        db.prepare(
          "INSERT INTO projection_channel_reads VALUES (?, ?, ?, ?) ON CONFLICT(channel_id, topic_id, member_id) DO UPDATE SET through_sequence = MAX(through_sequence, excluded.through_sequence)",
        ).run(channelId, topicId, memberId, throughSequence);
        return this.get(channelId);
      },
    );
  }

  /** Rebuilds channel projections from committed events without changing agent threads. */
  rebuild(channelId: string): void {
    const db = this.database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      const events = databaseRows(
        db
          .prepare(
            "SELECT event_type, payload_json, occurred_at, sequence FROM orchestration_events WHERE aggregate_type = 'channel' AND aggregate_id = ? ORDER BY sequence",
          )
          .all(channelId),
      );
      for (const table of ["assignments", "tasks", "messages", "summaries", "reads", "contexts", "memories", "topics"])
        db.prepare(`DELETE FROM projection_channel_${table} WHERE channel_id = ?`).run(channelId);
      db.prepare("DELETE FROM projection_channels WHERE channel_id = ?").run(channelId);
      for (const event of events) {
        const value = JSON.parse(requiredStringColumn(event, "payload_json"));
        if (!isDynamicRecord(value)) throw new Error("Invalid channel event.");
        switch (event.event_type) {
          case "channel.changed": {
            if (
              !Array.isArray(value.messages) ||
              !value.messages.every(isChannelMessage) ||
              !Array.isArray(value.tasks) ||
              !value.tasks.every(isChannelTask) ||
              !Array.isArray(value.assignments)
            )
              throw new Error("Invalid channel change event.");
            this.project(db, {
              channel: decodeChannel(value.channel),
              messages: value.messages,
              tasks: value.tasks,
              assignments: value.assignments.map(decodeAssignment),
              ...(Array.isArray(value.topics) ? { topics: value.topics.filter(isChannelTopic).map(decodeTopic) } : {}),
            });
            break;
          }
          case "channel.context-created": {
            if (!isString(value.agentId) || !isString(value.threadId))
              throw new Error("Invalid channel context event.");
            const contextTopic = isString(value.topicId) ? value.topicId : this.#firstTopicId(db, channelId);
            const now = requiredStringColumn(event, "occurred_at");
            db.prepare("INSERT OR IGNORE INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?, ?)").run(
              value.threadId,
              value.agentId,
              this.get(channelId).name,
              now,
              now,
              requiredNumberColumn(event, "sequence"),
            );
            db.prepare(
              "INSERT INTO projection_channel_contexts(channel_id, topic_id, agent_id, thread_id) VALUES (?, ?, ?, ?)",
            ).run(channelId, contextTopic, value.agentId, value.threadId);
            break;
          }
          case "channel.context-accepted": {
            if (
              !isString(value.agentId) ||
              !isString(value.sessionId) ||
              typeof value.throughSequence !== "number" ||
              typeof value.summaryVersion !== "number"
            )
              throw new Error("Invalid context acceptance event.");
            db.prepare(
              "UPDATE projection_channel_contexts SET session_id = ?, through_sequence = ?, summary_version = ? WHERE channel_id = ? AND topic_id = ? AND agent_id = ?",
            ).run(
              value.sessionId,
              value.throughSequence,
              value.summaryVersion,
              channelId,
              isString(value.topicId) ? value.topicId : this.#firstTopicId(db, channelId),
              value.agentId,
            );
            break;
          }
          case "channel.summarized": {
            if (!isString(value.text) || typeof value.version !== "number" || typeof value.throughSequence !== "number")
              throw new Error("Invalid channel summary event.");
            db.prepare("INSERT OR REPLACE INTO projection_channel_summaries VALUES (?, ?, ?, ?, ?)").run(
              channelId,
              isString(value.topicId) ? value.topicId : this.#firstTopicId(db, channelId),
              value.version,
              value.throughSequence,
              value.text,
            );
            break;
          }
          case "channel.read": {
            if (!isString(value.memberId) || typeof value.throughSequence !== "number")
              throw new Error("Invalid channel read event.");
            db.prepare(
              "INSERT INTO projection_channel_reads VALUES (?, ?, ?, ?) ON CONFLICT(channel_id, topic_id, member_id) DO UPDATE SET through_sequence = MAX(through_sequence, excluded.through_sequence)",
            ).run(
              channelId,
              isString(value.topicId) ? value.topicId : this.#firstTopicId(db, channelId),
              value.memberId,
              value.throughSequence,
            );
            break;
          }
          default:
            throw new Error("Unknown channel event.");
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The tab a replayed event without one belongs to: the first, which every channel has. */
  #firstTopicId(db: DatabaseSync, channelId: string): string {
    const row = databaseRow(
      db
        .prepare(
          "SELECT topic_id FROM projection_channel_topics WHERE channel_id = ? ORDER BY created_at, topic_id LIMIT 1",
        )
        .get(channelId),
    );
    if (!row) throw new Error("The channel has no tab.");
    return requiredStringColumn(row, "topic_id");
  }

  /** A stored cursor of zero is a reader that read nothing, not a reader with no cursor at all. */
  #hasReadCursor(channelId: string, topicId: string, memberId: string): boolean {
    return (
      this.database.connection
        .prepare("SELECT 1 FROM projection_channel_reads WHERE channel_id = ? AND topic_id = ? AND member_id = ?")
        .get(channelId, topicId, memberId) !== undefined
    );
  }
}

/**
 * Every routine this channel ever owned, not only the ones it owns now.
 *
 * `RoutineStore.delete()` drops the projection row and keeps the event log, so a routine the user
 * deleted before the channel is invisible to `projection_channel_routines`. Its instruction text
 * lives on in the `channel-routine.created` payload, and permanent deletion promises that no such
 * text stays behind. The event log names its owner, and the run rows carry the channel, so the two
 * together cover a routine whichever of them outlived it.
 */
function channelRoutineIds(db: DatabaseSync, channelId: string): string[] {
  const ids = new Set<string>();
  for (const row of databaseRows(
    db
      .prepare(
        `SELECT DISTINCT aggregate_id FROM orchestration_events
         WHERE aggregate_type = 'channel-routine' AND json_extract(payload_json, '$.ownerId') = ?`,
      )
      .all(channelId),
  )) {
    ids.add(requiredStringColumn(row, "aggregate_id"));
  }
  for (const table of ["projection_channel_routines", "projection_channel_routine_runs"]) {
    for (const row of databaseRows(
      db.prepare(`SELECT DISTINCT routine_id FROM ${table} WHERE channel_id = ?`).all(channelId),
    )) {
      ids.add(requiredStringColumn(row, "routine_id"));
    }
  }
  return [...ids];
}

const CHANNEL_PREVIEW_SOURCE_LIMIT = CHANNEL_PREVIEW_LIMIT * 16;

/**
 * One line for a sidebar row. A message can carry no text at all (an attachment, or a question
 * the agent asked), so fall back to a description of what arrived instead of showing an empty row.
 */
function previewText(entry: ChannelMessage): string {
  // The text is Markdown with mention markup (`@[Chief](agent:chief)`): show what a reader sees.
  // Only the start is parsed, so a very long message does not slow down every channel list.
  const text = markdownPreviewText(entry.message.text.slice(0, CHANNEL_PREVIEW_SOURCE_LIMIT));
  if (text.length > 0) return text.slice(0, CHANNEL_PREVIEW_LIMIT);
  if (entry.message.questionPrompt) return "Asked a question";
  if (entry.message.attachments?.length) return "Sent an attachment";
  return "Sent a message";
}

function isChannelTopic(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.channelId) &&
    isString(value.name) &&
    isString(value.createdAt)
  );
}

function decodeTopic(row: DynamicRecord): ChannelTopic {
  return {
    id: requiredStringColumn(row, "topic_id"),
    channelId: requiredStringColumn(row, "channel_id"),
    name: requiredStringColumn(row, "name"),
    createdAt: requiredStringColumn(row, "created_at"),
    revision: requiredNumberColumn(row, "revision"),
  };
}

function decodeAssignment(value: unknown): ChannelAssignment {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.channelId) ||
    !isString(value.taskId) ||
    !isString(value.agentId) ||
    !(value.pendingRevision === null || typeof value.pendingRevision === "number") ||
    !(value.pendingOutcome === null || isString(value.pendingOutcome)) ||
    !Array.isArray(value.awaitedTaskIds) ||
    !value.awaitedTaskIds.every(isString) ||
    typeof value.taskRevision !== "number" ||
    typeof value.throughSequence !== "number" ||
    typeof value.summaryVersion !== "number" ||
    !(value.deliveryId === null || isString(value.deliveryId)) ||
    !(value.turnId === null || isString(value.turnId)) ||
    !(
      value.state === "queued" ||
      value.state === "starting" ||
      value.state === "running" ||
      value.state === "completed" ||
      value.state === "failed" ||
      value.state === "interrupted"
    )
  )
    throw new Error("Invalid stored channel assignment.");
  return {
    id: value.id,
    channelId: value.channelId,
    taskId: value.taskId,
    agentId: value.agentId,
    taskRevision: value.taskRevision,
    requestMessageId: isString(value.requestMessageId) ? value.requestMessageId : null,
    // An assignment written before resources were stored reads as a host reservation, which
    // conflicts with every other task. That holds the channel until the assignment ends, rather
    // than letting a second agent take a resource this one may still use.
    resources: Array.isArray(value.resources) && value.resources.every(isString) ? value.resources : ["host"],
    awaitedTaskIds: value.awaitedTaskIds,
    pendingRevision: value.pendingRevision,
    pendingOutcome: value.pendingOutcome,
    throughSequence: value.throughSequence,
    summaryVersion: value.summaryVersion,
    deliveryId: value.deliveryId,
    turnId: value.turnId,
    state: value.state,
    // A field that does not read is dropped, not the assignment: it only shows the retry.
    ...(isStartRetryView(value.startRetry) ? { startRetry: value.startRetry } : {}),
    ...(isChannelStartFailure(value.startFailure) ? { startFailure: value.startFailure } : {}),
  };
}

function pruneChannelEvents(db: DatabaseSync, channelId: string): void {
  const retained = databaseRow(
    db
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE aggregate_type = 'channel' AND aggregate_id = ?",
      )
      .get(channelId),
  );
  if (retained === null || retained === undefined) return;
  const retainedSequence = requiredNumberColumn(retained, "sequence");
  const older = "aggregate_type = 'channel' AND aggregate_id = ? AND event_type = 'channel.changed' AND sequence < ?";
  const commandIds = databaseRows(
    db.prepare(`SELECT command_id FROM orchestration_events WHERE ${older}`).all(channelId, retainedSequence),
  ).map((row) => requiredStringColumn(row, "command_id"));
  if (commandIds.length === 0) return;
  db.prepare(`DELETE FROM orchestration_events WHERE ${older}`).run(channelId, retainedSequence);
  deleteReceiptsOf(db, commandIds);
}
