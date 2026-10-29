import { describe, expect, it } from "vitest";
import { createWebPushSender, makeWebPushKeys } from "../src/server/web-push";

// The WebCrypto of the Worker is the one of the browser; the test plays the browser.

type Bytes = Uint8Array<ArrayBuffer>;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const bytes = (value: string): Bytes => new Uint8Array(Buffer.from(value, "base64url"));
const copy = (bytes: Uint8Array): Bytes => new Uint8Array(bytes);

async function browserSubscription() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  if (!("privateKey" in pair)) throw new Error("no key pair");
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, auth, endpoint: "https://push.example.test/subscription", p256dh: b64url(publicKey) };
}

/** The receiving half of RFC 8291, as a browser does it before it shows the notification. */
async function decrypt(pair: CryptoKeyPair, auth: Bytes, body: Bytes): Promise<string> {
  const salt = copy(body.subarray(0, 16));
  const idLength = body[20] ?? 0;
  const serverPublic = copy(body.subarray(21, 21 + idLength));
  const ciphertext = copy(body.subarray(21 + idLength));
  const ownPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const peer = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));

  const hkdf = async (ikm: Bytes, info: Bytes, length: number, withSalt: Bytes) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: withSalt, info }, key, length * 8),
    );
  };
  const encoder = new TextEncoder();
  const ikm = await hkdf(
    shared,
    new Uint8Array([...encoder.encode("WebPush: info\0"), ...ownPublic, ...serverPublic]),
    32,
    auth,
  );
  const contentKey = await hkdf(ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16, salt);
  const nonce = await hkdf(ikm, encoder.encode("Content-Encoding: nonce\0"), 12, salt);
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  // The last byte is the record delimiter, 0x02 for a single record.
  return new TextDecoder().decode(plaintext.subarray(0, plaintext.length - 1));
}

async function sender() {
  const keys = await makeWebPushKeys();
  return createWebPushSender({
    publicKey: keys.publicKey,
    privateKeyJwk: keys.privateKeyJwk,
    subject: "mailto:ops@example.test",
    now: () => 1_700_000_000_000,
    fetch: () => Promise.resolve(new Response(null, { status: 201 })),
  });
}

describe("web push", () => {
  it("sends a payload only the subscription can open, with a VAPID token of this key", async () => {
    const subscription = await browserSubscription();
    const seen: { authorization?: string; body?: Bytes } = {};
    const keys = await makeWebPushKeys();
    const client = createWebPushSender({
      publicKey: keys.publicKey,
      privateKeyJwk: keys.privateKeyJwk,
      subject: "mailto:ops@example.test",
      now: () => 1_700_000_000_000,
      fetch: async (_input, init) => {
        seen.authorization = new Headers(init.headers).get("Authorization") ?? "";
        seen.body = new Uint8Array(await new Response(init.body).arrayBuffer());
        return new Response(null, { status: 201 });
      },
    });

    const result = await client.send(
      { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: b64url(subscription.auth) },
      JSON.stringify({ title: "OpenBot", body: "New activity" }),
    );

    expect(result).toBe("sent");
    expect(await decrypt(subscription.pair, subscription.auth, seen.body ?? new Uint8Array())).toBe(
      JSON.stringify({ title: "OpenBot", body: "New activity" }),
    );

    const [token] = (seen.authorization ?? "").replace("vapid t=", "").split(", k=");
    const [header, claims, signature] = (token ?? "").split(".");
    const publicKey = await crypto.subtle.importKey(
      "raw",
      bytes(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      bytes(signature ?? ""),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toMatchObject({
      aud: "https://push.example.test",
      sub: "mailto:ops@example.test",
    });
    expect(new Headers({ Authorization: seen.authorization ?? "" }).get("Authorization")).toContain(
      `k=${keys.publicKey}`,
    );
  });

  it("reports a subscription the push service dropped, and a failure of the service", async () => {
    const subscription = await browserSubscription();
    const keys = await makeWebPushKeys();
    const target = { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: b64url(subscription.auth) };

    const gone = createWebPushSender({
      publicKey: keys.publicKey,
      privateKeyJwk: keys.privateKeyJwk,
      subject: "mailto:ops@example.test",
      fetch: () => Promise.resolve(new Response(null, { status: 410 })),
    });
    expect(await gone.send(target, "{}")).toBe("gone");

    const down = createWebPushSender({
      publicKey: keys.publicKey,
      privateKeyJwk: keys.privateKeyJwk,
      subject: "mailto:ops@example.test",
      fetch: () => Promise.reject(new Error("offline")),
    });
    expect(await down.send(target, "{}")).toBe("unavailable");
  });

  it("refuses a subscription whose keys are not a P-256 point", async () => {
    const client = await sender();
    const result = await client.send({ endpoint: "https://push.example.test/x", p256dh: "AAAA", auth: "AAAA" }, "{}");
    expect(result).toBe("unavailable");
  });
});
