// The second lock on what a connection result carries to the agent, after the Hub's own mask
// (contract §6.3): credentials by field name and by shape, and the vendor lines of the treg design
// (§2.2). It reads the decoded JSON, never the JSON text: in the text a line break is `\n` and a field
// name can be any spelling, so a pattern on the text misses both.

import type { HubJson } from "@openbot/contracts/hub-connections";
import { findSecretValue, findSecretValues } from "@openbot/logging";
import { isCredentialName } from "./hub-connection-input";
import { maskVendorPhrases } from "./vendor-lines";

const REDACTED = "[redacted]";
/** A bearer value written in a text. */
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
/** A query parameter in a URL or a form text: `?name=value`, `&name=value` or `;name=value`. */
const QUERY_PARAM = /([?&;]([^=&#\s"'<>;]{1,64})=)([^&#\s"'<>;]+)/gu;
/** Below this depth a value is read as one text: no real answer nests deeper. */
const MAX_DEPTH = 64;

/** `text` with each place replaced by `[redacted]`. The places are in order and do not overlap. */
function replacePlaces(text: string, places: ReadonlyArray<{ index: number; length: number }>): string {
  if (places.length === 0) return text;
  const parts: string[] = [];
  let from = 0;
  for (const place of places) {
    parts.push(text.slice(from, place.index), REDACTED);
    from = place.index + place.length;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * One decoded string of a result, masked: each secret by its shape (in one pass), each bearer value,
 * each query parameter with a credential name, and each vendor line.
 */
export function maskResultString(text: string): string {
  return maskVendorPhrases(
    replacePlaces(text, findSecretValues(text))
      .replace(BEARER, `$1${REDACTED}`)
      .replace(QUERY_PARAM, (whole: string, head: string, name: string) =>
        isCredentialName(name) ? `${head}${REDACTED}` : whole,
      ),
  );
}

/** The value of a field whose name labels a credential: every text in it goes. */
function maskCredential(value: unknown, depth: number): HubJson {
  if (typeof value === "string") return REDACTED;
  if (Array.isArray(value)) return value.map((item) => maskCredential(item, depth + 1));
  return maskResultValue(value, depth + 1);
}

/**
 * A decoded result, masked, as JSON: the value of each field whose name labels a credential (the
 * input rule, `isCredentialName`), and each string and field name by `maskResultString`. Numbers and
 * booleans stay: a count named `sessions` is data. A value that JSON does not write (a function,
 * `undefined`) is left out, as `JSON.stringify` leaves it out.
 */
export function maskResultValue(value: unknown, depth = 0): HubJson {
  if (typeof value === "string") return maskResultString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") return null;
  if (depth >= MAX_DEPTH) return maskResultString(JSON.stringify(value) ?? "");
  if (Array.isArray(value)) return value.map((item) => maskResultValue(item, depth + 1));
  const masked: { [key: string]: HubJson } = {};
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined || typeof item === "function") continue;
    masked[maskResultString(name)] = isCredentialName(name)
      ? maskCredential(item, depth)
      : maskResultValue(item, depth + 1);
  }
  return masked;
}

/**
 * The JSON text of a masked result, or null when a secret still shows in it after the mask (one that
 * stands across two values of the text, say): then the result is held back, closed, and never
 * reaches the agent.
 */
export function maskedResultJson(value: unknown): string | null {
  const text = JSON.stringify(maskResultValue(value));
  return findSecretValue(text) === null ? text : null;
}

/** A provider's own words in an error, masked, or null when a secret still shows after the mask. */
export function maskedResultText(text: string): string | null {
  const masked = maskResultString(text);
  return findSecretValue(masked) === null ? masked : null;
}
