import type { DatabaseSync } from "node:sqlite";

// The tail of the latest schema for new databases. IF NOT EXISTS throughout, as the other schema parts.
//
// A side thread is a second conversation of one agent that runs next to its own chat: the agent keeps
// its identity, workspace and memories, and the thread has a provider session of its own. The agent's
// own chat (`projection_agents.thread_id`) has no row here.
//
// `projection_agent_threads`: one row for each side thread. Deleting the thread deletes the row.
// `legacy_task_id` is the id of a task from before migration 47; mailbox records and Team API clients
// still name the thread by it. It is null for a thread created after 47. `origin` says who started it:
// the person, or the agent with its `start_task` tool. `title_source` says where the title came from:
// the first message (`auto`), the agent's `start_task` call (`agent`), or a rename (`user`). `outcome`
// is the end of the last turn, null before its first turn ends. `error` is the redacted provider error
// of the last failed turn; a new turn clears it. `archived_at` is set when the person or the agent
// archives the thread; an archived thread takes no message until it is restored.
//
// The title lives only here: the roster rewrites `projection_threads.title` to the agent name.
//
// `first_message` is the message that started the thread: the person's first message, or the brief of
// a thread that the agent started. A rename does not change it. `preview` is the last message that the
// person sent. Both are the text as written, cut to 2,000 characters, and empty when no message is
// known. The tab of the thread shows them on hover and in its details. Migration 49 adds them with
// ALTER TABLE, so they come before the branch columns here: a new database and an upgraded one have the
// same column order.
//
// The `branch_*` columns (migration 50) link a branch to the place it was copied from: the source thread
// (the agent's own chat or a side thread), the message the person chose there, and the last copied row
// in the branch. They have no foreign key, because the branch outlives its source. All three are null
// for a thread that is not a branch, or all three are set; the store keeps that rule. They are at the
// end of the column list, where migration 50 adds them, so a new database and an upgraded one match.

// The table as migration 47 created it. Frozen: migration 47 runs it, and a change here would change
// what that shipped migration does.
const V47_AGENT_THREAD_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS projection_agent_threads (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    legacy_task_id TEXT UNIQUE,
    origin TEXT NOT NULL CHECK(origin IN ('user', 'agent')),
    title TEXT NOT NULL,
    title_source TEXT NOT NULL CHECK(title_source IN ('auto', 'agent', 'user')),
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'failed', 'interrupted')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    last_event_sequence INTEGER NOT NULL
  );
`;

const AGENT_THREAD_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS agent_threads_open ON projection_agent_threads(agent_id, updated_at DESC)
    WHERE archived_at IS NULL;
  CREATE INDEX IF NOT EXISTS agent_threads_agent ON projection_agent_threads(agent_id, created_at DESC);
`;

// The latest table, for new databases.
export const AGENT_THREAD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projection_agent_threads (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    legacy_task_id TEXT UNIQUE,
    origin TEXT NOT NULL CHECK(origin IN ('user', 'agent')),
    title TEXT NOT NULL,
    title_source TEXT NOT NULL CHECK(title_source IN ('auto', 'agent', 'user')),
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'failed', 'interrupted')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    last_event_sequence INTEGER NOT NULL,
    first_message TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    branch_source_thread_id TEXT,
    branch_source_message_id TEXT,
    branch_through_message_id TEXT
  );
  ${AGENT_THREAD_INDEX_SQL}
`;

// Migration 47. Every task becomes a side thread with the same thread, title, state and dates: a closed
// task is an archived thread. The task id stays as `legacy_task_id`, so a queued mailbox message and a
// Team API client that name the task still find it. A task row whose thread is gone (written while
// foreign keys were off) is not copied: it has no conversation, and copying it would fail the foreign
// key check and stop the app at startup. The task table is a leaf, so it is dropped with no rebuild.
export const AGENT_THREAD_MIGRATION_SQL = `
  ${V47_AGENT_THREAD_TABLE_SQL}
  ${AGENT_THREAD_INDEX_SQL}
  INSERT INTO projection_agent_threads
    (thread_id, agent_id, legacy_task_id, origin, title, title_source, outcome, error, created_at, updated_at,
     archived_at, last_event_sequence)
  SELECT task.thread_id, task.agent_id, task.task_id, task.origin, task.title,
    CASE task.origin WHEN 'agent' THEN 'agent' ELSE 'auto' END,
    task.outcome, task.error, task.created_at, task.updated_at, task.closed_at, task.last_event_sequence
  FROM projection_agent_tasks AS task
  WHERE task.thread_id IN (SELECT thread_id FROM projection_threads);
  DROP INDEX IF EXISTS agent_tasks_agent;
  DROP TABLE projection_agent_tasks;
`;

// Migration 49. The text of a message row for the two preview columns: its `text` trimmed, or null for
// a routine instruction and for a row whose JSON or text is not as expected, so no row stops the
// upgrade. Each CASE reads the JSON only after the one before it accepts it.
const V49_MESSAGE_TEXT_SQL = `CASE WHEN json_valid(message.message_json) THEN
    CASE WHEN json_type(message.message_json, '$.text') = 'text'
      AND json_extract(message.message_json, '$.source') IS NOT 'routine'
    THEN trim(json_extract(message.message_json, '$.text'), char(9, 10, 13, 32)) END
  END`;

// The shown order of the thread: the order keys of migration 40, then time.
const V49_SHOWN_ORDER_SQL = [
  "group_start",
  "group_first",
  "group_id",
  "turn_rank",
  "created_at",
  "ordinal",
  "message_id",
];

// Migration 49, frozen. Fills the empty preview columns of the side threads in one range of rowids, from
// the messages of each thread. The first message is the first one that the person sent, or for a
// thread that the agent started, its brief, which the agent sends as itself. The preview is the last
// message that the person sent. A message with no text, such as one with only files, is passed over.
// A thread with no such message keeps its empty value. A column that has a value keeps it, so a second
// run changes nothing. A text keeps one character more than the limit, so the next statement can see
// that it was longer and mark the cut.
const V49_AGENT_THREAD_PREVIEW_BACKFILL_SQL = `
  UPDATE projection_agent_threads SET
    first_message = CASE WHEN first_message = '' THEN COALESCE((
      SELECT substr(${V49_MESSAGE_TEXT_SQL}, 1, 2001)
      FROM projection_thread_messages AS message
      WHERE message.thread_id = projection_agent_threads.thread_id
        AND (message.author = 'user' OR (projection_agent_threads.origin = 'agent' AND message.author = 'agent'))
        AND COALESCE(${V49_MESSAGE_TEXT_SQL}, '') <> ''
      ORDER BY ${V49_SHOWN_ORDER_SQL.map((key) => `message.${key}`).join(", ")}
      LIMIT 1
    ), '') ELSE first_message END,
    preview = CASE WHEN preview = '' THEN COALESCE((
      SELECT substr(${V49_MESSAGE_TEXT_SQL}, 1, 2001)
      FROM projection_thread_messages AS message
      WHERE message.thread_id = projection_agent_threads.thread_id
        AND message.author = 'user'
        AND COALESCE(${V49_MESSAGE_TEXT_SQL}, '') <> ''
      ORDER BY ${V49_SHOWN_ORDER_SQL.map((key) => `message.${key} DESC`).join(", ")}
      LIMIT 1
    ), '') ELSE preview END
  WHERE rowid > $after AND rowid <= $through AND (first_message = '' OR preview = '')
`;

// Migration 49, frozen. Cuts a text that the fill found longer than 2,000 characters to 1,999 and adds
// "…", as `messageExcerpt` does, so the details of the thread show that the text continues. A value that
// a column had before the fill is never longer than 2,000 characters, so this statement keeps it.
const V49_AGENT_THREAD_PREVIEW_CUT_SQL = `
  UPDATE projection_agent_threads SET
    first_message = CASE WHEN length(first_message) > 2000
      THEN rtrim(substr(first_message, 1, 1999), char(9, 10, 13, 32)) || '…' ELSE first_message END,
    preview = CASE WHEN length(preview) > 2000
      THEN rtrim(substr(preview, 1, 1999), char(9, 10, 13, 32)) || '…' ELSE preview END
  WHERE rowid > $after AND rowid <= $through AND (length(first_message) > 2000 OR length(preview) > 2000)
`;

/** The threads that one statement of the migration 49 backfill fills. */
const V49_BACKFILL_CHUNK = 500;

/**
 * Migration 49. Adds the two preview columns of a side thread, then fills them from the messages that
 * each thread already has. Only columns are added, so no foreign-key pause and no vacuum. A development
 * profile that ran this version before the fill has the columns already: each column is added only when
 * it is missing. The fill goes in ranges of rowids, so each statement reads a known number of threads.
 */
export function migrateAgentThreadPreviews(db: DatabaseSync): void {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(projection_agent_threads)")
      .all()
      .map((row) => String(row.name)),
  );
  if (!columns.has("first_message"))
    db.exec("ALTER TABLE projection_agent_threads ADD COLUMN first_message TEXT NOT NULL DEFAULT ''");
  if (!columns.has("preview"))
    db.exec("ALTER TABLE projection_agent_threads ADD COLUMN preview TEXT NOT NULL DEFAULT ''");
  const nextRange = db.prepare(
    `SELECT MAX(rowid) AS through FROM (
       SELECT rowid FROM projection_agent_threads WHERE rowid > ? ORDER BY rowid LIMIT ${V49_BACKFILL_CHUNK}
     )`,
  );
  const fill = db.prepare(V49_AGENT_THREAD_PREVIEW_BACKFILL_SQL);
  const cut = db.prepare(V49_AGENT_THREAD_PREVIEW_CUT_SQL);
  // SQLite gives a new row a rowid from 1 up, but a row can carry any rowid that was written into it.
  let after = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const through = nextRange.get(after)?.through;
    if (typeof through !== "number" && typeof through !== "bigint") return;
    fill.run({ after, through });
    cut.run({ after, through });
    after = Number(through);
  }
}
// Migration 50. The branch link, added with no default: no rebuild, no data change, and every existing
// thread gets null, which is a thread that is not a branch. The constant keeps the name it shipped
// with upstream, where it was migration 48.
export const V48_AGENT_THREAD_BRANCH_COLUMNS_SQL = [
  "branch_source_thread_id TEXT",
  "branch_source_message_id TEXT",
  "branch_through_message_id TEXT",
] as const;
