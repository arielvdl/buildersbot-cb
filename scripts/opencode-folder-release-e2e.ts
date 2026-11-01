// Runs the real `ProviderRuntime` idle check on the real OpenCode driver, with a fake `opencode acp`
// that keeps the MCP servers of each folder until its process ends, as OpenCode 2.2.5 does (one child
// process stands for each folder's servers). With a short idle check interval it checks:
// 1. Turns in two folders leave two folder process sets, which `processFolders` and the resource
//    process tree (`providerTrees`, `toolProcessCount`) both count.
// 2. While a turn runs in one folder, the process and every folder stay, also past the folder idle
//    time of the other folder.
// 3. After that turn, the process stops at the second idle check with no turn, long before
//    `PROVIDER_IDLE_RELEASE_MS`, because a folder was idle for `folderIdleReleaseMs`, and the folder
//    processes end with it.
// 4. The next turn starts OpenCode again and loads the same session: the conversation stays.
// 5. A second runtime with a long folder idle time keeps a process with `folderLimit` folders, and
//    stops it at one of the first idle checks after a turn in one more folder.
// `bun scripts/opencode-folder-release-e2e.ts`. Writes .openbot-build/opencode-folder-release-e2e/report.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import type { AgentClient } from "../src/backend/agent-client";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { BuildersBotDatabase } from "../src/backend/openbot-database";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import { providerProcessIds } from "../src/backend/provider-processes";
import { parsePsOutput, providerTrees } from "../src/main/resource-summary";
import { installFakeAgent, readJsonl, runTurn, startThread } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/opencode-folder-release-e2e");
const WAIT_MS = 15_000;
const IDLE_CHECK_MS = 100;
const FOLDER_IDLE_MS = 1_500;
const FOLDER_LIMIT = 2;
/** `LOW_MEMORY_IDLE_CHECKS` in `provider-runtime.ts`: a process that keeps idle folders waits for them too. */
const LOW_MEMORY_IDLE_CHECKS = 2;
/** Idle checks that must pass with the process still running. */
const KEPT_CHECKS = 5;
/** Idle checks that span twice the folder idle time, while a turn runs. */
const HELD_CHECKS = Math.ceil((FOLDER_IDLE_MS * 2) / IDLE_CHECK_MS);

interface LogEntry {
  event: string;
  sessionId?: string;
  cwd?: string;
  pid?: number | null;
  agent?: number;
}

interface Report {
  passed: boolean;
  foldersAfterTwoTurns?: unknown;
  toolProcessesAfterTwoTurns?: number;
  /** The folder MCP sets that run, from the fake's log: the two agent folders and the model probe's. */
  liveFolderSets?: number;
  /** Idle checks that ran while a turn held one folder, all past the other folder's idle time. */
  keptWhileTurnRuns?: number;
  /** Milliseconds from the end of the last turn to the stop of the process. */
  stoppedAfterMs?: number;
  /** Idle checks after the last turn, up to and with the one that stopped the process. */
  checksUntilStop?: number;
  folderProcessesLeft?: number;
  toolProcessesAfterStop?: number;
  /** The session that the next turn loaded, and the one it had before. */
  loadedSession?: string | null;
  firstSession?: string;
  foldersAfterResume?: unknown;
  /** Idle checks that kept a process at `FOLDER_LIMIT` folders. */
  keptAtLimit?: number;
  /** Idle checks after the turn in one more folder, up to and with the one that stopped it. */
  checksOverLimit?: number;
  /** Milliseconds from the end of that turn to the stop of the process. */
  overLimitStoppedAfterMs?: number;
  error?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-opencode-folder-release-e2e-"));
const log = join(root, "fake.jsonl");
const release = join(root, "release");
const report: Report = { passed: false };

interface Harness {
  readonly providers: ProviderRuntime;
  readonly state: { turns: number; checks: number };
  readonly client: () => AgentClient;
}
const harnesses: Harness[] = [];

/** Waits for a condition that another fiber or process changes, and fails after `WAIT_MS`. */
async function waitFor(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resume) => setTimeout(resume, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function folderPids(): Promise<number[]> {
  return (await readJsonl<LogEntry>(log)).flatMap((entry) =>
    entry.event === "folder" && typeof entry.pid === "number" ? [entry.pid] : [],
  );
}

/** The MCP and command processes that the resource samples count for OpenCode, from a real `ps`. */
function toolProcesses(): number {
  const text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,comm="], { encoding: "utf8" });
  const { usage } = providerTrees({
    processes: parsePsOutput(text),
    rootPid: process.pid,
    excludedPids: new Set(),
    registry: providerProcessIds(),
    previousCpuSeconds: null,
    elapsedSeconds: 0,
  });
  return usage.find((tree) => tree.provider === "opencode")?.toolProcessCount ?? 0;
}

function makeHarness(name: string, options: { folderIdleReleaseMs: number; folderLimit: number }): Harness {
  const state = { turns: 0, checks: 0 };
  const store = new AgentStore(
    join(root, name, "profile"),
    join(root, name, "home"),
    new BuildersBotDatabase(join(root, name, "profile")),
  );
  const providers: ProviderRuntime = new ProviderRuntime({
    offProviders: BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter((id) => id !== "opencode"),
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
      // As `AgentService` reports it: true while a turn on the provider runs.
      isProviderBusy: () => state.turns > 0,
      isAgentBusy: () => false,
      isProviderAssigned: () => true,
      // Each idle check reads the memory level one time, so this counts the checks. Memory stays ok.
      memoryLow: () => {
        state.checks += 1;
        return false;
      },
      onAgentClientLost: () => Effect.void,
      sharedRoot: () => join(root, name, "shared"),
      onProviderResumed: () => undefined,
      onProviderActivated: () => Effect.void,
      captureConfigRevision: () => 0,
    },
    emit: () => undefined,
    emitError: () => undefined,
    requestTimeoutMs: 10_000,
    idleCheckMs: IDLE_CHECK_MS,
    folderIdleReleaseMs: options.folderIdleReleaseMs,
    folderLimit: options.folderLimit,
    preferredProvider: "opencode",
    clientFactory: null,
    bundledExecutables: { opencode: executable },
    credentials: { ...NO_PROVIDER_CREDENTIALS, providerTempDirectory: join(root, name, "temp") },
    redactMcp: (text) => text,
  });
  const client = () => {
    const current = providers.currentClient("opencode");
    if (!current) throw new Error("OpenCode is not running.");
    return current;
  };
  const harness = { providers, state, client };
  harnesses.push(harness);
  return harness;
}

/** A turn that counts as busy for the idle check while it runs, as a turn of `AgentService` does. */
async function turn(harness: Harness, thread: string, text = "hello"): Promise<void> {
  harness.state.turns += 1;
  try {
    const result = await runTurn(harness.client(), thread, { text, timeoutMs: WAIT_MS });
    assert.equal(result.status, "completed", `The turn must complete: ${result.error ?? ""}`);
  } finally {
    harness.state.turns -= 1;
  }
}

async function folder(name: string): Promise<string> {
  const path = join(root, "folders", name);
  await mkdir(path, { recursive: true });
  return path;
}

const executable = join(root, "opencode", "bin", "opencode");

try {
  await mkdir(release, { recursive: true });
  await installFakeAgent(executable, "opencode-folders", { FAKE_LOG: log, FAKE_RELEASE: release });
  const first = makeHarness("first", { folderIdleReleaseMs: FOLDER_IDLE_MS, folderLimit: 8 });
  await runCauseEffect(first.providers.start());
  assert.equal(first.providers.isReady(), true, "OpenCode must be ready.");

  // 1. A turn in each of two folders: the process keeps a set of MCP servers for each.
  const folderA = await folder("a");
  const folderB = await folder("b");
  const threadA = await startThread(first.client(), { cwd: folderA });
  const threadB = await startThread(first.client(), { cwd: folderB });
  await turn(first, threadA);
  await turn(first, threadB);
  report.foldersAfterTwoTurns = first.providers.processFolders().opencode;
  assert.deepEqual(report.foldersAfterTwoTurns, { folders: 2, sessions: 2, processes: 1 });
  // The model probe at start opens a session in a folder of its own, which OpenCode loads too.
  report.toolProcessesAfterTwoTurns = toolProcesses();
  report.liveFolderSets = (await folderPids()).filter(alive).length;
  assert.equal(report.liveFolderSets, 3, "The fake must hold the two agent folders and the probe folder.");
  assert.equal(
    report.toolProcessesAfterTwoTurns,
    report.liveFolderSets,
    "The process tree must count one MCP set for each folder.",
  );

  // 2. A long turn in folder A: the process stays while it runs, also after folder B is idle for longer
  // than the folder idle time.
  const held = turn(first, threadA, "HOLD-TURN");
  await waitFor("the long turn", () => first.state.turns === 1);
  const heldFrom = first.state.checks;
  await waitFor("idle checks while a turn runs", () => first.state.checks >= heldFrom + HELD_CHECKS);
  report.keptWhileTurnRuns = first.state.checks - heldFrom;
  assert.ok(first.providers.currentClient("opencode"), "The process must stay while a turn runs.");
  assert.ok((await folderPids()).every(alive), "Every folder must keep its MCP servers while a turn runs.");

  // 3. The turn ends: folder B is idle past the folder idle time, so the process stops before the 10 min
  // of `PROVIDER_IDLE_RELEASE_MS`, and the MCP servers of both folders end with it.
  await writeFile(join(release, threadA), "");
  await held;
  const endedAt = Date.now();
  const endedAtCheck = first.state.checks;
  await waitFor("the stop of the process that keeps an idle folder", () => !first.providers.currentClient("opencode"));
  report.stoppedAfterMs = Date.now() - endedAt;
  report.checksUntilStop = first.state.checks - endedAtCheck;
  assert.ok(report.stoppedAfterMs >= IDLE_CHECK_MS, "The process must stay for one check interval after the turn.");
  const pids = await folderPids();
  const deadline = Date.now() + WAIT_MS;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((resume) => setTimeout(resume, 20));
  report.folderProcessesLeft = pids.filter(alive).length;
  assert.equal(report.folderProcessesLeft, 0, "The MCP servers of each folder must end with the process.");
  report.toolProcessesAfterStop = toolProcesses();
  assert.equal(report.toolProcessesAfterStop, 0);

  // 4. The next turn starts OpenCode again and loads the same session in folder A only.
  await runCauseEffect(first.providers.ensureProvider("opencode"));
  const resumed = await runCauseEffect(
    first.client().request("thread/resume", { threadId: threadA, cwd: folderA }, (value) => value),
  );
  assert.ok(resumed, "The thread must resume.");
  await turn(first, threadA);
  const loads = (await readJsonl<LogEntry>(log)).filter((entry) => entry.event === "load");
  report.firstSession = threadA;
  report.loadedSession = loads.at(-1)?.sessionId ?? null;
  assert.equal(report.loadedSession, threadA, "The next turn must load the same session.");
  report.foldersAfterResume = first.providers.processFolders().opencode;
  assert.deepEqual(report.foldersAfterResume, { folders: 1, sessions: 1, processes: 1 });

  // 5. A process at `FOLDER_LIMIT` folders stays; a turn in one more folder stops it one check interval
  // after the turn, long before the folder idle time.
  const limited = makeHarness("limited", { folderIdleReleaseMs: 600_000, folderLimit: FOLDER_LIMIT });
  await runCauseEffect(limited.providers.start());
  const limitThreads: string[] = [];
  for (const name of ["c", "d"]) {
    const thread = await startThread(limited.client(), { cwd: await folder(name) });
    limitThreads.push(thread);
    await turn(limited, thread);
  }
  const atLimitFrom = limited.state.checks;
  await waitFor("idle checks at the folder limit", () => limited.state.checks >= atLimitFrom + KEPT_CHECKS);
  report.keptAtLimit = limited.state.checks - atLimitFrom;
  assert.ok(limited.providers.currentClient("opencode"), "A process at the folder limit must stay.");
  const extra = await startThread(limited.client(), { cwd: await folder("e") });
  await turn(limited, extra);
  const overFrom = limited.state.checks;
  const overAt = Date.now();
  await waitFor("the stop of the process over the folder limit", () => !limited.providers.currentClient("opencode"));
  report.checksOverLimit = limited.state.checks - overFrom;
  report.overLimitStoppedAfterMs = Date.now() - overAt;
  assert.ok(
    report.overLimitStoppedAfterMs >= IDLE_CHECK_MS,
    "The process over the folder limit must stay for one check interval after the turn.",
  );
  assert.ok(
    report.checksOverLimit <= LOW_MEMORY_IDLE_CHECKS + 1,
    "The process over the folder limit must stop at the first idle checks after the turn.",
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  for (const { providers } of harnesses)
    for (const client of await runCauseEffect(providers.dispose())) await runCauseEffect(client.stop());
  for (const pid of await folderPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
