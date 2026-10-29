// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DICTATION_IDLE } from "@openbot/contracts/ipc";
import { Effect } from "effect";

/** The clipboard of the test, and the combinations the service registered. */
interface TestState {
  clipboard: string;
  registered: Map<string, () => void>;
  commands: { command: string; args: string[] }[];
  failPaste: boolean;
  windows: number;
}

const state: TestState = {
  clipboard: "",
  registered: new Map<string, () => void>(),
  commands: [],
  failPaste: false,
  windows: 1,
};

mock.module("electron", () => ({
  clipboard: {
    readText: async () => state.clipboard,
    writeText: async (text: string) => {
      state.clipboard = text;
    },
  },

  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (state.registered.has(accelerator)) return false;
      state.registered.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => state.registered.delete(accelerator),
    unregisterAll: () => state.registered.clear(),
  },
}));

mock.module("node:child_process", () => ({
  execFile: (
    command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    state.commands.push({ command, args });
    callback(state.failPaste ? new Error("no accessibility") : null, { stdout: "", stderr: "" });
  },
}));

const { DictationPreferenceStore } = await import("./dictation-preference-store");
const { DictationService } = await import("./dictation-service");

/** Waits on a condition instead of on the clock, as the repository asks of its tests. */
async function until(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      check();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  check();
}

const directories: string[] = [];
const phases: string[] = [];

async function service(platform: NodeJS.Platform = "darwin"): Promise<InstanceType<typeof DictationService>> {
  const directory = await mkdtemp(join(tmpdir(), "dictation-service-"));
  directories.push(directory);
  const preferences = new DictationPreferenceStore(join(directory, "dictation-preference.json"));
  await Effect.runPromise(preferences.load());
  const built = new DictationService(preferences, (next) => phases.push(next.phase), platform);
  built.watchRecorderWindow(() => state.windows > 0);
  built.apply();
  return built;
}

beforeEach(() => {
  state.clipboard = "before";
  state.registered.clear();
  state.commands.length = 0;
  state.failPaste = false;
  state.windows = 1;
  phases.length = 0;
});

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("dictation service", () => {
  it("registers nothing while it is off", async () => {
    await service();
    expect(state.registered.size).toBe(0);
  });

  it("registers the saved combination when it is on", async () => {
    const built = await service();
    await built.setPreference({ enabled: true });
    expect([...state.registered.keys()]).toEqual(["CommandOrControl+Shift+Space"]);
  });

  it("refuses a combination another app already holds and keeps the saved one", async () => {
    state.registered.set("Control+Alt+D", () => undefined);
    const built = await service();
    await expect(built.setPreference({ enabled: true, accelerator: "Control+Alt+D" })).rejects.toThrow(
      "Another app already uses that combination.",
    );
    expect(built.preference.enabled).toBe(false);
  });

  it("starts on the combination and stops on the next press", async () => {
    const built = await service();
    await built.setPreference({ enabled: true });
    state.registered.get("CommandOrControl+Shift+Space")?.();
    expect(built.state.phase).toBe("recording");
    state.registered.get("CommandOrControl+Shift+Space")?.();
    expect(built.state.phase).toBe("transcribing");
  });

  it("pastes a transcript and puts the previous clipboard back", async () => {
    const built = await service();
    await built.setPreference({ enabled: true });
    built.start();
    built.stop();
    const ended = await built.finish({ text: "  olá mundo  " });
    expect(state.clipboard).toBe("olá mundo");
    expect(state.commands[0]?.command).toBe("osascript");
    expect(state.commands[0]?.args.join(" ")).toContain("keystroke");
    await until(() => expect(state.clipboard).toBe("before"));
    expect(ended.phase).toBe("done");
  });

  it("leaves the text on the clipboard in copy mode", async () => {
    const built = await service();
    await built.setPreference({ enabled: true, mode: "copy" });
    built.start();
    built.stop();
    await built.finish({ text: "copiado" });
    expect(state.clipboard).toBe("copiado");
    expect(state.commands).toHaveLength(0);
  });

  it("keeps the text on the clipboard when the paste needs a permission", async () => {
    state.failPaste = true;
    const built = await service();
    await built.setPreference({ enabled: true });
    built.start();
    built.stop();
    const ended = await built.finish({ text: "olá" });
    expect(ended).toEqual({ phase: "failed", failure: "error.dictation.pastePermission" });
    expect(state.clipboard).toBe("olá");
  });

  it("names an empty recording instead of pasting nothing", async () => {
    const built = await service();
    await built.setPreference({ enabled: true });
    built.start();
    built.stop();
    expect(await built.finish({ text: "   " })).toEqual({ phase: "failed", failure: "error.dictation.empty" });
    expect(state.commands).toHaveLength(0);
  });

  it("returns to idle after a moment, so the next press starts cleanly", async () => {
    const built = await service();
    await built.setPreference({ enabled: true, mode: "copy" });
    built.start();
    built.stop();
    await built.finish({ text: "olá" });
    expect(built.state.phase).toBe("done");
    await until(() => expect(built.state).toEqual(DICTATION_IDLE));
  });

  it("names the missing window instead of recording with nobody", async () => {
    const built = await service();
    await built.setPreference({ enabled: true });
    state.windows = 0;
    built.start();
    expect(built.state).toEqual({ phase: "failed", failure: "error.dictation.noWindow" });
  });

  it("cancels a recording without a transcript", async () => {
    const built = await service();
    await built.setPreference({ enabled: true });
    built.start();
    expect(built.cancel().phase).toBe("idle");
    expect(await built.finish({ text: "tarde demais" })).toEqual(DICTATION_IDLE);
  });

  it("uses the Windows paste command there", async () => {
    const built = await service("win32");
    await built.setPreference({ enabled: true });
    built.start();
    built.stop();
    await built.finish({ text: "olá" });
    expect(state.commands[0]?.command).toBe("powershell");
    expect(state.commands[0]?.args.join(" ")).toContain("SendKeys");
  });
});
