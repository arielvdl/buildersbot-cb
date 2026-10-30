// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AutoRecoveryPreferenceStore } from "./auto-recovery-preference-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "auto-recovery-pref-"));
  roots.push(root);
  return join(root, "recovery.json");
}

describe("the automatic recovery preference", () => {
  it("is off, at 30 minutes, with no reassignment, when nothing is saved", async () => {
    const store = new AutoRecoveryPreferenceStore(await path());
    await Effect.runPromise(store.load());
    expect(store.get()).toEqual({ enabled: false, intervalMinutes: 30, reassign: false });
  });

  it("reads as off for a damaged file, another shape, or a value out of range", async () => {
    const file = await path();
    for (const content of [
      "{ nope",
      JSON.stringify({ version: 1, enabled: "yes", intervalMinutes: 30, reassign: false }),
      JSON.stringify({ version: 1, enabled: true, intervalMinutes: 1, reassign: false }),
      JSON.stringify({ version: 1, enabled: true, intervalMinutes: 99999, reassign: false }),
      JSON.stringify({ version: 1, enabled: true, intervalMinutes: 30.5, reassign: false }),
    ]) {
      await writeFile(file, content);
      const store = new AutoRecoveryPreferenceStore(file);
      await Effect.runPromise(store.load());
      expect(store.get().enabled).toBe(false);
    }
  });

  it("keeps what was set across a restart", async () => {
    const file = await path();
    await Effect.runPromise(
      new AutoRecoveryPreferenceStore(file).set({ enabled: true, intervalMinutes: 45, reassign: true }),
    );
    const again = new AutoRecoveryPreferenceStore(file);
    await Effect.runPromise(again.load());
    expect(again.get()).toEqual({ enabled: true, intervalMinutes: 45, reassign: true });
  });

  it("refuses a value out of range instead of storing it", async () => {
    const store = new AutoRecoveryPreferenceStore(await path());
    await expect(
      Effect.runPromise(store.set({ enabled: true, intervalMinutes: 2, reassign: false })),
    ).rejects.toBeDefined();
    expect(store.get().enabled).toBe(false);
  });
});
