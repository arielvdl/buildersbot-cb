// Checks that the plan of a turn keeps few copies in the event log of openbot.db. Each plan update of
// a provider replaced the plan message, and each one wrote a full copy of it to orchestration_events,
// which nothing removed. Now the first update keeps its event and each later one replaces the last.
// Runs the real agent service on a temporary profile with a fake Codex app-server whose turn sends
// PLAN_UPDATES plan updates, one more step done in each. Checks:
//   1. The turn completes.
//   2. The conversation shows the last plan.
//   3. The event log holds at most 4 copies of the plan message, one event of each kind (first
//      update, last update, end of the turn, the write after it), not one for each update. Before,
//      8 updates left 10 copies.
//   4. A rebuild of the thread from the event log gives the same plan.
//   5. After a restart, the conversation shows the same plan.
// No provider, account or network is used. `bun scripts/plan-event-log-e2e.ts`.
// Writes .openbot-build/plan-event-log-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ConversationMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/plan-event-log-e2e");
const PLAN_UPDATES = 8;
const root = await mkdtemp(join(tmpdir(), "openbot-plan-event-log-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { databaseRows, requiredStringColumn } = await import("../src/backend/database/database-rows");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");

// Each turn sends PLAN_UPDATES plan updates, 10 ms apart, then its answer. The last plan has every
// step done, so no plan continuation starts.
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const UPDATES = ${PLAN_UPDATES};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const planAt = (done) =>
  Array.from({ length: UPDATES }, (_, index) => ({ step: "Step " + (index + 1), status: index < done ? "completed" : "pending" }));
const runTurn = (threadId, turnId, update) => {
  if (update <= UPDATES) {
    write({ method: "turn/plan/updated", params: { threadId, turnId, plan: planAt(update) } });
    return setTimeout(() => runTurn(threadId, turnId, update + 1), 10);
  }
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      return runTurn(params.threadId, turnId, 1);
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: {
  checks: { name: string; passed: boolean; detail?: unknown }[];
  passed: boolean;
  checkedAt?: string;
  error?: string;
} = { checks: [], passed: false };

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

/** Waits for a state of the service or its database. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function check(name: string, run: () => unknown | Promise<unknown>) {
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
}

function openService() {
  const database = new BuildersBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const service = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  });
  return { database, store, mailbox, service };
}

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

const isPlanMessage = (value: unknown): boolean =>
  isDynamicRecord(value) && typeof value.id === "string" && value.id.endsWith(":plan");

/** The event type of each copy of a plan message that the events of the thread hold. */
function planCopies(database: InstanceType<typeof BuildersBotDatabase>, threadId: string): string[] {
  const rows = databaseRows(
    database.connection
      .prepare(
        `SELECT event_type, payload_json FROM orchestration_events
         WHERE aggregate_type = 'thread' AND aggregate_id = ? ORDER BY sequence`,
      )
      .all(threadId),
  );
  const copies: string[] = [];
  for (const row of rows) {
    const payload = JSON.parse(requiredStringColumn(row, "payload_json"));
    if (!isDynamicRecord(payload)) continue;
    const messages = [
      ...(Array.isArray(payload.changedMessages) ? payload.changedMessages : []),
      ...(isDynamicRecord(payload.snapshot) && Array.isArray(payload.snapshot.messages)
        ? payload.snapshot.messages
        : []),
      payload.streamedMessage,
    ];
    for (const _copy of messages.filter(isPlanMessage)) copies.push(requiredStringColumn(row, "event_type"));
  }
  return copies;
}

function planOf(messages: ConversationMessage[]) {
  const plan = messages.find((message) => message.id.endsWith(":plan"))?.plan;
  assert.ok(plan, "The conversation has a plan message.");
  return plan;
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
let current = openService();

try {
  await runCauseEffect(current.service.initialize());
  const agent = await runCauseEffect(
    current.service.createAgent({
      name: "Planner",
      description: "Checks the plan copies in the event log.",
      avatarSeed: "planner",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await check("the turn completes", async () => {
    const statuses = await waitFor("the first turn to end", () => {
      const deliveries = current.service.listQueue(agent.id).deliveries;
      return deliveries.length > 0 && deliveries.every((delivery) => ended(delivery.status))
        ? deliveries.map((delivery) => delivery.status)
        : null;
    });
    assert.deepEqual(statuses, ["completed"]);
    return { statuses };
  });

  const threadId = current.store.list().find((candidate) => candidate.id === agent.id)?.threadId;
  assert.ok(threadId, "The agent has a thread.");
  const shown = planOf(current.database.readConversation(agent.id, threadId).messages);
  await check("the conversation shows the last plan", () => {
    assert.equal(shown.steps.length, PLAN_UPDATES);
    assert.ok(
      shown.steps.every((step) => step.status === "completed"),
      "Every step of the last plan is done.",
    );
    return { steps: shown.steps.length };
  });

  await check("the event log holds at most 4 copies of the plan message", () => {
    const copies = planCopies(current.database, threadId);
    const detail = `${copies.length} copies for ${PLAN_UPDATES} updates: ${copies.join(", ")}`;
    assert.equal(copies.filter((type) => type === "turn.plan-updated").length, 1, detail);
    assert.ok(copies.length <= 4, detail);
    return { copies: copies.length, eventTypes: copies, updates: PLAN_UPDATES };
  });

  await check("a rebuild of the thread from the event log gives the same plan", () => {
    const rebuilt = planOf(current.database.rebuildThreadProjection(threadId).messages);
    assert.deepEqual(rebuilt, shown);
    return { steps: rebuilt.steps.length };
  });

  await check("after a restart, the conversation shows the same plan", async () => {
    await runCauseEffect(current.service.stop());
    current.database.close();
    current = openService();
    await runCauseEffect(current.service.initialize());
    const reopened = planOf(current.database.readConversation(agent.id, threadId).messages);
    assert.deepEqual(reopened, shown);
    return { steps: reopened.steps.length };
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(current.service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  current.database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
