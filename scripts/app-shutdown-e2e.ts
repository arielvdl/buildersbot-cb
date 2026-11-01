// Drives the quit path of the desktop app with fake services and real child processes:
// 1. A local server child that macOS gave the quit for Builders Bot passes it to the app once. A request
//    that crosses the app's own stop of that child does not quit the app again.
// 2. The app stops a child by closing its input. A child that quits then gets no signal.
// 3. A step that does not stop comes before a slow agent stop (one step, then two). The agent stop is
//    outside the budget: it records its interrupted turn, and the database closes after that.
// 4. A child that ignores its input and `SIGTERM` is killed at its grace, and it is gone when the
//    teardown ends: the app exits right after, and a kill timer does not outlive the app.
// 5. An app that exits while such a child is still there kills it as it exits.
// Each check runs, also after one that fails. The `TeardownRegistry` limits are scaled down in 3;
// `LocalServers` keeps its real 2 s and 6 s.
// Run: `bun scripts/app-shutdown-e2e.ts` (CI runs it too). Writes .openbot-build/app-shutdown-e2e/report.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ServerSummary } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { LOCAL_SERVERS_FILE } from "../src/main/local-servers/local-server-registry";
import { LocalServers } from "../src/main/local-servers/local-servers";
import { TeardownRegistry } from "../src/main/teardown-registry";

const OUT = resolve(import.meta.dirname, "../.openbot-build/app-shutdown-e2e");
const FAKE_CHILD = resolve(import.meta.dirname, "app-shutdown-fake-local-server.ts");
/** Check 5 runs this script again in this role: an app with a child, which then exits. */
const EXITING_APP_ROLE = "exiting-app";
/** A bound on failure only: a child starts in well under a second. */
const START_LIMIT_MS = 15_000;
/** `TERM_AFTER_MS` and `STOP_GRACE_MS` of `local-servers.ts`. */
const TERM_AFTER_MS = 2_000;
const STOP_GRACE_MS = 6_000;
/**
 * The registry limits of check 3, one fifth of the app: a step 10 s, the budget 15 s, the last step
 * by 24 s (`SHUTDOWN_DEADLINE_MS` less the time to close the database).
 */
const SCALED_LIMITS = { stepTimeoutMs: 2_000, budgetMs: 3_000, lastStepByMs: 4_800 };
/** All the steps that are left after the budget wait this long together (`teardown-registry.ts`). */
const LATE_STEPS_TOTAL_MS = 1_000;
/** Check 3: the database closes at the last step time at the latest, then this room. */
const SCALED_TEARDOWN_BOUND_MS = SCALED_LIMITS.lastStepByMs + LATE_STEPS_TOTAL_MS + 500;

interface ChildEvent {
  event: string;
  at: number;
}

type Detail = Record<string, number | string | boolean | null | string[]>;

interface CheckReport {
  name: string;
  passed: boolean;
  failure?: string;
  detail: Detail;
}

interface Report {
  passed: boolean;
  checks: CheckReport[];
}

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

function killIfThere(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It is gone.
  }
}

/** One app instance with one server on this computer, run by the fake child in `mode`. */
async function startLocalServers(directory: string, mode: "forward" | "stubborn", onQuitRequest: () => void) {
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
  process.env.FAKE_LOCAL_SERVER_MODE = mode;
  process.env.FAKE_LOCAL_SERVER_LOG = childLog;
  await Effect.runPromise(servers.load());
  await Effect.runPromise(servers.initialize());
  await waitFor(`the ${mode} child to start`, () => attached);
  const [pid] = servers.pids();
  assert.ok(pid, `The ${mode} child has no process id.`);
  return { servers, childLog, pid };
}

/** The role of check 5: it starts a child that ignores its input and `SIGTERM`, then exits at once. */
async function runExitingApp(directory: string): Promise<never> {
  const { pid } = await startLocalServers(directory, "stubborn", () => undefined);
  process.stdout.write(`${JSON.stringify({ pid })}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const report: Report = { passed: false, checks: [] };
  const root = await mkdtemp(join(tmpdir(), "openbot-app-shutdown-e2e-"));
  const started: LocalServers[] = [];
  const childPids: number[] = [];

  async function runCheck(name: string, run: (detail: Detail) => Promise<void>): Promise<void> {
    const detail: Detail = {};
    try {
      await run(detail);
      report.checks.push({ name, passed: true, detail });
    } catch (error) {
      report.checks.push({
        name,
        passed: false,
        failure: error instanceof Error ? error.message : String(error),
        detail,
      });
    }
  }

  async function startServers(mode: "forward" | "stubborn", onQuitRequest: () => void) {
    const value = await startLocalServers(join(root, mode), mode, onQuitRequest);
    started.push(value.servers);
    childPids.push(value.pid);
    return value;
  }

  async function checkForwardedQuit(detail: Detail): Promise<void> {
    let quitRequests = 0;
    const { servers, childLog } = await startServers("forward", () => {
      quitRequests += 1;
    });
    await waitFor("the quit request of the child", () => quitRequests > 0, 3_000);
    const stopStartedAt = Date.now();
    await Effect.runPromise(servers.stop());
    const stopMs = Date.now() - stopStartedAt;
    const events = readEvents(childLog);
    Object.assign(detail, { quitRequests, stopMs, childEvents: events.map(({ event }) => event) });
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

  /**
   * The steps in `hangs` never end. In the app the local host (90) did not stop on 31 Oct 2026, and the
   * team WebRTC bridge (100) after it. The agent stop took 11 s to 16 s in the logs of 30 Oct to 1 Nov.
   */
  async function checkAgentStopAfterHangs(
    detail: Detail,
    hangs: readonly (readonly [number, string])[],
    agentStopMs: number,
  ): Promise<void> {
    const errors: string[] = [];
    const reports: string[] = [];
    const registry = new TeardownRegistry({
      reportError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      report: (message) => reports.push(message),
      ...SCALED_LIMITS,
    });
    const startedAt = Date.now();
    let databaseOpen = true;
    let wroteAfterClose = false;
    const rows: string[] = [];
    let rowsAtClose: string[] = [];
    let interruptRecordedAtMs: number | null = null;
    let databaseClosedAtMs: number | null = null;
    for (const [order, name] of hangs) registry.push(order, name, () => new Promise<void>(() => undefined));
    // The positions of `TEARDOWN_ORDER` in `application-services.ts`.
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
          }, agentStopMs),
        ),
      { outsideBudget: true },
    );
    registry.push(120, "the trace file", () => undefined);
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
    // An agent stop that the database did not wait for still ends: it shows where it wrote.
    await waitFor("the agent stop to end", () => interruptRecordedAtMs !== null, agentStopMs + 2_000);
    Object.assign(detail, {
      agentStopMs,
      totalMs,
      boundMs: SCALED_TEARDOWN_BOUND_MS,
      interruptRecordedAtMs,
      databaseClosedAtMs,
      wroteAfterClose,
      rowsAtClose,
      errors,
      reports,
    });
    assert.ok(!wroteAfterClose, "The agent stop wrote its interrupted turn to a closed database.");
    assert.deepEqual(
      rowsAtClose,
      ["turn-1 interrupted"],
      "The database closed before the interrupted turn was written.",
    );
    assert.ok(
      totalMs < SCALED_TEARDOWN_BOUND_MS,
      `The teardown took ${totalMs} ms; the bound is ${SCALED_TEARDOWN_BOUND_MS} ms.`,
    );
    if (hangs.length > 1)
      assert.ok(
        reports.some((line) => line.startsWith("The shutdown steps used their")),
        "The spent budget was not reported.",
      );
  }

  /**
   * The stop of the servers is outside the budget, so a step before it that takes the whole budget
   * does not make the teardown abandon it before the kill. The step limit is above the grace, as in the
   * app (10 s and 6 s).
   */
  async function checkStubbornChild(detail: Detail): Promise<void> {
    const { servers, childLog, pid } = await startServers("stubborn", () => undefined);
    const errors: string[] = [];
    const registry = new TeardownRegistry({
      reportError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      stepTimeoutMs: 8_000,
      budgetMs: 1_000,
      lastStepByMs: 24_000,
    });
    const startedAt = Date.now();
    let stopStartedAt = 0;
    registry.push(45, "the live browser view", () => new Promise<void>((done) => setTimeout(done, 1_500)));
    registry.push(
      57,
      "the servers on this computer",
      () => {
        stopStartedAt = Date.now();
        return Effect.runPromise(servers.stop());
      },
      { outsideBudget: true },
    );
    registry.push(130, "the database", () => undefined, { afterAbandonedSteps: true });
    await registry.runAll();
    const totalMs = Date.now() - startedAt;
    const childThereAtEnd = processExists(pid);
    const childGoneWithinMs = childThereAtEnd ? null : Date.now() - stopStartedAt;
    const events = readEvents(childLog);
    const inputEnd = events.find(({ event }) => event === "end-of-input");
    const term = events.find(({ event }) => event === "SIGTERM");
    Object.assign(detail, {
      totalMs,
      errors,
      childThereAtEnd,
      childGoneWithinMs,
      childTermAfterInputMs: inputEnd && term ? term.at - inputEnd.at : null,
    });
    assert.ok(!childThereAtEnd, "The child was still there when the teardown ended. The app exits before its kill.");
    assert.ok(
      inputEnd && term && term.at - inputEnd.at >= TERM_AFTER_MS - 200,
      "The child did not get SIGTERM late after its input closed.",
    );
    assert.ok(
      childGoneWithinMs !== null && childGoneWithinMs <= STOP_GRACE_MS + 1_000,
      `The child ended ${childGoneWithinMs} ms after the stop.`,
    );
  }

  async function checkChildKilledAtExit(detail: Detail): Promise<void> {
    const app = spawn(process.execPath, [import.meta.filename], {
      env: { ...process.env, APP_SHUTDOWN_E2E_ROLE: EXITING_APP_ROLE, APP_SHUTDOWN_E2E_DIR: join(root, "exit") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = once(app, "exit");
    const [line] = await once(createInterface({ input: app.stdout }), "line");
    const value = JSON.parse(String(line));
    assert.ok(isDynamicRecord(value) && typeof value.pid === "number", "The app did not name its child.");
    const pid = value.pid;
    childPids.push(pid);
    await exited;
    const exitedAt = Date.now();
    const gone = await waitFor("the child to end after the app exit", () => !processExists(pid), 2_000).then(
      () => true,
      () => false,
    );
    Object.assign(detail, { childGoneAfterAppExitMs: gone ? Date.now() - exitedAt : null });
    assert.ok(gone, "The child outlived the app. It keeps its database, its port and its single-instance lock.");
  }

  try {
    await runCheck("A quit that reached a local server goes to the app once", checkForwardedQuit);
    await runCheck("One step that does not stop, then an agent stop of 2.6 s (13 s in the app)", (detail) =>
      checkAgentStopAfterHangs(detail, [[90, "the local host"]], 2_600),
    );
    await runCheck("Two steps that do not stop, then an agent stop of 1.5 s (7.5 s in the app)", (detail) =>
      checkAgentStopAfterHangs(
        detail,
        [
          [90, "the local host"],
          [100, "the team WebRTC bridge"],
        ],
        1_500,
      ),
    );
    await runCheck("A stubborn local server is killed before the teardown ends", checkStubbornChild);
    await runCheck("An app that exits kills a local server that is still there", checkChildKilledAtExit);
    report.passed = report.checks.every((check) => check.passed);
  } finally {
    for (const servers of started) await Effect.runPromise(servers.stop()).catch(() => undefined);
    for (const pid of childPids) killIfThere(pid);
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await rm(root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exit(1);
}

const exitingAppDirectory = process.env.APP_SHUTDOWN_E2E_DIR;
if (process.env.APP_SHUTDOWN_E2E_ROLE === EXITING_APP_ROLE && exitingAppDirectory)
  await runExitingApp(exitingAppDirectory);
else await main();
