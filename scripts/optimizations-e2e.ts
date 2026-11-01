// Checks the switches of the advanced optimizations (beta): the file, the port that the host reads, the
// change event, and the parser of the window's changes. Runs the real `OptimizationStore` on a temporary
// user data folder, the real IPC input parser of main and the real preload decoder. Checks:
//   1. With no file, every switch is off, and so is the port of a host with no file (`OPTIMIZATIONS_OFF`).
//   2. A change is saved as `{ version: 1, on: [ids] }` and a new store reads it after a restart.
//   3. The change event comes once for each switch whose value changed, and not for a change to the
//      same value. "Turn all on" and "Turn all off" are one change each.
//   4. A switch of a newer version stays in the file after a write, and is not on for this version.
//   5. A damaged file, or a file of another version, reads as every switch off.
//   6. Main refuses a change with an unknown id, the same id twice, a value that is not a boolean, or no
//      change; the preload leaves out an id that this version does not know.
// No provider, account or network is used. `bun scripts/optimizations-e2e.ts`. It writes
// .openbot-build/optimizations-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OPTIMIZATION_IDS, type OptimizationId } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { OPTIMIZATIONS_OFF } from "../src/backend/optimizations";
import { parseSetOptimizationsInput } from "../src/main/ipc/app-inputs";
import { OPTIMIZATIONS_FILE, OptimizationStore } from "../src/main/optimization-store";
import { decodeOptimizationState } from "../src/preload/app-decoding";

const OUT = resolve(import.meta.dirname, "../.openbot-build/optimizations-e2e");

interface Report {
  passed: boolean;
  defaultOn: OptimizationId[];
  savedFile?: unknown;
  events: string[];
  afterRestart?: OptimizationId[];
  keptForeign?: unknown;
  refused: string[];
  error?: string;
}

const report: Report = { passed: false, defaultOn: [], events: [], refused: [] };
const root = await mkdtemp(join(tmpdir(), "openbot-optimizations-"));
const path = join(root, OPTIMIZATIONS_FILE);

async function loaded(): Promise<OptimizationStore> {
  const store = new OptimizationStore(path);
  await Effect.runPromise(store.load());
  return store;
}

const enabledIds = (store: { optimizationEnabled(id: OptimizationId): boolean }) =>
  OPTIMIZATION_IDS.filter((id) => store.optimizationEnabled(id));

try {
  await mkdir(OUT, { recursive: true });

  // 1. No file.
  const store = await loaded();
  report.defaultOn = enabledIds(store);
  assert.deepEqual(report.defaultOn, [], "with no file every switch is off");
  assert.deepEqual(enabledIds(OPTIMIZATIONS_OFF), [], "a host with no file has every switch off");
  assert.deepEqual(store.state(), { on: [] }, "the window reads every switch off");

  // 2 and 3. One change, saved, with one event.
  store.onOptimizationChange((id, enabled) => report.events.push(`${id}:${enabled}`));
  await Effect.runPromise(store.set([{ id: "queue-priority-user", enabled: true }]));
  assert.deepEqual(report.events, ["queue-priority-user:true"], "one event for one changed switch");
  report.savedFile = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(report.savedFile, { version: 1, on: ["queue-priority-user"] }, "the file has the switch");
  await Effect.runPromise(store.set([{ id: "queue-priority-user", enabled: true }]));
  assert.equal(report.events.length, 1, "no event for a change to the same value");
  report.afterRestart = enabledIds(await loaded());
  assert.deepEqual(report.afterRestart, ["queue-priority-user"], "a restart reads the saved switch");

  report.events = [];
  await Effect.runPromise(store.set(OPTIMIZATION_IDS.map((id) => ({ id, enabled: true }))));
  assert.equal(report.events.length, OPTIMIZATION_IDS.length - 1, "Turn all on tells each switch that changed");
  assert.deepEqual(enabledIds(store), [...OPTIMIZATION_IDS], "every switch is on");
  report.events = [];
  await Effect.runPromise(store.set(OPTIMIZATION_IDS.map((id) => ({ id, enabled: false }))));
  assert.equal(report.events.length, OPTIMIZATION_IDS.length, "Turn all off tells each switch");
  assert.deepEqual(enabledIds(await loaded()), [], "every switch is off after a restart");

  // 4. A switch of a newer version.
  await writeFile(path, JSON.stringify({ version: 1, on: ["future-switch", "routing", "NOT valid!"] }));
  const newer = await loaded();
  assert.deepEqual(enabledIds(newer), ["routing"], "only the known switch is on");
  await Effect.runPromise(newer.set([{ id: "safe-resume", enabled: true }]));
  report.keptForeign = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(
    report.keptForeign,
    { version: 1, on: ["safe-resume", "routing", "future-switch"] },
    "the switch of a newer version stays in the file, and an id that is not a switch name does not",
  );

  // 5. Damaged files.
  await writeFile(path, "{ not json");
  assert.deepEqual(enabledIds(await loaded()), [], "a damaged file reads as every switch off");
  await writeFile(path, JSON.stringify({ version: 2, on: ["routing"] }));
  assert.deepEqual(enabledIds(await loaded()), [], "a file of another version reads as every switch off");
  await writeFile(path, JSON.stringify({ version: 1, on: "routing" }));
  assert.deepEqual(enabledIds(await loaded()), [], "a file of another shape reads as every switch off");

  // 6. The window's changes and main's answer.
  const refusals: [string, unknown][] = [
    ["unknown id", { changes: [{ id: "make-it-fast", enabled: true }] }],
    [
      "the same id twice",
      {
        changes: [
          { id: "routing", enabled: true },
          { id: "routing", enabled: false },
        ],
      },
    ],
    ["a value that is not a boolean", { changes: [{ id: "routing", enabled: "yes" }] }],
    ["no change", { changes: [] }],
    ["no list", { switches: { routing: true } }],
  ];
  for (const [name, input] of refusals) {
    assert.throws(() => parseSetOptimizationsInput(input), `main refuses ${name}`);
    report.refused.push(name);
  }
  assert.deepEqual(parseSetOptimizationsInput({ changes: [{ id: "routing", enabled: true, extra: 1 }] }), {
    changes: [{ id: "routing", enabled: true }],
  });
  assert.deepEqual(
    decodeOptimizationState({ on: ["future-switch", "safe-resume", "queue-priority-user"] }),
    { on: ["queue-priority-user", "safe-resume"] },
    "the preload leaves out an unknown id and keeps the list order",
  );
  assert.throws(() => decodeOptimizationState({ on: "routing" }), "the preload refuses another shape");
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
