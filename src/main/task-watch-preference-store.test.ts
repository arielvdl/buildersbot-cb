// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { parseTaskWatchPreference } from "./ipc/app-inputs";
import { TaskWatchPreferenceStore } from "./task-watch-preference-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "task-watch-pref-"));
  roots.push(root);
  return join(root, "task-watch.json");
}

describe("the task reviewer preference", () => {
  it("is off, at 15 minutes, when nothing is saved", async () => {
    const store = new TaskWatchPreferenceStore(await path());
    await Effect.runPromise(store.load());
    expect(store.get()).toEqual({ enabled: false, quietMinutes: 15 });
  });

  it("reads as off for a damaged file, another version or shape, or a value out of range", async () => {
    const file = await path();
    for (const content of [
      "{ nope",
      JSON.stringify({ version: 2, enabled: true, quietMinutes: 15 }),
      JSON.stringify({ version: 1, enabled: "yes", quietMinutes: 15 }),
      JSON.stringify({ version: 1, enabled: true, quietMinutes: 4 }),
      JSON.stringify({ version: 1, enabled: true, quietMinutes: 121 }),
      JSON.stringify({ version: 1, enabled: true, quietMinutes: 15.5 }),
      JSON.stringify({ version: 1, enabled: true }),
    ]) {
      await writeFile(file, content);
      const store = new TaskWatchPreferenceStore(file);
      await Effect.runPromise(store.load());
      expect(store.get()).toEqual({ enabled: false, quietMinutes: 15 });
    }
  });

  it("keeps what was set across a restart", async () => {
    const file = await path();
    await Effect.runPromise(new TaskWatchPreferenceStore(file).set({ enabled: true, quietMinutes: 40 }));
    const again = new TaskWatchPreferenceStore(file);
    await Effect.runPromise(again.load());
    expect(again.get()).toEqual({ enabled: true, quietMinutes: 40 });
  });

  it("refuses a value out of range instead of storing it", async () => {
    const store = new TaskWatchPreferenceStore(await path());
    await expect(Effect.runPromise(store.set({ enabled: true, quietMinutes: 2 }))).rejects.toBeDefined();
    expect(store.get().enabled).toBe(false);
  });
});

describe("the IPC input of the task reviewer", () => {
  it("takes a whole number of minutes from 5 to 120, and drops other fields", () => {
    expect(parseTaskWatchPreference({ enabled: true, quietMinutes: 5 })).toEqual({ enabled: true, quietMinutes: 5 });
    expect(parseTaskWatchPreference({ enabled: false, quietMinutes: 120, judge: "x" })).toEqual({
      enabled: false,
      quietMinutes: 120,
    });
  });

  it("refuses anything else, and never clamps it", () => {
    for (const input of [
      null,
      "on",
      {},
      { enabled: true },
      { quietMinutes: 15 },
      { enabled: true, quietMinutes: 4 },
      { enabled: true, quietMinutes: 121 },
      { enabled: true, quietMinutes: 15.5 },
      { enabled: true, quietMinutes: "15" },
      { enabled: "true", quietMinutes: 15 },
      { enabled: true, quietMinutes: Number.NaN },
    ])
      expect(() => parseTaskWatchPreference(input)).toThrow();
  });
});
