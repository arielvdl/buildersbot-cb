// Checks what the voice services do with a saved API key that this computer cannot decrypt, with
// the real stores and services and no app window. This is the state after the keychain item of the
// app changed, or after a profile was copied from another app (voice-anywhere design, section 2.2).
//
// The keychain is replaced by two AES-256-GCM ciphers with different keys: the file is sealed with
// the first one and read with the second one, so the decryption fails as `safeStorage` fails.
//   1. The ElevenLabs key: the store reports "unreadable", the file stays on the disk, and one log
//      line names the file and the category, with no part of the sealed value.
//   2. The dictation service: the cloud model status is "error" with the unreadable-key text, not
//      "missing"; `prepareModel` and `startStream` give the same text.
//   3. Reverse: removing the key deletes the file and the status is "missing"; a new key is "saved"
//      and the model is "ready".
//   4. The user's own voice server (Fase 0b): `hasApiKey` stays false as before and the additive
//      `apiKeyUnreadable` is true. A save with no typed key keeps the file. A server that refuses
//      the request says that the saved key cannot be read; a server that needs no key still answers.
//      A new key clears the state.
//   5. The secret health registry (Fase 0b): a custom agent whose values cannot be decrypted is
//      counted, and the registry lists only the stores that cannot read their file now, with the
//      file name and no value. A key that is saved again leaves the list at once.
//
// Run: bun scripts/voice-key-unreadable-smoke.ts
// It writes .openbot-build/voice-anywhere/f0a-key-unreadable.json and exits non-zero on a failure.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ELEVENLABS_VOICE_MODEL_ID, type LocalVoiceModelId } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger, teeLogLines } from "@openbot/logging";
import { Effect, Result } from "effect";
import { CUSTOM_AGENTS_FILE, CustomAgentStore } from "../src/main/custom-agent-store";
import { registerSecretHealthSource, unreadableSecrets } from "../src/main/secret-health";
import { type VoiceApiKeyCipher, VoiceApiKeyStore } from "../src/main/voice-api-key-store";
import { VoicePreferenceStore } from "../src/main/voice-preference-store";
import { createVoiceServerPreferenceStore, VoiceServerService } from "../src/main/voice-server-service";
import type { VoiceTranscriptionHostProcess } from "../src/main/voice-transcription-protocol";
import { VoiceTranscriptionService } from "../src/main/voice-transcription-service";

const OUTPUT = resolve(".openbot-build/voice-anywhere");
const REPORT = join(OUTPUT, "f0a-key-unreadable.json");
const KEY = "sk_smoke_voice_key_3b9d1f";
const NEW_KEY = "sk_smoke_voice_key_new_8c2e";
const logger = createBuildersBotLogger("voice-key-unreadable-smoke");

interface Check {
  name: string;
  passed: boolean;
  detail: unknown;
}

/** A cipher like `safeStorage`: a key of its own, and a decryption that throws on another key's data. */
function aesCipher(): VoiceApiKeyCipher {
  const key = randomBytes(32);
  return {
    canPersist: () => true,
    encrypt: (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
    },
    decrypt: (value) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

/** The status checks never start a host or open a socket. Either call is a failure of this script. */
function refuseHost(): VoiceTranscriptionHostProcess {
  throw new Error("The status checks must not start the transcription host.");
}

async function failureMessage(effect: Effect.Effect<unknown, { cause: unknown }>): Promise<string | null> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return null;
  const cause = result.failure.cause;
  return cause instanceof Error ? cause.message : String(cause);
}

const checks: Check[] = [];
function check(name: string, passed: boolean, detail: unknown): void {
  checks.push({ name, passed, detail });
  logger.info(`${passed ? "PASS" : "FAIL"} ${name}`);
}

const directory = await mkdtemp(join(tmpdir(), "voice-key-unreadable-"));
const lines: string[] = [];
const stopTee = teeLogLines(["voice-api-key-store", "voice-transcription-service"], (line) => lines.push(line));
try {
  const keyPath = join(directory, "voice-api-key.json");
  const before = new VoiceApiKeyStore({ path: keyPath, cipher: aesCipher() });
  await Effect.runPromise(before.load());
  await Effect.runPromise(before.set(KEY));
  const file = JSON.parse(await readFile(keyPath, "utf8"));
  const sealed = isDynamicRecord(file) && typeof file.key === "string" ? file.key : "";

  // 1. The keychain changed: the same file, another cipher.
  const keys = new VoiceApiKeyStore({ path: keyPath, cipher: aesCipher() });
  await Effect.runPromise(keys.load());
  check("the store reports the key as unreadable", keys.status() === "unreadable", keys.status());
  check("the store holds no key", keys.get() === null, keys.get() === null ? null : "a key");
  check("the file stays on the disk", existsSync(keyPath), keyPath);
  const keyLines = lines.filter((line) => line.includes("voice-api-key-store"));
  check(
    "one log line names the file and the category",
    keyLines.length === 1 &&
      keyLines[0]?.includes("voice-api-key.json") === true &&
      keyLines[0].includes("decrypt-failed"),
    keyLines,
  );
  check("the file holds a sealed value", sealed.length > 16, sealed.length);
  check(
    "no log line holds the key or the sealed value",
    lines.every((line) => !line.includes(KEY) && !line.includes(sealed.slice(0, 16))),
    lines.length,
  );

  // 2. The dictation service with ElevenLabs selected.
  const preferences = new VoicePreferenceStore(join(directory, "voice-preference.json"));
  await Effect.runPromise(preferences.load());
  await Effect.runPromise(preferences.set({ ...preferences.get(), modelId: ELEVENLABS_VOICE_MODEL_ID }));
  const modelDirectories: Record<LocalVoiceModelId, string> = {
    "parakeet-tdt-0.6b-v3": join(directory, "parakeet"),
    "bark-3.0-plus": join(directory, "bark"),
    "whisper-turbo": join(directory, "whisper"),
  };
  const voice = new VoiceTranscriptionService({
    resourcesRoot: join(directory, "resources"),
    modelDirectories,
    preferences,
    apiKeys: keys,
    spawnHost: refuseHost,
    openStreamSocket: () => {
      throw new Error("The status checks must not open a socket.");
    },
  });
  const unreadable = sourceText("error.voice.cloud.keyUnreadable");
  const status = await Effect.runPromise(voice.getModelStatus());
  check(
    "the cloud model is an error with the unreadable-key text",
    status.phase === "error" && status.message === unreadable,
    status,
  );
  const prepared = await Effect.runPromise(voice.prepareModel());
  check("prepareModel gives the same status", prepared.phase === "error" && prepared.message === unreadable, prepared);
  const streamFailure = await failureMessage(voice.startStream());
  check("startStream fails with the unreadable-key text", streamFailure === unreadable, streamFailure);

  // 3. Reverse: remove, then save a new key.
  const removed = await Effect.runPromise(voice.setApiKey(null));
  check("removing the key deletes the file", !existsSync(keyPath), keyPath);
  check(
    "after the removal the key is missing",
    keys.status() === "missing" &&
      removed.phase === "missing" &&
      removed.message === sourceText("error.voice.cloud.keyRequired"),
    { store: keys.status(), model: removed },
  );
  const saved = await Effect.runPromise(voice.setApiKey(NEW_KEY));
  check("a new key is saved and the model is ready", keys.status() === "saved" && saved.phase === "ready", {
    store: keys.status(),
    model: saved,
  });
  await Effect.runPromise(voice.shutdown());

  // 4. The user's own voice server, with its own key file.
  const serverKeyPath = join(directory, "voice-server-key.json");
  const address = "http://studio.local:8000/v1";
  const routes = { dictation: true, speech: false, transcriptionModel: "whisper-1", speechModel: null, voice: null };
  const serverPreferences = createVoiceServerPreferenceStore(join(directory, "voice-server.json"));
  await Effect.runPromise(serverPreferences.load());
  const sealedServer = new VoiceApiKeyStore({ path: serverKeyPath, cipher: aesCipher() });
  await Effect.runPromise(sealedServer.load());
  await Effect.runPromise(sealedServer.set(KEY));
  await Effect.runPromise(serverPreferences.set({ server: { address, routes } }));
  const serverKeys = new VoiceApiKeyStore({ path: serverKeyPath, cipher: aesCipher() });
  await Effect.runPromise(serverKeys.load());
  /** The fake server: it refuses a request with no key until `open` is set. */
  const fake: { open: boolean; authorized: boolean[] } = { open: false, authorized: [] };
  const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const authorized = new Headers(init?.headers).has("Authorization");
    fake.authorized.push(authorized);
    if (!authorized && !fake.open) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ text: "Server transcript" }), { status: 200 });
  };
  const server = new VoiceServerService({
    preferences: serverPreferences,
    apiKeys: serverKeys,
    fetch: Object.assign(fakeFetch, { preconnect: fetch.preconnect }),
  });
  const settings = server.get();
  check(
    "the server settings say the key cannot be read, and hasApiKey is false as before",
    settings?.hasApiKey === false && settings.apiKeyUnreadable === true,
    settings,
  );
  await Effect.runPromise(server.set({ address, apiKey: null, routes }));
  check("a save with no typed key keeps the unreadable file", existsSync(serverKeyPath), serverKeyPath);
  // A tenth of a second of silence after the 44-byte header. The fake server reads no audio.
  const wav = new Uint8Array(44 + 3_200);
  const refused = await failureMessage(server.transcribe(wav, "pt"));
  check(
    "a refused request says that the saved key cannot be read",
    refused === sourceText("error.voice.server.keyUnreadable"),
    refused,
  );
  fake.open = true;
  const open = await Effect.runPromise(server.transcribe(wav, "pt"));
  check("a server that needs no key still answers", open.text === "Server transcript", open);
  check(
    "no request carried a key while the saved key could not be read",
    fake.authorized.every((sent) => !sent),
    fake.authorized,
  );
  const renewed = await Effect.runPromise(server.set({ address, apiKey: NEW_KEY, routes }));
  check(
    "a new key clears the unreadable state",
    renewed?.hasApiKey === true && renewed.apiKeyUnreadable === undefined && serverKeys.status() === "saved",
    renewed,
  );
  // 5. The secret health registry, with a custom agent whose values were sealed by the old cipher.
  const agentsPath = join(directory, CUSTOM_AGENTS_FILE);
  const resolveCommand = () => Effect.succeed("/usr/bin/true");
  const sealedAgents = new CustomAgentStore({ path: agentsPath, cipher: aesCipher(), resolve: resolveCommand });
  await Effect.runPromise(sealedAgents.load());
  await Effect.runPromise(
    sealedAgents.save({
      id: "smoke-agent",
      name: "Smoke agent",
      command: "/usr/bin/true",
      args: [],
      env: [{ name: "SMOKE_TOKEN", value: KEY }],
      usagePrompt: null,
    }),
  );
  const agents = new CustomAgentStore({ path: agentsPath, cipher: aesCipher(), resolve: resolveCommand });
  await Effect.runPromise(agents.load());
  check("a custom agent whose values cannot be decrypted is counted", agents.unreadableSecretCount() === 1, {
    count: agents.unreadableSecretCount(),
  });
  const unreadableKeys = new VoiceApiKeyStore({ path: keyPath, cipher: aesCipher() });
  await Effect.runPromise(unreadableKeys.load());
  registerSecretHealthSource("voice-api-key", "voice-api-key.json", () => unreadableKeys.status() === "unreadable");
  registerSecretHealthSource("voice-server-key", "voice-server-key.json", () => serverKeys.status() === "unreadable");
  registerSecretHealthSource("custom-agents", CUSTOM_AGENTS_FILE, () => agents.unreadableSecretCount() > 0);
  const listed = unreadableSecrets();
  check(
    "the registry lists the unreadable stores with their file names only",
    listed.length === 2 &&
      listed.some((entry) => entry.store === "voice-api-key" && entry.file === "voice-api-key.json") &&
      listed.some((entry) => entry.store === "custom-agents" && entry.file === CUSTOM_AGENTS_FILE) &&
      !JSON.stringify(listed).includes(KEY),
    listed,
  );
  await Effect.runPromise(unreadableKeys.set(NEW_KEY));
  check(
    "a key that is saved again leaves the list at once",
    unreadableSecrets().every((entry) => entry.store !== "voice-api-key"),
    unreadableSecrets(),
  );
} finally {
  stopTee();
  await rm(directory, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.passed);
await mkdir(OUTPUT, { recursive: true });
await writeFile(
  REPORT,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), passed: failed.length === 0, checks }, null, 2)}\n`,
);
logger.info(`Report: ${REPORT}`);
if (failed.length > 0) {
  logger.error(`${failed.length} check(s) failed.`);
  process.exitCode = 1;
}
