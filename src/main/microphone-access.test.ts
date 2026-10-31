// @vitest-environment node
// The grant of the operating system for the microphone, read in main. macOS shows its prompt only
// while the grant is not decided; Windows has no prompt for a desktop app; Linux has no such API.
import type { MicrophoneAccess } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { type MicrophoneSystem, readMicrophoneAccess, requestMicrophoneAccess } from "./microphone-access";

/** A `systemPreferences` that answers `status` until the prompt is answered, then `afterPrompt`. */
function system(platform: NodeJS.Platform, status: string, afterPrompt: MicrophoneAccess = "granted") {
  let current = status;
  const askForMediaAccess = vi.fn(async () => {
    current = afterPrompt;
    return afterPrompt === "granted";
  });
  const fake: MicrophoneSystem = { platform, getMediaAccessStatus: () => current, askForMediaAccess };
  return { fake, askForMediaAccess };
}

describe("the microphone grant", () => {
  it("shows the macOS prompt while the grant is not decided, then reads the grant again", async () => {
    const { fake, askForMediaAccess } = system("darwin", "not-determined", "denied");

    await expect(requestMicrophoneAccess(fake)).resolves.toBe("denied");
    expect(askForMediaAccess).toHaveBeenCalledTimes(1);
  });

  it("does not show the macOS prompt again after a decision", async () => {
    for (const status of ["granted", "denied", "restricted"] as const) {
      const { fake, askForMediaAccess } = system("darwin", status);

      await expect(requestMicrophoneAccess(fake)).resolves.toBe(status);
      expect(askForMediaAccess).not.toHaveBeenCalled();
    }
  });

  it("only reads the grant on Windows, which has no prompt for a desktop app", async () => {
    const { fake, askForMediaAccess } = system("win32", "not-determined");

    await expect(requestMicrophoneAccess(fake)).resolves.toBe("not-determined");
    expect(readMicrophoneAccess(system("win32", "denied").fake)).toBe("denied");
    expect(askForMediaAccess).not.toHaveBeenCalled();
  });

  it("answers unknown on Linux, and for a status that this version does not know", async () => {
    const linux = system("linux", "granted");

    expect(readMicrophoneAccess(linux.fake)).toBe("unknown");
    await expect(requestMicrophoneAccess(linux.fake)).resolves.toBe("unknown");
    expect(linux.askForMediaAccess).not.toHaveBeenCalled();
    expect(readMicrophoneAccess(system("darwin", "something-new").fake)).toBe("unknown");
  });
});
