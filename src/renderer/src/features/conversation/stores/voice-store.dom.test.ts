import type { MicrophoneAccess, VoiceModelStatus } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceStore, type VoiceStoreDeps } from "./voice-store";

/**
 * The dictation of the message box reads the microphone grant of the system before it prepares a
 * model. On macOS a refusal stops it there with its own text; on Windows the status is a setting of
 * the whole system, so the dictation goes on to `getUserMedia`.
 */

/** The voice calls of main. The model download fails, so a dictation that passes the grant stops there. */
function installVoice(access: MicrophoneAccess) {
  const failed: VoiceModelStatus = {
    modelId: "parakeet-tdt-0.6b-v3",
    phase: "error",
    progress: null,
    message: "The model download failed.",
  };
  const voice = {
    getMicrophoneAccess: vi.fn(async (): Promise<MicrophoneAccess> => access),
    requestMicrophoneAccess: vi.fn(async (): Promise<MicrophoneAccess> => access),
    getSettings: vi.fn(async () => ({ modelId: "parakeet-tdt-0.6b-v3" as const, language: "pt" as const })),
    getServer: vi.fn(async () => null),
    prepareModel: vi.fn(async () => failed),
    onModelStatus: () => () => {},
  };
  Object.defineProperty(window, "openbot", { configurable: true, value: { voice } });
  return voice;
}

/** Starts one dictation and answers the errors that the message box showed. */
async function dictate(): Promise<string[]> {
  const errors: string[] = [];
  let phase: ReturnType<VoiceStoreDeps["voicePhase"]> = "idle";
  const deps: VoiceStoreDeps = {
    props: { runtime: undefined, agent: { id: "agent-1" }, server: { id: "local" } },
    resources: {
      voiceSubmitRequest: undefined,
      voiceDisposed: false,
      voiceRequestGeneration: 0,
      voiceRecorder: undefined,
      voiceStream: undefined,
      voiceRecordingTimer: undefined,
      voiceElapsedTimer: undefined,
      voiceChunks: [],
      voiceLiveRequest: undefined,
      voiceCloudStream: undefined,
      voiceMeterStop: undefined,
      voiceAgentId: undefined,
      voiceServerId: undefined,
      voiceThreadSend: false,
    },
    voicePhase: () => phase,
    setVoicePhase: (next) => {
      phase = next;
    },
    setVoiceModelProgress: () => {},
    voiceElapsedSeconds: () => 0,
    setVoiceElapsedSeconds: () => {},
    setVoiceLiveTranscript: () => {},
    voiceThreadKey: () => undefined,
    setVoiceThreadKey: () => {},
    setVoiceLevels: () => {},
    drafts: () => ({}),
    setDrafts: () => {},
    setConversationErrors: () => {},
    setComposerError: () => {},
    setComposerFocusRequest: () => {},
    clearConversationError: () => {},
    setConversationError: (_target, message) => errors.push(message),
    viewIsMounted: () => true,
    hooks: { saveEdit: async () => false, submit: async () => false, restoreTranscript: () => {} },
  };
  await createRoot(async (dispose) => {
    try {
      await createVoiceStore(deps).startVoiceRecording();
    } finally {
      dispose();
    }
  });
  expect(phase).toBe("idle");
  return errors;
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(navigator, "platform");
  Reflect.deleteProperty(window, "openbot");
});

function setPlatform(platform: "MacIntel" | "Win32"): void {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
}

describe("the grant of the system before a dictation in the message box", () => {
  it("stops on macOS before the model and the microphone when the system refused", async () => {
    setPlatform("MacIntel");
    const voice = installVoice("denied");

    const errors = await dictate();

    expect(errors).toEqual([currentText().t("composer.voice.blocked")]);
    expect(voice.prepareModel).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("names the administrator on macOS when the microphone is restricted", async () => {
    setPlatform("MacIntel");
    const voice = installVoice("restricted");

    const errors = await dictate();

    expect(errors).toEqual([currentText().t("composer.voice.restricted")]);
    expect(voice.prepareModel).not.toHaveBeenCalled();
  });

  it("goes on to the model on Windows, where the status is a setting of the whole system", async () => {
    setPlatform("Win32");
    const voice = installVoice("denied");

    const errors = await dictate();

    expect(voice.prepareModel).toHaveBeenCalledTimes(1);
    expect(voice.requestMicrophoneAccess).not.toHaveBeenCalled();
    // The failed download is the error, not a refused microphone.
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toBe(currentText().t("composer.voice.blocked"));
  });
});
