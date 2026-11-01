// Checks the memory reading of the Mac that holds new agent turns (`src/main/mac-memory.ts`) with the
// agent queue clause that uses it (`src/backend/agent/memory-hold.ts`).
//
// On 1 November 2026 macOS showed its low-memory panel ("Your system has run out of application
// memory") while Builders Bot and its agents held about 17 GB. The reading said "ok" the whole time:
// `memory_pressure` gave 39 to 44% "free", with 7 to 9 GB of swap and a kernel pressure level of warn.
// The free percentage counts memory that macOS can still compress, so it stays high on a full Mac.
//
// Checks:
//   1. On macOS, the real reading has the kernel level that `sysctl` gives.
//   2. The samples of 1 November: warn with 8.7 GB of swap holds new turns and tells the held agent.
//   3. A critical kernel level closes the idle provider threads one time.
//   4. A normal kernel level again lets the held agents start.
//   5. Warn with less swap than a full Mac (6.9 GB) holds nothing, and the old rules still apply.
//   6. Each level change reaches the log callback.
// No provider, account or network is used. `bun scripts/mac-memory-pressure-e2e.ts`. It writes
// .openbot-build/mac-memory-pressure-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { MemoryHold } from "../src/backend/agent/memory-hold";
import type { HostMemoryLevel } from "../src/backend/host-memory";
import { MacMemory, type MacMemorySample, parseKernelPressure, readMacMemory } from "../src/main/mac-memory";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "mac-memory-pressure-e2e");

interface Report {
  passed: boolean;
  realSample?: MacMemorySample | null;
  realKernelText?: string;
  steps: { sample: MacMemorySample; level: HostMemoryLevel; mayDrain: boolean }[];
  levelChanges: { level: HostMemoryLevel; sample: MacMemorySample }[];
  released: number;
  scheduledAll: number;
  told: string[];
  error?: string;
}

const report: Report = { passed: false, steps: [], levelChanges: [], released: 0, scheduledAll: 0, told: [] };

/** Resolves when `check` is true. Each hook call checks again. */
function waiter(): { until: (check: () => boolean) => Promise<void>; poke: () => void } {
  const waiting = new Set<{ check: () => boolean; done: () => void }>();
  return {
    until: (check) =>
      check()
        ? Promise.resolve()
        : new Promise<void>((done) => {
            waiting.add({ check, done });
          }),
    poke: () => {
      for (const entry of [...waiting])
        if (entry.check()) {
          waiting.delete(entry);
          entry.done();
        }
    },
  };
}

try {
  await mkdir(OUT, { recursive: true });

  if (process.platform === "darwin") {
    // 1. The real commands. The kernel level can change between the two reads, so a second pair
    //    settles a difference.
    let matched = false;
    for (let attempt = 0; attempt < 3 && !matched; attempt += 1) {
      const sample = await readMacMemory();
      const text = execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
        encoding: "utf8",
      });
      report.realSample = sample;
      report.realKernelText = text.trim();
      assert.ok(sample, "macOS gives a memory sample");
      matched = sample.kernelPressure === parseKernelPressure(text);
    }
    assert.ok(matched, "the reading has the kernel level of sysctl");
    assert.notEqual(report.realSample?.kernelPressure ?? null, null, "this macOS gives a kernel level");
  }

  // 2-6. The samples of 1 November, through the real reading and the real queue clause.
  let next: MacMemorySample = { freePercent: 44, swapUsedMb: 8718, kernelPressure: "normal" };
  const wake = waiter();
  const memory = new MacMemory({
    read: () => Promise.resolve(next),
    onError: (message) => {
      throw new Error(message);
    },
    onLevelChange: (level, sample) => report.levelChanges.push({ level, sample: { ...sample } }),
  });
  const hold = new MemoryHold({
    memory,
    hooks: {
      scheduleAll: () => {
        report.scheduledAll += 1;
        wake.poke();
      },
      retryWaiting: () => wake.poke(),
      releaseIdleThreads: () =>
        Effect.sync(() => {
          report.released += 1;
          wake.poke();
        }),
      emitError: (code, _error, agentId) => {
        report.told.push(`${code}:${agentId ?? ""}`);
      },
    },
  });
  hold.start();

  async function step(sample: MacMemorySample): Promise<void> {
    next = sample;
    await memory.sample();
    report.steps.push({ sample, level: memory.level(), mayDrain: hold.mayDrain("agent-a") });
  }

  await step({ freePercent: 44, swapUsedMb: 8718, kernelPressure: "normal" });
  assert.equal(memory.level(), "ok", "a normal kernel level with 44% free is ok");

  await step({ freePercent: 44, swapUsedMb: 9400, kernelPressure: "warn" });
  assert.equal(memory.level(), "low", "warn with the swap of a full Mac is low");
  assert.equal(hold.mayDrain("agent-a"), false, "a new turn waits while the memory is low");
  hold.held("agent-a");
  hold.held("agent-a");
  assert.deepEqual(report.told, ["host_memory_low:agent-a"], "the held agent is told one time");

  await step({ freePercent: 41, swapUsedMb: 9800, kernelPressure: "critical" });
  assert.equal(memory.level(), "critical", "a critical kernel level is critical");
  await wake.until(() => report.released === 1);

  await step({ freePercent: 44, swapUsedMb: 9800, kernelPressure: "normal" });
  assert.equal(memory.level(), "ok", "a normal kernel level ends the hold, also with a swap high-water mark");
  assert.equal(hold.mayDrain("agent-a"), true, "a new turn starts again");
  await wake.until(() => report.scheduledAll === 1);

  await step({ freePercent: 39, swapUsedMb: 6917, kernelPressure: "warn" });
  assert.equal(memory.level(), "ok", "warn with less swap than a full Mac holds nothing");

  await step({ freePercent: 12, swapUsedMb: 0, kernelPressure: null });
  assert.equal(memory.level(), "low", "with no kernel level, the free percentage still holds");

  assert.deepEqual(
    report.levelChanges.map((change) => change.level),
    ["low", "critical", "ok", "low"],
    "each level change reaches the log callback",
  );
  assert.equal(report.released, 1, "the idle threads close one time");
  await Effect.runPromise(hold.dispose());
  memory.stop();
  report.passed = true;
} catch (cause) {
  report.error = cause instanceof Error ? cause.message : String(cause);
} finally {
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${report.passed ? "PASS" : "FAIL"}${report.error ? `: ${report.error}` : ""}: report in ${join(OUT, "report.json")}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
