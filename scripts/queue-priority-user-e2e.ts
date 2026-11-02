// Checks the switch `queue-priority-user` of the advanced optimizations (beta) on the real agent service,
// mailbox and drain, with a fake Codex app-server whose turns run until the control file lets them end,
// a real switch file (`OptimizationStore`) and a desktop memory reading that the test sets. Cases:
// 1. Switch off (as before): a cap of 1 agent is full, and a message of the person to another agent waits.
// 2. Switch on: the same message starts on one place over the cap, while the first turn still runs. A
//    message to a third agent then waits: there is one extra place only.
// 3. Switch off at `low` memory: a message to an agent whose session is open waits, as before.
// 4. Switch on at `low` memory: that message starts; a message to a second open agent waits while the
//    first runs, and starts when it ends. A message to an agent with no session waits.
// 5. Switch on at `critical` memory: nothing starts.
// `bun scripts/queue-priority-user-e2e.ts`. Writes .openbot-build/queue-priority-user-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { HostMemory, HostMemoryLevel } from "../src/backend/host-memory";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/queue-priority-user-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-queue-priority-"));
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
const { OPTIMIZATIONS_FILE, OptimizationStore } = await import("../src/main/optimization-store");

/** A Codex app-server with the methods that the service calls. `holdTurns` keeps each turn running. */
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
const running = new Map();
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
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      running.set(turnId, params.threadId);
      if (reviewThreads.has(params.threadId)) return finish(turnId, "completed");
      log({ turnStarted: turnId, threadId: params.threadId, texts: texts(params.input) });
      return;
    }
    case "turn/interrupt": {
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

interface CaseReport {
  name: string;
  /** The marks of the turns that started in this case, in start order. */
  started: string[];
  /** The marks of the messages that still waited at the check. */
  waited: string[];
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

/** The texts of each agent turn that the fake started, in start order. */
function startedTexts(): string[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const entry = JSON.parse(line);
        if (!isRecord(entry) || !getString(entry, "turnStarted")) return [];
        const texts = Array.isArray(entry.texts) ? entry.texts.filter((text) => typeof text === "string") : [];
        return [texts.join("\n")];
      });
  } catch {
    return [];
  }
}

const startedMark = (mark: string) => startedTexts().some((text) => text.includes(mark));

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const setControl = (holdTurns: boolean) => writeFile(controlPath, JSON.stringify({ holdTurns }));

/** A desktop memory reading that the test sets. Each change is one sample for `MemoryHold`. */
let level: HostMemoryLevel = "ok";
const memoryListeners = new Set<() => void>();
const memoryPressure: HostMemory = {
  kind: "desktop",
  hostedPlan: false,
  level: () => level,
  turnLimit: () => 64,
  reserveTurn: () => () => {},
  subscribe: (listener) => {
    memoryListeners.add(listener);
    return () => memoryListeners.delete(listener);
  },
};
function setLevel(next: HostMemoryLevel): void {
  level = next;
  for (const listener of [...memoryListeners]) listener();
}

await setControl(false);
await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
mkdirSync(userData, { recursive: true });
const optimizations = new OptimizationStore(join(userData, OPTIMIZATIONS_FILE));
await Effect.runPromise(optimizations.load());
const switchTo = (enabled: boolean) => Effect.runPromise(optimizations.set([{ id: "queue-priority-user", enabled }]));
const database = new BuildersBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
let agentCap: number | null = null;
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  agentLimit: () => agentCap,
  memoryPressure,
  optimizations,
});

const status = (deliveryId: string) => mailbox.getDelivery(deliveryId)?.delivery.status ?? "missing";
/** The agents that the drain held for low memory: it tells each one once in each low period. */
const toldLowMemory = new Set<string>();
agents.on("failure", (failure) => {
  if (failure.code === "host_memory_low" && failure.agentId) toldLowMemory.add(failure.agentId);
});

/** Creates an agent whose first message runs one turn to its end, so its session is open. */
async function openAgent(name: string): Promise<string> {
  const first = `${name}-first-${randomUUID()}`;
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Checks the person's place.",
      avatarSeed: name,
      avatarHue: null,
      initialMessage: first,
    }),
  );
  await waitFor(`${name}: the first turn`, () => startedMark(first));
  await waitFor(`${name}: the first turn to end`, () =>
    agents.runningTurns().every((turn) => turn.agentId !== agent.id),
  );
  return agent.id;
}

async function send(agentId: string, mark: string): Promise<string> {
  const receipt = await runCauseEffect(agents.sendMessage({ agentId, text: mark }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, `${mark}: no delivery`);
  return deliveryId;
}

/** Waits until every turn ended and the queue of each delivery is done. */
async function settle(deliveries: readonly string[]): Promise<void> {
  await setControl(false);
  await waitFor("the turns to end", () =>
    deliveries.every((id) => ["completed", "failed", "interrupted"].includes(status(id))),
  );
  await waitFor("no turn to run", () => agents.runningTurns().length === 0);
}

async function runCase(name: string, check: (result: CaseReport) => Promise<void>) {
  const result: CaseReport = { name, started: [], waited: [], passed: false };
  report.cases.push(result);
  await check(result);
  result.passed = true;
}

try {
  await runCauseEffect(agents.initialize());
  const a = await openAgent("busy-a");
  const b = await openAgent("person-b");
  const c = await openAgent("person-c");

  await runCase("switch off: the full cap holds the person's message", async (result) => {
    agentCap = 1;
    agents.agentLimitChanged();
    await setControl(true);
    const busy = await send(a, "cap-busy-a-1c5e");
    await waitFor("the first turn", () => startedMark("cap-busy-a-1c5e"));
    const held = await send(b, "cap-person-b-7d2a");
    await waitFor("b to wait for a place", () => agents.slotWaitingAgents().includes(b));
    result.waited = status(held) === "queued" ? ["cap-person-b-7d2a"] : [];
    assert.equal(startedMark("cap-person-b-7d2a"), false, "the message does not start while the cap is full");

    // 2. The switch turns on while the message waits: its change wakes the waiting lane.
    await switchTo(true);
    await waitFor("the person's message to start on the extra place", () => startedMark("cap-person-b-7d2a"));
    result.started.push("cap-person-b-7d2a");
    assert.equal(
      agents.runningTurns().some((turn) => turn.agentId === a),
      true,
      "the first turn still runs",
    );
    const third = await send(c, "cap-person-c-4b8f");
    await waitFor("c to wait for a place", () => agents.slotWaitingAgents().includes(c));
    assert.equal(startedMark("cap-person-c-4b8f"), false, "there is one extra place only");
    result.waited.push("cap-person-c-4b8f");
    await settle([busy, held, third]);
    assert.ok(startedMark("cap-person-c-4b8f"), "the third message starts when a place frees");
    agentCap = null;
    agents.agentLimitChanged();
    await switchTo(false);
  });

  await runCase("switch off at low memory: the person's message waits", async (result) => {
    setLevel("low");
    // An agent with no provider session: its first message arrives at low memory, so no turn opened one.
    const fresh = await runCauseEffect(
      agents.createAgent({
        name: "no-session-d",
        description: "Checks the person's place.",
        avatarSeed: "no-session-d",
        avatarHue: null,
        initialMessage: "low-on-d-8f2b",
      }),
    );
    await waitFor("the drain to hold d for memory", () => toldLowMemory.has(fresh.id));
    const noSession = await waitFor("the first message of d", () => {
      const queued = agents.listQueue(fresh.id).deliveries.find((delivery) => delivery.status === "queued");
      return queued?.id;
    });
    const held = await send(b, "low-off-b-3e9c");
    await waitFor("the drain to hold b for memory", () => toldLowMemory.has(b));
    assert.equal(startedMark("low-off-b-3e9c"), false, "nothing starts at low memory with the switch off");
    result.waited.push("low-off-b-3e9c");

    // 4. The switch turns on: the message to the open agent passes.
    await setControl(true);
    await switchTo(true);
    await waitFor("the message to start at low memory", () => startedMark("low-off-b-3e9c"));
    result.started.push("low-off-b-3e9c");
    const second = await send(c, "low-on-c-6a1d");
    await waitFor("the drain to hold c for memory", () => toldLowMemory.has(c));
    assert.equal(startedMark("low-on-c-6a1d"), false, "one turn of the person at a time at low memory");
    result.waited.push("low-on-c-6a1d");
    await setControl(false);
    await waitFor("c to start when b ends", () => startedMark("low-on-c-6a1d"));
    result.started.push("low-on-c-6a1d");
    // Each sample of the memory tries the waiting lanes again.
    setLevel("low");
    await waitFor("c to end", () => status(second) === "completed");
    setLevel("low");
    assert.equal(startedMark("low-on-d-8f2b"), false, "an agent with no open session waits at low memory");
    result.waited.push("low-on-d-8f2b");

    // 5. Critical holds everything. Agent a was not held in this low period, so its notice is the barrier.
    setLevel("critical");
    const critical = await send(a, "critical-a-2c7a");
    await waitFor("the drain to hold a for memory", () => toldLowMemory.has(a));
    assert.equal(startedMark("critical-a-2c7a"), false, "nothing passes at critical memory");
    result.waited.push("critical-a-2c7a");
    setLevel("ok");
    await settle([held, second, noSession, critical]);
    assert.ok(startedMark("low-on-d-8f2b") && startedMark("critical-a-2c7a"), "the held messages start at ok");
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
