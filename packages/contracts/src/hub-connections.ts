// The wire contract between Builders Bot and the Cultura Builder Hub for Hub connections: paid
// third-party APIs that the Hub offers through its proxy, with the vendor key only in the Hub vault.
// The first connection is `tool-catalog`, with the operations `search`, `describe` and `call`.
//
// docs/architecture/hub-connections-contract.md is the same contract for people: the Hub team builds
// the Hub side from it. A change here is a change there, and a change of meaning needs a new version.
//
// Every decoder below reads an answer of the Hub, which is untrusted input. A decoder returns null
// when a required field is wrong. It keeps only the fields that it knows, so a new field of the Hub
// does not reach the app. Text is plain text with a size limit: a value with markup is refused.
// Amounts are integer micros (millionths of the currency unit) and must be safe integers.

import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";

/** The contract version. The app sends it in `HUB_CONNECTIONS_CONTRACT_HEADER` on every request. */
export const HUB_CONNECTIONS_CONTRACT_VERSION = 1;
export const HUB_CONNECTIONS_CONTRACT_HEADER = "X-Builders-Bot-Contract";
export const HUB_CONNECTIONS_CONTRACT_VALUE = `hub-connections/${HUB_CONNECTIONS_CONTRACT_VERSION}`;

/** The connection of the vendor tool catalog. Stable: the app keeps settings by this id. */
export const TOOL_CATALOG_CONNECTION_ID = "tool-catalog";
export const TOOL_CATALOG_OPERATIONS = ["search", "describe", "call"] as const;
export type ToolCatalogOperation = (typeof TOOL_CATALOG_OPERATIONS)[number];

/** The prefix of every proxy token. Redaction knows it, so a token is masked without registration. */
export const HUB_PROXY_TOKEN_PREFIX = "cbp_";

/** Paths on the Hub origin. `{id}` is a connection id. */
export const HUB_CONNECTIONS_PATHS = {
  session: "/api/builder-ai/gateway/v1/session",
  token: "/api/mcp-oauth/token",
  proxyResource: "/api/builder-ai/proxy",
  connections: "/api/builder-ai/proxy/v1/connections",
  usage: "/api/builder-ai/proxy/v1/usage",
  operation: (connectionId: string, operation: string) =>
    `/api/builder-ai/proxy/v1/connections/${connectionId}/${operation}`,
} as const;

/** The scope that the app asks for in a proxy token request. */
export const HUB_PROXY_SCOPE = "builder-proxy";

export const HUB_CONNECTIONS_LIMITS = {
  /** The `/session` answer. */
  sessionBytes: 8 * 1024,
  /** The connection catalog. */
  catalogBytes: 256 * 1024,
  /** A token answer. */
  tokenBytes: 8 * 1024,
  /** A search or describe answer. */
  operationBytes: 64 * 1024,
  /** A call answer: 200,000 characters of content and the fields around them. */
  callBytes: 1024 * 1024,
  /** A usage answer. */
  usageBytes: 256 * 1024,
  /** Every request of the app waits at most this long. */
  timeoutMs: 25_000,
  /** The JSON body of a call: size and nesting. */
  callInputBytes: 16 * 1024,
  callInputDepth: 8,
  searchQueryChars: 200,
  searchResults: 10,
  titleChars: 80,
  summaryChars: 300,
  descriptionChars: 200,
  nameChars: 60,
  taglineChars: 120,
  paramsBytes: 4 * 1024,
  exampleBytes: 2 * 1024,
  providerMessageChars: 300,
  contentChars: 200_000,
  connections: 100,
  operations: 50,
  orgs: 50,
  accessRows: 51,
  paramsPerObject: 64,
  enumValues: 100,
  /** The proxy token lives at most this long. The app asks for a new one 60 s before the end. */
  tokenSeconds: 300,
  /** The capability of `/session` holds this long before the app reads it again. */
  sessionCacheSeconds: 300,
} as const;

// --- Shapes of values -------------------------------------------------------------------------

const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{1,39}$/u;
const OPERATION_ID = /^[a-z][a-z0-9_]{0,39}$/u;
/** A vendor endpoint id. No `/` and no `:`, so a team tool path or a full URL is not an id. */
const ENDPOINT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VENDOR_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,79}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const CONFIRMATION_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const PERIOD_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
/** Markup: a tag, a comment or a declaration. Hub text is plain text, and the app never renders HTML. */
const MARKUP = /<\s*[A-Za-z!/?]/u;

/** A control character other than tab, line feed and carriage return. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

export function isHubConnectionId(value: unknown): value is string {
  return isString(value) && CONNECTION_ID.test(value);
}

export function isHubEndpointId(value: unknown): value is string {
  return isString(value) && ENDPOINT_ID.test(value);
}

export function isHubOrgId(value: unknown): value is string {
  return isString(value) && ORG_ID.test(value);
}

export function isHubParamName(value: unknown): value is string {
  return isString(value) && PARAM_NAME.test(value);
}

export function isHubConfirmationId(value: unknown): value is string {
  return isString(value) && CONFIRMATION_ID.test(value);
}

function matches(pattern: RegExp, value: unknown): value is string {
  return isString(value) && pattern.test(value);
}

/** Plain text of at most `max` characters: no markup and no control characters other than line breaks. */
export function isHubPlainText(value: unknown, max: number, min = 1): value is string {
  return (
    isString(value) && value.length >= min && value.length <= max && !MARKUP.test(value) && !hasControlCharacter(value)
  );
}

function micros(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function intIn(value: unknown, min: number, max: number): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

function timestamp(value: unknown): value is string {
  return isString(value) && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return isString(value) && values.some((candidate) => candidate === value);
}

function isStringList(value: unknown, maxItems: number, maxChars: number): value is string[] {
  return (
    Array.isArray(value) && value.length <= maxItems && value.every((item) => isString(item) && item.length <= maxChars)
  );
}

/** A JSON value, as a Hub body holds it once parsed. */
export type HubJson = string | number | boolean | null | readonly HubJson[] | HubJsonObject;
export type HubJsonObject = { readonly [key: string]: HubJson };

const JSON_DEPTH_LIMIT = 64;

/** Whether a value is plain JSON, nested at most 64 levels: no function, no class, no cycle. */
export function isHubJson(value: unknown, depth = 0): value is HubJson {
  if (depth > JSON_DEPTH_LIMIT) return false;
  if (value === null || isString(value) || isBoolean(value)) return true;
  if (isNumber(value)) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isHubJson(item, depth + 1));
  if (!isDynamicRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isHubJson(item, depth + 1));
}

export function isHubJsonObject(value: unknown): value is HubJsonObject {
  return isDynamicRecord(value) && !Array.isArray(value) && isHubJson(value);
}

/** The value when it is valid, else undefined, so an optional field with a wrong value is dropped. */
function optional<T>(value: unknown, valid: (value: unknown) => value is T): T | undefined {
  return valid(value) ? value : undefined;
}

// --- Error codes ------------------------------------------------------------------------------

/** Codes of `{ error }` answers. The app maps each one to a fixed text; it never shows Hub text. */
export const HUB_CONNECTION_ERROR_CODES = [
  "upstream_unavailable",
  "connection_unavailable",
  "cost_above_limit",
  "rate_limited",
  "not_allowed",
  "endpoint_not_allowed",
  "input_refused",
  "internal_error",
  "provider_unavailable",
  "provider_rejected_request",
  "provider_failed",
  "no_result",
  "result_too_large",
  "idempotency_in_progress",
  "idempotency_conflict",
  "result_expired",
  "unauthorized",
] as const;
export type HubConnectionErrorCode = (typeof HUB_CONNECTION_ERROR_CODES)[number];

/** What only the person can resolve. The agent stops calling the connection in the turn. */
export const HUB_CONNECTION_NEEDS_PERSON = [
  "cap_reached",
  "org_budget_reached",
  "confirm_cost",
  "choose_org",
  "not_allowed",
] as const;
export type HubConnectionNeedsPerson = (typeof HUB_CONNECTION_NEEDS_PERSON)[number];

// --- GET /session (extension) ------------------------------------------------------------------

export interface HubConnectionCapability {
  enabled: boolean;
  /** A code such as `paused`, or null. */
  reason: string | null;
}

/** What the app reads from `/session` for connections. Absent capabilities mean "off". */
export interface HubSessionConnections {
  active: boolean;
  connections: Readonly<Record<string, HubConnectionCapability>>;
  connectionsUsage: boolean;
}

/**
 * The connection part of the `/session` answer. A session without `capabilities` has every
 * connection off. Null for an answer that is not an object.
 */
export function decodeHubSessionConnections(value: unknown): HubSessionConnections | null {
  if (!isDynamicRecord(value)) return null;
  const capabilities = isDynamicRecord(value.capabilities) ? value.capabilities : {};
  const connections: Record<string, HubConnectionCapability> = {};
  if (isDynamicRecord(capabilities.connections)) {
    for (const [id, entry] of Object.entries(capabilities.connections).slice(0, HUB_CONNECTIONS_LIMITS.connections)) {
      if (!isHubConnectionId(id) || !isDynamicRecord(entry)) continue;
      connections[id] = {
        enabled: entry.enabled === true,
        reason: matches(REASON_CODE, entry.reason) ? entry.reason : null,
      };
    }
  }
  return { active: value.active === true, connections, connectionsUsage: capabilities.connectionsUsage === true };
}

// --- POST /api/mcp-oauth/token (proxy token) ----------------------------------------------------

export interface HubProxyToken {
  token: string;
  expiresInSeconds: number;
  /** The organization the token pays with; null for a token that only reads the catalog. */
  orgId: string | null;
  /** A new refresh token, when the Hub rotated it against the contract. The app saves it. */
  rotatedRefresh: string | null;
}

/** The token error codes that the app tells apart. */
export const HUB_PROXY_TOKEN_ERRORS = [
  "invalid_grant",
  "not_member",
  "consent_required",
  "connections_disabled",
] as const;
export type HubProxyTokenError = (typeof HUB_PROXY_TOKEN_ERRORS)[number];

const TOKEN_TEXT = /^[A-Za-z0-9._~+/=-]{8,4096}$/u;

export function decodeHubProxyToken(value: unknown): HubProxyToken | null {
  if (!isDynamicRecord(value)) return null;
  const token = value.access_token;
  if (!isString(token) || !token.startsWith(HUB_PROXY_TOKEN_PREFIX) || !TOKEN_TEXT.test(token)) return null;
  if (value.token_type !== undefined && !(isString(value.token_type) && value.token_type.toLowerCase() === "bearer"))
    return null;
  if (!intIn(value.expires_in, 1, 3600)) return null;
  const orgId = value.org === undefined || value.org === null ? null : isHubOrgId(value.org) ? value.org : undefined;
  if (orgId === undefined) return null;
  const refresh = value.refresh_token;
  return {
    token,
    expiresInSeconds: Math.min(value.expires_in, HUB_CONNECTIONS_LIMITS.tokenSeconds),
    orgId,
    rotatedRefresh: isString(refresh) && TOKEN_TEXT.test(refresh) ? refresh : null,
  };
}

export function decodeHubProxyTokenError(value: unknown): HubProxyTokenError | null {
  return isDynamicRecord(value) && oneOf(HUB_PROXY_TOKEN_ERRORS, value.error) ? value.error : null;
}

// --- GET /connections (catalog) -----------------------------------------------------------------

export const HUB_ORG_STATES = ["enabled", "not_enabled", "not_in_plan", "paused", "revoked"] as const;
export const HUB_USER_STATES = ["allowed", "not_allowed", "requested"] as const;
export const HUB_CAP_STATES = ["ok", "warning", "reached"] as const;
export const HUB_BINDING_SCOPES = ["user", "org_connection", "org_total"] as const;
export const HUB_OPERATION_EFFECTS = ["read", "external"] as const;
export const HUB_PRICING_UNITS = ["call", "page", "result", "1k_tokens"] as const;
export const HUB_PRICING_BASES = ["fixed", "metered"] as const;

export type HubCapState = (typeof HUB_CAP_STATES)[number];
export type HubBindingScope = (typeof HUB_BINDING_SCOPES)[number];

export interface HubOrgView {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  default: boolean;
}

export interface HubConnectionOperation {
  id: string;
  title: string;
  effect: (typeof HUB_OPERATION_EFFECTS)[number];
  pricing: { unit: (typeof HUB_PRICING_UNITS)[number]; basis: (typeof HUB_PRICING_BASES)[number] };
}

export interface HubConnectionAccess {
  /** An organization id, or `personal` for the personal plan. */
  orgId: string;
  org: (typeof HUB_ORG_STATES)[number];
  user: (typeof HUB_USER_STATES)[number];
  consented: boolean;
  currency: string;
  cap: { kind: "limited"; amountMicros: number } | { kind: "unlimited"; dailyMicros: number | null };
  settledMicros: number;
  reservedMicros: number;
  availableMicros: number;
  effectiveAvailableMicros: number;
  bindingScope: HubBindingScope;
  state: HubCapState;
  maxCostPerCallMicros: number;
  confirmAboveMicros: number | null;
  resetsAt: string;
  asOf: string;
  counterVersion: number;
}

export interface HubConnectionEntry {
  id: string;
  name: string;
  tagline: string;
  operations: HubConnectionOperation[];
  itemsCount: number;
  dataPolicy: { vendor: string; region: string; retentionDays: number | null };
  access: HubConnectionAccess[];
}

export interface HubConnectionCatalog {
  catalogVersion: string;
  ttlSeconds: number;
  orgs: HubOrgView[];
  personal: boolean;
  connections: HubConnectionEntry[];
}

function decodeOrg(value: unknown): HubOrgView | null {
  if (!isDynamicRecord(value) || !isHubOrgId(value.id) || !isHubPlainText(value.name, HUB_CONNECTIONS_LIMITS.nameChars))
    return null;
  return {
    id: value.id,
    name: value.name,
    role: oneOf(["owner", "admin", "member"] as const, value.role) ? value.role : "member",
    default: value.default === true,
  };
}

/** An operation with an unknown effect, unit or basis is hidden: it never breaks the catalog. */
function decodeOperation(value: unknown): HubConnectionOperation | null {
  if (!isDynamicRecord(value) || !matches(OPERATION_ID, value.id)) return null;
  if (!oneOf(HUB_OPERATION_EFFECTS, value.effect) || !isDynamicRecord(value.pricing)) return null;
  const { unit, basis } = value.pricing;
  if (!oneOf(HUB_PRICING_UNITS, unit) || !oneOf(HUB_PRICING_BASES, basis)) return null;
  return {
    id: value.id,
    title: isHubPlainText(value.title, HUB_CONNECTIONS_LIMITS.titleChars) ? value.title : value.id,
    effect: value.effect,
    pricing: { unit, basis },
  };
}

function decodeCap(value: unknown): HubConnectionAccess["cap"] | null {
  if (!isDynamicRecord(value)) return null;
  if (value.kind === "limited" && micros(value.amountMicros))
    return { kind: "limited", amountMicros: value.amountMicros };
  if (value.kind === "unlimited")
    return { kind: "unlimited", dailyMicros: micros(value.dailyMicros) ? value.dailyMicros : null };
  return null;
}

function decodeAccess(value: unknown): HubConnectionAccess | null {
  if (!isDynamicRecord(value) || !isHubOrgId(value.orgId)) return null;
  if (!oneOf(HUB_ORG_STATES, value.org) || !oneOf(HUB_USER_STATES, value.user)) return null;
  if (!matches(CURRENCY, value.currency) || !oneOf(HUB_CAP_STATES, value.state)) return null;
  if (!oneOf(HUB_BINDING_SCOPES, value.bindingScope)) return null;
  const cap = decodeCap(value.cap);
  if (!cap) return null;
  if (
    !micros(value.settledMicros) ||
    !micros(value.reservedMicros) ||
    !micros(value.availableMicros) ||
    !micros(value.effectiveAvailableMicros) ||
    !micros(value.maxCostPerCallMicros)
  )
    return null;
  if (value.confirmAboveMicros !== null && value.confirmAboveMicros !== undefined && !micros(value.confirmAboveMicros))
    return null;
  if (!timestamp(value.resetsAt) || !timestamp(value.asOf) || !micros(value.counterVersion)) return null;
  return {
    orgId: value.orgId,
    org: value.org,
    user: value.user,
    consented: value.consented === true,
    currency: value.currency,
    cap,
    settledMicros: value.settledMicros,
    reservedMicros: value.reservedMicros,
    availableMicros: value.availableMicros,
    effectiveAvailableMicros: value.effectiveAvailableMicros,
    bindingScope: value.bindingScope,
    state: value.state,
    maxCostPerCallMicros: value.maxCostPerCallMicros,
    confirmAboveMicros: micros(value.confirmAboveMicros) ? value.confirmAboveMicros : null,
    resetsAt: value.resetsAt,
    asOf: value.asOf,
    counterVersion: value.counterVersion,
  };
}

function decodeConnection(value: unknown): HubConnectionEntry | null {
  if (!isDynamicRecord(value) || !isHubConnectionId(value.id)) return null;
  if (!isHubPlainText(value.name, HUB_CONNECTIONS_LIMITS.nameChars)) return null;
  if (!Array.isArray(value.operations) || !Array.isArray(value.access)) return null;
  const operations = value.operations
    .slice(0, HUB_CONNECTIONS_LIMITS.operations)
    .map(decodeOperation)
    .filter((operation): operation is HubConnectionOperation => operation !== null);
  const access = value.access
    .slice(0, HUB_CONNECTIONS_LIMITS.accessRows)
    .map(decodeAccess)
    .filter((row): row is HubConnectionAccess => row !== null);
  const policy = isDynamicRecord(value.dataPolicy) ? value.dataPolicy : {};
  const items = isDynamicRecord(value.items) ? value.items : {};
  return {
    id: value.id,
    name: value.name,
    tagline: isHubPlainText(value.tagline, HUB_CONNECTIONS_LIMITS.taglineChars) ? value.tagline : "",
    operations,
    itemsCount: intIn(items.count, 0, 1_000_000) ? items.count : 0,
    dataPolicy: {
      vendor: isHubPlainText(policy.vendor, HUB_CONNECTIONS_LIMITS.taglineChars) ? policy.vendor : "",
      region: isHubPlainText(policy.region, 40) ? policy.region : "",
      retentionDays: intIn(policy.retentionDays, 0, 3650) ? policy.retentionDays : null,
    },
    access,
  };
}

/** The connection catalog, or null when the envelope is wrong. A wrong entry is dropped alone. */
export function decodeHubConnectionCatalog(value: unknown): HubConnectionCatalog | null {
  if (!isDynamicRecord(value) || !Array.isArray(value.connections)) return null;
  if (!isHubPlainText(value.catalogVersion, 64) || !intIn(value.ttlSeconds, 0, 86_400)) return null;
  const viewer = isDynamicRecord(value.viewer) ? value.viewer : {};
  const orgs = Array.isArray(viewer.orgs)
    ? viewer.orgs
        .slice(0, HUB_CONNECTIONS_LIMITS.orgs)
        .map(decodeOrg)
        .filter((org): org is HubOrgView => org !== null)
    : [];
  return {
    catalogVersion: value.catalogVersion,
    ttlSeconds: value.ttlSeconds,
    orgs,
    personal: viewer.personal === true,
    connections: value.connections
      .slice(0, HUB_CONNECTIONS_LIMITS.connections)
      .map(decodeConnection)
      .filter((entry): entry is HubConnectionEntry => entry !== null),
  };
}

// --- tool-catalog: search -----------------------------------------------------------------------

export const TOOL_CATALOG_PRICE_KINDS = ["per_call", "per_row", "per_target"] as const;
export type ToolCatalogPriceKind = (typeof TOOL_CATALOG_PRICE_KINDS)[number];

export interface ToolCatalogSearchRequest {
  query: string;
  platform?: string;
  limit?: number;
}

export interface ToolCatalogSearchResult {
  endpointId: string;
  title: string;
  platform: string;
  provider: string;
  priceKind: ToolCatalogPriceKind;
  unitPriceMicros: number;
  currency: string;
  maxUnits: number;
  maxCostMicros: number;
  reliability: number | null;
  effect: "read";
}

export interface ToolCatalogSearchAnswer {
  results: ToolCatalogSearchResult[];
  verdict: "match" | "none";
}

/** Builds a search body, or null when a field is outside the contract. */
export function toolCatalogSearchRequest(input: {
  query: unknown;
  platform?: unknown;
  limit?: unknown;
}): ToolCatalogSearchRequest | null {
  if (!isHubPlainText(input.query, HUB_CONNECTIONS_LIMITS.searchQueryChars) || input.query.trim() === "") return null;
  if (input.platform !== undefined && !matches(VENDOR_SLUG, input.platform)) return null;
  if (input.limit !== undefined && !intIn(input.limit, 1, HUB_CONNECTIONS_LIMITS.searchResults)) return null;
  return {
    query: input.query.trim(),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function decodeSearchResult(value: unknown): ToolCatalogSearchResult | null {
  if (!isDynamicRecord(value) || !isHubEndpointId(value.endpointId)) return null;
  if (!isHubPlainText(value.title, HUB_CONNECTIONS_LIMITS.titleChars)) return null;
  if (!matches(VENDOR_SLUG, value.platform) || !matches(VENDOR_SLUG, value.provider)) return null;
  if (!oneOf(TOOL_CATALOG_PRICE_KINDS, value.priceKind) || !matches(CURRENCY, value.currency)) return null;
  if (!micros(value.unitPriceMicros) || !micros(value.maxCostMicros) || !intIn(value.maxUnits, 1, 10_000)) return null;
  // Only read endpoints reach an agent in this version of the contract.
  if (value.effect !== "read") return null;
  const reliability =
    isNumber(value.reliability) && value.reliability >= 0 && value.reliability <= 1 ? value.reliability : null;
  return {
    endpointId: value.endpointId,
    title: value.title,
    platform: value.platform,
    provider: value.provider,
    priceKind: value.priceKind,
    unitPriceMicros: value.unitPriceMicros,
    currency: value.currency,
    maxUnits: value.maxUnits,
    maxCostMicros: value.maxCostMicros,
    reliability,
    effect: "read",
  };
}

export function decodeToolCatalogSearchAnswer(value: unknown): ToolCatalogSearchAnswer | null {
  if (!isDynamicRecord(value) || !Array.isArray(value.results)) return null;
  const results = value.results
    .slice(0, HUB_CONNECTIONS_LIMITS.searchResults)
    .map(decodeSearchResult)
    .filter((result): result is ToolCatalogSearchResult => result !== null);
  return { results, verdict: results.length > 0 && value.verdict !== "none" ? "match" : "none" };
}

// --- tool-catalog: describe ---------------------------------------------------------------------

/** The JSON Schema subset that a mirrored endpoint can declare. Every object is closed. */
export type HubParamSchema =
  | { type: "string"; description?: string; maxLength?: number; enum?: string[]; format?: "uri" }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: HubParamSchema; maxItems: number }
  | HubObjectSchema;

export interface HubObjectSchema {
  type: "object";
  description?: string;
  properties: Record<string, HubParamSchema>;
  required: string[];
  additionalProperties: false;
}

export interface ToolCatalogDescribeAnswer {
  endpointId: string;
  title: string;
  summary: string;
  method: "GET" | "POST";
  /** The query parameters (scalars only), or null. */
  query: HubObjectSchema | null;
  /** The JSON body, or null. */
  body: HubObjectSchema | null;
  priceKind: ToolCatalogPriceKind;
  unitPriceMicros: number;
  currency: string;
  maxUnits: number;
  maxCostMicros: number;
  effect: "read";
  example: HubJson;
}

function decodeDescription(value: unknown): { description?: string } {
  // A description that fails the text rules is dropped; the parameter stays.
  return isHubPlainText(value, HUB_CONNECTIONS_LIMITS.descriptionChars) ? { description: value } : {};
}

/**
 * One parameter schema. Null for a schema outside the subset or an object that is not closed:
 * the app checks every input against this schema, so an open object would let any field through.
 */
export function decodeHubParamSchema(value: unknown, depth = 0): HubParamSchema | null {
  if (!isDynamicRecord(value) || depth > HUB_CONNECTIONS_LIMITS.callInputDepth) return null;
  const description = decodeDescription(value.description);
  switch (value.type) {
    case "string": {
      const maxLength = optional(value.maxLength, (n): n is number => intIn(n, 1, 100_000));
      let values: string[] | undefined;
      if (value.enum !== undefined) {
        if (!isStringList(value.enum, HUB_CONNECTIONS_LIMITS.enumValues, 200)) return null;
        values = value.enum;
      }
      if (value.format !== undefined && value.format !== "uri") return null;
      return {
        type: "string",
        ...description,
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(values ? { enum: values } : {}),
        ...(value.format === "uri" ? { format: "uri" as const } : {}),
      };
    }
    case "number":
    case "integer": {
      const minimum = isNumber(value.minimum) && Number.isFinite(value.minimum) ? value.minimum : undefined;
      const maximum = isNumber(value.maximum) && Number.isFinite(value.maximum) ? value.maximum : undefined;
      return {
        type: value.type,
        ...description,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
    }
    case "boolean":
      return { type: "boolean", ...description };
    case "array": {
      const items = decodeHubParamSchema(value.items, depth + 1);
      if (!items || !intIn(value.maxItems, 1, 1000)) return null;
      return { type: "array", ...description, items, maxItems: value.maxItems };
    }
    case "object":
      return decodeObjectSchema(value, depth);
    default:
      return null;
  }
}

function decodeObjectSchema(value: unknown, depth: number): HubObjectSchema | null {
  if (!isDynamicRecord(value) || value.type !== "object" || value.additionalProperties !== false) return null;
  if (!isDynamicRecord(value.properties)) return null;
  const entries = Object.entries(value.properties);
  if (entries.length > HUB_CONNECTIONS_LIMITS.paramsPerObject) return null;
  const properties: Record<string, HubParamSchema> = {};
  for (const [name, schema] of entries) {
    if (!isHubParamName(name)) return null;
    const decoded = decodeHubParamSchema(schema, depth + 1);
    if (!decoded) return null;
    properties[name] = decoded;
  }
  const required = value.required === undefined ? [] : value.required;
  if (!isStringList(required, HUB_CONNECTIONS_LIMITS.paramsPerObject, 64)) return null;
  if (!required.every((name) => Object.hasOwn(properties, name))) return null;
  return {
    type: "object",
    ...decodeDescription(value.description),
    properties,
    required,
    additionalProperties: false,
  };
}

function scalarOnly(schema: HubObjectSchema): boolean {
  return Object.values(schema.properties).every((property) => property.type !== "object" && property.type !== "array");
}

export function decodeToolCatalogDescribeAnswer(value: unknown): ToolCatalogDescribeAnswer | null {
  if (!isDynamicRecord(value) || !isHubEndpointId(value.endpointId)) return null;
  if (!isHubPlainText(value.title, HUB_CONNECTIONS_LIMITS.titleChars)) return null;
  if (value.method !== "GET" && value.method !== "POST") return null;
  if (value.effect !== "read") return null;
  if (!oneOf(TOOL_CATALOG_PRICE_KINDS, value.priceKind) || !matches(CURRENCY, value.currency)) return null;
  if (!micros(value.unitPriceMicros) || !micros(value.maxCostMicros) || !intIn(value.maxUnits, 1, 10_000)) return null;
  const params = isDynamicRecord(value.params) ? value.params : {};
  const query = params.query === undefined || params.query === null ? null : decodeObjectSchema(params.query, 0);
  const body = params.body === undefined || params.body === null ? null : decodeObjectSchema(params.body, 0);
  if ((params.query && !query) || (params.body && !body)) return null;
  if (query && !scalarOnly(query)) return null;
  if (JSON.stringify({ query, body }).length > HUB_CONNECTIONS_LIMITS.paramsBytes) return null;
  const exampleText = value.example === undefined ? "" : JSON.stringify(value.example);
  return {
    endpointId: value.endpointId,
    title: value.title,
    summary: isHubPlainText(value.summary, HUB_CONNECTIONS_LIMITS.summaryChars) ? value.summary : "",
    method: value.method,
    query,
    body,
    priceKind: value.priceKind,
    unitPriceMicros: value.unitPriceMicros,
    currency: value.currency,
    maxUnits: value.maxUnits,
    maxCostMicros: value.maxCostMicros,
    effect: "read",
    example:
      isHubJson(value.example) &&
      exampleText.length > 0 &&
      exampleText.length <= HUB_CONNECTIONS_LIMITS.exampleBytes &&
      !MARKUP.test(exampleText)
        ? value.example
        : null,
  };
}

// --- tool-catalog: call -------------------------------------------------------------------------

/** The call body. `confirmationId` and `maxCostMicros` come only from the main process of the app. */
export interface ToolCatalogCallRequest {
  endpointId: string;
  query?: { readonly [name: string]: string | number | boolean };
  body?: HubJsonObject;
  maxCostMicros?: number;
  confirmationId?: string;
}

export const TOOL_CATALOG_VERDICTS = ["verified", "unverified", "mismatch", "unknown"] as const;

export interface ToolCatalogSignals {
  verificationVerdict?: (typeof TOOL_CATALOG_VERDICTS)[number];
  domainMatch?: boolean;
  ignoredFilters?: string[];
}

export type HubCapWarning = {
  code: "cap_warning";
  percent: number;
};

export interface ToolCatalogCallAnswer {
  kind: "result";
  requestId: string;
  endpointId: string;
  servedBy: string;
  providerStatus: number;
  orgId: string;
  chargedMicros: number;
  estimateMicros: number;
  currency: string;
  availableMicros: number;
  effectiveAvailableMicros: number;
  bindingScope: HubBindingScope;
  state: HubCapState;
  warningCrossed: boolean;
  warnings: HubCapWarning[];
  counterVersion: number;
  asOf: string;
  signals: ToolCatalogSignals;
  truncated: boolean;
  content: HubJson;
}

export interface HubNeedsPersonAnswer {
  kind: "needs-person";
  needsPerson: HubConnectionNeedsPerson;
  /** A reason code, such as `consent_required` for `not_allowed`. */
  reason: string | null;
  currency: string | null;
  estimateMicros: number | null;
  confirmationId: string | null;
  expiresAt: string | null;
  availableMicros: number | null;
  effectiveAvailableMicros: number | null;
  neededMicros: number | null;
  bindingScope: HubBindingScope | null;
  resetsAt: string | null;
}

export interface HubErrorAnswer {
  kind: "error";
  error: HubConnectionErrorCode;
  reason: string | null;
  scope: string | null;
  retryAfterSeconds: number | null;
  estimateMicros: number | null;
  chargedMicros: number | null;
  providerStatus: number | null;
  /** At most 300 characters of a provider refusal, masked by the Hub. Untrusted text. */
  providerMessage: string | null;
  /** The name of an input field that the Hub refused, for `input_refused`. */
  field: string | null;
  alternatives: string[];
}

export type ToolCatalogCallOutcome = ToolCatalogCallAnswer | HubNeedsPersonAnswer | HubErrorAnswer;

function decodeSignals(value: unknown): ToolCatalogSignals {
  if (!isDynamicRecord(value)) return {};
  const ignored = Array.isArray(value.ignoredFilters)
    ? value.ignoredFilters.filter((name): name is string => isHubParamName(name)).slice(0, 20)
    : undefined;
  return {
    ...(oneOf(TOOL_CATALOG_VERDICTS, value.verificationVerdict)
      ? { verificationVerdict: value.verificationVerdict }
      : {}),
    ...(isBoolean(value.domainMatch) ? { domainMatch: value.domainMatch } : {}),
    ...(ignored && ignored.length > 0 ? { ignoredFilters: ignored } : {}),
  };
}

function nullableMicros(value: unknown): number | null {
  return micros(value) ? value : null;
}

/** A `{ needsPerson }` answer, or null. */
export function decodeHubNeedsPerson(value: unknown): HubNeedsPersonAnswer | null {
  if (!isDynamicRecord(value) || !oneOf(HUB_CONNECTION_NEEDS_PERSON, value.needsPerson)) return null;
  if (value.needsPerson === "confirm_cost") {
    // A cost question without an id and an amount cannot be asked.
    if (!isHubConfirmationId(value.confirmationId) || !micros(value.estimateMicros) || !timestamp(value.expiresAt))
      return null;
  }
  return {
    kind: "needs-person",
    needsPerson: value.needsPerson,
    reason: matches(REASON_CODE, value.reason) ? value.reason : null,
    currency: matches(CURRENCY, value.currency) ? value.currency : null,
    estimateMicros: nullableMicros(value.estimateMicros),
    confirmationId: isHubConfirmationId(value.confirmationId) ? value.confirmationId : null,
    expiresAt: timestamp(value.expiresAt) ? value.expiresAt : null,
    availableMicros: nullableMicros(value.availableMicros),
    effectiveAvailableMicros: nullableMicros(value.effectiveAvailableMicros),
    neededMicros: nullableMicros(value.neededMicros),
    bindingScope: oneOf(HUB_BINDING_SCOPES, value.bindingScope) ? value.bindingScope : null,
    resetsAt: timestamp(value.resetsAt) ? value.resetsAt : null,
  };
}

/** An `{ error }` answer, or null. An unknown code is `internal_error`, never a success. */
export function decodeHubError(value: unknown): HubErrorAnswer | null {
  if (!isDynamicRecord(value) || !isString(value.error)) return null;
  return {
    kind: "error",
    error: oneOf(HUB_CONNECTION_ERROR_CODES, value.error) ? value.error : "internal_error",
    reason: matches(REASON_CODE, value.reason) ? value.reason : null,
    scope: matches(REASON_CODE, value.scope) ? value.scope : null,
    retryAfterSeconds: intIn(value.retryAfter, 0, 86_400) ? value.retryAfter : null,
    estimateMicros: nullableMicros(value.estimateMicros),
    chargedMicros: nullableMicros(value.chargedMicros),
    providerStatus: intIn(value.providerStatus, 100, 599) ? value.providerStatus : null,
    providerMessage: isHubPlainText(value.providerMessage, HUB_CONNECTIONS_LIMITS.providerMessageChars)
      ? value.providerMessage
      : null,
    field: isHubParamName(value.field) ? value.field : null,
    alternatives: Array.isArray(value.alternatives)
      ? value.alternatives.filter((id): id is string => isHubEndpointId(id)).slice(0, 5)
      : [],
  };
}

/** A successful call answer, or null. */
export function decodeToolCatalogCallAnswer(value: unknown): ToolCatalogCallAnswer | null {
  if (!isDynamicRecord(value) || !matches(OPAQUE_ID, value.requestId) || !isHubEndpointId(value.endpointId))
    return null;
  if (!isHubOrgId(value.orgId) || !matches(CURRENCY, value.currency) || !intIn(value.providerStatus, 100, 599))
    return null;
  if (
    !micros(value.chargedMicros) ||
    !micros(value.estimateMicros) ||
    !micros(value.availableMicros) ||
    !micros(value.effectiveAvailableMicros) ||
    !micros(value.counterVersion)
  )
    return null;
  if (!oneOf(HUB_BINDING_SCOPES, value.bindingScope) || !oneOf(HUB_CAP_STATES, value.state) || !timestamp(value.asOf))
    return null;
  if (!isHubJson(value.content)) return null;
  const warnings = Array.isArray(value.warnings)
    ? value.warnings
        .filter(
          (warning): warning is { code: "cap_warning"; percent: number } =>
            isDynamicRecord(warning) && warning.code === "cap_warning" && intIn(warning.percent, 1, 100),
        )
        .map((warning) => ({ code: "cap_warning" as const, percent: warning.percent }))
        .slice(0, 4)
    : [];
  return {
    kind: "result",
    requestId: value.requestId,
    endpointId: value.endpointId,
    // The vendor names the provider; the value goes into an attribute, so it must be a slug.
    servedBy: matches(VENDOR_SLUG, value.servedBy) ? value.servedBy : "unknown",
    providerStatus: value.providerStatus,
    orgId: value.orgId,
    chargedMicros: value.chargedMicros,
    estimateMicros: value.estimateMicros,
    currency: value.currency,
    availableMicros: value.availableMicros,
    effectiveAvailableMicros: value.effectiveAvailableMicros,
    bindingScope: value.bindingScope,
    state: value.state,
    warningCrossed: value.warningCrossed === true,
    warnings,
    counterVersion: value.counterVersion,
    asOf: value.asOf,
    signals: decodeSignals(value.signals),
    truncated: value.truncated === true,
    content: value.content,
  };
}

/** Any call answer. Null when the body has none of the three shapes. */
export function decodeToolCatalogCallOutcome(value: unknown): ToolCatalogCallOutcome | null {
  if (!isDynamicRecord(value)) return null;
  if ("needsPerson" in value) return decodeHubNeedsPerson(value);
  if ("error" in value) return decodeHubError(value);
  return decodeToolCatalogCallAnswer(value);
}

// --- GET /usage ---------------------------------------------------------------------------------

export interface HubConnectionUsage {
  orgId: string;
  periodKey: string;
  resetsAt: string;
  timeZone: string;
  currency: string;
  connections: Array<{
    id: string;
    settledMicros: number;
    reservedMicros: number;
    calls: number;
    availableMicros: number;
    effectiveAvailableMicros: number;
    state: HubCapState;
    counterVersion: number;
    platforms: Array<{ platform: string; settledMicros: number; calls: number }>;
  }>;
  asOf: string;
}

export function decodeHubConnectionUsage(value: unknown): HubConnectionUsage | null {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.org) || !isHubOrgId(value.org.id)) return null;
  const period = isDynamicRecord(value.period) ? value.period : {};
  if (!matches(PERIOD_KEY, period.key) || !timestamp(period.resetsAt) || !isHubPlainText(period.timeZone, 64))
    return null;
  if (!matches(CURRENCY, value.currency) || !timestamp(value.asOf) || !Array.isArray(value.connections)) return null;
  const connections: HubConnectionUsage["connections"] = [];
  for (const row of value.connections.slice(0, HUB_CONNECTIONS_LIMITS.connections)) {
    if (!isDynamicRecord(row) || !isHubConnectionId(row.id) || !oneOf(HUB_CAP_STATES, row.state)) continue;
    if (
      !micros(row.settledMicros) ||
      !micros(row.reservedMicros) ||
      !micros(row.calls) ||
      !micros(row.availableMicros) ||
      !micros(row.effectiveAvailableMicros) ||
      !micros(row.counterVersion)
    )
      continue;
    const platforms = Array.isArray(row.platforms)
      ? row.platforms
          .filter(
            (item): item is { platform: string; settledMicros: number; calls: number } =>
              isDynamicRecord(item) &&
              matches(VENDOR_SLUG, item.platform) &&
              micros(item.settledMicros) &&
              micros(item.calls),
          )
          .slice(0, 200)
          .map((item) => ({ platform: item.platform, settledMicros: item.settledMicros, calls: item.calls }))
      : [];
    connections.push({
      id: row.id,
      settledMicros: row.settledMicros,
      reservedMicros: row.reservedMicros,
      calls: row.calls,
      availableMicros: row.availableMicros,
      effectiveAvailableMicros: row.effectiveAvailableMicros,
      state: row.state,
      counterVersion: row.counterVersion,
      platforms,
    });
  }
  return {
    orgId: value.org.id,
    periodKey: period.key,
    resetsAt: period.resetsAt,
    timeZone: period.timeZone,
    currency: value.currency,
    connections,
    asOf: value.asOf,
  };
}
