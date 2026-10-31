// @vitest-environment node
// A saved voice key that this computer cannot decrypt: after the keychain item changed, or after a
// profile was copied from another app. The store says "unreadable" and keeps the file, its one log
// line holds no part of the key, the dictation service names the reason, and the user's own voice
// server does not say that it refused a key that was never sent.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELEVENLABS_VOICE_MODEL_ID, type LocalVoiceModelId } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { teeLogLines } from "@openbot/logging";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { type VoiceApiKeyCipher, VoiceApiKeyStore } from "./voice-api-key-store";
import { VoicePreferenceStore } from "./voice-preference-store";
import { createVoiceServerPreferenceStore, VoiceServerService } from "./voice-server-service";
import { VoiceTranscriptionService } from "./voice-transcription-service";

const KEY = "sk_test_voice_key_3b9d1f";
const NEW_KEY = "sk_test_voice_key_new_8c2e";

/**
 * A keychain item with a name. It decrypts only what it sealed itself, as `safeStorage` does after
 * the keychain item changed.
 */
function keychain(name: string): VoiceApiKeyCipher {
  return {
    canPersist: () => true,
    encrypt: (value) => Buffer.from(`${name}\n${value}`, "utf8"),
    decrypt: (value) => {
      const [sealedBy, ...rest] = value.toString("utf8").split("\n");
      if (sealedBy !== name) throw new Error(`Cannot decrypt ${value.toString("base64")}`);
      return rest.join("\n");
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "voice-key-unreadable-"));
  roots.push(root);
  return root;
}

/** A key file sealed by the old keychain item, loaded with the new one. */
async function unreadableKeyStore(path: string): Promise<VoiceApiKeyStore> {
  const before = new VoiceApiKeyStore({ path, cipher: keychain("old") });
  await Effect.runPromise(before.load());
  await Effect.runPromise(before.set(KEY));
  const after = new VoiceApiKeyStore({ path, cipher: keychain("new") });
  await Effect.runPromise(after.load());
  return after;
}

async function failureMessage(effect: Effect.Effect<unknown, { cause: unknown }>): Promise<string | null> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return null;
  const cause = result.failure.cause;
  return cause instanceof Error ? cause.message : String(cause);
}

describe("a voice key that this computer cannot decrypt", () => {
  it("is unreadable, keeps its file, and logs one line with no part of the key", async () => {
    const path = join(await directory(), "voice-api-key.json");
    const lines: string[] = [];
    const stopTee = teeLogLines(["voice-api-key-store"], (line) => lines.push(line));
    let keys: VoiceApiKeyStore;
    try {
      keys = await unreadableKeyStore(path);
    } finally {
      stopTee();
    }
    const file = JSON.parse(await readFile(path, "utf8"));
    const sealed = isDynamicRecord(file) && typeof file.key === "string" ? file.key : "";

    expect(keys.status()).toBe("unreadable");
    expect(keys.get()).toBeNull();
    expect(existsSync(path)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("voice-api-key.json");
    expect(lines[0]).toContain("decrypt-failed");
    expect(sealed.length).toBeGreaterThan(16);
    expect(lines.every((line) => !line.includes(KEY) && !line.includes(sealed.slice(0, 16)))).toBe(true);
  });

  it("is missing after the removal, and saved after a new key", async () => {
    const path = join(await directory(), "voice-api-key.json");
    const keys = await unreadableKeyStore(path);

    await Effect.runPromise(keys.set(null));
    expect(existsSync(path)).toBe(false);
    expect(keys.status()).toBe("missing");
    await Effect.runPromise(keys.set(NEW_KEY));
    expect(keys.status()).toBe("saved");
    expect(keys.get()).toBe(NEW_KEY);
  });

  it("gives the ElevenLabs model the unreadable-key text, not the text that asks for a key", async () => {
    const root = await directory();
    const keys = await unreadableKeyStore(join(root, "voice-api-key.json"));
    const preferences = new VoicePreferenceStore(join(root, "voice-preference.json"));
    await Effect.runPromise(preferences.load());
    await Effect.runPromise(preferences.set({ ...preferences.get(), modelId: ELEVENLABS_VOICE_MODEL_ID }));
    const modelDirectories: Record<LocalVoiceModelId, string> = {
      "parakeet-tdt-0.6b-v3": join(root, "parakeet"),
      "bark-3.0-plus": join(root, "bark"),
      "whisper-turbo": join(root, "whisper"),
    };
    const voice = new VoiceTranscriptionService({
      resourcesRoot: join(root, "resources"),
      modelDirectories,
      preferences,
      apiKeys: keys,
      // The status of the cloud model never starts a host or opens a socket.
      spawnHost: () => {
        throw new Error("The status checks must not start the transcription host.");
      },
      openStreamSocket: () => {
        throw new Error("The status checks must not open a socket.");
      },
    });
    const unreadable = sourceText("error.voice.cloud.keyUnreadable");
    try {
      await expect(Effect.runPromise(voice.getModelStatus())).resolves.toMatchObject({
        phase: "error",
        message: unreadable,
      });
      await expect(Effect.runPromise(voice.prepareModel())).resolves.toMatchObject({
        phase: "error",
        message: unreadable,
      });
      await expect(failureMessage(voice.startStream())).resolves.toBe(unreadable);

      await expect(Effect.runPromise(voice.setApiKey(null))).resolves.toMatchObject({
        phase: "missing",
        message: sourceText("error.voice.cloud.keyRequired"),
      });
      await expect(Effect.runPromise(voice.setApiKey(NEW_KEY))).resolves.toMatchObject({ phase: "ready" });
    } finally {
      await Effect.runPromise(voice.shutdown());
    }
  });
});

describe("the voice server with a saved key that this computer cannot decrypt", () => {
  const address = "http://studio.local:8000/v1";
  const routes = { dictation: true, speech: false, transcriptionModel: "whisper-1", speechModel: null, voice: null };
  /** A tenth of a second of silence after the 44-byte header. The fake server reads no audio. */
  const wav = new Uint8Array(44 + 3_200);

  async function service() {
    const root = await directory();
    const keyPath = join(root, "voice-server-key.json");
    const preferences = createVoiceServerPreferenceStore(join(root, "voice-server.json"));
    await Effect.runPromise(preferences.load());
    await Effect.runPromise(preferences.set({ server: { address, routes } }));
    const keys = await unreadableKeyStore(keyPath);
    /** The fake server refuses a request with no key until `open` is set. */
    const fake: { open: boolean; authorized: boolean[] } = { open: false, authorized: [] };
    const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const authorized = new Headers(init?.headers).has("Authorization");
      fake.authorized.push(authorized);
      if (!authorized && !fake.open) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ text: "Server transcript" }), { status: 200 });
    };
    const server = new VoiceServerService({
      preferences,
      apiKeys: keys,
      fetch: Object.assign(fakeFetch, { preconnect: fetch.preconnect }),
    });
    return { server, keys, keyPath, fake };
  }

  it("says that the key cannot be read, and keeps hasApiKey false as before", async () => {
    const { server } = await service();

    expect(server.get()).toMatchObject({ hasApiKey: false, apiKeyUnreadable: true });
  });

  it("keeps the unreadable file when a save has no typed key", async () => {
    const { server, keyPath } = await service();

    await Effect.runPromise(server.set({ address, apiKey: null, routes }));

    expect(existsSync(keyPath)).toBe(true);
  });

  it("says that the saved key cannot be read when the server refuses the request", async () => {
    const { server, fake } = await service();

    await expect(failureMessage(server.transcribe(wav, "pt"))).resolves.toBe(
      sourceText("error.voice.server.keyUnreadable"),
    );
    fake.open = true;
    await expect(Effect.runPromise(server.transcribe(wav, "pt"))).resolves.toEqual({ text: "Server transcript" });
    // No request carried a key while the saved key could not be read.
    expect(fake.authorized).toEqual([false, false]);
  });

  it("names the unreadable key in the check of the server form, and not a refused key", async () => {
    const { server } = await service();

    await expect(Effect.runPromise(server.probe({ address, apiKey: null }))).resolves.toEqual({
      ok: false,
      field: "apiKey",
      message: sourceText("error.voice.server.keyUnreadable"),
    });
  });

  it("clears the unreadable state with a new key", async () => {
    const { server, keys } = await service();

    const renewed = await Effect.runPromise(server.set({ address, apiKey: NEW_KEY, routes }));

    expect(renewed?.hasApiKey).toBe(true);
    expect(renewed?.apiKeyUnreadable).toBeUndefined();
    expect(keys.status()).toBe("saved");
  });
});
