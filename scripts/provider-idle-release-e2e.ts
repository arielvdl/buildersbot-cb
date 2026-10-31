// Runs the real `ProviderRuntime` idle check with a fake Antigravity ACP server, with a short idle check
// interval. Checks that an assigned provider with no turn keeps its process while memory is `ok`, keeps
// it while a turn runs even when memory is low, stops it at the second idle check in a row once the turn
// ends while memory is low (`ProviderHooks.memoryLow`, `LOW_MEMORY_IDLE_CHECKS`), and starts it again for
// the next turn. A second runtime checks that a provider no agent is set to counts its idle time from its
// start, so the first check after `PROVIDER_UNASSIGNED_RELEASE_MS` stops it.
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
/** `LOW_MEMORY_IDLE_CHECKS` in `provider-runtime.ts`. */
const LOW_MEMORY_IDLE_CHECKS = 2;

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
  /** The process ran on through these idle checks while memory was low and a turn ran. */
  keptWhileBusy?: number;
  /** The idle checks after the turn ended while memory was low, up to and with the one that stopped it. */
  idleChecksUntilStop?: number;
  startedAgain?: boolean;
  starts?: number;
  /** For a provider no agent is set to: the check, from 1, that stopped it. */
  unassignedStoppedAtCheck?: number;
  error?: string;
}

/** The state of the process at the start of one idle check. Each check reads the memory level one time. */
interface CheckEntry {
  busy: boolean;
  running: boolean;
}

interface Harness {
  readonly providers: ProviderRuntime;
  readonly running: () => boolean;
  readonly checks: CheckEntry[];
  readonly state: { memoryLow: boolean; busy: boolean };
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

/** The number of checks in `entries` up to and with the last one that found the process running. */
function checksUntilStop(entries: readonly CheckEntry[]): number {
  return entries.findLastIndex((entry) => entry.running) + 1;
}

const executable = join(root, "agy", "1.2.1", "bin", "agy_acp_server");
await mkdir(join(root, "agy", "1.2.1", "bin"), { recursive: true });
await writeFile(join(root, "agy", "1.2.1", ANTIGRAVITY_MANIFEST), JSON.stringify({ version: "1.2.1" }));
await writeFile(executable, FAKE_AGY);
await chmod(executable, 0o755);

const harnesses: Harness[] = [];

function makeHarness(name: string, options: { assigned: boolean; unassignedReleaseMs?: number }): Harness {
  const state = { memoryLow: false, busy: false };
  const checks: CheckEntry[] = [];
  const store = new AgentStore(
    join(root, name, "profile"),
    join(root, name, "home"),
    new BuildersBotDatabase(join(root, name, "profile")),
  );
  const providers: ProviderRuntime = new ProviderRuntime({
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
      isProviderBusy: () => state.busy,
      isAgentBusy: () => false,
      isProviderAssigned: () => options.assigned,
      memoryLow: () => {
        checks.push({ busy: state.busy, running: providers.currentClient("antigravity") !== null });
        return state.memoryLow;
      },
      onAgentClientLost: () => Effect.void,
      sharedRoot: () => join(root, name, "shared"),
      onProviderResumed: () => undefined,
      onProviderActivated: () => Effect.void,
      captureConfigRevision: () => 0,
    },
    emit: () => undefined,
    emitError: () => undefined,
    requestTimeoutMs: 5_000,
    idleCheckMs: IDLE_CHECK_MS,
    ...(options.unassignedReleaseMs === undefined ? {} : { unassignedReleaseMs: options.unassignedReleaseMs }),
    preferredProvider: "antigravity",
    clientFactory: null,
    bundledExecutables: { antigravity: executable },
    credentials: { ...NO_PROVIDER_CREDENTIALS, providerTempDirectory: join(root, name, "temp") },
    redactMcp: (text) => text,
  });
  const harness = { providers, running: () => providers.currentClient("antigravity") !== null, checks, state };
  harnesses.push(harness);
  return harness;
}

try {
  const assigned = makeHarness("assigned", { assigned: true });
  await runCauseEffect(assigned.providers.start());
  assert.equal(assigned.providers.isReady(), true, "The provider must be ready.");
  assert.equal(assigned.running(), true);

  // 1. Memory is ok: an assigned provider keeps its process for `PROVIDER_IDLE_RELEASE_MS`.
  const okFrom = assigned.checks.length;
  await waitFor("idle checks while memory is ok", () => assigned.checks.length >= okFrom + KEPT_CHECKS);
  report.keptWhileMemoryOk = assigned.checks.length - okFrom;
  assert.equal(assigned.running(), true, "The process must stay while memory is ok.");

  // 2. Memory is low and a turn runs: the process stays.
  assigned.state.busy = true;
  assigned.state.memoryLow = true;
  const busyFrom = assigned.checks.length;
  await waitFor("idle checks while a turn runs", () => assigned.checks.length >= busyFrom + KEPT_CHECKS);
  report.keptWhileBusy = assigned.checks.length - busyFrom;
  assert.equal(assigned.running(), true, "The process must stay while a turn runs.");

  // 3. The turn ends while memory is low: the first idle check keeps the process, so it stays for one
  // full interval after the turn, and the second one stops it.
  const idleFrom = assigned.checks.length;
  assigned.state.busy = false;
  await waitFor("the stop of the idle process", () => !assigned.running());
  report.idleChecksUntilStop = checksUntilStop(assigned.checks.slice(idleFrom));
  assert.equal(
    report.idleChecksUntilStop,
    LOW_MEMORY_IDLE_CHECKS,
    "The process must stop at the second idle check after the turn, not at the first.",
  );

  // 4. The next turn starts the provider again.
  assigned.state.memoryLow = false;
  await runCauseEffect(assigned.providers.ensureProvider("antigravity"));
  report.startedAgain = assigned.running();
  report.starts = await starts();
  assert.equal(report.startedAgain, true, "The next turn must start the provider again.");
  assert.equal(report.starts, 2, "The provider must start one time at launch and one time for the next turn.");

  // 5. No agent is set to the provider: its idle time counts from its start, not from the first check.
  // With no wait after the start, the first check after the start stops it. The first check can come
  // before `start()` returns, so the start is read from the log of the fake server.
  const unassigned = makeHarness("unassigned", { assigned: false, unassignedReleaseMs: 0 });
  await runCauseEffect(unassigned.providers.start());
  assert.equal(await starts(), 3, "The provider no agent is set to must start.");
  await waitFor("the stop of the provider no agent is set to", () => !unassigned.running());
  report.unassignedStoppedAtCheck = checksUntilStop(unassigned.checks);
  assert.equal(report.unassignedStoppedAtCheck, 1, "The first check after the start must stop it.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  for (const { providers } of harnesses)
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
