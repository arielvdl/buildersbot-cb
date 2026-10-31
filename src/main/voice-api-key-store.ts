import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger, registerSecretValue } from "@openbot/logging";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

const logger = createBuildersBotLogger("voice-api-key-store");

/** The operating system's cipher. Injected, so tests need neither a keychain nor a display. */
export interface VoiceApiKeyCipher {
  canPersist: () => boolean;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

/** Whether a key is saved. This is the only fact about the key that may cross the IPC boundary. */
export type VoiceApiKeyStatus = "saved" | "missing" | "unreadable";

/**
 * Why a saved key could not be decrypted. Only this category is kept and logged, never the cause:
 * the message of a cipher error can hold part of the sealed value.
 */
type VoiceApiKeyLoadError = "storage-unavailable" | "decrypt-failed";

/**
 * An API key for a voice service, encrypted with the system cipher. The plaintext stays in this
 * process: the renderer learns only the status of the key.
 *
 * A key that this computer cannot decrypt, for example after the keychain changed or after a profile
 * was copied from another app, is "unreadable", not "missing". The file stays on the disk until the
 * user saves a new key or removes the key, because a keychain that refuses once must not cost the
 * user the file.
 */
export class VoiceApiKeyStore {
  readonly #path: string;
  readonly #cipher: VoiceApiKeyCipher;
  #key: string | null = null;
  #loadError: VoiceApiKeyLoadError | null = null;
  #writes = Semaphore.makeUnsafe(1);

  constructor(options: { path: string; cipher: VoiceApiKeyCipher }) {
    this.#path = options.path;
    this.#cipher = options.cipher;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      this.#key = null;
      this.#loadError = null;
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): string | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && typeof parsed.key === "string" ? parsed.key : null,
        ),
      );
      if (Result.isFailure(loaded)) {
        if (isMissingFileError(loaded.failure.cause) || loaded.failure.cause instanceof SyntaxError) return;
        return yield* loaded.failure;
      }
      if (!loaded.success) return;
      try {
        this.#key = this.#cipher.decrypt(Buffer.from(loaded.success, "base64")) || null;
      } catch {
        this.#key = null;
        this.#loadError = this.#cipher.canPersist() ? "decrypt-failed" : "storage-unavailable";
        logger.warn("The saved voice key cannot be decrypted.", {
          file: basename(this.#path),
          category: this.#loadError,
        });
      }
      if (this.#key) registerSecretValue(this.#key);
    });
  }

  get(): string | null {
    return this.#key;
  }

  /** "unreadable" while a saved file cannot be decrypted. A save or a removal clears it. */
  status(): VoiceApiKeyStatus {
    if (this.#key !== null) return "saved";
    return this.#loadError === null ? "missing" : "unreadable";
  }

  readonly set = Effect.fn("VoiceApiKey.set")(function* (this: VoiceApiKeyStore, key: string | null) {
    yield* this.#writes.withPermit(
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          if (key === null) {
            yield* Effect.tryPromise({
              try: () => rm(this.#path, { force: true }),
              catch: (cause) => new PreferenceFileFailure({ cause }),
            });
          } else {
            if (!this.#cipher.canPersist())
              return yield* new PreferenceFileFailure({
                cause: new Error(sourceText("error.app.secretStorageUnavailable")),
              });
            registerSecretValue(key);
            const sealed = this.#cipher.encrypt(key).toString("base64");
            yield* writePreferenceFile(this.#path, { version: 1, key: sealed });
          }
          this.#key = key;
          this.#loadError = null;
        }),
      ),
    );
  });
}
