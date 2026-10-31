// The egress proxy setting of one server, or the app default for new servers, on disk. The password
// is encrypted by the operating system (`safeStorage`), as in `ProviderCredentialStore`; it is never
// in the file as text and never in a log. See docs/architecture/egress-proxy.md.

import { readFile, rm } from "node:fs/promises";
import {
  EGRESS_DEFAULT_BYPASS,
  EGRESS_DEFAULT_COUNTRY,
  type EgressProxySettings,
  type EgressProxyUpdate,
  parseEgressProxyUpdate,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema, Semaphore } from "effect";
import { writeFileAtomically } from "../backend/atomic-json-file";
import { causeHelpers } from "../backend/effect-boundary";
import type { SecretCipher } from "./provider-credential-store";

export class EgressProxyStoreFailure extends Schema.TaggedError<EgressProxyStoreFailure>()("EgressProxyStoreFailure", {
  cause: Schema.Defect(),
}) {}

const { io: storeIO, sync: storeSync } = causeHelpers(EgressProxyStoreFailure);

export const EGRESS_PROXY_FILE = "openbot-egress-proxy-v1.json";
export const EGRESS_DEFAULT_FILE = "openbot-egress-default-v1.json";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PENDING_SERVERS = 64;

export const EMPTY_EGRESS_SETTINGS: EgressProxySettings = {
  enabled: false,
  host: "",
  port: null,
  username: "",
  bypass: [...EGRESS_DEFAULT_BYPASS],
  expectedCountry: EGRESS_DEFAULT_COUNTRY,
  blockOtherCountry: true,
};

/**
 * Masks the password and the forms of the full line that a person pastes or a tool prints, so no
 * log, export or error shows them.
 */
export function registerEgressSecrets(settings: EgressProxySettings, password: string | null): void {
  if (!password) return;
  registerSecretValue(password, { allowShort: true });
  if (!settings.host || settings.port === null) return;
  registerSecretValue(`${settings.host}:${settings.port}:${settings.username}:${password}`);
  registerSecretValue(`${settings.username}:${password}`);
}

interface Snapshot {
  settings: EgressProxySettings;
  password: string | null;
  pending: string[];
}

/**
 * One envelope: the settings as text and the password encrypted on its own. A file that cannot be
 * read stays as it is until an admin saves: a keychain that refuses once must not cost the setting,
 * and the server must not run without the proxy because of it. `unreadable()` makes the service
 * block the traffic.
 */
export class EgressProxyStore {
  readonly #path: string;
  readonly #cipher: SecretCipher;
  #snapshot: Snapshot = { settings: EMPTY_EGRESS_SETTINGS, password: null, pending: [] };
  #exists = false;
  #unreadable = false;
  #loaded = false;
  readonly #writes = Semaphore.makeUnsafe(1);

  constructor(path: string, cipher: SecretCipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  readonly load = Effect.fn("EgressProxyStore.load")(function* (this: EgressProxyStore) {
    const result = yield* Effect.result(this.#read());
    this.#loaded = true;
    if (Result.isSuccess(result)) {
      this.#snapshot = result.success?.snapshot ?? { settings: EMPTY_EGRESS_SETTINGS, password: null, pending: [] };
      this.#exists = result.success !== null;
      // The settings can be readable while the password cannot be decrypted: the view keeps the host
      // that the admin set, and the service blocks the traffic.
      this.#unreadable = result.success?.secretUnreadable === true;
      registerEgressSecrets(this.#snapshot.settings, this.#snapshot.password);
      return;
    }
    this.#exists = true;
    this.#unreadable = true;
    this.#snapshot = { settings: { ...EMPTY_EGRESS_SETTINGS, enabled: true }, password: null, pending: [] };
  });

  #requireLoaded(): void {
    if (!this.#loaded) throw new Error("The egress proxy store is not loaded.");
  }

  settings(): EgressProxySettings {
    this.#requireLoaded();
    return this.#snapshot.settings;
  }

  password(): string | null {
    this.#requireLoaded();
    return this.#snapshot.password;
  }

  passwordSaved(): boolean {
    return this.password() !== null;
  }

  /** Whether a file was there or a save made one. A new server takes the default only when not. */
  exists(): boolean {
    this.#requireLoaded();
    return this.#exists;
  }

  /** The file is there and cannot be read or decrypted. */
  unreadable(): boolean {
    this.#requireLoaded();
    return this.#unreadable;
  }

  /** The ids of new hosted servers that still wait for the app default. */
  pendingServers(): readonly string[] {
    this.#requireLoaded();
    return this.#snapshot.pending;
  }

  /** Saves a change. A `password` that is absent keeps the saved one; an empty one removes it. */
  save(update: EgressProxyUpdate): Effect.Effect<void, EgressProxyStoreFailure> {
    return this.#edit((current) => {
      const { password, ...settings } = update;
      const next = password === undefined ? current.password : password || null;
      return { settings, password: next, pending: current.pending };
    });
  }

  /** Removes the setting and the file. */
  clear(): Effect.Effect<void, EgressProxyStoreFailure> {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        this.#requireLoaded();
        yield* storeIO(() => rm(this.#path, { force: true }));
        this.#snapshot = { settings: EMPTY_EGRESS_SETTINGS, password: null, pending: [] };
        this.#exists = false;
        this.#unreadable = false;
      }).pipe(Effect.uninterruptible),
    );
  }

  setPending(serverIds: readonly string[]): Effect.Effect<void, EgressProxyStoreFailure> {
    return this.#edit((current) => ({ ...current, pending: [...new Set(serverIds)].slice(-MAX_PENDING_SERVERS) }));
  }

  #edit(change: (current: Snapshot) => Snapshot): Effect.Effect<void, EgressProxyStoreFailure> {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        this.#requireLoaded();
        // An unreadable file starts from empty: nothing in it can be decrypted.
        const current = this.#unreadable
          ? { settings: EMPTY_EGRESS_SETTINGS, password: null, pending: [] }
          : this.#snapshot;
        const next = change(current);
        yield* this.#write(next);
        registerEgressSecrets(next.settings, next.password);
        this.#snapshot = next;
        this.#exists = true;
        this.#unreadable = false;
      }).pipe(Effect.uninterruptible),
    );
  }

  #read = Effect.fn("EgressProxyStore.read")(function* (this: EgressProxyStore) {
    const source = yield* storeIO(() => readFile(this.#path, "utf8")).pipe(
      Effect.catch(({ cause }) =>
        cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(new EgressProxyStoreFailure({ cause })),
      ),
    );
    if (source === null) return null;
    return yield* storeSync((): { snapshot: Snapshot; secretUnreadable: boolean } => {
      if (source.length > MAX_FILE_BYTES) throw new Error("The egress proxy file is too large.");
      const parsed = JSON.parse(source);
      if (!isDynamicRecord(parsed) || parsed.version !== 1)
        throw new Error("The egress proxy file has another version.");
      const { password: _ignored, ...settings } = parseEgressProxyUpdate(parsed.settings);
      const encrypted = parsed.encryptedPassword;
      if (encrypted !== null && !isString(encrypted)) throw new Error("The egress proxy password is not readable.");
      const pending = Array.isArray(parsed.pending) ? parsed.pending.filter(isString).slice(-MAX_PENDING_SERVERS) : [];
      if (encrypted === null) return { snapshot: { settings, password: null, pending }, secretUnreadable: false };
      try {
        const password = this.#cipher.decrypt(Buffer.from(encrypted, "base64"));
        return { snapshot: { settings, password, pending }, secretUnreadable: false };
      } catch {
        return { snapshot: { settings, password: null, pending }, secretUnreadable: true };
      }
    });
  });

  #write = Effect.fn("EgressProxyStore.write")(function* (this: EgressProxyStore, next: Snapshot) {
    const content = yield* storeSync(() => {
      const encryptedPassword = next.password === null ? null : this.#cipher.encrypt(next.password).toString("base64");
      return `${JSON.stringify({ version: 1, settings: next.settings, encryptedPassword, pending: next.pending })}\n`;
    });
    yield* writeFileAtomically(this.#path, content, { createDirectory: true }).pipe(
      Effect.mapError(({ cause }) => new EgressProxyStoreFailure({ cause })),
    );
  });
}
