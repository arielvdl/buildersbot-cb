// The grant of the operating system for this app's microphone, read in main.
//
// The renderer asks for the microphone with `getUserMedia`, and macOS shows its prompt only when the
// dictation reaches that call. A dictation that stops earlier, for example at a model that is not
// ready, never shows the prompt, and a refusal shows only a browser error. Main reads the grant
// first, so the window can ask before a long model download and can name the System Settings pane.

import { isMicrophoneAccess, type MicrophoneAccess } from "@openbot/contracts/ipc";

/** The part of Electron's `systemPreferences` that the grant uses. Injected, so a test needs no Electron. */
export interface MicrophoneSystem {
  platform: NodeJS.Platform;
  getMediaAccessStatus: (mediaType: "microphone") => string;
  askForMediaAccess: (mediaType: "microphone") => Promise<boolean>;
}

/** The grant on macOS and Windows. Linux has no such API, so the answer there is "unknown". */
export function readMicrophoneAccess(system: MicrophoneSystem): MicrophoneAccess {
  if (system.platform !== "darwin" && system.platform !== "win32") return "unknown";
  const status = system.getMediaAccessStatus("microphone");
  return isMicrophoneAccess(status) ? status : "unknown";
}

/**
 * Shows the macOS prompt while the grant is not decided, then reads the grant again. macOS shows
 * the prompt only in that state; after a refusal only System Settings changes the grant, and the app
 * must start again. Windows has no prompt for a desktop app, so there this only reads.
 */
export async function requestMicrophoneAccess(system: MicrophoneSystem): Promise<MicrophoneAccess> {
  const current = readMicrophoneAccess(system);
  if (system.platform !== "darwin" || current !== "not-determined") return current;
  await system.askForMediaAccess("microphone");
  return readMicrophoneAccess(system);
}
