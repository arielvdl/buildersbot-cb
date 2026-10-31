// @vitest-environment node

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { transcribeWithEngine } from "./voice-handlers";

const AUDIO = new Uint8Array(44);

function engines(options: { available?: boolean; systemText?: string; systemError?: Error } = {}) {
  const model = vi.fn(() => Effect.succeed({ text: "do modelo" }));
  return {
    os: {
      status: vi.fn(async () => ({ available: options.available ?? true, reason: null })),
      transcribe: vi.fn(async () => {
        if (options.systemError) throw options.systemError;
        return options.systemText ?? "do sistema";
      }),
    },
    voice: {
      transcribe: model,
      getSettings: () => ({ modelId: "parakeet-tdt-0.6b-v3" as const, language: "pt" as const }),
    },
    server: {
      dictates: () => false,
      transcribe: vi.fn(() => Effect.succeed({ text: "do servidor" })),
    },
    model,
  };
}

describe("the engine of a transcription", () => {
  it("keeps the model when the composer names no engine", async () => {
    const parts = engines();
    expect(await transcribeWithEngine({ audio: AUDIO }, parts)).toEqual({ text: "do modelo" });
    expect(parts.os.transcribe).not.toHaveBeenCalled();
  });

  it("reads with the system when it is named and available", async () => {
    const parts = engines();
    expect(await transcribeWithEngine({ audio: AUDIO, engine: "system" }, parts)).toEqual({ text: "do sistema" });
    expect(parts.model).not.toHaveBeenCalled();
  });

  it("uses the system on automatic when it can work", async () => {
    const parts = engines();
    expect(await transcribeWithEngine({ audio: AUDIO, engine: "auto" }, parts)).toEqual({ text: "do sistema" });
  });

  it("falls back to the model on automatic when the system is out", async () => {
    const parts = engines({ available: false });
    expect(await transcribeWithEngine({ audio: AUDIO, engine: "auto" }, parts)).toEqual({ text: "do modelo" });
    expect(parts.os.transcribe).not.toHaveBeenCalled();
  });

  it("falls back to the model when automatic finds the system broken", async () => {
    const parts = engines({ systemError: new Error("boom") });
    expect(await transcribeWithEngine({ audio: AUDIO, engine: "auto" }, parts)).toEqual({ text: "do modelo" });
  });

  it("names the failure when the system was chosen on purpose", async () => {
    const parts = engines({ systemError: new Error("boom") });
    await expect(transcribeWithEngine({ audio: AUDIO, engine: "system" }, parts)).rejects.toThrow(
      "error.dictation.failed",
    );
    expect(parts.model).not.toHaveBeenCalled();
  });
});
