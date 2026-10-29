/**
 * Web Push to the installed web app, in the shape RFC 8291 and RFC 8292 give it: the payload is
 * encrypted for the subscription and the request is signed with the VAPID key of the account service.
 * The push service of the browser therefore carries bytes it cannot read and cannot fake.
 *
 * What is sent here is deliberately short. The host seals the notification text for the phone app with
 * keys that only the phone has; a browser tab has no such seal yet, so the push says that something
 * happened and the app reads the detail over WebRTC as soon as it opens. Nothing of the account
 * reaches the push service.
 */

export interface WebPushSubscription {
  endpoint: string;
  /** The public key of the browser, base64url, as `subscription.toJSON().keys.p256dh`. */
  p256dh: string;
  /** The auth secret of the browser, base64url. */
  auth: string;
}

export interface WebPushSender {
  /** The public key that the page subscribes with, base64url. */
  publicKey: string;
  send(subscription: WebPushSubscription, payload: string): Promise<WebPushResult>;
}

export type WebPushResult = "sent" | "gone" | "rejected" | "unavailable";

/** The push service keeps the message this long for a phone that is off. */
const TTL_SECONDS = 86_400;
/** A record of this size, as every push service accepts. */
const RECORD_SIZE = 4096;
const REQUEST_TIMEOUT_MS = 5_000;
/** A VAPID token is accepted for a day at most; a shorter one leaves room for clock drift. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;

class PushCryptoError extends Error {}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Bytes of an `ArrayBuffer`, which is what the WebCrypto calls of this file take. */
type Bytes = Uint8Array<ArrayBuffer>;

function fromBase64Url(value: string): Bytes {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function text(value: string): Bytes {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(encoded.length);
  copy.set(encoded);
  return copy;
}

/** HKDF as RFC 8291 uses it: extract, then expand with the given info. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * One encrypted record of RFC 8188, which RFC 8291 fills in: the browser key and the auth secret make
 * the key of the record, and only the browser can derive it back.
 */
async function encrypt(subscription: WebPushSubscription, plaintext: Bytes): Promise<{ body: Bytes; salt: Bytes }> {
  const browserKey = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);
  if (browserKey.length !== 65 || authSecret.length < 16) throw new PushCryptoError("The subscription is invalid.");

  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const peer = await crypto.subtle.importKey("raw", browserKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, ephemeral.privateKey, 256),
  );

  // The key material is bound to both public keys, so a record cannot be replayed to another browser.
  const keyInfo = concat(text("WebPush: info\0"), browserKey, ephemeralPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  // 0x02 ends the plaintext and marks the last record.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))),
  );

  const header = new Uint8Array(16 + 4 + 1 + ephemeralPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = ephemeralPublic.length;
  header.set(ephemeralPublic, 21);
  return { body: concat(header, ciphertext), salt };
}

/** The signed token that proves this service may push to the endpoint (RFC 8292). */
async function vapidToken(endpoint: string, privateKey: CryptoKey, subject: string, now: number): Promise<string> {
  const header = base64Url(text(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64Url(
    text(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS,
        sub: subject,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    text(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

export interface WebPushConfig {
  /** The VAPID public key, base64url. */
  publicKey: string;
  /** The VAPID private key as a P-256 JWK. */
  privateKeyJwk: JsonWebKey;
  /** `mailto:` of the operator, as RFC 8292 asks. */
  subject: string;
  now?: () => number;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createWebPushSender(config: WebPushConfig): WebPushSender {
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  let privateKey: Promise<CryptoKey> | null = null;
  const key = () => {
    privateKey ??= crypto.subtle.importKey("jwk", config.privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ]);
    return privateKey;
  };

  return {
    publicKey: config.publicKey,
    async send(subscription, payload) {
      try {
        const [token, encrypted] = await Promise.all([
          key().then((privateKey) =>
            vapidToken(subscription.endpoint, privateKey, config.subject, config.now?.() ?? Date.now()),
          ),
          encrypt(subscription, text(payload)),
        ]);
        const response = await doFetch(subscription.endpoint, {
          method: "POST",
          headers: {
            Authorization: `vapid t=${token}, k=${config.publicKey}`,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(TTL_SECONDS),
            Urgency: "normal",
          },
          body: encrypted.body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return "sent";
        // 404 and 410 mean the browser dropped the subscription; nothing brings it back.
        if (response.status === 404 || response.status === 410) return "gone";
        return "rejected";
      } catch {
        return "unavailable";
      }
    },
  };
}

/** A VAPID key pair, for the setup script and the tests. */
export async function makeWebPushKeys(): Promise<{ publicKey: string; privateKeyJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64Url(publicKey), privateKeyJwk };
}

/** The sender of this isolate, so the private key is imported once rather than per notification. */
let shared: { publicKey: string; sender: WebPushSender } | null = null;

export function sharedWebPushSender(config: Omit<WebPushConfig, "now" | "fetch">): WebPushSender {
  if (shared?.publicKey === config.publicKey) return shared.sender;
  const sender = createWebPushSender(config);
  shared = { publicKey: config.publicKey, sender };
  return sender;
}
