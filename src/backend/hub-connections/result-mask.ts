// The second lock on what a connection result carries to the agent, after the Hub's own mask
// (contract §6.3): credentials by field name and by shape, and the vendor lines of the treg design
// (§2.2). It reads the decoded JSON, never the JSON text: in the text a line break is `\n` and a field
// name can be any spelling, so a pattern on the text misses both.

import type { HubJson } from "@openbot/contracts/hub-connections";
import { findSecretValue, findSecretValues } from "@openbot/logging";
import { isCredentialName, isSignedQueryName } from "./hub-connection-input";
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

/** A query parameter name as a URL reader sees it: `%53ignature` is `Signature`. A bad escape stays as written. */
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name.replaceAll("+", " "));
  } catch {
    return name;
  }
}

/** Whether a query parameter of this name carries a credential: by the field rule, or as a signed URL's. */
function isCredentialParam(name: string): boolean {
  const decoded = decodedName(name);
  return isCredentialName(decoded) || isSignedQueryName(decoded);
}

/**
 * One decoded string of a result, masked: each secret by its shape (in one pass), each bearer value,
 * each query parameter with a credential name or the name of a signed URL's credential (decoded from
 * percent-encoding), and each vendor line.
 */
export function maskResultString(text: string): string {
  return maskVendorPhrases(
    replacePlaces(text, findSecretValues(text))
      .replace(BEARER, `$1${REDACTED}`)
      .replace(QUERY_PARAM, (whole: string, head: string, name: string) =>
        isCredentialParam(name) ? `${head}${REDACTED}` : whole,
      ),
  );
}

/** A count whose name has the plural of a credential word, or ends in `count` or `total`: `sessions: 42`. */
function isCountName(name: string): boolean {
  const plain = name.toLowerCase().replace(/[-_.]/gu, "");
  return /(?:count|total)$/u.test(plain) || (plain.endsWith("s") && isCredentialName(plain.slice(0, -1)));
}

/**
 * The value of a field whose name labels a credential: every string and number in it goes, at every
 * depth, also in a field whose own name is not a credential's. A boolean and null stay: they carry no
 * secret. A number stays only under a count name (`isCountName`). Field names are masked as text.
 */
function maskCredential(value: unknown, depth: number, name: string): HubJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return isCountName(name) && Number.isFinite(value) ? value : REDACTED;
  if (typeof value !== "object" || depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => maskCredential(item, depth + 1, name));
  const masked: { [key: string]: HubJson } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === "function") continue;
    masked[maskResultString(key)] = maskCredential(item, depth + 1, key);
  }
  return masked;
}

/**
 * A decoded result, masked, as JSON: the value of each field whose name labels a credential (the
 * input rule, `isCredentialName`), and each string and field name by `maskResultString`. Outside a
 * credential field numbers and booleans stay. A value that JSON does not write (a function,
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
      ? maskCredential(item, depth, name)
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
