// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLimitPreferenceStore } from "./agent-limit-preference-store";
import { parseAgentLimitPreference } from "./ipc/app-inputs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-limit-pref-"));
  roots.push(root);
  return join(root, "agent-limit.json");
}

describe("the agent limit preference", () => {
  it("is off, at ten agents, when nothing is saved, so no limit holds a turn", async () => {
    const store = new AgentLimitPreferenceStore(await path());
    await Effect.runPromise(store.load());
    expect(store.get()).toEqual({ enabled: false, max: 10 });
    expect(store.limit()).toBeNull();
  });

  it("reads as off for a damaged file, another shape, or a value out of range", async () => {
    const file = await path();
    for (const content of [
      "{ nope",
      JSON.stringify({ version: 1, enabled: "yes", max: 10 }),
      JSON.stringify({ version: 1, enabled: true, max: 0 }),
      JSON.stringify({ version: 1, enabled: true, max: 65 }),
      JSON.stringify({ version: 1, enabled: true, max: 3.5 }),
      JSON.stringify({ version: 2, enabled: true, max: 3 }),
    ]) {
      await writeFile(file, content);
      const store = new AgentLimitPreferenceStore(file);
      await Effect.runPromise(store.load());
      expect(store.limit()).toBeNull();
    }
  });

  it("keeps what was set across a restart, and gives the cap while it is on", async () => {
    const file = await path();
    await Effect.runPromise(new AgentLimitPreferenceStore(file).set({ enabled: true, max: 3 }));
    const again = new AgentLimitPreferenceStore(file);
    await Effect.runPromise(again.load());
    expect(again.get()).toEqual({ enabled: true, max: 3 });
    expect(again.limit()).toBe(3);
  });

  it("refuses a value out of range instead of storing it", async () => {
    const store = new AgentLimitPreferenceStore(await path());
    await expect(Effect.runPromise(store.set({ enabled: true, max: 0 }))).rejects.toBeDefined();
    expect(store.limit()).toBeNull();
  });
});

describe("the IPC input of the agent limit", () => {
  it("takes a whole number of agents from 1 to 64", () => {
    expect(parseAgentLimitPreference({ enabled: true, max: 1 })).toEqual({ enabled: true, max: 1 });
    expect(parseAgentLimitPreference({ enabled: false, max: 64, extra: "dropped" })).toEqual({
      enabled: false,
      max: 64,
    });
  });

  it("refuses anything else, and never clamps it", () => {
    for (const input of [
      null,
      {},
      { enabled: true },
      { enabled: true, max: 0 },
      { enabled: true, max: 65 },
      { enabled: true, max: 2.5 },
      { enabled: true, max: "10" },
      { enabled: "true", max: 10 },
    ])
      expect(() => parseAgentLimitPreference(input)).toThrow();
  });
});
