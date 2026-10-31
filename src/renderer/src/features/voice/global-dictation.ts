import {
  DICTATION_IDLE,
  type DictationEngine,
  type DictationState,
  VOICE_MODELS,
  VOICE_STREAM_LIMITS,
  type VoiceTranscriptionResult,
} from "@openbot/contracts/ipc";
import { type AppTextKey, en } from "@openbot/i18n";
import { currentText } from "@openbot/ui/text";
import { createSignal, onCleanup } from "solid-js";
import { appPort } from "../../app-port";
import { encodePcm16, recordingToSamples, recordingToWav } from "../../voice-recording";

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
/**
 * The engine the saved preference names, read when the recording starts. `auto` is resolved in
 * main; here it only decides whether the recording can stream, which a model on this computer and
 * ElevenLabs need.
 */
let engine: DictationEngine = "voice";

async function readEngine(): Promise<void> {
  try {
    engine = (await appPort().voice.getDictationPreference()).engine;
  } catch {
    // A preference that cannot be read keeps the model: it is the path that always existed.
    engine = "voice";
  }
}

async function start(): Promise<void> {
  stopping = false;
  if (recording) return;
  await readEngine();
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
  // The system recognition and `auto` read a whole recording; only the voice model can stream.
  let streamed = false;
  if (engine === "voice") {
    try {
      streamed = await takesStream();
    } catch (error) {
      await report({ failure: failureKey(error) });
      return;
    }
  }
  const recorded = new Blob(current.chunks, { type: current.recorder.mimeType });
  let audio: Uint8Array;
  try {
    // A stream takes 16-bit samples with no header. A whole recording goes as a WAV file.
    audio = streamed ? encodePcm16(await recordingToSamples(recorded)) : await recordingToWav(recorded);
  } catch {
    await report({ failure: "error.dictation.tooLong" });
    return;
  }
  try {
    const result = streamed
      ? await transcribeStream(audio)
      : await appPort().voice.transcribe(engine === "voice" ? { audio } : { audio, engine });
    await report({ text: result.text });
  } catch (error) {
    await report({ failure: failureKey(error) });
  }
}

/**
 * True when the model in the voice settings is in the cloud. ElevenLabs takes a stream and refuses
 * a whole recording, as in the composer. The user's own server takes the whole recording for every
 * model.
 */
async function takesStream(): Promise<boolean> {
  const voice = appPort().voice;
  const [settings, server] = await Promise.all([voice.getSettings(), voice.getServer()]);
  if (server?.routes.dictation) return false;
  return VOICE_MODELS.find((model) => model.id === settings.modelId)?.kind === "cloud";
}

/** Sends the whole recording through a stream, in parts that IPC accepts, then ends the stream. */
async function transcribeStream(pcm: Uint8Array): Promise<VoiceTranscriptionResult> {
  const voice = appPort().voice;
  const { streamId } = await voice.startStream();
  try {
    for (let offset = 0; offset < pcm.byteLength; offset += VOICE_STREAM_LIMITS.maximumChunkBytes)
      await voice.appendStream({ streamId, pcm: pcm.slice(offset, offset + VOICE_STREAM_LIMITS.maximumChunkBytes) });
  } catch (error) {
    // An open stream would take the audio of the next dictation.
    void voice.cancelStream({ streamId }).catch(() => {});
    throw error;
  }
  // Main ends the stream when it finishes, also when it fails.
  return voice.finishStream({ streamId });
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

/** Whether `key` names a plain message of the catalog, as each failure that main sends does. */
function isTextKey(key: string): key is AppTextKey {
  return Object.entries(en).some(([name, message]) => name === key && typeof message === "string");
}

/** What the overlay says, in the user's language. */
export function dictationText(next: DictationState): string {
  const text = currentText();
  if (next.phase === "failed") {
    const failure = next.failure ?? "error.dictation.failed";
    return text.t(isTextKey(failure) ? failure : "error.dictation.failed");
  }
  if (next.phase === "transcribing") return text.t("app.dictation.transcribing");
  if (next.phase === "recording") return text.t("app.dictation.recording");
  return text.t("app.dictation.done");
}
