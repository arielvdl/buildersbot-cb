/**
 * The app's side of the Chrome pairing, sealed (DESIGN §3.3):
 *
 * - `app-key.bin`: the app's static P-256 key (PKCS8) and a 256-bit state key, sealed together by the
 *   operating system key store (`safeStorage`, so the macOS Keychain, in the app).
 * - `bridge-state-v1.bin` (0600): every pairing (install id, the extension's static key, what the
 *   extension reported, revoked or not) and the refused attempts, as AES-256-GCM with the state key.
 *
 * What protects the state is its integrity, not its secrecy: a coding agent of the same user can edit
 * files, but cannot make a tag without the state key, which only the key store opens. A missing,
 * edited or unknown file reads as no pairing at all, and the person pairs again.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChannelKeyPair,
  exportChannelKeyPkcs8,
  generateChannelKey,
  importChannelKeyPkcs8,
  type PeerKeyStatus,
} from "@openbot/contracts/chrome-bridge/channel";
import { BROWSER_BRANDS } from "@openbot/contracts/chrome-bridge/protocol";
import { Schema } from "effect";

/** The operating system key store. In the app this is `safeStorage`; it must fail when it is not available. */
export interface KeySealer {
  seal(plain: Uint8Array): Uint8Array;
  open(sealed: Uint8Array): Uint8Array;
}

const EMPTY: BridgeStateData = { version: 1, browsers: [], refusals: [] };
const STATE_AAD = Buffer.from("bb-bridge-state-v1");
const KEY_FILE = "app-key.bin";
const STATE_FILE = "bridge-state-v1.bin";
const MAX_REFUSALS = 50;

/** Why the state started empty: never paired, or a file that did not open. */
export type StateStart = "new" | "loaded" | "reset";

const PairedBrowserSchema = Schema.Struct({
  installId: Schema.String,
  extensionKey: Schema.String,
  browser: Schema.Struct({ brand: Schema.Literals(BROWSER_BRANDS), version: Schema.String }),
  profileLabel: Schema.NullOr(Schema.String),
  extVersion: Schema.String,
  pairedAt: Schema.Number,
  lastSeen: Schema.Number,
  revoked: Schema.Boolean,
});

/** Every pairing, and the times of refused or cancelled pairings (for Settings and the card's rate). */
const BridgeStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  browsers: Schema.Array(PairedBrowserSchema),
  refusals: Schema.Array(Schema.Number),
});

export type PairedBrowser = typeof PairedBrowserSchema.Type;
export type BridgeStateData = typeof BridgeStateSchema.Type;

async function writePrivate(path: string, bytes: Uint8Array) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export class BridgeStateStore {
  readonly #folder: string;
  readonly #stateKey: Buffer;
  readonly appKey: ChannelKeyPair;
  #data: BridgeStateData;
  readonly start: StateStart;
  /** Writes run one at a time, so two changes never race on the file. */
  #writing: Promise<void> = Promise.resolve();

  private constructor(
    folder: string,
    stateKey: Buffer,
    appKey: ChannelKeyPair,
    data: BridgeStateData,
    start: StateStart,
  ) {
    this.#folder = folder;
    this.#stateKey = stateKey;
    this.appKey = appKey;
    this.#data = data;
    this.start = start;
  }

  /**
   * Opens the state in `folder`, or makes a new app key and an empty state. A key file that the key
   * store does not open is replaced: the pairings that used the old key cannot be trusted any more.
   */
  static async open(folder: string, sealer: KeySealer): Promise<BridgeStateStore> {
    const keyPath = join(folder, KEY_FILE);
    const statePath = join(folder, STATE_FILE);
    const sealedKey = await readOptional(keyPath);
    let material: { pkcs8: Uint8Array; stateKey: Buffer } | null = null;
    if (sealedKey) {
      try {
        const opened = Buffer.from(sealer.open(sealedKey));
        // 32 bytes of state key, then the PKCS8 of the app key.
        if (opened.length > 64) material = { stateKey: opened.subarray(0, 32), pkcs8: opened.subarray(32) };
      } catch {
        material = null;
      }
    }
    if (material) {
      try {
        const appKey = await importChannelKeyPkcs8(material.pkcs8);
        const sealedState = await readOptional(statePath);
        if (!sealedState) return new BridgeStateStore(folder, material.stateKey, appKey, EMPTY, "new");
        const data = BridgeStateStore.#decrypt(material.stateKey, sealedState);
        return new BridgeStateStore(folder, material.stateKey, appKey, data ?? EMPTY, data ? "loaded" : "reset");
      } catch {
        // A key that does not import is the same as a key that does not open.
      }
    }
    const generated = await generateChannelKey(true);
    const pkcs8 = await exportChannelKeyPkcs8(generated);
    const stateKey = randomBytes(32);
    await writePrivate(keyPath, sealer.seal(Buffer.concat([stateKey, Buffer.from(pkcs8)])));
    await rm(statePath, { force: true });
    const appKey = await importChannelKeyPkcs8(pkcs8);
    return new BridgeStateStore(folder, stateKey, appKey, EMPTY, sealedKey ? "reset" : "new");
  }

  static #decrypt(key: Buffer, sealed: Buffer): BridgeStateData | null {
    if (sealed.length < 12 + 16 + 2) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      decipher.setAAD(STATE_AAD);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
      return Schema.decodeUnknownSync(BridgeStateSchema)(JSON.parse(plain.toString("utf8")));
    } catch {
      return null;
    }
  }

  get data(): BridgeStateData {
    return this.#data;
  }

  /** How the app treats an extension key when it reads the `hello`. */
  keyStatus(installId: string, publicKey: string): PeerKeyStatus {
    const browser = this.#data.browsers.find(
      (candidate) => candidate.installId === installId && candidate.extensionKey === publicKey,
    );
    if (!browser) return "unknown";
    return browser.revoked ? "revoked" : "known";
  }

  /** Recent refusals, for the rate limit of the "a Chrome wants to connect" card. */
  refusalsSince(time: number): number {
    return this.#data.refusals.filter((at) => at >= time).length;
  }

  #save(next: BridgeStateData): Promise<void> {
    this.#data = next;
    const run = this.#writing.then(async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#stateKey, iv);
      cipher.setAAD(STATE_AAD);
      const body = Buffer.concat([cipher.update(JSON.stringify(this.#data), "utf8"), cipher.final()]);
      await writePrivate(join(this.#folder, STATE_FILE), Buffer.concat([iv, body, cipher.getAuthTag()]));
    });
    this.#writing = run.catch(() => undefined);
    return run;
  }

  /** Pins an extension key after the person chose the right words on both sides. A new key of the same install replaces the old one. */
  pin(browser: Omit<PairedBrowser, "pairedAt" | "lastSeen" | "revoked">, now = Date.now()): Promise<void> {
    const others = this.#data.browsers.filter((candidate) => candidate.installId !== browser.installId);
    return this.#save({
      ...this.#data,
      browsers: [...others, { ...browser, pairedAt: now, lastSeen: now, revoked: false }],
    });
  }

  touch(installId: string, now = Date.now()): Promise<void> {
    return this.#save({
      ...this.#data,
      browsers: this.#data.browsers.map((browser) =>
        browser.installId === installId ? { ...browser, lastSeen: now } : browser,
      ),
    });
  }

  /** Disconnect in Settings: the next connection of this install gets `reject{revoked}`. */
  revoke(installId: string): Promise<void> {
    return this.#save({
      ...this.#data,
      browsers: this.#data.browsers.map((browser) =>
        browser.installId === installId ? { ...browser, revoked: true } : browser,
      ),
    });
  }

  /** Reconnect in Settings forgets the revoked pin, so the next connection pairs again with the words. */
  forget(installId: string): Promise<void> {
    return this.#save({
      ...this.#data,
      browsers: this.#data.browsers.filter((browser) => browser.installId !== installId),
    });
  }

  recordRefusal(now = Date.now()): Promise<void> {
    return this.#save({ ...this.#data, refusals: [...this.#data.refusals, now].slice(-MAX_REFUSALS) });
  }
}
