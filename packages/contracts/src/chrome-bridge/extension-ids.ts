/**
 * The fixed IDs of the Builders Bot extension, by build channel, and the public keys that give the
 * development and E2E builds their IDs (the manifest `key` field). A public key is not a secret: the
 * ID of a store item is public too. An ID never authenticates anything (DESIGN §3.5); the pinned keys
 * and the person's choice of the words do.
 *
 * The store ID is unknown until the first upload. Until then a store build of the host refuses to build.
 */

export const CHROME_BRIDGE_CHANNELS = ["store", "dev", "e2e"] as const;
export type ChromeBridgeChannel = (typeof CHROME_BRIDGE_CHANNELS)[number];

export const EXTENSION_IDS: Readonly<Record<ChromeBridgeChannel, string | null>> = {
  store: null,
  dev: "nolcljlaobfddmiecaigbelkackeioip",
  e2e: "hegoaegekbbdbbhdpgohjilgjddgpjbi",
};

/** The manifest `key` of the development and E2E builds (SubjectPublicKeyInfo, DER, base64). */
export const EXTENSION_PUBLIC_KEYS: Readonly<Record<Exclude<ChromeBridgeChannel, "store">, string>> = {
  dev: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkgMOASuKGIELHY1UIFu567lQGvYsaB1lJ/J5i8qghlyonMw6Lsov1MPXkm9vZgKtWNdHqo0sgcWSzbkDejnYgbtZdUHxg2tqdt+vpBNzJNXiodOGwN0nMw70bCDWJ/ptBlxugrBxYOUuswYuHTia8wyLsl6soA++EejyFQAO9ZCUFHythcK7Q1KPVLo2Q0ioo1FM8ltE3V8PkvoLIWQ3q267TaHRmyeBMxDUJvLAUG+xFLlZEar0BqL7B41XUKQN6rkE+BKK3MGivUO75X9s4Sc3/u5C1lUmWJ9o1nnhm3/nFrKZLfc28KihICtiZYqUI26Pj7j+61lSvoxFyInVHQIDAQAB",
  e2e: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsayLv7sNVbsIcMgS3iKvgPwmbGtd3lNVNmuStXARVo3MyiGTJaJx6LCiH3wD2SpndyFcK4R86fhl43szqB+mfQ6/jAQIMW8RdLJicI2vGsrK0fOBjVThZZ0Rqjhg8lbpYw6G+SzfmHguqXQImMTU6e6xh/vp7JeW7m+qqD0SoID9szAPPPG8IDD0KMKZEujdXqs2o34rWoxjxIx9vXiMRKf8HxghyoOh0PK0HfGzXvD8aQWNMzj1Mdfv+xK+BTce3GgxEo0b0QJ1UA+WQ2m/YcM8RQV/NlwTXDPlz1aM+DKISJAh8g1icFAbhWaF5oMsi8evhsdAK0uV7C4fEv/+LwIDAQAB",
};

const EXTENSION_ID = /^[a-p]{32}$/u;

/** The origin that Chrome passes to the native host as its first argument. */
export function extensionOrigin(id: string): string {
  if (!EXTENSION_ID.test(id)) throw new Error("An extension ID is 32 letters from a to p.");
  return `chrome-extension://${id}/`;
}
