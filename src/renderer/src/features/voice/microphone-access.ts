import type { BuildersBotDesktopApi, MicrophoneAccess } from "@openbot/contracts/ipc";
import { currentDevicePlatform } from "../../send-shortcut-preference";

/** The two calls that read and ask for the grant of the system for the microphone, in main. */
type MicrophoneAccessPort = Pick<BuildersBotDesktopApi["voice"], "getMicrophoneAccess" | "requestMicrophoneAccess">;

/** Read on each call: tests and stories replace `window.openbot` per case. */
function microphonePort(): MicrophoneAccessPort {
  return window.openbot.voice;
}

/**
 * The grant of the system for the microphone, asked for first while it is not decided. A dictation
 * of the desktop app calls this before it downloads a model or opens the microphone: macOS then asks
 * at once, and a refusal gets its own text, not a browser error after a long download. Only macOS
 * has a prompt for a desktop app, so on Windows this only reads.
 *
 * `onPrompt` runs before the system prompt, so the caller can say that it waits for the user. A read
 * that fails answers "unknown": the dictation then goes on to `getUserMedia`, as it did before.
 */
export async function ensureMicrophoneAccess(onPrompt?: () => void): Promise<MicrophoneAccess> {
  try {
    const port = microphonePort();
    const access = await port.getMicrophoneAccess();
    if (access !== "not-determined" || currentDevicePlatform() !== "darwin") return access;
    onPrompt?.();
    return await port.requestMicrophoneAccess();
  } catch {
    return "unknown";
  }
}

/** Reads the grant without a prompt. A read that fails answers "unknown", and the row is not shown. */
export async function readMicrophoneAccess(): Promise<MicrophoneAccess> {
  try {
    return await microphonePort().getMicrophoneAccess();
  } catch {
    return "unknown";
  }
}

/** Shows the system prompt while the grant is not decided, and answers the grant after it. */
export async function askForMicrophoneAccess(): Promise<MicrophoneAccess> {
  try {
    return await microphonePort().requestMicrophoneAccess();
  } catch {
    return "unknown";
  }
}

/**
 * The grant that stops a dictation before `getUserMedia`, or null when the dictation may go on. Only
 * macOS stops early: there the grant is the grant of this app. On Windows the status comes from a
 * setting of the whole system, and it is not known to match the grant of a desktop app. A dictation
 * there goes on to `getUserMedia`, which shows the same refusal text when the system refuses.
 */
export function blockingMicrophoneAccess(
  access: MicrophoneAccess,
  platform: "darwin" | "win32" | "linux" = currentDevicePlatform(),
): "denied" | "restricted" | null {
  if (platform !== "darwin") return null;
  return access === "denied" || access === "restricted" ? access : null;
}

/**
 * The composer text of a grant that stops a dictation, or null when the dictation may go on. A
 * refusal can change in System Settings; a restriction is set by the administrator of the computer.
 */
export function microphoneBlockText(
  access: MicrophoneAccess,
  platform: "darwin" | "win32" | "linux" = currentDevicePlatform(),
): "composer.voice.blocked" | "composer.voice.restricted" | null {
  const blocked = blockingMicrophoneAccess(access, platform);
  if (blocked === "denied") return "composer.voice.blocked";
  if (blocked === "restricted") return "composer.voice.restricted";
  return null;
}
