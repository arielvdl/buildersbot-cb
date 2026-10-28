// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DICTATION_PREFERENCE,
  isDictationAccelerator,
  isDictationPreference,
  normalizeDictationAccelerator,
  parseDictationPreferenceChange,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DictationPreferenceStore } from "./dictation-preference-store";

const directories: string[] = [];

async function storeWith(content?: unknown): Promise<DictationPreferenceStore> {
  const directory = await mkdtemp(join(tmpdir(), "dictation-preference-"));
  directories.push(directory);
  const path = join(directory, "dictation-preference.json");
  if (content !== undefined) await writeFile(path, JSON.stringify(content));
  const store = new DictationPreferenceStore(path);
  await Effect.runPromise(store.load());
  return store;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("dictation accelerator", () => {
  it("takes a modifier and one key", () => {
    for (const accelerator of ["CommandOrControl+Shift+Space", "Control+Alt+D", "Command+F5", "Alt+num1"]) {
      expect(isDictationAccelerator(accelerator), accelerator).toBe(true);
    }
  });

  it("refuses a bare key, a modifier alone and a key it cannot name", () => {
    for (const accelerator of ["D", "Shift", "Control+Shift", "Control+Shift+Unobtainium", "", "Control+"]) {
      expect(isDictationAccelerator(accelerator), accelerator).toBe(false);
    }
  });

  it("keeps the combination as typed, without the spaces around its parts", () => {
    expect(normalizeDictationAccelerator(" Control + Alt + D ")).toBe("Control+Alt+D");
  });
});

describe("dictation change", () => {
  it("reads the three choices", () => {
    expect(parseDictationPreferenceChange({ enabled: true, accelerator: "Control + Alt + D", mode: "copy" })).toEqual({
      enabled: true,
      accelerator: "Control+Alt+D",
      mode: "copy",
    });
  });

  it("refuses a combination another app would take from every app", () => {
    expect(() => parseDictationPreferenceChange({ accelerator: "D" })).toThrow();
  });

  it("refuses a change that says nothing", () => {
    expect(() => parseDictationPreferenceChange({})).toThrow();
  });
});

describe("dictation preference store", () => {
  it("is off by default", async () => {
    const store = await storeWith();
    expect(store.get()).toEqual(DEFAULT_DICTATION_PREFERENCE);
    expect(store.get().enabled).toBe(false);
  });

  it("keeps what it saves", async () => {
    const store = await storeWith();
    await Effect.runPromise(store.set({ enabled: true, accelerator: "Control+Alt+D", mode: "copy" }));
    expect(store.get()).toEqual({ enabled: true, accelerator: "Control+Alt+D", mode: "copy" });
  });

  it("changes one choice and leaves the others", async () => {
    const store = await storeWith({ ...DEFAULT_DICTATION_PREFERENCE, enabled: true });
    await Effect.runPromise(store.set({ mode: "copy" }));
    expect(store.get()).toEqual({ ...DEFAULT_DICTATION_PREFERENCE, enabled: true, mode: "copy" });
  });

  it("reads an unreadable file as the default", async () => {
    const store = await storeWith({ ...DEFAULT_DICTATION_PREFERENCE, accelerator: "D" });
    expect(store.get()).toEqual(DEFAULT_DICTATION_PREFERENCE);
    expect(isDictationPreference(store.get())).toBe(true);
  });
});
