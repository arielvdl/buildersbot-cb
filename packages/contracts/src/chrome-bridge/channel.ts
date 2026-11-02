/**
 * The encrypted channel between Builders Bot and its Chrome extension (DESIGN §6.2 and §6.3): the
 * handshake with a commitment, the session keys, the key confirmation, the comparison words, and the
 * sealed frames with their parts. It uses WebCrypto only, so the extension service worker and the app
 * run the same code, and it holds no I/O: each side feeds it the messages it receives.
 *
 * Handshake, one per connection, in clear:
 *
 * 1. ext -> app `commit {digest}`: SHA-256 of the extension's `hello`, made before the extension sees
 *    the app's values, so a party in the middle cannot pick its own values to match the words.
 * 2. app -> ext `welcome` or `reject`.
 * 3. ext -> app `hello`; the app checks it against the commit.
 * 4. Each side derives the keys from three ECDH values (ephemeral and static keys of both sides), with the
 *    SHA-256 of the transcript as the HKDF salt, and sends `confirm`, an HMAC of its role and the
 *    transcript. The app can send `reject` in place of `confirm` once it has read the `hello`.
 *
 * The transcript is the canonical JSON (sorted keys, no spaces) of the three decoded messages. Chrome
 * writes the extension's messages with sorted keys and the app writes its own in insertion order, so
 * neither side can hash the bytes it received: both hash the canonical form of the same values.
 *
 * The comparison words come from SHA-256(transcript ‖ "sas"): 33 bits for the code that Chrome shows
 * and the app asks about, and 33 bits for the code that the app shows and Chrome asks about.
 */

import type { Decoded } from "./decode";
import { PAIRING_WORDS } from "./pairing-words";
import {
  BRIDGE_LIMITS,
  CHROME_BRIDGE_PROTOCOL,
  compareVersions,
  decodeHostFrame,
  decodeSealedFrame,
  HANDSHAKE_DECODERS,
  type HandshakeMessage,
  MIN_EXTENSION_VERSION,
  negotiateProtocol,
  type RejectCode,
  sharedFeatures,
} from "./protocol";

const LABEL = "bb-chrome-v1";
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export type ChannelRole = "ext" | "app";

/** A broken channel. The connection closes; nothing is retried on the same keys. */
export class ChannelError extends Error {
  readonly code: "decode" | "order" | "tag" | "size" | "protocol" | "commitment" | "confirm" | "timeout";
  constructor(code: ChannelError["code"], message: string) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------
// Bytes

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64URL.length; index += 1) BASE64URL_VALUES[BASE64URL.charCodeAt(index)] = index;

/** base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const value = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    chunk +=
      BASE64URL.charAt(value >> 18) +
      BASE64URL.charAt((value >> 12) & 63) +
      BASE64URL.charAt((value >> 6) & 63) +
      BASE64URL.charAt(value & 63);
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const value = (bytes[index] ?? 0) << 16;
    chunk += BASE64URL.charAt(value >> 18) + BASE64URL.charAt((value >> 12) & 63);
  } else if (rest === 2) {
    const value = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    chunk += BASE64URL.charAt(value >> 18) + BASE64URL.charAt((value >> 12) & 63) + BASE64URL.charAt((value >> 6) & 63);
  }
  parts.push(chunk);
  return parts.join("");
}

/** Strict base64url without padding: any other character, or a length of 4n+1, fails. */
export function fromBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new ChannelError("decode", "base64url has an impossible length");
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let bits = 0;
  let buffer = 0;
  let position = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code < 128 ? (BASE64URL_VALUES[code] ?? -1) : -1;
    if (digit < 0) throw new ChannelError("decode", "base64url has a character outside its alphabet");
    buffer = ((buffer << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[position] = (buffer >> bits) & 0xff;
      position += 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new ChannelError("decode", "base64url has stray bits");
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** JSON with the keys of each object sorted and no spaces: the same text for the same values on both sides. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new ChannelError("decode", "a value has no JSON form");
  return text;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", own(bytes)));
}

/** 128 random bits in base64url: install ids, app instance ids, nonces of 32 bytes use `randomBase64Url(32)`. */
export function randomBase64Url(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------------------------------------------------------------------------------------------------
// Keys

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** A static or ephemeral P-256 key pair. The private key may be non-extractable; `deriveBits` still works. */
export interface ChannelKeyPair {
  readonly privateKey: CryptoKey;
  /** The raw uncompressed public key (65 bytes) in base64url. */
  readonly publicKey: string;
}

async function pairOf(keys: CryptoKeyPair): Promise<ChannelKeyPair> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  return { privateKey: keys.privateKey, publicKey: toBase64Url(raw) };
}

/** A new key pair. The extension asks for a non-extractable private key; the app seals its own PKCS8. */
export async function generateChannelKey(extractable = false): Promise<ChannelKeyPair> {
  return pairOf(await crypto.subtle.generateKey(ECDH, extractable, ["deriveBits"]));
}

export async function exportChannelKeyPkcs8(key: ChannelKeyPair): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
}

/** Imports a sealed PKCS8 key as non-extractable, with its public key. */
export async function importChannelKeyPkcs8(pkcs8: Uint8Array): Promise<ChannelKeyPair> {
  const extractable = await crypto.subtle.importKey("pkcs8", own(pkcs8), ECDH, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", extractable);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    ECDH,
    true,
    [],
  );
  const privateKey = await crypto.subtle.importKey("pkcs8", own(pkcs8), ECDH, false, ["deriveBits"]);
  return pairOf({ privateKey, publicKey });
}

async function importPublic(publicKey: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("raw", own(fromBase64Url(publicKey)), ECDH, false, []);
  } catch {
    throw new ChannelError("decode", "a public key is not a P-256 point");
  }
}

async function ecdh(privateKey: CryptoKey, publicKey: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: await importPublic(publicKey) }, privateKey, 256),
  );
}

interface SessionKeys {
  readonly extToApp: CryptoKey;
  readonly appToExt: CryptoKey;
  readonly confirm: CryptoKey;
}

async function sessionKeys(ikm: Uint8Array, transcript: Uint8Array): Promise<SessionKeys> {
  const base = await crypto.subtle.importKey("raw", own(ikm), "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: own(await sha256(transcript)), info: encoder.encode(`${LABEL} keys`) },
      base,
      768,
    ),
  );
  const aes = (bytes: Uint8Array) =>
    crypto.subtle.importKey("raw", own(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return {
    extToApp: await aes(bits.subarray(0, 32)),
    appToExt: await aes(bits.subarray(32, 64)),
    confirm: await crypto.subtle.importKey(
      "raw",
      own(bits.subarray(64, 96)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  };
}

const confirmInput = (role: ChannelRole, transcript: Uint8Array) =>
  concat(encoder.encode(`${LABEL} confirm ${role}`), new Uint8Array([0]), transcript);

// ---------------------------------------------------------------------------------------------------
// Comparison words

/** Three words. A code is 33 bits: 3 words of 11 bits from `PAIRING_WORDS`. */
export type PairingCode = readonly [string, string, string];

function bitsAt(bytes: Uint8Array, start: number, count: number): number {
  let value = 0;
  for (let bit = start; bit < start + count; bit += 1) {
    value = value * 2 + (((bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
  }
  return value;
}

function codeAt(bytes: Uint8Array, start: number): PairingCode {
  const word = (offset: number) => PAIRING_WORDS[bitsAt(bytes, start + offset, 11)] ?? "";
  return [word(0), word(11), word(22)];
}

/** The two codes of one transcript: Chrome shows `chrome` and the app asks for it; the app shows `app`. */
export async function pairingCodes(transcript: Uint8Array): Promise<{ chrome: PairingCode; app: PairingCode }> {
  const digest = await sha256(concat(transcript, encoder.encode("sas")));
  return { chrome: codeAt(digest, 0), app: codeAt(digest, 33) };
}

/**
 * Three options for the person to choose from: the right code at a random place and two decoys. Each
 * decoy differs from the right code and from the other decoy in every word, so the right one is the only
 * option that matches the words on the other screen.
 */
export function pairingOptions(correct: PairingCode): { options: PairingCode[]; correctIndex: number } {
  const used = correct.map((word) => new Set([word]));
  const decoy = (): PairingCode => {
    const pick = (place: number) => {
      for (;;) {
        const index = (crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) & 2047;
        const word = PAIRING_WORDS[index] ?? "";
        const seen = used[place];
        if (seen && !seen.has(word)) {
          seen.add(word);
          return word;
        }
      }
    };
    return [pick(0), pick(1), pick(2)];
  };
  const decoys = [decoy(), decoy()];
  let byte = 255;
  while (byte >= 255) byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 255;
  const correctIndex = byte % 3;
  const options = [...decoys];
  options.splice(correctIndex, 0, correct);
  return { options, correctIndex };
}

export const samePairingCode = (left: PairingCode, right: PairingCode) =>
  left[0] === right[0] && left[1] === right[1] && left[2] === right[2];

// ---------------------------------------------------------------------------------------------------
// Handshake

type Commit = HandshakeMessage<"commit">;
type Welcome = HandshakeMessage<"welcome">;
type Hello = HandshakeMessage<"hello">;
type Confirm = HandshakeMessage<"confirm">;
type Reject = HandshakeMessage<"reject">;

/** The value of a decode, or a broken channel. */
function must<T>(decoded: Decoded<T>): T {
  if (!decoded.ok) throw new ChannelError("protocol", decoded.error);
  return decoded.value;
}

/** What one side knows when its handshake ends. */
export interface Established {
  readonly protocol: number;
  readonly features: readonly string[];
  /** The other side's static public key. */
  readonly peerKey: string;
  readonly codes: { readonly chrome: PairingCode; readonly app: PairingCode };
  readonly channel: SealedChannel;
}

/** The extension's side. `start` makes the `commit`; the hello is fixed before any app value is seen. */
export class ExtensionHandshake {
  readonly #staticKey: ChannelKeyPair;
  readonly #ephemeral: ChannelKeyPair;
  readonly #hello: Hello;
  readonly #commit: Commit;
  #state: "welcome" | "confirm" | "done" = "welcome";
  #transcript: Uint8Array | null = null;
  #keys: SessionKeys | null = null;
  #welcome: Welcome | null = null;
  readonly startedAt: number;

  private constructor(staticKey: ChannelKeyPair, ephemeral: ChannelKeyPair, hello: Hello, commit: Commit, now: number) {
    this.#staticKey = staticKey;
    this.#ephemeral = ephemeral;
    this.#hello = hello;
    this.#commit = commit;
    this.startedAt = now;
  }

  static async start(input: {
    staticKey: ChannelKeyPair;
    extVersion: string;
    installId: string;
    features: readonly string[];
    browser: Hello["browser"];
    consent?: Hello["consent"];
    profileLabel?: string;
    now?: number;
  }): Promise<{ handshake: ExtensionHandshake; commit: Commit }> {
    const ephemeral = await generateChannelKey(false);
    const hello: Hello = {
      k: "hello",
      proto: { min: CHROME_BRIDGE_PROTOCOL.min, max: CHROME_BRIDGE_PROTOCOL.current },
      extVersion: input.extVersion,
      installId: input.installId,
      sPub: input.staticKey.publicKey,
      ePub: ephemeral.publicKey,
      nonce: randomBase64Url(32),
      features: [...input.features],
      browser: input.browser,
      ...(input.consent ? { consent: input.consent } : {}),
      ...(input.consent && input.profileLabel !== undefined ? { profileLabel: input.profileLabel } : {}),
    };
    must(HANDSHAKE_DECODERS.hello(hello, "hello"));
    const commit: Commit = {
      k: "commit",
      digest: toBase64Url(await sha256(encoder.encode(canonicalJson(hello)))),
    };
    const handshake = new ExtensionHandshake(input.staticKey, ephemeral, hello, commit, input.now ?? Date.now());
    return { handshake, commit };
  }

  /**
   * The app's answer to the commit. A `reject` ends the handshake with its code. A `welcome` gives the
   * `hello` and this side's `confirm`, to send in that order.
   */
  async onWelcome(value: unknown): Promise<{ rejected: RejectCode } | { frames: [Hello, Confirm]; welcome: Welcome }> {
    if (this.#state !== "welcome") throw new ChannelError("protocol", "a welcome came out of order");
    if (isKind(value, "reject")) {
      this.#state = "done";
      return { rejected: must(HANDSHAKE_DECODERS.reject(value, "reject")).code };
    }
    const welcome = must(HANDSHAKE_DECODERS.welcome(value, "welcome"));
    if (negotiateProtocol(this.#hello.proto, welcome.proto) === null) {
      this.#state = "done";
      throw new ChannelError("protocol", "the app speaks no protocol of this extension");
    }
    const transcript = encoder.encode(canonicalJson([this.#commit, welcome, this.#hello]));
    const ikm = concat(
      await ecdh(this.#ephemeral.privateKey, welcome.ePub),
      await ecdh(this.#ephemeral.privateKey, welcome.sPub),
      await ecdh(this.#staticKey.privateKey, welcome.ePub),
    );
    this.#keys = await sessionKeys(ikm, transcript);
    this.#transcript = transcript;
    this.#welcome = welcome;
    this.#state = "confirm";
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", this.#keys.confirm, confirmInput("ext", transcript)));
    return { frames: [this.#hello, { k: "confirm", mac: toBase64Url(mac) }], welcome };
  }

  /** The app's `confirm`, or a `reject` that the app sends once it has read the hello. */
  async onConfirm(value: unknown, now = Date.now()): Promise<{ rejected: RejectCode } | Established> {
    if (this.#state !== "confirm" || !this.#keys || !this.#transcript || !this.#welcome)
      throw new ChannelError("protocol", "a confirm came out of order");
    this.#state = "done";
    if (isKind(value, "reject")) return { rejected: must(HANDSHAKE_DECODERS.reject(value, "reject")).code };
    if (now - this.startedAt > BRIDGE_LIMITS.handshakeTimeoutMs)
      throw new ChannelError("timeout", "the handshake took too long");
    const confirm = must(HANDSHAKE_DECODERS.confirm(value, "confirm"));
    const valid = await crypto.subtle.verify(
      "HMAC",
      this.#keys.confirm,
      own(fromBase64Url(confirm.mac)),
      confirmInput("app", this.#transcript),
    );
    if (!valid) throw new ChannelError("confirm", "the app's confirmation does not match");
    const protocol = negotiateProtocol(this.#hello.proto, this.#welcome.proto) ?? CHROME_BRIDGE_PROTOCOL.min;
    return {
      protocol,
      features: sharedFeatures(this.#hello.features, this.#welcome.features),
      peerKey: this.#welcome.sPub,
      codes: await pairingCodes(this.#transcript),
      channel: new SealedChannel("ext", this.#keys.extToApp, this.#keys.appToExt, now),
    };
  }
}

/** How the app classifies the extension's static key when it reads the `hello`. */
export type PeerKeyStatus = "known" | "revoked" | "unknown";

/** The app's side. */
export class AppHandshake {
  readonly #staticKey: ChannelKeyPair;
  readonly #ephemeral: ChannelKeyPair;
  readonly #welcome: Welcome;
  #commit: Commit | null = null;
  #state: "commit" | "hello" | "confirm" | "done" = "commit";
  #transcript: Uint8Array | null = null;
  #keys: SessionKeys | null = null;
  #hello: Hello | null = null;
  #startedAt = 0;

  private constructor(staticKey: ChannelKeyPair, ephemeral: ChannelKeyPair, welcome: Welcome) {
    this.#staticKey = staticKey;
    this.#ephemeral = ephemeral;
    this.#welcome = welcome;
  }

  /**
   * `pairing` says whether the person opened a pairing window in the app ("new") or not ("known"). The
   * app cannot know the extension's key before the `hello`, so this is a hint for the extension's text.
   */
  static async create(input: {
    staticKey: ChannelKeyPair;
    appVersion: string;
    appInstanceId: string;
    features: readonly string[];
    pairing: Welcome["pairing"];
  }): Promise<AppHandshake> {
    const ephemeral = await generateChannelKey(false);
    const welcome: Welcome = {
      k: "welcome",
      proto: { min: CHROME_BRIDGE_PROTOCOL.min, max: CHROME_BRIDGE_PROTOCOL.current },
      appVersion: input.appVersion,
      appInstanceId: input.appInstanceId,
      sPub: input.staticKey.publicKey,
      ePub: ephemeral.publicKey,
      nonce: randomBase64Url(32),
      features: [...input.features],
      pairing: input.pairing,
    };
    must(HANDSHAKE_DECODERS.welcome(welcome, "welcome"));
    return new AppHandshake(input.staticKey, ephemeral, welcome);
  }

  get startedAt() {
    return this.#startedAt;
  }

  onCommit(value: unknown, now = Date.now()): Welcome {
    if (this.#state !== "commit") throw new ChannelError("protocol", "a commit came out of order");
    this.#commit = must(HANDSHAKE_DECODERS.commit(value, "commit"));
    this.#startedAt = now;
    this.#state = "hello";
    return this.#welcome;
  }

  /**
   * The extension's `hello`. It must match the commit. The answer is a `reject` (versions that do not
   * meet, an old extension, or a revoked key) or this side's `confirm`.
   */
  async onHello(
    value: unknown,
    keyStatus: (installId: string, publicKey: string) => PeerKeyStatus,
  ): Promise<{ reject: Reject } | { confirm: Confirm; hello: Hello; keyStatus: PeerKeyStatus }> {
    if (this.#state !== "hello" || !this.#commit) throw new ChannelError("protocol", "a hello came out of order");
    const hello = must(HANDSHAKE_DECODERS.hello(value, "hello"));
    const digest = toBase64Url(await sha256(encoder.encode(canonicalJson(hello))));
    if (digest !== this.#commit.digest) throw new ChannelError("commitment", "the hello does not match its commit");
    const reject = (code: RejectCode) => {
      this.#state = "done";
      const message: Reject = { k: "reject", code };
      return { reject: message };
    };
    if (negotiateProtocol(this.#welcome.proto, hello.proto) === null)
      return reject(hello.proto.max < this.#welcome.proto.min ? "update_extension" : "update_app");
    if (compareVersions(hello.extVersion, MIN_EXTENSION_VERSION) < 0) return reject("update_extension");
    const status = keyStatus(hello.installId, hello.sPub);
    if (status === "revoked") return reject("revoked");
    const transcript = encoder.encode(canonicalJson([this.#commit, this.#welcome, hello]));
    const ikm = concat(
      await ecdh(this.#ephemeral.privateKey, hello.ePub),
      await ecdh(this.#staticKey.privateKey, hello.ePub),
      await ecdh(this.#ephemeral.privateKey, hello.sPub),
    );
    this.#keys = await sessionKeys(ikm, transcript);
    this.#transcript = transcript;
    this.#hello = hello;
    this.#state = "confirm";
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", this.#keys.confirm, confirmInput("app", transcript)));
    return { confirm: { k: "confirm", mac: toBase64Url(mac) }, hello, keyStatus: status };
  }

  async onConfirm(value: unknown, now = Date.now()): Promise<Established> {
    if (this.#state !== "confirm" || !this.#keys || !this.#transcript || !this.#hello)
      throw new ChannelError("protocol", "a confirm came out of order");
    this.#state = "done";
    if (now - this.#startedAt > BRIDGE_LIMITS.handshakeTimeoutMs)
      throw new ChannelError("timeout", "the handshake took too long");
    const confirm = must(HANDSHAKE_DECODERS.confirm(value, "confirm"));
    const valid = await crypto.subtle.verify(
      "HMAC",
      this.#keys.confirm,
      own(fromBase64Url(confirm.mac)),
      confirmInput("ext", this.#transcript),
    );
    if (!valid) throw new ChannelError("confirm", "the extension's confirmation does not match");
    return {
      protocol: negotiateProtocol(this.#welcome.proto, this.#hello.proto) ?? CHROME_BRIDGE_PROTOCOL.min,
      features: sharedFeatures(this.#welcome.features, this.#hello.features),
      peerKey: this.#hello.sPub,
      codes: await pairingCodes(this.#transcript),
      channel: new SealedChannel("app", this.#keys.appToExt, this.#keys.extToApp, now),
    };
  }
}

function isKind(value: unknown, kind: string): boolean {
  return value !== null && typeof value === "object" && "k" in value && value.k === kind;
}

// ---------------------------------------------------------------------------------------------------
// Sealed frames

/** A frame on the wire after the handshake: a whole message, or one part of one. */
export interface SealedFrame {
  readonly v: 1;
  readonly c: number;
  readonly p?: { readonly i: number; readonly n: number };
  readonly d: string;
}

const DIRECTION_BYTE: Readonly<Record<ChannelRole, number>> = { ext: 1, app: 2 };
const MAX_COUNTER = 2 ** 32;
const TAG_BYTES = 16;

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  return bytes;
}

function nonceFor(sender: ChannelRole, counter: number): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array([DIRECTION_BYTE[sender]]), counterBytes(counter), new Uint8Array(3));
}

const aadFor = (counter: number) => concat(encoder.encode(LABEL), counterBytes(counter));

/**
 * One direction pair of sealed frames. Each message is encrypted once with AES-256-GCM; a ciphertext
 * above `BRIDGE_LIMITS.partBytes` is cut into parts that share the counter. The counter of each direction
 * is strict: a skip, a repeat, a part out of order, or a failed tag throws, and the connection closes.
 * At most one message is being reassembled at a time, so a peer cannot make this side hold more than
 * one message of `BRIDGE_LIMITS.maxMessageBytes`.
 */
export class SealedChannel {
  readonly #role: ChannelRole;
  readonly #peer: ChannelRole;
  readonly #sendKey: CryptoKey;
  readonly #receiveKey: CryptoKey;
  readonly #openedAt: number;
  #sendCounter = 0;
  #receiveCounter = 0;
  #parts: {
    counter: number;
    total: number;
    next: number;
    chunks: Uint8Array[];
    bytes: number;
    startedAt: number;
  } | null = null;
  /** Encryptions run one at a time, in call order, so counters and parts never interleave. */
  #sealing: Promise<unknown> = Promise.resolve();

  constructor(role: ChannelRole, sendKey: CryptoKey, receiveKey: CryptoKey, now = Date.now()) {
    this.#role = role;
    this.#peer = role === "ext" ? "app" : "ext";
    this.#sendKey = sendKey;
    this.#receiveKey = receiveKey;
    this.#openedAt = now;
  }

  /** True when the keys must be replaced: the connection then closes and a new handshake follows. */
  needsNewKeys(now = Date.now()): boolean {
    return (
      now - this.#openedAt >= BRIDGE_LIMITS.rekeyAfterMs ||
      Math.max(this.#sendCounter, this.#receiveCounter) >= Math.min(BRIDGE_LIMITS.rekeyAfterFrames, MAX_COUNTER) - 1
    );
  }

  /** When a message is half received: the time its first part came, else null. */
  get reassemblyStartedAt(): number | null {
    return this.#parts?.startedAt ?? null;
  }

  /** The frames of one message, in order. Each frame's JSON text is below 1 MB. */
  seal(message: unknown): Promise<SealedFrame[]> {
    const run = this.#sealing.then(() => this.#sealNow(message));
    this.#sealing = run.catch(() => undefined);
    return run;
  }

  async #sealNow(message: unknown): Promise<SealedFrame[]> {
    const text = JSON.stringify(message);
    if (text === undefined) throw new ChannelError("decode", "a message has no JSON form");
    const plain = encoder.encode(text);
    if (plain.length > BRIDGE_LIMITS.maxMessageBytes)
      throw new ChannelError("size", "a message is larger than the channel carries");
    if (this.#sendCounter >= MAX_COUNTER) throw new ChannelError("order", "the send counter is used up");
    const counter = this.#sendCounter;
    this.#sendCounter += 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonceFor(this.#role, counter), additionalData: aadFor(counter), tagLength: 128 },
        this.#sendKey,
        plain,
      ),
    );
    if (sealed.length <= BRIDGE_LIMITS.partBytes) return [{ v: 1, c: counter, d: toBase64Url(sealed) }];
    const total = Math.ceil(sealed.length / BRIDGE_LIMITS.partBytes);
    const frames: SealedFrame[] = [];
    for (let index = 0; index < total; index += 1) {
      const chunk = sealed.subarray(index * BRIDGE_LIMITS.partBytes, (index + 1) * BRIDGE_LIMITS.partBytes);
      frames.push({ v: 1, c: counter, p: { i: index, n: total }, d: toBase64Url(chunk) });
    }
    return frames;
  }

  /** One received frame: null while a message is still in parts, else the decrypted message. */
  async open(value: unknown, now = Date.now()): Promise<{ message: unknown } | null> {
    const decoded = decodeSealedFrame(value, "frame");
    if (!decoded.ok) throw new ChannelError("protocol", decoded.error);
    const frame = decoded.value;
    if (frame.c !== this.#receiveCounter) throw new ChannelError("order", "a frame came with the wrong counter");
    const bytes = fromBase64Url(frame.d);
    let sealed: Uint8Array;
    if (frame.p === undefined) {
      if (this.#parts) throw new ChannelError("order", "a whole message came in the middle of a split one");
      sealed = bytes;
    } else {
      const { i, n } = frame.p;
      if (n < 2 || i >= n || bytes.length === 0 || bytes.length > BRIDGE_LIMITS.partBytes)
        throw new ChannelError("protocol", "a part has the wrong shape");
      if (i === 0) {
        if (this.#parts) throw new ChannelError("order", "a new message started before the last one ended");
        this.#parts = { counter: frame.c, total: n, next: 0, chunks: [], bytes: 0, startedAt: now };
      }
      const parts = this.#parts;
      if (!parts || parts.counter !== frame.c || parts.total !== n || parts.next !== i)
        throw new ChannelError("order", "a part came out of order");
      if (now - parts.startedAt > BRIDGE_LIMITS.reassemblyTimeoutMs)
        throw new ChannelError("timeout", "a split message took too long");
      parts.bytes += bytes.length;
      if (parts.bytes > BRIDGE_LIMITS.maxMessageBytes + TAG_BYTES)
        throw new ChannelError("size", "a split message is larger than the channel carries");
      if (i < n - 1 && bytes.length !== BRIDGE_LIMITS.partBytes)
        throw new ChannelError("protocol", "a part other than the last is short");
      parts.chunks.push(bytes);
      parts.next += 1;
      if (parts.next < n) return null;
      this.#parts = null;
      sealed = concat(...parts.chunks);
    }
    this.#receiveCounter += 1;
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonceFor(this.#peer, frame.c), additionalData: aadFor(frame.c), tagLength: 128 },
          this.#receiveKey,
          own(sealed),
        ),
      );
    } catch {
      throw new ChannelError("tag", "a frame failed its authentication tag");
    }
    try {
      return { message: JSON.parse(strictDecoder.decode(plain)) };
    } catch {
      throw new ChannelError("decode", "a message is not UTF-8 JSON");
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// The host's own frames, as the extension sees them

/**
 * Where the extension is in its connection to the host, and which of the host's own frames it accepts:
 * `hello` once, first; then `status`, only outside an encrypted session. `status: online` before a
 * session lets a handshake start; `status: offline` ends the session that was open. Anything else
 * breaks the protocol, and the extension closes the port.
 */
export class HostFrameGate {
  #phase: "hello" | "waiting" | "online" | "session" = "hello";
  #hello: { hostVersion: string; pid: number; parent: "google-chrome" | "other" | "unknown" } | null = null;

  get phase() {
    return this.#phase;
  }

  get hostHello() {
    return this.#hello;
  }

  /** Whether a frame is one of the host's own frames (it has `h`), and not one from the app. */
  static isHostFrame(value: unknown): boolean {
    return value !== null && typeof value === "object" && "h" in value;
  }

  /** Applies one host frame. The result says what the extension does next. */
  accept(value: unknown): "start-handshake" | "app-offline" | "wait" {
    const decoded = decodeHostFrame(value);
    if (!decoded.ok) throw new ChannelError("protocol", decoded.error);
    const frame = decoded.value;
    if (frame.h === "hello") {
      if (this.#phase !== "hello") throw new ChannelError("protocol", "the host said hello twice");
      this.#hello = { hostVersion: frame.hostVersion, pid: frame.pid, parent: frame.parent };
      this.#phase = "waiting";
      return "wait";
    }
    if (this.#phase === "hello") throw new ChannelError("protocol", "a host status came before its hello");
    if (frame.app === "online") {
      if (this.#phase !== "waiting") throw new ChannelError("protocol", "a host status came during a session");
      this.#phase = "online";
      return "start-handshake";
    }
    if (this.#phase === "waiting") return "wait";
    this.#phase = "waiting";
    return "app-offline";
  }

  /** The handshake ended well: from now on, only `status: offline` may come from the host. */
  sessionStarted() {
    if (this.#phase !== "online") throw new ChannelError("protocol", "a session started with the app offline");
    this.#phase = "session";
  }
}
