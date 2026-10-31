// Runs the real `ProviderRuntime` idle check with a fake Antigravity ACP server, with a short idle check
// interval. Checks that an assigned provider with no turn keeps its process while memory is `ok`, stops
// it at the next check once memory is low (`ProviderHooks.memoryLow`), keeps it while a turn runs even
// when memory is low, and starts it again for the next turn.
// `bun scripts/provider-idle-release-e2e.ts`. Writes .openbot-build/provider-idle-release-e2e/report.json.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import { AgentStore } from "../src/backend/agent-store";
import { ANTIGRAVITY_MANIFEST } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { BuildersBotDatabase } from "../src/backend/openbot-database";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";

const OUT = resolve(import.meta.dirname, "../.openbot-build/provider-idle-release-e2e");
const WAIT_MS = 15_000;
const IDLE_CHECK_MS = 100;
/** Idle checks that must pass with the process still running. */
const KEPT_CHECKS = 3;

// An ACP server with one model. It writes its pid to `FAKE_AGY_LOG` when it starts.
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const NL = String.fromCharCode(10);
fs.appendFileSync(process.env.FAKE_AGY_LOG, process.pid + NL);
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + NL);
function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize")
    return write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (message.method === "session/new")
    return write({ id: message.id, result: {
      sessionId: "s-" + message.id,
      models: { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" },
    } });
  write({ id: message.id, result: {} });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
setInterval(() => {}, 1000);
`;

interface Report {
  passed: boolean;
  /** The process ran on through these idle checks while memory was `ok`. */
  keptWhileMemoryOk?: number;
  stoppedWhenMemoryLow?: boolean;
  /** The process ran on through these idle checks while memory was low and a turn ran. */
  keptWhileBusy?: number;
  startedAgain?: boolean;
  starts?: number;
  error?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-provider-idle-release-e2e-"));
const log = join(root, "agy.log");
const report: Report = { passed: false };
process.env.FAKE_AGY_LOG = log;

/** Waits for a condition that another fiber or process changes, and fails after `WAIT_MS`. */
async function waitFor(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resume) => setTimeout(resume, 20));
  }
}

async function starts(): Promise<number> {
  return (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
}

const executable = join(root, "agy", "1.2.1", "bin", "agy_acp_server");
await mkdir(join(root, "agy", "1.2.1", "bin"), { recursive: true });
await writeFile(join(root, "agy", "1.2.1", ANTIGRAVITY_MANIFEST), JSON.stringify({ version: "1.2.1" }));
await writeFile(executable, FAKE_AGY);
await chmod(executable, 0o755);

let memoryLow = false;
let busy = false;
/** Each idle check reads the memory level one time, so this counts the checks. */
let checks = 0;

const store = new AgentStore(join(root, "profile"), join(root, "home"), new BuildersBotDatabase(join(root, "profile")));
const providers = new ProviderRuntime({
  offProviders: BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter((id) => id !== "antigravity"),
  conversation: new ConversationRuntime(
    store,
    () => undefined,
    () => store.list(),
  ),
  hooks: {
    bindClient: () => undefined,
    onProvidersReady: () => Effect.void,
    onProviderLost: () => undefined,
    onClientStopped: () => Effect.void,
    isStopping: () => false,
    isProviderBusy: () => busy,
    isAgentBusy: () => false,
    isProviderAssigned: () => true,
    memoryLow: () => {
      checks += 1;
      return memoryLow;
    },
    onAgentClientLost: () => Effect.void,
    sharedRoot: () => join(root, "shared"),
    onProviderResumed: () => undefined,
    onProviderActivated: () => Effect.void,
    captureConfigRevision: () => 0,
  },
  emit: () => undefined,
  emitError: () => undefined,
  requestTimeoutMs: 5_000,
  idleCheckMs: IDLE_CHECK_MS,
  preferredProvider: "antigravity",
  clientFactory: null,
  bundledExecutables: { antigravity: executable },
  credentials: { ...NO_PROVIDER_CREDENTIALS, providerTempDirectory: join(root, "temp") },
  redactMcp: (text) => text,
});
const running = () => providers.currentClient("antigravity") !== null;

try {
  await runCauseEffect(providers.start());
  assert.equal(providers.isReady(), true, "The provider must be ready.");
  assert.equal(running(), true);

  // 1. Memory is ok: an assigned provider keeps its process for `PROVIDER_IDLE_RELEASE_MS`.
  const okFrom = checks;
  await waitFor("idle checks while memory is ok", () => checks >= okFrom + KEPT_CHECKS);
  report.keptWhileMemoryOk = checks - okFrom;
  assert.equal(running(), true, "The process must stay while memory is ok.");

  // 2. Memory is low and a turn runs: the process stays.
  busy = true;
  memoryLow = true;
  const busyFrom = checks;
  await waitFor("idle checks while a turn runs", () => checks >= busyFrom + KEPT_CHECKS);
  report.keptWhileBusy = checks - busyFrom;
  assert.equal(running(), true, "The process must stay while a turn runs.");

  // 3. The turn ends while memory is low: the process stops after one idle check with no turn.
  busy = false;
  await waitFor("the stop of the idle process", () => !running());
  report.stoppedWhenMemoryLow = true;

  // 4. The next turn starts the provider again.
  memoryLow = false;
  await runCauseEffect(providers.ensureProvider("antigravity"));
  report.startedAgain = running();
  report.starts = await starts();
  assert.equal(report.startedAgain, true, "The next turn must start the provider again.");
  assert.equal(report.starts, 2, "The provider must start one time at launch and one time for the next turn.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  for (const client of await runCauseEffect(providers.dispose())) await runCauseEffect(client.stop());
  const pids = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // Already stopped.
    }
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
