// The checks that the main process runs on an agent's input before anything goes to the Hub. The
// Hub runs its own checks again (docs/architecture/hub-connections-contract.md); these are the first
// lock, so a refused input never leaves the computer.
//
// Each refusal names a rule and, when it helps the agent correct the input, the field path. It never
// repeats the value: a refused value can be a secret.

import {
  HUB_CONNECTIONS_LIMITS,
  type HubJsonObject,
  type HubObjectSchema,
  type HubParamSchema,
  isHubEndpointId,
  isHubJsonObject,
} from "@openbot/contracts/hub-connections";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { findSecretValue } from "@openbot/logging";
import { cookieOrToken } from "../guard/guard-triage";
import { isPublicAddress } from "../network-address";

export const INPUT_RULES = [
  "too_large",
  "too_deep",
  "not_an_object",
  "unknown_field",
  "missing_field",
  "wrong_type",
  "not_in_enum",
  "too_long",
  "out_of_range",
  "too_many_items",
  "credential_name",
  "credential_value",
  "cookie_value",
  "token_value",
  "url_refused",
  "bad_endpoint",
] as const;
export type InputRule = (typeof INPUT_RULES)[number];

export interface InputRefusal {
  readonly rule: InputRule;
  /** The path of the field, such as `body.filters.url`. Never its value. */
  readonly field: string | null;
}

/** Fields that only the main process may set. The router drops them from an agent's input. */
export const MAIN_PROCESS_FIELDS = ["confirmationId", "maxCostMicros"] as const;

/**
 * Names that hold a credential, a cookie or a session, after case and `-`/`_`/`.` are removed. Whole
 * names: `key` alone is a credential, and `keyword` is not.
 */
const CREDENTIAL_NAMES = new Set([
  "key",
  "apikey",
  "xapikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "auth",
  "authorization",
  "proxyauthorization",
  "bearer",
  "password",
  "passwd",
  "pass",
  "secret",
  "clientsecret",
  "privatekey",
  "cookie",
  "cookies",
  "session",
  "sessionid",
  "sid",
  "liat",
  "csrf",
  "csrftoken",
  "xcsrftoken",
  "header",
  "headers",
  "proxy",
  "sig",
  "signature",
]);
/** Parts of a name, after case and `-`/`_`/`.` are removed, that a data field never has. */
const CREDENTIAL_PARTS = ["cookie", "session", "password", "secret", "authorization", "bearer", "csrf", "apikey"];
/**
 * Words of a name (split at case changes, `-`, `_` and `.`) that make it a credential: `apiToken`,
 * `X-Auth-Token`, `refresh_token`. A word, not a part, so `author` and `tokens` stay data.
 */
const CREDENTIAL_WORDS = new Set(["token", "auth", "secret", "apikey", "privatekey"]);
/** Pagination and count names that hold the word `token` and are data. */
const DATA_NAMES = new Set([
  "pagetoken",
  "nexttoken",
  "nextpagetoken",
  "prevtoken",
  "previoustoken",
  "prevpagetoken",
  "previouspagetoken",
  "continuationtoken",
  "cursor",
  "tokencount",
  "maxtokens",
]);

/** The words of a name: `X-Auth-Token` gives `x`, `auth`, `token`; `apiKey` gives `api`, `key` and `apikey`. */
function nameWords(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[\s._-]+/u)
    .filter(Boolean);
  // Two words that make a credential together: `api key`, `private key`.
  const pairs = words.slice(1).map((word, index) => `${words[index]}${word}`);
  return [...words, ...pairs];
}

/**
 * Whether a field name labels a credential, a cookie or a session. The same rule refuses such a
 * field in a call input and masks its value in a call result (contract §6.2 step 6 and §6.3).
 */
export function isCredentialName(name: string): boolean {
  const plain = name.toLowerCase().replace(/[-_.]/gu, "");
  if (DATA_NAMES.has(plain)) return false;
  return (
    CREDENTIAL_NAMES.has(plain) ||
    CREDENTIAL_PARTS.some((part) => plain.includes(part)) ||
    nameWords(name).some((word) => CREDENTIAL_WORDS.has(word))
  );
}

/** A bearer or basic credential written in a value. */
const SCHEME_CREDENTIAL = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu;

/**
 * The rule that a string value breaks, or null. The cookie and token shapes are the Guard's own
 * (`cookieOrToken`), so this lock and the Guard's lock refuse the same values.
 */
export function valueRule(value: string): InputRule | null {
  const shape = cookieOrToken(value);
  if (shape === "token") return "token_value";
  if (shape === "cookie") return "cookie_value";
  if (SCHEME_CREDENTIAL.test(value) || findSecretValue(value) !== null) return "credential_value";
  return null;
}

/** A URL inside a text, up to the first space, quote or angle bracket. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>]+/giu;

/** Host suffixes that only a private network, a tailnet or this computer resolves. */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".ts.net"];
/** Query names that make a URL a signed one, which carries its own credential. */
const SIGNED_QUERY =
  /^(?:x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential|signature|sig|token|access_token|key|api_key|apikey|auth|code)$/iu;

/**
 * Whether the Hub may receive this URL: `http` or `https` on the default port, a public host with a
 * dot in its name, no user or password, and no signature in the query. The Hub resolves the name and
 * checks the address again; the app refuses what it can see without a lookup.
 */
export function isUrlAllowed(text: string): boolean {
  if (text.length > 2048) return false;
  // A protocol-relative URL (`//host/path`) takes the scheme of whatever reads it.
  if (text.trimStart().startsWith("//")) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "" || url.port !== "") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // The URL parser writes every IPv4 form (decimal, octal, hex) as a dotted address.
  if (/^[\d.]+$/u.test(bare) || bare.includes(":")) return isPublicAddress(bare);
  if (!bare.includes(".") || bare === "localhost") return false;
  if (PRIVATE_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return false;
  for (const name of url.searchParams.keys()) if (SIGNED_QUERY.test(name)) return false;
  return true;
}

function depthOf(value: unknown, limit: number): number {
  if (Array.isArray(value)) {
    let deepest = 0;
    for (const item of value) {
      deepest = Math.max(deepest, depthOf(item, limit));
      if (deepest > limit) break;
    }
    return deepest + 1;
  }
  if (isDynamicRecord(value)) {
    let deepest = 0;
    for (const item of Object.values(value)) {
      deepest = Math.max(deepest, depthOf(item, limit));
      if (deepest > limit) break;
    }
    return deepest + 1;
  }
  return 0;
}

/** Size and nesting of a whole input, before any schema is read. */
export function checkInputShape(input: unknown): InputRefusal | null {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    return { rule: "not_an_object", field: null };
  }
  if (Buffer.byteLength(text) > HUB_CONNECTIONS_LIMITS.callInputBytes) return { rule: "too_large", field: null };
  if (depthOf(input, HUB_CONNECTIONS_LIMITS.callInputDepth) > HUB_CONNECTIONS_LIMITS.callInputDepth)
    return { rule: "too_deep", field: null };
  return null;
}

/** Walks every key and string of a value: credential names and secret, cookie or token values. */
export function checkSecrets(value: unknown, path: string): InputRefusal | null {
  if (isString(value)) {
    const rule = valueRule(value);
    return rule ? { rule, field: path || null } : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const refused = checkSecrets(item, `${path}[${index}]`);
      if (refused) return refused;
    }
    return null;
  }
  if (isDynamicRecord(value)) {
    for (const [name, item] of Object.entries(value)) {
      const field = path ? `${path}.${name}` : name;
      if (isCredentialName(name)) return { rule: "credential_name", field };
      const refused = checkSecrets(item, field);
      if (refused) return refused;
    }
  }
  return null;
}

/** A value against one parameter schema of the mirrored endpoint. */
function checkParam(schema: HubParamSchema, value: unknown, field: string): InputRefusal | null {
  switch (schema.type) {
    case "string": {
      if (!isString(value)) return { rule: "wrong_type", field };
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return { rule: "too_long", field };
      if (schema.enum && !schema.enum.includes(value)) return { rule: "not_in_enum", field };
      if (schema.format === "uri" && !isUrlAllowed(value)) return { rule: "url_refused", field };
      // Any string can carry a URL, so a field without `format: "uri"` is checked when it is one, and
      // each URL inside a text is checked too (`see http://10.0.0.1/admin`).
      if (/^[a-z][a-z0-9+.-]{1,15}:/iu.test(value.trim()) && /:\/\//u.test(value) && !isUrlAllowed(value.trim()))
        return { rule: "url_refused", field };
      if (/^\s*(?:file:|\/\/)/iu.test(value)) return { rule: "url_refused", field };
      for (const url of value.matchAll(URL_IN_TEXT)) if (!isUrlAllowed(url[0])) return { rule: "url_refused", field };
      return null;
    }
    case "number":
    case "integer": {
      if (!isNumber(value) || !Number.isFinite(value)) return { rule: "wrong_type", field };
      if (schema.type === "integer" && !Number.isInteger(value)) return { rule: "wrong_type", field };
      if (schema.minimum !== undefined && value < schema.minimum) return { rule: "out_of_range", field };
      if (schema.maximum !== undefined && value > schema.maximum) return { rule: "out_of_range", field };
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : { rule: "wrong_type", field };
    case "array": {
      if (!Array.isArray(value)) return { rule: "wrong_type", field };
      if (value.length > schema.maxItems) return { rule: "too_many_items", field };
      for (const [index, item] of value.entries()) {
        const refused = checkParam(schema.items, item, `${field}[${index}]`);
        if (refused) return refused;
      }
      return null;
    }
    case "object":
      return checkObject(schema, value, field);
  }
}

/** A value against a closed object schema: no field that the schema does not declare. */
export function checkObject(schema: HubObjectSchema, value: unknown, path: string): InputRefusal | null {
  if (!isDynamicRecord(value)) return { rule: "not_an_object", field: path || null };
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, name))
      return { rule: "unknown_field", field: path ? `${path}.${name}` : name };
  }
  for (const name of schema.required) {
    if (value[name] === undefined) return { rule: "missing_field", field: path ? `${path}.${name}` : name };
  }
  for (const [name, item] of Object.entries(value)) {
    const property = schema.properties[name];
    if (!property || item === undefined) continue;
    const refused = checkParam(property, item, path ? `${path}.${name}` : name);
    if (refused) return refused;
  }
  return null;
}

/** The call input of `tool-catalog`, as the agent gives it, once the main-process fields are gone. */
export interface CallInput {
  readonly endpointId: string;
  readonly query?: { readonly [name: string]: string | number | boolean };
  readonly body?: HubJsonObject;
}

function isScalarObject(value: unknown): value is { readonly [name: string]: string | number | boolean } {
  return (
    isDynamicRecord(value) &&
    Object.values(value).every((item) => isString(item) || (isNumber(item) && Number.isFinite(item)) || isBoolean(item))
  );
}

/**
 * Splits an agent's call input: the fields that only the main process may set are dropped and named,
 * and the rest is checked for shape. The schema check needs the endpoint description, so it runs after.
 */
export function readCallInput(
  input: unknown,
): { readonly input: CallInput; readonly dropped: string[] } | { readonly refusal: InputRefusal } {
  if (!isDynamicRecord(input)) return { refusal: { rule: "not_an_object", field: "input" } };
  const dropped = MAIN_PROCESS_FIELDS.filter((name) => Object.hasOwn(input, name));
  for (const name of Object.keys(input)) {
    if (name !== "endpointId" && name !== "query" && name !== "body" && !dropped.some((field) => field === name))
      return { refusal: { rule: "unknown_field", field: `input.${name}` } };
  }
  const { endpointId, query, body } = input;
  if (!isHubEndpointId(endpointId)) return { refusal: { rule: "bad_endpoint", field: "input.endpointId" } };
  const shape = checkInputShape({ endpointId, query, body });
  if (shape) return { refusal: shape };
  if (query !== undefined && !isScalarObject(query))
    return { refusal: { rule: isDynamicRecord(query) ? "wrong_type" : "not_an_object", field: "input.query" } };
  if (body !== undefined && !isHubJsonObject(body)) return { refusal: { rule: "not_an_object", field: "input.body" } };
  return {
    input: { endpointId, ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }) },
    dropped,
  };
}

/**
 * The checks that need the endpoint description: the closed schema of the query and the body, then
 * credential names and values everywhere. Null when the input may go to the Hub.
 */
export function checkCallInput(
  input: CallInput,
  described: { query: HubObjectSchema | null; body: HubObjectSchema | null },
): InputRefusal | null {
  const secrets = checkSecrets({ query: input.query ?? {}, body: input.body ?? {} }, "input");
  if (secrets) return secrets;
  if (input.query !== undefined) {
    if (!described.query) return { rule: "unknown_field", field: "input.query" };
    const refused = checkObject(described.query, input.query, "input.query");
    if (refused) return refused;
  } else if (described.query && described.query.required.length > 0) {
    return { rule: "missing_field", field: `input.query.${described.query.required[0]}` };
  }
  if (input.body !== undefined) {
    if (!described.body) return { rule: "unknown_field", field: "input.body" };
    const refused = checkObject(described.body, input.body, "input.body");
    if (refused) return refused;
  } else if (described.body && described.body.required.length > 0) {
    return { rule: "missing_field", field: `input.body.${described.body.required[0]}` };
  }
  return null;
}
