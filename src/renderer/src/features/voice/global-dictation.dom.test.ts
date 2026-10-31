import {
  AUTOMATIC_VOICE_LANGUAGE,
  DICTATION_IDLE,
  type DictationResult,
  type DictationState,
  ELEVENLABS_VOICE_MODEL_ID,
  VOICE_MODELS,
  type VoiceServerSettings,
  type VoiceSettings,
  type VoiceStream,
  type VoiceStreamAudio,
  type VoiceTranscriptionInput,
} from "@openbot/contracts/ipc";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalDictation } from "./global-dictation";

/** jsdom has no Web Audio. This decodes each recording as one second of mono audio at 16 kHz. */
class FakeAudioContext {
  async decodeAudioData(): Promise<Pick<AudioBuffer, "sampleRate" | "length" | "numberOfChannels" | "getChannelData">> {
    return { sampleRate: 16_000, length: 16_000, numberOfChannels: 1, getChannelData: () => new Float32Array(16_000) };
  }

  async close(): Promise<void> {}
}

/** The recorders that the dictation made, newest last. */
const recorders: FakeRecorder[] = [];

/** A recorder that holds one part of audio and gives it when it stops, as the browser does. */
class FakeRecorder extends EventTarget {
  readonly mimeType = "audio/webm";
  state: "inactive" | "recording" = "inactive";

  constructor() {
    super();
    recorders.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const data = new Blob([new Uint8Array(64)], { type: this.mimeType });
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }));
    this.dispatchEvent(new Event("stop"));
  }
}

/**
 * The voice calls of main. `transcribe` refuses a cloud model as main does: ElevenLabs takes a
 * stream, not a recording. The user's own server takes the recording for every model.
 */
function installVoice(
  settings: VoiceSettings,
  server: VoiceServerSettings | null = null,
  engine: "auto" | "system" | "voice" = "voice",
) {
  let listener: ((state: DictationState) => void) | undefined;
  const cloud = VOICE_MODELS.find((model) => model.id === settings.modelId)?.kind === "cloud";
  const voice = {
    onDictationState: (next: (state: DictationState) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    finishDictation: vi.fn(async (_result: DictationResult) => DICTATION_IDLE),
    cancelDictation: vi.fn(async () => DICTATION_IDLE),
    transcribe: vi.fn(async (_input: VoiceTranscriptionInput) => {
      if (cloud && !server?.routes.dictation) throw new Error("Builders Bot could not transcribe this recording.");
      return { text: "Text from the recording" };
    }),
    getSettings: vi.fn(async () => settings),
    getServer: vi.fn(async () => server),
    getDictationPreference: vi.fn(async () => ({
      enabled: true,
      accelerator: "CommandOrControl+Shift+Space",
      mode: "paste" as const,
      engine,
    })),
    startStream: vi.fn(async (): Promise<VoiceStream> => ({ streamId: "stream-1" })),
    appendStream: vi.fn(async (_audio: VoiceStreamAudio) => undefined),
    finishStream: vi.fn(async (_stream: VoiceStream) => ({ text: "Text from ElevenLabs" })),
    cancelStream: vi.fn(async (_stream: VoiceStream) => undefined),
  };
  Object.defineProperty(window, "openbot", { configurable: true, value: { voice } });
  return { voice, publish: (state: DictationState) => listener?.(state) };
}

/** Presses the combination two times: the first press records, the second press stops. */
async function dictate(publish: (state: DictationState) => void): Promise<void> {
  publish({ phase: "recording", failure: null });
  // A stop before the microphone opens records nothing.
  await vi.waitFor(() => expect(recorders.at(-1)?.state).toBe("recording"));
  publish({ phase: "transcribing", failure: null });
}

const disposers: (() => void)[] = [];

function mount(): void {
  disposers.push(
    createRoot((dispose) => {
      createGlobalDictation(true);
      return dispose;
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
  });
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  recorders.length = 0;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(window, "openbot");
});

describe("the dictation of the global combination", () => {
  it("streams the recording to ElevenLabs, because ElevenLabs refuses a whole recording", async () => {
    const { voice, publish } = installVoice({ modelId: ELEVENLABS_VOICE_MODEL_ID, language: "pt" });
    mount();

    await dictate(publish);

    await vi.waitFor(() => expect(voice.finishDictation).toHaveBeenCalled());
    expect(voice.finishDictation).toHaveBeenCalledWith({ text: "Text from ElevenLabs" });
    expect(voice.transcribe).not.toHaveBeenCalled();
    // The whole second goes as 16-bit samples, then the stream ends.
    const sent = voice.appendStream.mock.calls.reduce((bytes, [audio]) => bytes + audio.pcm.byteLength, 0);
    expect(sent).toBe(32_000);
    expect(voice.appendStream.mock.calls.every(([audio]) => audio.streamId === "stream-1")).toBe(true);
    expect(voice.finishStream).toHaveBeenCalledWith({ streamId: "stream-1" });
  });

  it("sends the whole recording to a model on this computer", async () => {
    const { voice, publish } = installVoice({ modelId: "parakeet-tdt-0.6b-v3", language: AUTOMATIC_VOICE_LANGUAGE });
    mount();

    await dictate(publish);

    await vi.waitFor(() => expect(voice.finishDictation).toHaveBeenCalled());
    expect(voice.finishDictation).toHaveBeenCalledWith({ text: "Text from the recording" });
    // A WAV file: a 44-byte header, then the second of audio as 16-bit samples.
    expect(voice.transcribe.mock.calls.map(([input]) => input.audio.byteLength)).toEqual([44 + 32_000]);
    expect(voice.startStream).not.toHaveBeenCalled();
  });

  it("sends a whole recording to the system recognition, without a stream", async () => {
    const { voice, publish } = installVoice({ modelId: ELEVENLABS_VOICE_MODEL_ID, language: "pt" }, null, "system");
    mount();

    await dictate(publish);

    await vi.waitFor(() => expect(voice.finishDictation).toHaveBeenCalled());
    expect(voice.transcribe.mock.calls.map(([input]) => input.engine)).toEqual(["system"]);
    expect(voice.startStream).not.toHaveBeenCalled();
  });

  it("sends the whole recording to the user's own server, also while ElevenLabs is selected", async () => {
    const server: VoiceServerSettings = {
      address: "http://studio.local:8000/v1",
      hasApiKey: false,
      routes: { dictation: true, speech: false, transcriptionModel: "whisper-1", speechModel: null, voice: null },
    };
    const { voice, publish } = installVoice({ modelId: ELEVENLABS_VOICE_MODEL_ID, language: "pt" }, server);
    mount();

    await dictate(publish);

    await vi.waitFor(() => expect(voice.finishDictation).toHaveBeenCalled());
    expect(voice.finishDictation).toHaveBeenCalledWith({ text: "Text from the recording" });
    expect(voice.startStream).not.toHaveBeenCalled();
  });

  it("ends the stream and reports the failure when a part of the audio does not go", async () => {
    const { voice, publish } = installVoice({ modelId: ELEVENLABS_VOICE_MODEL_ID, language: "pt" });
    voice.appendStream.mockRejectedValueOnce(new Error("The stream closed."));
    mount();

    await dictate(publish);

    await vi.waitFor(() => expect(voice.finishDictation).toHaveBeenCalled());
    expect(voice.finishDictation).toHaveBeenCalledWith({ failure: "error.dictation.failed" });
    expect(voice.cancelStream).toHaveBeenCalledWith({ streamId: "stream-1" });
    expect(voice.finishStream).not.toHaveBeenCalled();
  });
});
