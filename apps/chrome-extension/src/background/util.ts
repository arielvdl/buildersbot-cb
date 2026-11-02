/** Small helpers of the service worker: identifiers, base64url, errors, deadlines and retries. */

import type { ChromeBridgeErrorCode } from "@openbot/contracts/chrome-bridge/protocol";

/** An error with a code of the closed list. Its message goes to the app; it never holds page or typed text. */
export class BridgeError extends Error {
  readonly code: ChromeBridgeErrorCode;
  constructor(code: ChromeBridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(text: string): Uint8Array {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A 128-bit opaque value in base64url (22 characters): tab handles and install ids. */
export function opaqueId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** The message of a Chrome API rejection, without anything a page wrote. */
export function chromeErrorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error).slice(0, 300);
}

/** Resolves to the promise's value, or rejects with `timeout` after `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError("timeout", `${what} took more than ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs a tab strip edit again while Chrome refuses it because the person drags a tab
 * ("Tabs cannot be edited right now"), every `everyMs`, at most `times` more times.
 */
export async function retryTabEdit<T>(edit: () => Promise<T>, everyMs: number, times: number): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await edit();
    } catch (error) {
      if (attempt >= times || !chromeErrorText(error).includes("cannot be edited right now")) throw error;
      await delay(everyMs);
    }
  }
}

/** Origin of a URL, or null when it has none (`about:blank`, a bad URL). */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** A count of events in the last minute, for the navigation limits. */
export class MinuteWindow {
  readonly #times = new Map<string, number[]>();

  /** Records one event for `key` when the count stays within `limit`; false when it would not. */
  take(key: string, limit: number, now = Date.now()): boolean {
    const recent = (this.#times.get(key) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= limit) {
      this.#times.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#times.set(key, recent);
    return true;
  }
}
