/**
 * The fixed IDs of the Builders Bot extension, by build channel, and the public keys that give the
 * unpacked builds their IDs (the manifest `key` field). A public key is not a secret: the ID of a store
 * item is public too. An ID never authenticates anything (DESIGN §3.5); the pinned keys and the person's
 * choice of the words do.
 *
 * - `store`: the Chrome Web Store item, for an app signed with the team's Developer ID. The store ID is
 *   unknown until the first upload. Until then a store build of the host refuses to build.
 * - `local`: an app that its owner signed on their Mac with their own certificate
 *   (`scripts/sign-local-macos.sh`), and the extension that they load unpacked. The app and its host
 *   check each other against that certificate.
 * - `dev`: the app in development (`bun run dev`); nothing is signed or checked.
 * - `e2e`: the tests, in Chrome for Testing.
 */

export const CHROME_BRIDGE_CHANNELS = ["store", "local", "dev", "e2e"] as const;
export type ChromeBridgeChannel = (typeof CHROME_BRIDGE_CHANNELS)[number];

export const EXTENSION_IDS: Readonly<Record<ChromeBridgeChannel, string | null>> = {
  store: null,
  local: "ehopolekjieofichphfdjmjckkkacipn",
  dev: "nolcljlaobfddmiecaigbelkackeioip",
  e2e: "hegoaegekbbdbbhdpgohjilgjddgpjbi",
};

/** The manifest `key` of the unpacked builds (SubjectPublicKeyInfo, DER, base64). */
export const EXTENSION_PUBLIC_KEYS: Readonly<Record<Exclude<ChromeBridgeChannel, "store">, string>> = {
  local:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsGGrYlNdX1x08W9gYisW5Rb2senuquACoNdR2rJcJ8meYPB8OrAYP+CnyGA3BWPcL7NiR1mmfzDZo+CeH7JHK1JkLa3Xy7UO9R8gcH2mBgEi+8Wd/5Q0QJabCeeFUyadz4fcXXl2ShPXkmg5mJ6UpkLh9Hj3b12ockf2JQWwQV+UogH2BiXmaYP1pcCjW+WVmIUIdvYu27iidp8iN5abdNTQoXxS9d8ZJFWNvVxFSb/h4LX8DnV3LQyWWhd8uo0xU4+hTVXnEEuLMUtSUIRthxXuMovESJRI8/NVpThL20I9Hi629QxHmjFsXMZm7wWjVTbZDbLmNU04BWyydCCBJwIDAQAB",
  dev: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkgMOASuKGIELHY1UIFu567lQGvYsaB1lJ/J5i8qghlyonMw6Lsov1MPXkm9vZgKtWNdHqo0sgcWSzbkDejnYgbtZdUHxg2tqdt+vpBNzJNXiodOGwN0nMw70bCDWJ/ptBlxugrBxYOUuswYuHTia8wyLsl6soA++EejyFQAO9ZCUFHythcK7Q1KPVLo2Q0ioo1FM8ltE3V8PkvoLIWQ3q267TaHRmyeBMxDUJvLAUG+xFLlZEar0BqL7B41XUKQN6rkE+BKK3MGivUO75X9s4Sc3/u5C1lUmWJ9o1nnhm3/nFrKZLfc28KihICtiZYqUI26Pj7j+61lSvoxFyInVHQIDAQAB",
  e2e: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsayLv7sNVbsIcMgS3iKvgPwmbGtd3lNVNmuStXARVo3MyiGTJaJx6LCiH3wD2SpndyFcK4R86fhl43szqB+mfQ6/jAQIMW8RdLJicI2vGsrK0fOBjVThZZ0Rqjhg8lbpYw6G+SzfmHguqXQImMTU6e6xh/vp7JeW7m+qqD0SoID9szAPPPG8IDD0KMKZEujdXqs2o34rWoxjxIx9vXiMRKf8HxghyoOh0PK0HfGzXvD8aQWNMzj1Mdfv+xK+BTce3GgxEo0b0QJ1UA+WQ2m/YcM8RQV/NlwTXDPlz1aM+DKISJAh8g1icFAbhWaF5oMsi8evhsdAK0uV7C4fEv/+LwIDAQAB",
};

const EXTENSION_ID = /^[a-p]{32}$/u;

/** The origin that Chrome passes to the native host as its first argument. */
export function extensionOrigin(id: string): string {
  if (!EXTENSION_ID.test(id)) throw new Error("An extension ID is 32 letters from a to p.");
  return `chrome-extension://${id}/`;
}
