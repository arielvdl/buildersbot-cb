// Drives the quit path of the desktop app with fake services and real child processes:
// 1. A local server child that macOS gave the quit for Builders Bot passes it to the app once. A request
//    that crosses the app's own stop of that child does not quit the app again.
// 2. The app stops a child by closing its input. A child that quits then gets no signal: Electron takes
//    one `SIGTERM` as a quit and ends the process at the next one, in the middle of its teardown.
// 3. The teardown, with two steps that never end, a child that ignores its input and `SIGTERM`, and a
//    slow agent stop, ends within its budget. The agent stop still records its interrupted turn, and
//    the database closes after that. The child gets `SIGTERM` late and `SIGKILL` at the grace.
// The `TeardownRegistry` limits are scaled down; `LocalServers` keeps its real 2 s and 6 s.
// Run: `bun scripts/app-shutdown-e2e.ts`. Writes .openbot-build/app-shutdown-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerSummary } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { LOCAL_SERVERS_FILE } from "../src/main/local-servers/local-server-registry";
import { LocalServers } from "../src/main/local-servers/local-servers";
import { TeardownRegistry } from "../src/main/teardown-registry";

const OUT = resolve(import.meta.dirname, "../.openbot-build/app-shutdown-e2e");
const FAKE_CHILD = resolve(import.meta.dirname, "app-shutdown-fake-local-server.ts");
/** A bound on failure only: a child starts in well under a second. */
const START_LIMIT_MS = 15_000;
/** `TERM_AFTER_MS` and `STOP_GRACE_MS` of `local-servers.ts`. */
const TERM_AFTER_MS = 2_000;
const STOP_GRACE_MS = 6_000;
// The registry limits of this run. The app uses 10 s and 15 s.
const STEP_TIMEOUT_MS = 2_000;
const BUDGET_MS = 3_000;
/** The agent stop takes longer than a step that is left after the budget gets, so it is abandoned. */
const AGENT_STOP_MS = 300;
/**
 * The budget, a short wait for each of the three steps after it, the half step limit that the
 * database waits for abandoned steps, and some room. Without the budget the limits add up to 7.3 s.
 */
const TEARDOWN_BOUND_MS = BUDGET_MS + 3 * 100 + STEP_TIMEOUT_MS / 2 + 600;

interface ChildEvent {
  event: string;
  at: number;
}

interface Report {
  passed: boolean;
  forward?: { quitRequests: number; stopMs: number; childEvents: string[] };
  teardown?: {
    totalMs: number;
    boundMs: number;
    interruptRecordedAtMs: number | null;
    databaseClosedAtMs: number | null;
    rowsAtClose: string[];
    errors: string[];
    reports: string[];
    childTermAfterInputMs: number | null;
    childGoneWithinMs: number | null;
  };
  failure?: string;
}

const report: Report = { passed: false };
const root = await mkdtemp(join(tmpdir(), "openbot-app-shutdown-e2e-"));
const started: LocalServers[] = [];

function readEvents(path: string): ChildEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const value = JSON.parse(line);
      return isDynamicRecord(value) && typeof value.event === "string" && typeof value.at === "number"
        ? [{ event: value.event, at: value.at }]
        : [];
    });
}

/** Resolves when `check` is true. It reads state, so it does not wait a fixed time. */
async function waitFor(label: string, check: () => boolean, limitMs = START_LIMIT_MS): Promise<void> {
  const endsAt = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > endsAt) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One app instance with one server on this computer, run by the fake child in `mode`. */
async function startLocalServers(mode: "forward" | "stubborn", onQuitRequest: () => void) {
  const directory = join(root, mode);
  await mkdir(directory, { recursive: true });
  const secret = `secret-${mode}`;
  await writeFile(
    join(directory, LOCAL_SERVERS_FILE),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: randomUUID(),
          name: `E2E ${mode}`,
          createdAt: new Date().toISOString(),
          encryptedSecret: Buffer.from(secret).toString("base64"),
          serverId: null,
          fingerprint: null,
          publicKey: null,
        },
      ],
    }),
  );
  const childLog = join(directory, "child.ndjson");
  let attached = false;
  const summary = (serverId: string): ServerSummary => ({
    notificationsMuted: false,
    notificationsMutedUntil: null,
    notificationLevel: "all",
    id: serverId,
    name: `E2E ${mode}`,
    kind: "remote",
    state: "online",
    apiUrl: "http://127.0.0.1:9",
    remoteDesktopAvailable: false,
    logoUrl: null,
    role: "owner",
    active: false,
    thisComputer: true,
  });
  const servers = new LocalServers({
    registryPath: join(directory, LOCAL_SERVERS_FILE),
    userDataRoot: join(directory, "user-data"),
    agentRoot: join(directory, "agents"),
    runtimeRoot: join(directory, "runtimes"),
    cipher: { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
    remoteServers: {
      setThisComputerServers: () => undefined,
      attachLocalServer: (input) =>
        Effect.sync(() => {
          attached = true;
          return summary(input.serverId);
        }),
      detachLocalServer: () => Effect.void,
    },
    command: { executable: process.execPath, args: [FAKE_CHILD] },
    trash: async () => undefined,
    log: { info: () => undefined, warn: () => undefined },
    platform: process.platform,
    quitRequested: onQuitRequest,
  });
  started.push(servers);
  process.env.FAKE_LOCAL_SERVER_MODE = mode;
  process.env.FAKE_LOCAL_SERVER_LOG = childLog;
  await Effect.runPromise(servers.load());
  await Effect.runPromise(servers.initialize());
  await waitFor(`the ${mode} child to start`, () => attached);
  const [pid] = servers.pids();
  assert.ok(pid, `The ${mode} child has no process id.`);
  return { servers, childLog, pid };
}

async function checkForwardedQuit(): Promise<void> {
  let quitRequests = 0;
  const { servers, childLog } = await startLocalServers("forward", () => {
    quitRequests += 1;
  });
  await waitFor("the quit request of the child", () => quitRequests > 0, 3_000);
  const stopStartedAt = Date.now();
  await Effect.runPromise(servers.stop());
  const stopMs = Date.now() - stopStartedAt;
  const events = readEvents(childLog);
  report.forward = { quitRequests, stopMs, childEvents: events.map(({ event }) => event) };
  assert.equal(quitRequests, 1, "The request that crossed the stop quit the app again.");
  assert.ok(
    events.some(({ event }) => event === "end-of-input"),
    "The child did not see its input close.",
  );
  assert.ok(
    !events.some(({ event }) => event === "SIGTERM"),
    "A child that quits at the end of its input got SIGTERM too.",
  );
  assert.ok(stopMs < TERM_AFTER_MS, `The stop took ${stopMs} ms.`);
}

async function checkBoundedTeardown(): Promise<void> {
  const { servers, childLog, pid } = await startLocalServers("stubborn", () => undefined);
  const rows: string[] = [];
  let databaseOpen = true;
  let wroteAfterClose = false;
  const errors: string[] = [];
  const reports: string[] = [];
  const registry = new TeardownRegistry({
    reportError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
    report: (message) => reports.push(message),
    stepTimeoutMs: STEP_TIMEOUT_MS,
    budgetMs: BUDGET_MS,
  });
  const startedAt = Date.now();
  let interruptRecordedAtMs: number | null = null;
  let databaseClosedAtMs: number | null = null;
  let rowsAtClose: string[] = [];
  let stopStartedAt = 0;
  // The positions of `TEARDOWN_ORDER` in `application-services.ts`.
  registry.push(57, "the servers on this computer", () => {
    stopStartedAt = Date.now();
    return Effect.runPromise(servers.stop());
  });
  registry.push(90, "the local host", () => new Promise<void>(() => undefined));
  registry.push(100, "the team WebRTC bridge", () => new Promise<void>(() => undefined));
  registry.push(
    110,
    "the agent service",
    () =>
      new Promise<void>((done) =>
        setTimeout(() => {
          if (!databaseOpen) wroteAfterClose = true;
          rows.push("turn-1 interrupted");
          interruptRecordedAtMs = Date.now() - startedAt;
          done();
        }, AGENT_STOP_MS),
      ),
  );
  registry.push(
    130,
    "the database",
    () => {
      rowsAtClose = [...rows];
      databaseOpen = false;
      databaseClosedAtMs = Date.now() - startedAt;
    },
    { afterAbandonedSteps: true },
  );
  await registry.runAll();
  const totalMs = Date.now() - startedAt;
  // The servers step was abandoned. Its kill comes at the grace, after the teardown.
  await waitFor("the stubborn child to end", () => !processExists(pid), STOP_GRACE_MS + 2_000);
  const childGoneWithinMs = Date.now() - stopStartedAt;
  const events = readEvents(childLog);
  const inputEnd = events.find(({ event }) => event === "end-of-input");
  const term = events.find(({ event }) => event === "SIGTERM");
  const childTermAfterInputMs = inputEnd && term ? term.at - inputEnd.at : null;
  report.teardown = {
    totalMs,
    boundMs: TEARDOWN_BOUND_MS,
    interruptRecordedAtMs,
    databaseClosedAtMs,
    rowsAtClose,
    errors,
    reports,
    childTermAfterInputMs,
    childGoneWithinMs,
  };
  assert.ok(totalMs < TEARDOWN_BOUND_MS, `The teardown took ${totalMs} ms; the bound is ${TEARDOWN_BOUND_MS} ms.`);
  assert.ok(!wroteAfterClose, "The agent stop wrote to a closed database.");
  assert.deepEqual(rowsAtClose, ["turn-1 interrupted"], "The database closed before the interrupted turn was written.");
  assert.ok(
    reports.some((line) => line.startsWith("The shutdown steps used their")),
    "The spent budget was not reported.",
  );
  assert.ok(
    childTermAfterInputMs !== null && childTermAfterInputMs >= TERM_AFTER_MS - 200,
    `The child got SIGTERM ${childTermAfterInputMs} ms after its input closed.`,
  );
  assert.ok(childGoneWithinMs <= STOP_GRACE_MS + 1_000, `The child ended ${childGoneWithinMs} ms after the stop.`);
}

try {
  await checkForwardedQuit();
  await checkBoundedTeardown();
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  for (const servers of started) await Effect.runPromise(servers.stop()).catch(() => undefined);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exit(1);
