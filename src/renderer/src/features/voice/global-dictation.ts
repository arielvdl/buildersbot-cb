import { DICTATION_IDLE, type DictationState } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { currentText } from "@openbot/ui/text";
import { createSignal, onCleanup } from "solid-js";
import { appPort } from "../../app-port";
import { recordingToWav } from "../../voice-recording";

/**
 * The dictation of the global combination.
 *
 * Main owns the combination and the phase; this follows the phase it sends. The microphone and the
 * models stay here, next to the rest of the voice work, so main never holds audio. A recording that
 * ends goes to the model in the voice settings, the same one the composer uses.
 */
const [state, setState] = createSignal<DictationState>(DICTATION_IDLE);

/** The phase the overlay draws. */
export const dictationState = state;

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
}

let recording: Recording | null = null;
/** A stop that arrives before the microphone opened must not be lost. */
let stopping = false;

async function start(): Promise<void> {
  stopping = false;
  if (recording) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    await report({ failure: "error.dictation.microphone" });
    return;
  }
  if (stopping) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recording = { recorder, stream, chunks };
  recorder.start();
  // A stop that arrived while the permission prompt was open is served now.
  if (stopping) await stop();
}

async function stop(): Promise<void> {
  stopping = true;
  const current = recording;
  if (!current) return;
  recording = null;
  const stopped = new Promise<void>((resolve) => {
    current.recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  current.recorder.stop();
  for (const track of current.stream.getTracks()) track.stop();
  await stopped;
  if (current.chunks.length === 0) {
    await report({ failure: "error.dictation.empty" });
    return;
  }
  let audio: Uint8Array;
  try {
    audio = await recordingToWav(new Blob(current.chunks, { type: current.recorder.mimeType }));
  } catch {
    await report({ failure: "error.dictation.tooLong" });
    return;
  }
  try {
    const result = await appPort().voice.transcribe({ audio });
    await report({ text: result.text });
  } catch (error) {
    await report({ failure: failureKey(error) });
  }
}

async function report(result: { text: string } | { failure: string }): Promise<void> {
  await appPort()
    .voice.finishDictation(result)
    .catch(() => setState(DICTATION_IDLE));
}

/**
 * The IPC failure of a transcription is a catalog key, because main sends no prose. Anything else
 * is a bug here, and reads as the generic failure.
 */
function failureKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("error.") ? message : "error.dictation.failed";
}

function cancel(): void {
  if (!recording) return;
  const current = recording;
  recording = null;
  stopping = false;
  current.recorder.stop();
  for (const track of current.stream.getTracks()) track.stop();
}

/**
 * Mounts the listener. Every window shows the phase, but only one records: a chat window and the
 * main window are both open at times, and two microphones would answer the same press.
 */
export function createGlobalDictation(capture: boolean): void {
  const stopListening = appPort().voice.onDictationState((next) => {
    setState(next);
    if (!capture) return;
    if (next.phase === "recording") void start();
    else if (next.phase === "transcribing") void stop();
    else if (next.phase === "idle" || next.phase === "failed") cancel();
  });
  onCleanup(() => {
    stopListening();
    cancel();
  });
}

/** What the overlay says, in the user's language. */
export function dictationText(next: DictationState): string {
  const text = currentText();
  if (next.phase === "failed") return text.t((next.failure ?? "error.dictation.failed") as AppTextKey);
  if (next.phase === "transcribing") return text.t("app.dictation.transcribing");
  if (next.phase === "recording") return text.t("app.dictation.recording");
  return text.t("app.dictation.done");
}
