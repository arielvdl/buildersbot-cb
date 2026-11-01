// Checks the start retry of a turn (`src/backend/agent/start-retry.ts`). Runs the real agent service
// on a temporary profile with the real `CodexAppServerClient`, which talks to a stand-in `codex`
// app-server. The stand-in refuses `turn/start` on a model as many times as `control.json` says, with
// the text that `control.json` gives, and logs each `turn/start` it reads.
// Checks:
//   1. A 529 that passes on the second start: one turn, two starts, no backup, no error.
//   2. A 529 that stays: one start and 3 tries again on the agent's own model with growing waits,
//      then one turn on the agent's backup model, with the switch note; the breaker holds the own model.
//   3. While the breaker waits, a new message goes to the backup model at once, with no start on the own model.
//   4. No backup and no default backup: 1 + 3 starts, then the delivery fails with the provider's text.
//   5. A refusal of the request ("prompt is too long"): one start, no try again, failed.
//   6. A usage limit with "try again after a limit" on: the account moves by itself, and the second start runs.
//   7. A usage limit with that option off: straight to the backup model, one start on the own model.
//   8. An agent with no backup of its own uses the default backup of the settings.
//   9. A restart during a wait keeps the retry (`delivery_json.startRetry`), and the turn runs once.
//  10. A channel task: the task shows the retry (`startRetry`), the channel hold is `retrying`, and after
//      the tries the card shows how many starts ran (`startAttempts`) with no provider text in the record.
//  11. The breaker: after its wait the agent goes back to its own model, one start tries it (no try again),
//      a failure sends it to the backup with a longer wait, and a start that runs closes the breaker.
//  12. No text of a message is in the breakers file or in a start retry record.
// Only a turn with a message id (`clientUserMessageId`) is refused and logged: a Guard scan or a profile
// generation is a turn of the same stand-in, and it must not spend the refusals of a check.
// `bun scripts/start-retry-e2e.ts`. Writes .openbot-build/start-retry-e2e/report.json. Check 11 waits about
// two minutes, because a breaker waits at least one minute; `--quick` leaves it out.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentBackupModels,
  type AgentEvent,
  type AgentModelId,
  DEFAULT_START_RETRY_SETTINGS,
  defaultProviderModel,
  MODEL_SWITCH_ITEM_TYPE_PREFIX,
  type StartRetrySettings,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { StoredStartBreaker } from "../src/backend/agent/start-retry";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const QUICK = process.argv.includes("--quick");
const OUT = resolve(import.meta.dirname, "../.openbot-build/start-retry-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-start-retry-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const codexExecutable = join(root, "codex");
const controlFile = join(root, "control.json");
const startLog = join(root, "starts.jsonl");
const breakersFile = join(root, "breakers.json");
const PRIMARY: AgentModelId = defaultProviderModel("codex");
const BACKUP: AgentModelId = `${PRIMARY}-backup`;
const SPARE: AgentModelId = `${PRIMARY}-spare`;
// A marker that the check looks for in every record that must not keep the text of a message.
const SECRET = `do-not-store-${randomUUID()}`;
const OVERLOADED =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_e2e"}';
const FIVE_HOURS = "You've hit your session limit · resets 8:40pm";
const TOO_LONG = "invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum";

process.env.HOME = home;
process.env.OPENBOT_CODEX_PATH = codexExecutable;
process.env.CODEX_HOME = join(home, ".codex");
// Claude is off in this check, but its search runs: point it at nothing.
process.env.OPENBOT_CLAUDE_PATH = join(root, "no-claude");
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { CodexAppServerClient } = await import("../src/backend/app-server-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");

// The stand-in Codex app-server. `control.json`: { "<model>": { "count": n, "message": "…" } }.
const STAND_IN_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.1"); process.exit(0); }
const threads = new Map();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
const answer = (request) => {
  const params = request.params ?? {};
  const reply = (result) => write({ id: request.id, result });
  const thread = threads.get(params.threadId) ?? { id: params.threadId, turns: [] };
  switch (request.method) {
    case "initialize": return reply({});
    case "account/read": return reply({ account: { type: "chatgpt", email: "codex@example.com" } });
    case "account/rateLimits/read": return reply({ rateLimits: null, rateLimitsByLimitId: null });
    case "model/list": return reply({ data: [
      { model: ${JSON.stringify(PRIMARY)}, displayName: "Primary" },
      { model: ${JSON.stringify(BACKUP)}, displayName: "Backup" },
      { model: ${JSON.stringify(SPARE)}, displayName: "Spare" },
    ] });
    case "plugin/list": return reply({ marketplaces: [] });
    case "config/read": return reply(config);
    case "config/batchWrite": return reply({});
    case "thread/start": {
      const created = { id: randomUUID(), turns: [] };
      threads.set(created.id, created);
      return reply({ thread: created });
    }
    case "thread/resume":
    case "thread/read": return reply({ thread });
    case "thread/unsubscribe": return reply({ status: "Unsubscribed" });
    case "thread/turns/list": return reply({ data: thread.turns.toReversed(), nextCursor: null });
    case "thread/items/list": return reply({ data: [], nextCursor: null });
    case "turn/start": {
      const input = JSON.stringify(params.input);
      const caseId = /case:([a-z0-9-]+)/.exec(input.split("--- current message ---").at(-1))?.[1] ?? "none";
      const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, "utf8"));
      const rule = control[params.model];
      // Only a delivery's turn: a Guard scan or a profile generation sends no message id.
      if (!params.clientUserMessageId) {
        const turn = { id: randomUUID(), status: "inProgress", items: [] };
        thread.turns.push(turn);
        reply({ turn });
        write({ method: "turn/started", params: { threadId: thread.id, turn: { id: turn.id } } });
        setImmediate(() => {
          const item = { type: "agentMessage", id: randomUUID(), phase: "final_answer", text: "{}" };
          turn.items.push(item);
          write({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
          turn.status = "completed";
          write({ method: "turn/completed", params: { threadId: thread.id, turn } });
        });
        return;
      }
      const refuse = rule && rule.count > 0;
      if (refuse) { rule.count -= 1; fs.writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify(control)); }
      fs.appendFileSync(${JSON.stringify(startLog)}, JSON.stringify({ model: params.model, caseId, clientId: params.clientUserMessageId ?? null, refused: Boolean(refuse), at: Date.now() }) + "\\n");
      if (refuse) return write({ id: request.id, error: { code: -32000, message: rule.message } });
      const turn = { id: randomUUID(), status: "inProgress", items: [] };
      thread.turns.push(turn);
      reply({ turn });
      write({ method: "turn/started", params: { threadId: thread.id, turn: { id: turn.id } } });
      setImmediate(() => {
        const item = { type: "agentMessage", id: randomUUID(), phase: "final_answer", text: "Done." };
        turn.items.push(item);
        write({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: thread.id, turn } });
      });
      return;
    }
    case "turn/interrupt": return reply({});
    default: return write({ id: request.id, error: { code: -32601, message: "Method not found: " + request.method } });
  }
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id !== undefined && request.method) answer(request);
  }
});
process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); else throw error; });
`;

interface Start {
  model: string;
  caseId: string;
  clientId: string | null;
  refused: boolean;
  at: number;
}

interface Check {
  name: string;
  passed: boolean;
  detail?: unknown;
}

const report: { checks: Check[]; passed: boolean; checkedAt?: string; error?: string; starts?: unknown } = {
  checks: [],
  passed: false,
};

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function isStart(value: unknown): value is Start {
  return (
    isDynamicRecord(value) &&
    typeof value.model === "string" &&
    typeof value.caseId === "string" &&
    typeof value.refused === "boolean" &&
    typeof value.at === "number"
  );
}

/** The `delivery_json` of each stored delivery, or of one. */
function deliveryRows(deliveryId?: string): string[] {
  const statement = deliveryId
    ? database.connection.prepare("SELECT delivery_json FROM projection_deliveries WHERE delivery_id = ?")
    : database.connection.prepare("SELECT delivery_json FROM projection_deliveries");
  const rows: unknown[] = deliveryId ? statement.all(deliveryId) : statement.all();
  return rows.flatMap((row) =>
    isDynamicRecord(row) && typeof row.delivery_json === "string" ? [row.delivery_json] : [],
  );
}

function starts(caseId?: string): Start[] {
  try {
    const rows = readFileSync(startLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .filter(isStart);
    return caseId ? rows.filter((row) => row.caseId === caseId) : rows;
  } catch {
    return [];
  }
}

function refuse(rules: Record<string, { count: number; message: string }>) {
  writeFileSync(controlFile, JSON.stringify(rules));
}

// Short waits, so the check runs in seconds: 1 s, then 2 s at most. The breaker waits one minute.
let settings: StartRetrySettings = {
  ...DEFAULT_START_RETRY_SETTINGS,
  firstDelaySeconds: 1,
  maxDelaySeconds: 2,
  breakerMinutes: [1, 1],
};
let storedBreakers: StoredStartBreaker[] = [];

await writeFile(codexExecutable, STAND_IN_CODEX, { mode: 0o755 });
refuse({});
const database = new BuildersBotDatabase(userData);
const events: AgentEvent[] = [];

function startService() {
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const service = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    clientFactory: (_provider, cli) => new CodexAppServerClient(cli.executable, 30000),
    startRetry: {
      settings: () => settings,
      breakers: {
        read: () => storedBreakers,
        write: (breakers) => {
          storedBreakers = breakers.map((entry) => ({ ...entry, pinnedTasks: [...entry.pinnedTasks] }));
          writeFileSync(breakersFile, JSON.stringify({ version: 1, breakers: storedBreakers }));
        },
      },
    },
  });
  service.on("event", (event) => events.push(event));
  return { store, mailbox, service };
}

let { store, mailbox, service } = startService();

async function check(name: string, run: () => Promise<unknown>) {
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
  process.stdout.write(`PASS ${name}\n`);
}

function agentOf(agentId: string) {
  const agent = store.list().find((candidate) => candidate.id === agentId);
  assert.ok(agent, `Agent ${agentId} exists.`);
  return agent;
}

async function createAgent(name: string, backupModels?: AgentBackupModels) {
  // The first message of a new agent starts on a model that the check does not refuse.
  refuse({});
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks the start retry.",
      avatarSeed: randomUUID(),
      avatarHue: null,
      provider: "codex",
      model: PRIMARY,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the first turn to end", () =>
    service.listQueue(agent.id).deliveries.every((delivery) => delivery.status === "completed"),
  );
  if (backupModels) await runCauseEffect(service.updateAgent({ agentId: agent.id, backupModels }));
  return agentOf(agent.id);
}

async function sendOnly(agentId: string, text: string) {
  const receipt = await runCauseEffect(service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  return deliveryId;
}

async function settle(deliveryId: string, label: string, timeoutMs = 60_000) {
  const status = await waitFor(
    label,
    () => {
      const value = mailbox.getDelivery(deliveryId)?.delivery.status;
      return value === "completed" || value === "failed" || value === "interrupted" ? value : null;
    },
    timeoutMs,
  );
  return { status, error: mailbox.getDelivery(deliveryId)?.delivery.error ?? null };
}

async function send(agentId: string, text: string, timeoutMs?: number) {
  const deliveryId = await sendOnly(agentId, text);
  return { deliveryId, ...(await settle(deliveryId, `"${text}" to end`, timeoutMs)) };
}

async function switchNotes(agentId: string) {
  const snapshot = await runCauseEffect(service.readConversation(agentId));
  return snapshot.messages.filter((message) => message.itemType?.startsWith(MODEL_SWITCH_ITEM_TYPE_PREFIX)).length;
}

const backupOnly: AgentBackupModels = { automatic: true, order: [{ provider: "codex", model: BACKUP }] };

/** The waits between the starts of one case, in milliseconds. */
const gaps = (rows: Start[]) => rows.slice(1).map((row, index) => row.at - (rows[index]?.at ?? row.at));

try {
  await runCauseEffect(service.initialize());

  await check("a 529 that passes on the second start runs one turn, with no backup", async () => {
    const agent = await createAgent("Brief", backupOnly);
    refuse({ [PRIMARY]: { count: 1, message: OVERLOADED } });
    const notes = await switchNotes(agent.id);
    const outcome = await send(agent.id, `case:brief ${SECRET}`);
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    const rows = starts("brief");
    assert.deepEqual(
      rows.map((row) => [row.model, row.refused]),
      [
        [PRIMARY, true],
        [PRIMARY, false],
      ],
    );
    assert.equal(new Set(rows.map((row) => row.clientId)).size, 1, "Each start sends the same message id.");
    assert.equal(agentOf(agent.id).model, PRIMARY, "The agent stays on its own model.");
    assert.equal(await switchNotes(agent.id), notes, "No switch note.");
    assert.equal(storedBreakers.length, 0, "No breaker.");
    return { gaps: gaps(rows) };
  });

  const persistent = await createAgent("Persistent", backupOnly);
  await check("a 529 that stays: 1 + 3 starts with growing waits, then one turn on the backup", async () => {
    refuse({ [PRIMARY]: { count: 100, message: OVERLOADED } });
    const notes = await switchNotes(persistent.id);
    const outcome = await send(persistent.id, `case:persistent ${SECRET}`);
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    const rows = starts("persistent");
    assert.deepEqual(
      rows.map((row) => [row.model, row.refused]),
      [
        [PRIMARY, true],
        [PRIMARY, true],
        [PRIMARY, true],
        [PRIMARY, true],
        [BACKUP, false],
      ],
    );
    const waits = gaps(rows.slice(0, 4));
    // 1 s, 2 s and 2 s, each 25% up or down, plus the time of a start.
    assert.ok(waits[0] !== undefined && waits[0] >= 700 && waits[0] < 2500, `First wait: ${waits[0]}`);
    assert.ok(waits[1] !== undefined && waits[1] >= 1400 && waits[1] < 3500, `Second wait: ${waits[1]}`);
    assert.ok(waits[2] !== undefined && waits[2] >= 1400 && waits[2] < 3500, `Third wait: ${waits[2]}`);
    assert.equal(agentOf(persistent.id).model, BACKUP, "The agent runs on its backup model.");
    assert.equal(await switchNotes(persistent.id), notes + 1, "The chat says that the agent moved.");
    const breaker = storedBreakers.find((entry) => entry.agentId === persistent.id);
    assert.ok(breaker && breaker.model === PRIMARY && breaker.opens === 1, "The breaker holds the own model.");
    assert.ok(Date.parse(breaker.until) > Date.now(), "The breaker waits.");
    return { waits, breaker };
  });

  await check("while the breaker waits, a new message goes to the backup at once", async () => {
    const outcome = await send(persistent.id, "case:during-wait");
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    assert.deepEqual(
      starts("during-wait").map((row) => [row.model, row.refused]),
      [[BACKUP, false]],
      "No start on the own model.",
    );
    return {};
  });

  await check("no backup: 1 + 3 starts, then the delivery fails with the provider's text", async () => {
    const agent = await createAgent("Alone");
    refuse({ [PRIMARY]: { count: 100, message: OVERLOADED } });
    const outcome = await send(agent.id, "case:alone");
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.error?.includes("529"), `The provider's reason stays: ${outcome.error}`);
    assert.equal(starts("alone").length, 4);
    assert.ok(starts("alone").every((row) => row.model === PRIMARY));
    assert.equal(agentOf(agent.id).model, PRIMARY);
    return { error: outcome.error };
  });

  await check("a refusal of the request is not tried again", async () => {
    const agent = await createAgent("Too long", backupOnly);
    refuse({ [PRIMARY]: { count: 100, message: TOO_LONG } });
    const outcome = await send(agent.id, "case:too-long");
    assert.equal(outcome.status, "failed");
    assert.equal(starts("too-long").length, 1, "One start.");
    assert.equal(agentOf(agent.id).model, PRIMARY, "No backup either.");
    return {};
  });

  await check("a usage limit with 'try again' on: the second start runs, with no backup", async () => {
    const agent = await createAgent("Switches account", backupOnly);
    refuse({ [PRIMARY]: { count: 1, message: FIVE_HOURS } });
    const outcome = await send(agent.id, "case:limit-on");
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    assert.deepEqual(
      starts("limit-on").map((row) => [row.model, row.refused]),
      [
        [PRIMARY, true],
        [PRIMARY, false],
      ],
    );
    assert.equal(agentOf(agent.id).model, PRIMARY);
    return {};
  });

  await check("a usage limit with 'try again' off goes to the backup at once", async () => {
    settings = { ...settings, retryAfterUsageLimit: false };
    const agent = await createAgent("Limit off", backupOnly);
    refuse({ [PRIMARY]: { count: 100, message: FIVE_HOURS } });
    const outcome = await send(agent.id, "case:limit-off");
    settings = { ...settings, retryAfterUsageLimit: true };
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    assert.deepEqual(
      starts("limit-off").map((row) => [row.model, row.refused]),
      [
        [PRIMARY, true],
        [BACKUP, false],
      ],
    );
    const breaker = storedBreakers.find((entry) => entry.agentId === agent.id);
    assert.ok(breaker, "The breaker holds the own model.");
    // The message names 8:40pm, so the breaker waits for it when that is later than its own wait.
    assert.ok(Date.parse(breaker.until) - Date.now() > 50_000, "The breaker waits.");
    return { until: breaker.until };
  });

  await check("an agent with no backup of its own uses the default backup of the settings", async () => {
    settings = { ...settings, defaultFallback: { provider: "codex", model: SPARE } };
    const agent = await createAgent("Default backup");
    refuse({ [PRIMARY]: { count: 100, message: OVERLOADED } });
    const outcome = await send(agent.id, "case:default-backup");
    settings = { ...settings, defaultFallback: null };
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    const rows = starts("default-backup");
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.at(-1)?.model, SPARE);
    assert.equal(agentOf(agent.id).model, SPARE);
    return {};
  });

  await check("a restart during a wait keeps the retry, and the turn runs once", async () => {
    settings = { ...settings, firstDelaySeconds: 4, maxDelaySeconds: 4 };
    const agent = await createAgent("Restarts");
    refuse({ [PRIMARY]: { count: 1, message: OVERLOADED } });
    const deliveryId = await sendOnly(agent.id, "case:restart");
    await waitFor("the first start to fail", () => starts("restart").length === 1);
    await waitFor("the retry to be stored", () => mailbox.getDelivery(deliveryId)?.startRetry);
    await runCauseEffect(service.stop());
    const [stored] = deliveryRows(deliveryId);
    assert.ok(stored, "The delivery row is there.");
    const delivery = JSON.parse(stored);
    assert.equal(delivery.status, "queued");
    assert.equal(delivery.startRetry?.attempt, 1, "The stored delivery keeps its retry.");
    assert.ok(!stored.includes("Overloaded"), "The retry keeps no provider text.");
    ({ store, mailbox, service } = startService());
    await runCauseEffect(service.initialize());
    const outcome = await settle(deliveryId, "the restarted retry to end");
    settings = { ...settings, firstDelaySeconds: 1, maxDelaySeconds: 2 };
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    const rows = starts("restart");
    assert.deepEqual(
      rows.map((row) => row.refused),
      [true, false],
      "One refused start, one turn: no start ran twice.",
    );
    return { stored: delivery.startRetry };
  });

  await check("a channel task shows the retry, holds the reviewer, and records the tries", async () => {
    const agent = await createAgent("Member");
    const channelId = randomUUID();
    await runCauseEffect(
      service.channels.command(
        {
          type: "save",
          operationId: randomUUID(),
          channelId,
          draft: {
            name: "retry",
            title: "Retry",
            instructions: "",
            members: [{ agentId: agent.id }],
            leadAgentId: agent.id,
          },
        },
        { id: "person", name: "Person" },
      ),
    );
    settings = { ...settings, firstDelaySeconds: 3, maxDelaySeconds: 3 };
    refuse({ [PRIMARY]: { count: 100, message: OVERLOADED } });
    await runCauseEffect(
      service.channels.command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId,
          text: `case:channel ${SECRET}`,
          recipientAgentId: agent.id,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        { id: "person", name: "Person" },
      ),
    );
    const topicId = service.channels.store.firstTopic(channelId)?.id ?? "";
    const retrying = await waitFor("the task to show the retry", () =>
      service.channels.store.page(channelId, topicId).tasks.find((task) => task.startRetry),
    );
    assert.equal(retrying.state, "queued");
    assert.equal(retrying.error, null, "No card while it tries again.");
    assert.equal(service.channels.queuedHolds().get(retrying.id), "retrying", "The reviewer's hold is `retrying`.");
    const failed = await waitFor("the task to fail after its tries", () =>
      service.channels.store.page(channelId, topicId).tasks.find((task) => task.state === "failed"),
    );
    settings = { ...settings, firstDelaySeconds: 1, maxDelaySeconds: 2 };
    assert.equal(failed.startAttempts, 4, "The card says how many starts ran.");
    assert.equal(starts("channel").length, 4);
    const record = service.channels.store.assignments(channelId).find((assignment) => assignment.startFailure);
    assert.ok(record?.startFailure, "The assignment keeps why.");
    assert.equal(record.startFailure.cause, "provider_unavailable");
    assert.ok(!JSON.stringify(record).includes("Overloaded"), "No provider text in the record.");
    return { startRetry: retrying.startRetry, startFailure: record.startFailure };
  });

  if (!QUICK)
    await check("the breaker: one start tries the own model after the wait, then closes or waits again", async () => {
      // The persistent agent waits on its backup since check 2. Its own model still fails. The next
      // message after the wait takes the agent back, and is the one try of its own model.
      refuse({ [PRIMARY]: { count: 1, message: OVERLOADED } });
      const first = storedBreakers.find((entry) => entry.agentId === persistent.id);
      assert.ok(first);
      // Only while the wait still runs for some seconds, so the message cannot land on its end.
      if (Date.parse(first.until) - Date.now() > 5_000) {
        const beforeWait = await send(persistent.id, "case:before-wait");
        assert.equal(beforeWait.status, "completed", beforeWait.error ?? "");
        assert.deepEqual(
          starts("before-wait").map((row) => row.model),
          [BACKUP],
          "A turn of another agent on the own model does not end the wait of this agent.",
        );
      }
      await waitFor("the breaker wait to end", () => Date.now() > Date.parse(first.until) + 500, 120_000);
      const probe = await send(persistent.id, "case:probe-fails");
      assert.equal(probe.status, "completed", probe.error ?? "");
      assert.deepEqual(
        starts("probe-fails").map((row) => [row.model, row.refused]),
        [
          [PRIMARY, true],
          [BACKUP, false],
        ],
        "The try of the own model has no try again: it goes to the backup.",
      );
      const second = storedBreakers.find((entry) => entry.agentId === persistent.id);
      assert.equal(second?.opens, 2, "The breaker counts the second failure.");
      // The own model works now: after the next wait, one start runs there and the breaker closes.
      refuse({});
      await waitFor("the second wait to end", () => Date.now() > Date.parse(second?.until ?? "") + 500, 120_000);
      const back = await send(persistent.id, "case:probe-passes");
      assert.equal(back.status, "completed", back.error ?? "");
      assert.deepEqual(
        starts("probe-passes").map((row) => [row.model, row.refused]),
        [[PRIMARY, false]],
      );
      assert.equal(agentOf(persistent.id).model, PRIMARY, "The agent is back on its own model.");
      assert.equal(
        storedBreakers.some((entry) => entry.agentId === persistent.id),
        false,
        "The breaker closed.",
      );
      return { first: first.until, second: second?.until };
    });

  await check("no text of a message in the breakers file or a retry record", async () => {
    const breakers = (() => {
      try {
        return readFileSync(breakersFile, "utf8");
      } catch {
        return "";
      }
    })();
    assert.ok(!breakers.includes(SECRET), "The breakers file has no message text.");
    for (const row of deliveryRows()) {
      const delivery = JSON.parse(row);
      if (delivery.startRetry) assert.ok(!JSON.stringify(delivery.startRetry).includes(SECRET));
    }
    return {};
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // The starts that the stand-in read, to see what ran.
  report.starts = starts().map(({ model, caseId, refused, at }) => ({ model, caseId, refused, at }));
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
