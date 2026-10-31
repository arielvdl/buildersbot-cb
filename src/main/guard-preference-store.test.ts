// @vitest-environment node
// The Guard preference: its default, a damaged file, and the change a window sends across the
// renderer-to-main boundary. A window can choose only a level that this version runs.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GUARD_PREFERENCE, parseGuardPreferenceChange } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { decodeGuardState } from "../preload/guard-decoding";
import { GuardPreferenceStore } from "./guard-preference-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guard-pref-"));
  roots.push(root);
  return join(root, "guard.json");
}

describe("the Guard preference", () => {
  it("is Light with the fast Cultura Builder model when nothing is saved", async () => {
    const store = new GuardPreferenceStore(await path());
    await Effect.runPromise(store.load());
    expect(store.get()).toEqual({
      level: "light",
      judge: { provider: "cultura-builder", model: "cultura-builder/builder-fast" },
    });
  });

  it("reads a damaged file, another version or another shape as the default, never as off", async () => {
    const file = await path();
    for (const content of [
      "{ nope",
      JSON.stringify({ version: 2, level: "off", judge: null }),
      JSON.stringify({ version: 1, level: "asleep", judge: null }),
      JSON.stringify({ version: 1, level: "off", judge: { provider: "nobody", model: "x" } }),
      JSON.stringify({ version: 1, level: "off" }),
    ]) {
      await writeFile(file, content);
      const store = new GuardPreferenceStore(file);
      await Effect.runPromise(store.load());
      expect(store.get()).toEqual(DEFAULT_GUARD_PREFERENCE);
    }
  });

  it("keeps a change across a restart, and keeps the choice that was not changed", async () => {
    const file = await path();
    const first = new GuardPreferenceStore(file);
    await Effect.runPromise(first.set({ level: "off" }));
    await Effect.runPromise(first.set({ judge: null }));
    const again = new GuardPreferenceStore(file);
    await Effect.runPromise(again.load());
    expect(again.get()).toEqual({ level: "off", judge: null });
    await Effect.runPromise(again.set({ level: "light" }));
    expect(again.get()).toEqual({ level: "light", judge: null });
  });
});

describe("parseGuardPreferenceChange", () => {
  it("accepts a level that this version runs, a model choice, or none", () => {
    expect(parseGuardPreferenceChange({ level: "off" })).toEqual({ level: "off" });
    expect(parseGuardPreferenceChange({ judge: null })).toEqual({ judge: null });
    expect(
      parseGuardPreferenceChange({ level: "light", judge: { provider: "claude", model: "claude-haiku" } }),
    ).toEqual({ level: "light", judge: { provider: "claude", model: "claude-haiku" } });
  });

  it.each([
    ["nothing", undefined],
    ["an empty change", {}],
    ["a planned level", { level: "strict" }],
    ["a custom level", { level: "custom" }],
    ["an unknown level", { level: "asleep" }],
    ["an unknown field", { level: "off", timeoutMs: 1 }],
    ["an unknown provider", { judge: { provider: "evil", model: "x" } }],
    ["a model id with a space", { judge: { provider: "claude", model: "a b" } }],
    ["a model id that is too long", { judge: { provider: "claude", model: "m".repeat(201) } }],
    ["a model id that is not text", { judge: { provider: "claude", model: 1 } }],
  ])("refuses %s", (_name, input) => {
    expect(() => parseGuardPreferenceChange(input)).toThrow();
  });
});

describe("decodeGuardState", () => {
  it("passes a state and refuses another shape", () => {
    const state = { preference: DEFAULT_GUARD_PREFERENCE, judgeReady: false };
    expect(decodeGuardState(state)).toEqual(state);
    expect(() => decodeGuardState({ preference: DEFAULT_GUARD_PREFERENCE })).toThrow();
    expect(() => decodeGuardState({ preference: { level: "x", judge: null }, judgeReady: true })).toThrow();
  });
});
