import type { BuildersBotDesktopApi, MicrophoneAccess } from "@openbot/contracts/ipc";

/** The two calls that read and ask for the grant of the system for the microphone, in main. */
type MicrophoneAccessPort = Pick<BuildersBotDesktopApi["voice"], "getMicrophoneAccess" | "requestMicrophoneAccess">;

/** Read on each call: tests and stories replace `window.openbot` per case. */
function microphonePort(): MicrophoneAccessPort {
  return window.openbot.voice;
}

/**
 * The grant of the system for the microphone, asked for first while it is not decided. A dictation
 * of the desktop app calls this before it downloads a model or opens the microphone: macOS then asks
 * at once, and a refusal gets its own text, not a browser error after a long download.
 *
 * `onPrompt` runs before the system prompt, so the caller can say that it waits for the user. A read
 * that fails answers "unknown": the dictation then goes on to `getUserMedia`, as it did before.
 */
export async function ensureMicrophoneAccess(onPrompt?: () => void): Promise<MicrophoneAccess> {
  try {
    const port = microphonePort();
    const access = await port.getMicrophoneAccess();
    if (access !== "not-determined") return access;
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
 * The composer text of a grant that stops a dictation, or null when the dictation may go on. A
 * refusal can change in System Settings; a restriction is set by the administrator of the computer.
 */
export function microphoneBlockText(
  access: MicrophoneAccess,
): "composer.voice.blocked" | "composer.voice.restricted" | null {
  if (access === "denied") return "composer.voice.blocked";
  if (access === "restricted") return "composer.voice.restricted";
  return null;
}
