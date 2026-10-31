// Checks Force now on a queued message (`forceQueuedMessage`, queue-force-v1). Runs the real agent
// service, mailbox and drain on a temporary profile with a fake Codex app-server whose turns run until
// the control file lets them end. Cases:
// 1. A turn runs and three messages wait. A force of the third one (two clicks) sends one
//    `turn/interrupt`, the next `turn/start` carries only that message, and then the first and the
//    second start together, in queue order.
// 2. The turn that the person saw ends before the Stop, while a cap of 0 running agents holds the
//    queue. The force sends no `turn/interrupt`, and the message starts once, alone.
// 3. The provider refuses the Stop. The force fails, the queue keeps its order and the message waits.
// 4. A channel request waits at the head of the agent's queue. The force sends no `turn/interrupt`
//    and answers `next`: the channel turn starts first, then the message.
// 5. A message starts and has no turn id yet. The force waits for that start, stops the turn that it
//    starts, and the forced message starts next, alone.
// `bun scripts/queue-force-e2e.ts`. Writes .openbot-build/queue-force-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ForceQueuedMessageResult } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/queue-force-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-queue-force-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
process.env.OPENBOT_FAKE_CODEX_CONTROL = controlPath;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A Codex app-server with the methods that the service calls. `control.json` sets how turns behave:
 * `holdTurns` keeps each turn running until it is false (then every turn ends), `interruptFails` makes
 * `turn/interrupt` fail, and `startDelayMs` answers `turn/start` late.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const control = () => JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
/** turnId -> threadId of each turn that runs. */
const running = new Map();
/** The short-lived threads of the prompt review. Their turns end at once and are not agent turns. */
const reviewThreads = new Set();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
process.on("SIGTERM", () => process.exit(0));
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turnId, status) => {
  const threadId = running.get(turnId);
  if (threadId === undefined) return;
  running.delete(turnId);
  log({ turnEnded: turnId, threadId, status });
  if (status === "completed") {
    const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
    write({ method: "item/completed", params: { threadId, turnId, item } });
  }
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
};
// A turn runs while the control file holds turns. Then every turn ends by itself.
setInterval(() => {
  if (running.size === 0) return;
  let current;
  try {
    current = control();
  } catch {
    return;
  }
  if (current.holdTurns) return;
  for (const turnId of [...running.keys()]) finish(turnId, "completed");
}, 25);
const texts = (input) =>
  (Array.isArray(input) ? input : []).flatMap((item) => (item && typeof item.text === "string" ? [item.text] : []));
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": {
      const threadId = "thread-" + (++threads);
      if (params.ephemeral) reviewThreads.add(threadId);
      return write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    }
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      if (reviewThreads.has(params.threadId)) {
        write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
        running.set(turnId, params.threadId);
        return finish(turnId, "completed");
      }
      log({ turnRequested: turnId, threadId: params.threadId });
      const start = () => {
        write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
        running.set(turnId, params.threadId);
        log({ turnStarted: turnId, threadId: params.threadId, texts: texts(params.input) });
      };
      const delay = control().startDelayMs || 0;
      if (delay > 0) setTimeout(start, delay);
      else start();
      return;
    }
    case "turn/interrupt": {
      if (control().interruptFails) {
        log({ interruptRefused: params.turnId });
        return write({ id: message.id, error: { code: -32603, message: "The fake provider refuses this stop." } });
      }
      write({ id: message.id, result: {} });
      return finish(params.turnId, "interrupted");
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
      log({ method: message.method ?? null, id: message.id ?? null, params: message.params ?? null });
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface Control {
  holdTurns: boolean;
  interruptFails?: boolean;
  startDelayMs?: number;
}

/** One line of the fake Codex log: a message that Builders Bot sent, or a fact that the fake reports. */
interface ProtocolEntry {
  method: string | null;
  threadId: string | null;
  turnId: string | null;
  turnStarted: string | null;
  turnEnded: string | null;
  status: string | null;
  interruptRefused: string | null;
  texts: string[];
}

interface CaseReport {
  name: string;
  outcome: ForceQueuedMessageResult["outcome"] | null;
  error: string | null;
  /** The `turn/interrupt` requests that Builders Bot sent for the agent's turns. */
  interrupts: string[];
  /** The marked messages of each turn that started after the force, in start order. */
  turnsAfterForce: string[][];
  queueOrderAfterForce: string[];
  passed: boolean;
}

const report: { cases: CaseReport[]; passed: boolean; error?: string } = { cases: [], passed: false };

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

function protocol(): ProtocolEntry[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => protocolEntry(JSON.parse(line)));
  } catch {
    return [];
  }
}

function protocolEntry(value: unknown): ProtocolEntry {
  const entry = isRecord(value) ? value : {};
  const params = isRecord(entry.params) ? entry.params : {};
  return {
    method: getString(entry, "method"),
    threadId: getString(params, "threadId") ?? getString(entry, "threadId"),
    turnId: getString(params, "turnId"),
    turnStarted: getString(entry, "turnStarted"),
    turnEnded: getString(entry, "turnEnded"),
    status: getString(entry, "status"),
    interruptRefused: getString(entry, "interruptRefused"),
    texts: Array.isArray(entry.texts) ? entry.texts.filter((text): text is string => typeof text === "string") : [],
  };
}

/** Waits for a state of the service or of the fake Codex. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const setControl = (control: Control) => writeFile(controlPath, JSON.stringify(control));

await setControl({ holdTurns: false });
await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new BuildersBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
/** The person's cap on agents that run turns at the same time. Case 2 sets it to 0 to hold the queue. */
let agentCap: number | null = null;
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  agentLimit: () => agentCap,
});

const status = (deliveryId: string) => mailbox.getDelivery(deliveryId)?.delivery.status ?? "missing";
const ended = (deliveryId: string) => ["completed", "failed", "interrupted"].includes(status(deliveryId));
const queuedOrder = (agentId: string) =>
  agents
    .listQueue(agentId)
    .deliveries.filter((delivery) => delivery.status === "queued")
    .map((delivery) => delivery.id);
const activeTurnId = async (agentId: string) => (await runCauseEffect(agents.readConversation(agentId))).activeTurnId;
const force = (agentId: string, deliveryId: string, expectedTurnId: string | null) =>
  runCauseEffect(agents.forceQueuedMessage({ agentId, deliveryId, expectedTurnId }));

/** Creates an agent whose first message starts a turn. With `hold`, that turn runs until released. */
async function startAgent(name: string, hold: boolean) {
  await setControl({ holdTurns: hold });
  const first = `${name}-first-${randomUUID()}`;
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Checks Force now on a queued message.",
      avatarSeed: name,
      avatarHue: null,
      initialMessage: first,
    }),
  );
  const started = await waitFor(`${name}: the first turn`, () =>
    protocol().find((line) => line.turnStarted && line.texts.some((text) => text.includes(first))),
  );
  const turnId = started.turnStarted ?? "";
  const threadId = started.threadId ?? "";
  // The turn id that the person's chat shows, which a click on Force now sends.
  await waitForAsync(`${name}: the chat to show the first turn`, async () =>
    hold ? (await activeTurnId(agent.id)) === turnId : (await activeTurnId(agent.id)) === null,
  );
  return { agentId: agent.id, threadId, turnId };
}

async function waitForAsync<T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** Queues messages of the person. Each text is unique, so the fake's log names the turn of each one. */
async function queueMessages(agentId: string, texts: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const text of texts) {
    const receipt = await runCauseEffect(agents.sendMessage({ agentId, text }));
    const deliveryId = receipt.deliveries[0]?.id;
    assert.ok(deliveryId, `${text}: no delivery`);
    ids.push(deliveryId);
  }
  await waitFor("the messages to wait in the queue", () => ids.every((id) => status(id) === "queued"));
  return ids;
}

/** The `turn/interrupt` requests for the turns of these threads. */
const interruptsOn = (threadIds: readonly string[]) =>
  protocol()
    .filter((line) => line.method === "turn/interrupt" && line.threadId !== null && threadIds.includes(line.threadId))
    .map((line) => line.turnId ?? "");

/** The marked texts of each turn that started after `afterTurnId`, in start order. */
function turnsAfter(afterTurnId: string, marks: readonly string[]): string[][] {
  const entries = protocol();
  const from = entries.findIndex((line) => line.turnStarted === afterTurnId);
  return entries
    .slice(from + 1)
    .filter((line) => line.turnStarted)
    .map((line) => {
      const text = line.texts.join("\n");
      return marks
        .map((mark) => ({ mark, at: text.indexOf(mark) }))
        .filter((found) => found.at >= 0)
        .sort((left, right) => left.at - right.at)
        .map((found) => found.mark);
    })
    .filter((found) => found.length > 0);
}

async function runCase(name: string, check: (result: CaseReport) => Promise<void>) {
  const result: CaseReport = {
    name,
    outcome: null,
    error: null,
    interrupts: [],
    turnsAfterForce: [],
    queueOrderAfterForce: [],
    passed: false,
  };
  report.cases.push(result);
  await check(result);
  result.passed = true;
}

try {
  await runCauseEffect(agents.initialize());

  await runCase("force the third of three queued messages", async (result) => {
    const { agentId, threadId, turnId } = await startAgent("force-third", true);
    const marks = ["third-one-4c1d", "third-two-8e2a", "third-three-1f9b"];
    const [one, two, three] = await queueMessages(agentId, marks);
    assert.ok(one && two && three);
    // A double click sends two forces of the same message.
    const outcomes = await Promise.all([force(agentId, three, turnId), force(agentId, three, turnId)]);
    result.outcome = outcomes[0]?.outcome ?? null;
    result.queueOrderAfterForce = queuedOrder(agentId).map((id) => marks[[one, two, three].indexOf(id)] ?? id);
    await setControl({ holdTurns: false });
    await waitFor("the three messages to end", () => [one, two, three].every(ended));
    result.interrupts = interruptsOn([threadId]);
    result.turnsAfterForce = turnsAfter(turnId, marks);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome),
      ["interrupted", "interrupted"],
    );
    assert.deepEqual(result.interrupts, [turnId], "one turn/interrupt, for the turn the person saw");
    assert.deepEqual(result.turnsAfterForce, [[marks[2]], [marks[0], marks[1]]], "the forced message starts alone");
  });

  await runCase("the turn ends before the Stop", async (result) => {
    const { agentId, threadId, turnId } = await startAgent("ended-first", true);
    const marks = ["ended-one-2b7c", "ended-two-6d3e", "ended-three-9a5f"];
    const [one, two, three] = await queueMessages(agentId, marks);
    assert.ok(one && two && three);
    // No agent may start a new turn, so the queue waits when the turn that the person saw ends.
    agentCap = 0;
    await setControl({ holdTurns: false });
    await waitForAsync("the turn to end", async () => (await activeTurnId(agentId)) === null);
    await waitFor("the queue to wait for a free place", () => agents.slotWaitingAgents().includes(agentId));
    const outcome = await force(agentId, three, turnId);
    result.outcome = outcome.outcome;
    result.queueOrderAfterForce = queuedOrder(agentId).map((id) => marks[[one, two, three].indexOf(id)] ?? id);
    agentCap = null;
    agents.agentLimitChanged();
    await waitFor("the three messages to end", () => [one, two, three].every(ended));
    result.interrupts = interruptsOn([threadId]);
    result.turnsAfterForce = turnsAfter(turnId, marks);
    assert.equal(outcome.outcome, "started");
    assert.deepEqual(result.queueOrderAfterForce, [marks[2], marks[0], marks[1]]);
    assert.deepEqual(result.interrupts, [], "no turn/interrupt");
    assert.deepEqual(result.turnsAfterForce, [[marks[2]], [marks[0], marks[1]]], "the message starts once, alone");
  });

  await runCase("the provider refuses the Stop", async (result) => {
    const { agentId, threadId, turnId } = await startAgent("stop-refused", true);
    await setControl({ holdTurns: true, interruptFails: true });
    const marks = ["refused-one-3e8d", "refused-two-7a1c", "refused-three-5b6f"];
    const [one, two, three] = await queueMessages(agentId, marks);
    assert.ok(one && two && three);
    const error = await force(agentId, three, turnId).then(
      () => null,
      (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
    );
    result.error = error;
    result.queueOrderAfterForce = queuedOrder(agentId).map((id) => marks[[one, two, three].indexOf(id)] ?? id);
    result.interrupts = interruptsOn([threadId]);
    assert.equal(error, sourceText("error.backend.forceStopFailed"));
    assert.deepEqual(result.queueOrderAfterForce, marks, "the queue keeps its order");
    assert.equal(status(three), "queued");
    assert.deepEqual(result.interrupts, [turnId]);
    await setControl({ holdTurns: false });
    await waitFor("the three messages to end", () => [one, two, three].every(ended));
    result.turnsAfterForce = turnsAfter(turnId, marks);
    // The force did not go through, so the messages start together, as they do with no force.
    assert.deepEqual(result.turnsAfterForce, [marks]);
  });

  await runCase("channel work waits at the head", async (result) => {
    const { agentId, threadId, turnId } = await startAgent("channel-first", false);
    // A channel reserves only an agent with no turn and an empty queue. The cap keeps its turn from
    // starting, so the channel work waits at the head of the agent's queue.
    agentCap = 0;
    const actor = { id: "local", name: "Alex" };
    const channelId = randomUUID();
    await runCauseEffect(
      agents.channels.command(
        {
          type: "save",
          operationId: randomUUID(),
          channelId,
          draft: {
            name: "force",
            title: "",
            instructions: "Answer each request.",
            members: [{ agentId }],
            leadAgentId: agentId,
          },
        },
        actor,
      ),
    );
    const request = "channel-request-6f2d";
    await runCauseEffect(
      agents.channels.command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId,
          text: request,
          recipientAgentId: agentId,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    await waitFor("the channel work to wait in the agent's queue", () =>
      mailbox.queuedExecutionDeliveryIds(agentId).some((id) => mailbox.taskIdForDelivery(id) === null),
    );
    const mark = "channel-chat-0d4b";
    const [message] = await queueMessages(agentId, [mark]);
    assert.ok(message);
    // The chat shows no turn of its own.
    const outcome = await force(agentId, message, null);
    result.outcome = outcome.outcome;
    result.queueOrderAfterForce = queuedOrder(agentId).map((id) => (id === message ? mark : id));
    assert.equal(outcome.outcome, "next", "the channel work starts first");
    agentCap = null;
    agents.agentLimitChanged();
    await waitFor("the message to end", () => ended(message));
    const channelThreads = protocol()
      .filter((line) => line.turnStarted && line.texts.some((text) => text.includes(request)))
      .map((line) => line.threadId ?? "");
    result.interrupts = interruptsOn([threadId, ...channelThreads]);
    result.turnsAfterForce = turnsAfter(turnId, [request, mark]);
    assert.deepEqual(result.interrupts, [], "no turn/interrupt");
    assert.deepEqual(result.turnsAfterForce.slice(0, 2), [[request], [mark]], "the channel turn starts first");
  });

  await runCase("a start with no turn id yet", async (result) => {
    const { agentId, threadId } = await startAgent("starting", false);
    const marks = ["starting-one-8c3a", "starting-two-2d9e"];
    // The fake answers `turn/start` late, so the first message stays "starting" with no turn id.
    await setControl({ holdTurns: true, startDelayMs: 1_500 });
    const one = (await runCauseEffect(agents.sendMessage({ agentId, text: marks[0] ?? "" }))).deliveries[0]?.id;
    assert.ok(one);
    const startsBefore = protocol().filter((line) => line.method === "turn/start" && line.threadId === threadId).length;
    await waitFor(
      "the late turn/start",
      () =>
        status(one) === "starting" &&
        protocol().filter((line) => line.method === "turn/start" && line.threadId === threadId).length > startsBefore,
    );
    const [two] = await queueMessages(agentId, [marks[1] ?? ""]);
    assert.ok(two);
    // The chat showed the agent at work, with no turn id.
    const outcome = await force(agentId, two, null);
    result.outcome = outcome.outcome;
    const stoppedTurn = protocol().find(
      (line) => line.turnStarted && line.texts.some((text) => text.includes(marks[0] ?? "")),
    )?.turnStarted;
    assert.ok(stoppedTurn);
    await setControl({ holdTurns: false });
    await waitFor("both messages to end", () => ended(one) && ended(two));
    result.interrupts = interruptsOn([threadId]);
    result.turnsAfterForce = turnsAfter(stoppedTurn, marks);
    assert.equal(outcome.outcome, "interrupted");
    assert.deepEqual(result.interrupts, [stoppedTurn], "the turn of the starting message stops");
    assert.deepEqual(result.turnsAfterForce, [[marks[1]]], "the forced message starts next, alone");
  });

  report.passed = report.cases.every((entry) => entry.passed);
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
