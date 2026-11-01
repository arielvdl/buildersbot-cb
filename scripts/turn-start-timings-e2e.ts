// Measures the steps of a turn start (`src/backend/agent/start-timings.ts`) on the real agent service,
// mailbox and drain, with a fake Codex app-server as the provider and its ephemeral threads as the
// models of the security review and of the prompt guard scan. The fake answers at once, so the numbers
// of the first round are Builders Bot's own part. In the second round each ephemeral turn takes
// `REVIEW_DELAY_MS`, as a model generation would. Each round sends `MESSAGES` messages of the person,
// one at a time, and writes the spans through the real local trace (`TraceFile`). Checks:
//   1. Each message of the person gets the steps, with names, numbers and status words only.
//   2. The review and the scan run one after the other, before `turn/start`: two generations for each
//      message, and the time of the start is about their sum.
//   3. The spans reach `trace.ndjson`, and its summary has them by step.
// No account or network is used. `bun scripts/turn-start-timings-e2e.ts`. Writes
// .openbot-build/turn-start-timings-e2e/report.json with the numbers of each round.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { StartTiming } from "../src/backend/agent/start-timings";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { getString, isRecord } from "../src/backend/protocol";
import { TraceFile } from "../src/main/trace-file";

const OUT = resolve(import.meta.dirname, "../.openbot-build/turn-start-timings-e2e");
const MESSAGES = 8;
const REVIEW_DELAY_MS = 800;
const root = await mkdtemp(join(tmpdir(), "openbot-start-timings-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex");

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
 * A Codex app-server with the methods that the service calls. Each agent turn sends one text delta at
 * once, then ends. `reviewDelayMs` in the control file is the time that a turn of an ephemeral thread
 * (a security review or a scan, `WarmGenerations`) takes, as the generation of a model would.
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
      if (reviewThreads.has(params.threadId)) {
        // Out of \`running\` until it ends, so the timer that ends agent turns does not end it sooner.
        log({ reviewTurn: turnId });
        const end = () => {
          running.set(turnId, params.threadId);
          finish(turnId, "completed");
        };
        const delay = control().reviewDelayMs || 0;
        if (delay > 0) setTimeout(end, delay);
        else end();
        return;
      }
      running.set(turnId, params.threadId);
      log({ turnStarted: turnId, threadId: params.threadId, texts: texts(params.input) });
      write({ method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId, itemId: "message-" + turnId, delta: "Working." } });
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

interface StageNumbers {
  count: number;
  p50Ms: number;
  maxMs: number;
  outcomes: Record<string, number>;
}

interface RoundReport {
  reviewDelayMs: number;
  messages: number;
  /** The generations of ephemeral threads (review and scan) for each message of the person. */
  generationsPerMessage: number;
  stages: Record<string, StageNumbers>;
  /** The mean of review + scan, and of `accepted`, the whole start. */
  reviewPlusScanMs: number;
  acceptedMs: number;
}

const report: {
  passed: boolean;
  rounds: RoundReport[];
  traceSummary?: unknown;
  error?: string;
} = { passed: false, rounds: [] };

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

/** The turns of ephemeral threads that the fake ran: one for each review and each scan. */
function reviewTurns(): number {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const entry = JSON.parse(line);
        return isRecord(entry) && getString(entry, "reviewTurn") !== null;
      }).length;
  } catch {
    return 0;
  }
}

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

function numbers(timings: readonly StartTiming[]): Record<string, StageNumbers> {
  const stages: Record<string, StageNumbers> = {};
  const byStage = new Map<string, StartTiming[]>();
  for (const timing of timings) byStage.set(timing.stage, [...(byStage.get(timing.stage) ?? []), timing]);
  for (const [stage, list] of byStage) {
    const sorted = list.map((timing) => timing.durationMs).sort((left, right) => left - right);
    const outcomes: Record<string, number> = {};
    for (const timing of list) outcomes[timing.outcome] = (outcomes[timing.outcome] ?? 0) + 1;
    stages[stage] = {
      count: sorted.length,
      p50Ms: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
      outcomes,
    };
  }
  return stages;
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

await writeFile(controlPath, JSON.stringify({ holdTurns: false, reviewDelayMs: 0 }));
await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new BuildersBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const trace = new TraceFile({ directory: join(root, "logs") });
const timings: StartTiming[] = [];
agents.on("startTiming", (timing) => {
  timings.push(timing);
  trace.record({ kind: "start", name: timing.stage, durationMs: timing.durationMs, outcome: timing.outcome });
});
const status = (deliveryId: string) => mailbox.getDelivery(deliveryId)?.delivery.status ?? "missing";

try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "timings",
      description: "Measures the start of a turn.",
      avatarSeed: "timings",
      avatarHue: null,
      initialMessage: `warm-up-${randomUUID()}`,
    }),
  );
  await waitFor(
    "the first turn to end",
    () => timings.some((timing) => timing.stage === "accepted") && agents.runningTurns().length === 0,
  );

  for (const reviewDelayMs of [0, REVIEW_DELAY_MS]) {
    await writeFile(controlPath, JSON.stringify({ holdTurns: false, reviewDelayMs }));
    timings.length = 0;
    const reviewsBefore = reviewTurns();
    for (let index = 0; index < MESSAGES; index += 1) {
      const receipt = await runCauseEffect(
        agents.sendMessage({ agentId: agent.id, text: `Please check item ${index} of the list.` }),
      );
      const deliveryId = receipt.deliveries[0]?.id;
      assert.ok(deliveryId);
      await waitFor(`message ${index} to end`, () => status(deliveryId) === "completed");
      await waitFor(
        `the first output of message ${index}`,
        () => timings.filter((timing) => timing.stage === "first-output").length > index,
      );
    }
    const stages = numbers(timings);
    for (const stage of ["client", "prepare", "thread", "review", "scan", "turn-start", "accepted", "first-output"])
      assert.equal(stages[stage]?.count, MESSAGES, `one ${stage} span for each message`);
    for (const timing of timings) {
      assert.ok(Number.isInteger(timing.durationMs) && timing.durationMs >= 0, "a whole number of milliseconds");
      assert.match(timing.outcome, /^[a-z-]+$/u, "a status word, never a text");
    }
    const generationsPerMessage = (reviewTurns() - reviewsBefore) / MESSAGES;
    const byStage = (stage: string) =>
      timings.filter((timing) => timing.stage === stage).map((timing) => timing.durationMs);
    const reviewPlusScan = byStage("review").map((review, index) => review + (byStage("scan")[index] ?? 0));
    report.rounds.push({
      reviewDelayMs,
      messages: MESSAGES,
      generationsPerMessage,
      stages,
      reviewPlusScanMs: mean(reviewPlusScan),
      acceptedMs: mean(byStage("accepted")),
    });
    assert.equal(generationsPerMessage, 2, "a review and a scan for each message of the person");
    if (reviewDelayMs > 0) {
      // The two generations run one after the other: the start waits for their sum.
      assert.ok(mean(reviewPlusScan) >= 2 * reviewDelayMs, "the review and the scan add up");
      assert.ok(mean(byStage("accepted")) >= 2 * reviewDelayMs, "the start waits for both");
    }
  }
  await Effect.runPromise(trace.flush());
  const summary = await Effect.runPromise(trace.summarize());
  report.traceSummary = summary.filter((group) => group.kind === "start");
  assert.ok(
    summary.some((group) => group.kind === "start" && group.name === "review" && group.count >= MESSAGES),
    "the spans reach the local trace",
  );
  const text = readFileSync(join(root, "logs", "trace.ndjson"), "utf8");
  assert.equal(text.includes("Please check item"), false, "the trace has no text of a message");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  await Effect.runPromise(trace.close()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
