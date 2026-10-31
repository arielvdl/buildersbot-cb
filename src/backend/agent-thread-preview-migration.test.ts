// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { migrateAgentThreadPreviews } from "./agent-threads/agent-thread-schema";
import { AgentThreadStore } from "./agent-threads/agent-thread-store";
import { refreshThreadOrder } from "./database/thread-message-order";
import { runCauseEffect } from "./effect-boundary";
import { BuildersBotDatabase } from "./openbot-database";
import { migrateBuildersBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; a thread gets the wrong first or last
// message (an answer, a routine instruction, a message with only files, a later message, the title of a
// renamed thread); a long or non-ASCII text is cut in the wrong place; a message row that is not as
// expected stops the upgrade; a second run, or a development profile that has the columns already,
// changes a value; a failed upgrade keeps the columns or the marker; a newer or incomplete history is
// changed; a thread past the first range of rowids is not filled. After the upgrade: a new thread does
// not keep its first message, a later message replaces it, or a rename changes it.
const databases: DatabaseSync[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(db, version);
  return db;
}

function migrateUpTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateBuildersBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

const LONG_TEXT = `${"界😀".repeat(1_100)} end`;

/** One message row: its thread, id, turn, author, time, ordinal and JSON. */
type MessageSeed = [thread: string, id: string, turn: string | null, author: string, at: string, json: unknown];

const MESSAGES: MessageSeed[] = [
  // The person's first message, an answer, a message with only files, the person's last message, and
  // a routine instruction after it.
  ["openbot-thread-billing", "m1", "t1", "user", "10:00", { text: "  Export the **billing** data\nfor October  " }],
  ["openbot-thread-billing", "m2", "t1", "assistant", "10:01", { text: "Done." }],
  ["openbot-thread-billing", "m3", "t2", "user", "10:05", { text: "", attachments: [{ name: "a.csv" }] }],
  ["openbot-thread-billing", "m4", "t3", "user", "10:10", { text: "Now as CSV 界 😀" }],
  ["openbot-thread-billing", "m5", "t3", "assistant", "10:11", { text: "Here it is." }],
  ["openbot-thread-billing", "m6", "t4", "user", "10:20", { text: "Daily check", source: "routine" }],
  // A renamed thread.
  ["openbot-thread-renamed", "r1", "t5", "user", "11:00", { text: "Original ask" }],
  ["openbot-thread-renamed", "r2", "t6", "user", "11:05", { text: "Follow up" }],
  // A thread that the agent started: its brief has the agent as its author, and the person sent nothing.
  ["openbot-thread-agent", "b1", "t7", "agent", "12:00", { text: "Research the market", source: "agent" }],
  ["openbot-thread-agent", "b2", "t7", "assistant", "12:01", { text: "Started." }],
  // A long text, and rows whose text is not a string.
  ["openbot-thread-long", "l1", "t8", "user", "13:00", { text: 42 }],
  ["openbot-thread-long", "l2", "t9", "user", "13:01", { note: "no text" }],
  ["openbot-thread-long", "l3", "t10", "user", "13:02", { text: LONG_TEXT }],
];

const THREAD_ROWS = [
  ["openbot-thread-billing", "user", "Billing export", "auto"],
  ["openbot-thread-renamed", "user", "My rename", "user"],
  ["openbot-thread-agent", "agent", "Market research", "agent"],
  ["openbot-thread-long", "user", "Long one", "auto"],
  ["openbot-thread-empty", "user", "No messages", "auto"],
] as const;

/** The agent's own chat and five side threads with their messages, in the columns of schema 48. */
function seedThreads(db: DatabaseSync): void {
  const thread = db.prepare(
    "INSERT INTO projection_threads VALUES (?, 'chief', ?, NULL, '2026-10-01', '2026-10-01', 1)",
  );
  thread.run("openbot-thread-chief", "Chief");
  const side = db.prepare(`INSERT INTO projection_agent_threads
    (thread_id, agent_id, legacy_task_id, origin, title, title_source, outcome, error, created_at, updated_at,
     archived_at, last_event_sequence)
    VALUES (?, 'chief', NULL, ?, ?, ?, NULL, NULL, '2026-10-01', '2026-10-02', NULL, 3)`);
  for (const [threadId, origin, title, titleSource] of THREAD_ROWS) {
    thread.run(threadId, title);
    side.run(threadId, origin, title, titleSource);
  }
  seedMessages(db, MESSAGES);
}

function seedMessages(db: DatabaseSync, messages: readonly MessageSeed[]): void {
  const insert = db.prepare(`INSERT INTO projection_thread_messages
    (thread_id, message_id, turn_id, author, status, item_type, created_at, ordinal, message_json, last_event_sequence)
    VALUES (?, ?, ?, ?, 'completed', NULL, ?, ?, ?, 2)`);
  messages.forEach(([threadId, id, turn, author, at, json], ordinal) => {
    insert.run(threadId, id, turn, author, `2026-10-01T${at}:00.000Z`, ordinal, JSON.stringify(json));
  });
  for (const threadId of new Set(messages.map(([threadId]) => threadId))) refreshThreadOrder(db, threadId);
}

const EXPECTED = [
  {
    thread_id: "openbot-thread-agent",
    title: "Market research",
    title_source: "agent",
    first_message: "Research the market",
    preview: "",
  },
  {
    thread_id: "openbot-thread-billing",
    title: "Billing export",
    title_source: "auto",
    first_message: "Export the **billing** data\nfor October",
    preview: "Now as CSV 界 😀",
  },
  { thread_id: "openbot-thread-empty", title: "No messages", title_source: "auto", first_message: "", preview: "" },
  {
    thread_id: "openbot-thread-long",
    title: "Long one",
    title_source: "auto",
    first_message: Array.from(LONG_TEXT).slice(0, 2_000).join(""),
    preview: Array.from(LONG_TEXT).slice(0, 2_000).join(""),
  },
  {
    thread_id: "openbot-thread-renamed",
    title: "My rename",
    title_source: "user",
    first_message: "Original ask",
    preview: "Follow up",
  },
];

function previews(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT thread_id, title, title_source, first_message, preview FROM projection_agent_threads ORDER BY 1")
    .all();
}

type Rows = Record<string, Record<string, SQLOutputValue>[]>;

/** Every row of every table, by table name. */
function contents(db: DatabaseSync): Rows {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

/** The rows of every table, with the side threads less the two new columns. */
function withoutPreviews(rows: Rows): Rows {
  return {
    ...rows,
    projection_agent_threads: (rows.projection_agent_threads ?? []).map(
      ({ first_message: _first, preview: _preview, ...rest }) => rest,
    ),
  };
}

function columns(db: DatabaseSync): string[] {
  return db
    .prepare("PRAGMA table_info(projection_agent_threads)")
    .all()
    .map((row) => String(row.name));
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 49 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("agent thread preview migration", () => {
  it("fills the first and the last message of each thread at 48 and keeps every other row", () => {
    const db = databaseAt(48);
    seedThreads(db);
    const before = contents(db);
    migrateBuildersBotDatabase(db);
    expect(withoutPreviews(contents(db))).toEqual(before);
    expect(previews(db)).toEqual(EXPECTED);
    expect(columns(db).slice(-3)).toEqual(["last_event_sequence", "first_message", "preview"]);
    expectHealthy(db);
  });

  it("fills the threads that migration 47 makes from the tasks of a database at 46", () => {
    const db = databaseAt(46);
    db.exec(`INSERT INTO projection_threads VALUES
      ('openbot-thread-billing', 'chief', 'Billing export', NULL, '2026-10-01', '2026-10-01', 1)`);
    db.exec(`INSERT INTO projection_agent_tasks
      (task_id, agent_id, thread_id, origin, title, outcome, error, created_at, updated_at, closed_at,
       last_event_sequence)
      VALUES ('agent-task-billing', 'chief', 'openbot-thread-billing', 'user', 'Billing export', NULL, NULL,
        '2026-10-01', '2026-10-02', NULL, 4)`);
    seedMessages(
      db,
      MESSAGES.filter(([threadId]) => threadId === "openbot-thread-billing"),
    );
    const messages = contents(db).projection_thread_messages;
    migrateBuildersBotDatabase(db);
    expect(contents(db).projection_thread_messages).toEqual(messages);
    expect(db.prepare("SELECT legacy_task_id, first_message, preview FROM projection_agent_threads").all()).toEqual([
      {
        legacy_task_id: "agent-task-billing",
        first_message: "Export the **billing** data\nfor October",
        preview: "Now as CSV 界 😀",
      },
    ]);
    expectHealthy(db);
  });

  it("keeps a value that a column already has, and a second run changes nothing", () => {
    const db = databaseAt(48);
    seedThreads(db);
    // A development profile that ran this version before the fill has the columns, some with a value.
    db.exec(`ALTER TABLE projection_agent_threads ADD COLUMN first_message TEXT NOT NULL DEFAULT '';
      ALTER TABLE projection_agent_threads ADD COLUMN preview TEXT NOT NULL DEFAULT '';
      UPDATE projection_agent_threads SET first_message = 'Kept first' WHERE thread_id = 'openbot-thread-billing';
      UPDATE projection_agent_threads SET preview = 'Kept last' WHERE thread_id = 'openbot-thread-renamed';`);
    migrateBuildersBotDatabase(db);
    const filled = previews(db);
    expect(filled).toEqual(
      EXPECTED.map((row) =>
        row.thread_id === "openbot-thread-billing"
          ? { ...row, first_message: "Kept first" }
          : row.thread_id === "openbot-thread-renamed"
            ? { ...row, preview: "Kept last" }
            : row,
      ),
    );
    const after = contents(db);
    db.exec("BEGIN");
    migrateAgentThreadPreviews(db);
    db.exec("COMMIT");
    expect(contents(db)).toEqual(after);
    expectHealthy(db);
  });

  it("passes over a message row whose JSON is not valid, and stops on nothing", () => {
    const db = databaseAt(48);
    seedThreads(db);
    // Written past the CHECK, as a damaged or hand-edited file could hold it.
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.exec(`INSERT INTO projection_thread_messages
      (thread_id, message_id, turn_id, author, status, item_type, created_at, ordinal, message_json, last_event_sequence)
      VALUES ('openbot-thread-empty', 'x1', NULL, 'user', 'completed', NULL, '2026-10-01T09:00:00.000Z', 99,
        '{not json', 2)`);
    db.exec("PRAGMA ignore_check_constraints = OFF");
    db.exec("BEGIN");
    migrateAgentThreadPreviews(db);
    db.exec("COMMIT");
    expect(previews(db)).toEqual(EXPECTED);
  });

  it("fills the threads in every range of rowids", () => {
    const db = databaseAt(48);
    const thread = db.prepare(
      "INSERT INTO projection_threads VALUES (?, 'chief', 'Thread', NULL, '2026-10-01', '2026-10-01', 1)",
    );
    const side = db.prepare(`INSERT INTO projection_agent_threads
      (thread_id, agent_id, legacy_task_id, origin, title, title_source, outcome, error, created_at, updated_at,
       archived_at, last_event_sequence)
      VALUES (?, 'chief', NULL, 'user', 'Thread', 'auto', NULL, NULL, '2026-10-01', '2026-10-01', NULL, 1)`);
    const seeds: MessageSeed[] = [];
    for (let index = 0; index < 1_201; index += 1) {
      const threadId = `openbot-thread-${String(index).padStart(4, "0")}`;
      thread.run(threadId);
      side.run(threadId);
      seeds.push([threadId, `m-${index}`, `t-${index}`, "user", "10:00", { text: `Message ${index}` }]);
    }
    seedMessages(db, seeds);
    migrateBuildersBotDatabase(db);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM projection_agent_threads WHERE first_message = 'Message ' || CAST(substr(thread_id, 16) AS INTEGER) AND preview = first_message",
        )
        .get(),
    ).toEqual({ count: 1_201 });
    expectHealthy(db);
  });

  it("rolls back the columns, the values and the marker after a late failure, then retries", () => {
    const db = databaseAt(48);
    seedThreads(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version = 49
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateBuildersBotDatabase(db)).toThrow("migration to version 49 failed");
    expect(contents(db)).toEqual(before);
    expect(columns(db)).not.toContain("first_message");
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 49").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateBuildersBotDatabase(db);
    expect(previews(db)).toEqual(EXPECTED);
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it fills a thread", () => {
    const db = databaseAt(48);
    seedThreads(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES (50, 'now')");
    expect(() => migrateBuildersBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version = 50; DELETE FROM schema_migrations WHERE version = 20");
    expect(() => migrateBuildersBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(columns(db)).not.toContain("preview");
  });
});

describe("side thread previews after the upgrade", () => {
  it("keeps the first message of a new thread, follows the person's last message, and keeps both on a rename", async () => {
    const database = await createDatabase();
    const store = new AgentThreadStore(database);
    const started = store.create({
      agentId: "chief",
      origin: "user",
      text: "  Plan the launch\nwith dates  ",
      title: "Plan the launch",
      titleSource: "auto",
    });
    expect(started).toMatchObject({
      firstMessage: "Plan the launch\nwith dates",
      preview: "Plan the launch\nwith dates",
    });
    store.setPreview(started.taskId, "Add the budget");
    store.setPreview(started.taskId, "   ");
    store.rename(started.threadId, "Launch");
    expect(store.task(started.taskId)).toMatchObject({
      title: "Launch",
      firstMessage: "Plan the launch\nwith dates",
      preview: "Add the budget",
    });

    // The brief of a thread that the agent started is its first message, not a message of the person.
    const delegated = store.create({
      agentId: "chief",
      origin: "agent",
      text: "Research the market",
      title: "Market research",
      titleSource: "agent",
    });
    expect(delegated).toMatchObject({ firstMessage: "Research the market", preview: "" });
    store.setPreview(delegated.taskId, "Focus on Europe");
    expect(store.task(delegated.taskId)).toMatchObject({
      firstMessage: "Research the market",
      preview: "Focus on Europe",
    });

    // A long text is cut by characters, so the cut does not split one in two.
    const long = store.create({
      agentId: "chief",
      origin: "user",
      text: LONG_TEXT,
      title: "Long",
      titleSource: "auto",
    });
    expect(long.firstMessage).toBe(Array.from(LONG_TEXT).slice(0, 2_000).join(""));
    database.close();
  });

  it("reads the first message that the person sent in the agent's own chat", async () => {
    const database = await createDatabase();
    database.replaceAgents("seed-first-message", [testAgent()], "agents.updated");
    expect(database.readFirstPersonMessageText("chief", "openbot-thread-chief")).toBeNull();
    database.persistConversation(
      {
        agentId: "chief",
        threadId: "openbot-thread-chief",
        activeTurnId: null,
        revision: 0,
        messages: [
          message("c1", "user", "Daily check", "09:00", "routine"),
          message("c2", "user", "   ", "09:01"),
          message("c3", "user", "Plan the Q4 launch", "09:02"),
          message("c4", "assistant", "Sure.", "09:03"),
          message("c5", "user", "And the budget", "09:04"),
        ],
      },
      "conversation.saved",
    );
    expect(database.readFirstPersonMessageText("chief", "openbot-thread-chief")).toBe("Plan the Q4 launch");
    // Another agent cannot read the chat by its thread id.
    expect(database.readFirstPersonMessageText("helper", "openbot-thread-chief")).toBeNull();
    database.close();
  });
});

function message(id: string, author: "user" | "assistant", text: string, at: string, source?: "routine") {
  return {
    id,
    author,
    text,
    status: "completed" as const,
    createdAt: `2026-10-01T${at}:00.000Z`,
    ...(source ? { source } : {}),
  };
}

async function createDatabase(): Promise<BuildersBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "openbot-thread-preview-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  await runCauseEffect(database.initialize());
  return database;
}

function testAgent(): AgentSummary {
  return {
    id: "chief",
    provider: "codex",
    name: "Chief",
    title: "Coordinator",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "openbot-thread-chief",
    workspacePath: "/tmp/openbot-chief",
    preview: "",
    updatedAt: "2026-10-01T09:00:00.000Z",
    avatarSeed: "chief",
    avatarHue: null,
    avatarUrl: null,
  };
}
