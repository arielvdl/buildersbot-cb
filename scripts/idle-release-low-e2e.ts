// Checks the switch `idle-release-low` of the advanced optimizations (beta): when the memory of the Mac
// goes from `ok` to `low`, the provider threads with no turn for more than 2 minutes close. Runs the real
// memory reading (`MacMemory`, with samples that the test gives), the real queue clause (`MemoryHold`),
// a real switch file (`OptimizationStore`) and the real pool of provider threads (`IdleThreadPool`).
//   1. Switch off: `low` closes nothing, and `critical` closes every idle thread, as before.
//   2. Switch on: `ok` to `low` closes the threads idle for 2 minutes or more, once; `critical` still
//      closes every idle thread; a second sample at `low` closes nothing more.
//   3. The pool closes only the threads idle for at least the time asked, never one in a turn, and every
//      idle thread when no time is asked.
// No provider, account or network is used. `bun scripts/idle-release-low-e2e.ts`. It writes
// .openbot-build/idle-release-low-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { LOW_MEMORY_IDLE_RELEASE_MS, MemoryHold } from "../src/backend/agent/memory-hold";
import { type IdleThread, IdleThreadPool } from "../src/backend/idle-thread-pool";
import { MacMemory, type MacMemorySample } from "../src/main/mac-memory";
import { OPTIMIZATIONS_FILE, OptimizationStore } from "../src/main/optimization-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/idle-release-low-e2e");

interface Report {
  passed: boolean;
  /** Each call of the release hook: the least idle time it asked, or null for every idle thread. */
  releasesOff: (number | null)[];
  releasesOn: (number | null)[];
  closedByLow: string[];
  closedByCritical: string[];
  error?: string;
}

const report: Report = { passed: false, releasesOff: [], releasesOn: [], closedByLow: [], closedByCritical: [] };
const root = await mkdtemp(join(tmpdir(), "openbot-idle-release-low-"));

const OK: MacMemorySample = { freePercent: 44, swapUsedMb: 2_000, kernelPressure: "normal" };
const LOW: MacMemorySample = { freePercent: 12, swapUsedMb: 2_000, kernelPressure: "normal" };
const CRITICAL: MacMemorySample = { freePercent: 6, swapUsedMb: 2_000, kernelPressure: "normal" };

/** Runs the samples through a real reading and queue clause, and gives each call of the release hook. */
async function releases(store: OptimizationStore, samples: readonly MacMemorySample[]): Promise<(number | null)[]> {
  const calls: (number | null)[] = [];
  let next = OK;
  // Each sample of the queue clause first tries the waiting lanes: the count of those calls says that
  // the clause handled every sample before it.
  let handled = 0;
  let wake: (() => void) | null = null;
  const memory = new MacMemory({
    read: () => Promise.resolve(next),
    onError: (message) => {
      throw new Error(message);
    },
  });
  const hold = new MemoryHold({
    memory,
    optimizations: store,
    hooks: {
      scheduleAll: () => {},
      retryWaiting: () => {
        handled += 1;
        wake?.();
      },
      releaseIdleThreads: (minIdleMs) =>
        Effect.sync(() => {
          calls.push(minIdleMs ?? null);
        }),
      emitError: (code) => {
        throw new Error(code);
      },
    },
  });
  hold.start();
  // One more sample of `ok` at the end: when the clause starts it, the one before has ended.
  const all = [...samples, OK];
  for (const sample of all) {
    next = sample;
    await memory.sample();
  }
  await new Promise<void>((done) => {
    wake = () => {
      if (handled >= all.length) done();
    };
    wake();
  });
  await Effect.runPromise(hold.dispose());
  memory.stop();
  return calls;
}

interface FakeThread extends IdleThread {
  name: string;
}

try {
  await mkdir(OUT, { recursive: true });
  const store = new OptimizationStore(join(root, OPTIMIZATIONS_FILE));
  await Effect.runPromise(store.load());

  // 1. Off.
  report.releasesOff = await releases(store, [LOW, LOW, CRITICAL, OK, LOW]);
  assert.deepEqual(report.releasesOff, [null], "with the switch off only critical closes threads, as before");

  // 2. On.
  await Effect.runPromise(store.set([{ id: "idle-release-low", enabled: true }]));
  report.releasesOn = await releases(store, [LOW, LOW, CRITICAL, OK, LOW]);
  assert.deepEqual(
    report.releasesOn,
    [LOW_MEMORY_IDLE_RELEASE_MS, null, LOW_MEMORY_IDLE_RELEASE_MS],
    "each move from ok to low closes the threads idle for 2 minutes; critical closes every idle thread",
  );

  // 3. The pool.
  const scope = Scope.makeUnsafe();
  const closed: string[] = [];
  const pool = new IdleThreadPool<FakeThread, string>({
    releaseAfterMs: 10 * 60_000,
    idleLimit: 10,
    scope: () => scope,
    canRelease: () => true,
    snapshot: (thread) => thread.name,
    dispose: (thread) =>
      Effect.sync(() => {
        closed.push(thread.name);
      }),
    reopen: () => Effect.void,
  });
  const now = Date.now();
  const thread = (name: string, idleForMs: number, inTurn = false): FakeThread => ({
    id: name,
    name,
    activeTurn: inTurn ? {} : null,
    idleRelease: null,
    idleSince: now - idleForMs,
  });
  for (const entry of [
    thread("idle-3-min", 3 * 60_000),
    thread("idle-30-s", 30_000),
    thread("idle-10-min-in-turn", 10 * 60_000, true),
  ])
    pool.add(entry);
  await Effect.runPromise(pool.releaseIdle(LOW_MEMORY_IDLE_RELEASE_MS));
  await Effect.runPromise(Effect.yieldNow);
  report.closedByLow = [...closed];
  assert.deepEqual(report.closedByLow, ["idle-3-min"], "low closes only the thread idle for 2 minutes or more");
  assert.equal(pool.isReleased("idle-3-min"), true, "the closed thread keeps its snapshot, so it opens again");
  await Effect.runPromise(pool.releaseIdle());
  await Effect.runPromise(Effect.yieldNow);
  report.closedByCritical = closed.slice(report.closedByLow.length);
  assert.deepEqual(report.closedByCritical, ["idle-30-s"], "critical closes every idle thread, never one in a turn");
  for (const entry of pool.clear()) closed.push(entry.name);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  report.passed = true;
} catch (cause) {
  report.error = cause instanceof Error ? cause.message : String(cause);
} finally {
  await rm(root, { recursive: true, force: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${report.passed ? "PASS" : "FAIL"}${report.error ? `: ${report.error}` : ""}: report in ${join(OUT, "report.json")}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
