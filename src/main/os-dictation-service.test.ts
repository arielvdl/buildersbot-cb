// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dictationFailureKey, OsDictationFailure, OsDictationService } from "./os-dictation-service";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A voice folder with, or without, the macOS helper. */
async function resources(withHelper: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "os-dictation-"));
  directories.push(directory);
  if (withHelper) {
    await mkdir(join(directory, "os-speech", "darwin"), { recursive: true });
    await writeFile(join(directory, "os-speech", "darwin", "os-speech"), "#!/bin/sh\n");
  }
  return directory;
}

/** A runner that answers by the arguments it is given. */
function runner(answer: (args: string[]) => { stdout?: string; stderr?: string }) {
  return vi.fn(async (_file: string, args: string[]) => {
    const { stdout = "", stderr = "" } = answer(args);
    if (stderr) throw Object.assign(new Error("failed"), { stderr });
    return { stdout, stderr };
  });
}

const WAV = new Uint8Array(44);

describe("system dictation", () => {
  it("is unavailable on a system with no speech recognition", async () => {
    const service = new OsDictationService({
      resourcesRoot: await resources(true),
      language: () => "en",
      platform: "linux",
    });
    expect(await service.status()).toEqual({ available: false, reason: "error.dictation.system.platform" });
  });

  it("is unavailable when the build has no helper", async () => {
    const service = new OsDictationService({
      resourcesRoot: await resources(false),
      language: () => "en",
      platform: "darwin",
    });
    expect(await service.status()).toEqual({ available: false, reason: "error.dictation.system.missing" });
  });

  it("is available when the Mac never asked for the permission yet", async () => {
    const service = new OsDictationService({
      resourcesRoot: await resources(true),
      language: () => "en",
      platform: "darwin",
      run: runner(() => ({ stderr: "permission: Speech recognition was not granted yet." })),
    });
    expect(await service.status()).toEqual({ available: true, reason: null });
  });

  it("reports a denied permission", async () => {
    const service = new OsDictationService({
      resourcesRoot: await resources(true),
      language: () => "en",
      platform: "darwin",
      run: runner(() => ({ stderr: "permission: Speech recognition is denied." })),
    });
    expect(await service.status()).toEqual({ available: false, reason: "error.dictation.system.permission" });
  });

  it("answers the engine a preference resolves to", async () => {
    const unavailable = new OsDictationService({
      resourcesRoot: await resources(false),
      language: () => "en",
      platform: "darwin",
    });
    expect((await unavailable.engineStatus("auto")).resolved).toBe("voice");
    expect((await unavailable.engineStatus("system")).resolved).toBe("system");

    const available = new OsDictationService({
      resourcesRoot: await resources(true),
      language: () => "en",
      platform: "darwin",
      run: runner(() => ({})),
    });
    expect((await available.engineStatus("auto")).resolved).toBe("system");
    expect((await available.engineStatus("voice")).resolved).toBe("voice");
  });

  it("sends the recording and the language to the helper", async () => {
    const run = runner(() => ({ stdout: "  olá mundo \n" }));
    const service = new OsDictationService({
      resourcesRoot: await resources(true),
      language: () => "pt",
      platform: "darwin",
      run,
    });
    expect(await service.transcribe(WAV)).toBe("olá mundo");
    const [file, args] = run.mock.calls[0] ?? [];
    expect(file).toContain("os-speech");
    expect(args).toEqual(["--language", "pt", "--file", expect.stringContaining("recording.wav")]);
  });

  it("reads the Windows answer as JSON", async () => {
    const run = runner(() => ({ stdout: JSON.stringify({ text: "hello" }) }));
    const service = new OsDictationService({
      resourcesRoot: await resources(false),
      language: () => "en",
      platform: "win32",
      run,
    });
    expect(await service.transcribe(WAV)).toBe("hello");
  });

  it("refuses a recording that Windows could not read", async () => {
    const run = runner(() => ({ stdout: JSON.stringify({ error: "language", message: "no recognizer" }) }));
    const service = new OsDictationService({
      resourcesRoot: await resources(false),
      language: () => "pt",
      platform: "win32",
      run,
    });
    await expect(service.transcribe(WAV)).rejects.toBeInstanceOf(OsDictationFailure);
  });

  it("names the catalog key of each failure", () => {
    expect(dictationFailureKey(new OsDictationFailure("permission"))).toBe("error.dictation.system.permission");
    expect(dictationFailureKey(new OsDictationFailure("language"))).toBe("error.dictation.system.language");
    expect(dictationFailureKey(new OsDictationFailure("empty"))).toBe("error.dictation.empty");
    expect(dictationFailureKey(new Error("bug"))).toBe("error.dictation.failed");
  });
});
