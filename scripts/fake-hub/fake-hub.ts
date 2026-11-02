// Test only. A fake of the Cultura Builder Hub side of docs/architecture/hub-connections-contract.md,
// with the fake vendor of fake-treg.ts behind it. It listens on 127.0.0.1 and a random port, needs a
// token on every route, and is driven by the E2E scripts through the returned object (there is no
// admin route). It keeps the session, the proxy tokens, the ledger with caps, the cost approvals and
// a log of every request, so a check can prove what the app sent and what the vendor received.
//
// It follows the contract as the Hub team must build it: the device sign-in that gives the refresh
// family only to the fixed client of Builders Bot, the `platforms` of the catalog, the closed outbound
// header list to the vendor, the reservation and the cap before the vendor call, the 80 % mark,
// confirm_cost bound to the body and approved only on the Hub page (with its status route and the
// `not_allowed` reasons), choose_org for a person who left the organization, the kill switch, and the
// error mapping.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { type HubJson, type HubJsonObject, isHubJsonObject } from "@openbot/contracts/hub-connections";
import { isCredentialName } from "../../src/backend/hub-connections/hub-connection-input";
import { FAKE_VENDOR_KEY, type FakeTreg, startFakeTreg } from "./fake-treg";
import { failedRule, type ObjectSchema, type ParamSchema, triagedText, VENDOR_ROWS, type VendorRow } from "./mirror";

/** 5 BRL per USD, in parts per million, as the period rate of the ledger. */
const RATE_PPM = 5_000_000;
const TOKEN_SECONDS = 300;
const CONFIRMATION_MS = 5 * 60_000;
const VENDOR_TIMEOUT_MS = 25_000;
const VENDOR_BODY_LIMIT = 2 * 1024 * 1024;
const CONTENT_CHARS = 200_000;
const CONNECTION = "tool-catalog";
const PROXY_RESOURCE = "https://hub.culturabuilder.com/api/builder-ai/proxy";
/**
 * The fixed public OAuth client of Builders Bot. The Hub lists it for the proxy, so only a sign-in
 * with it gets the refresh family that proxy tokens need. A client that `/register` makes gets an
 * access token only.
 */
export const FAKE_HUB_CLIENT_ID = "28244c0a-7d6b-4256-be9b-9933cf0e6e94";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CONFIRMATION_PATH = /^\/api\/builder-ai\/proxy\/v1\/connections\/tool-catalog\/confirmations\/([^/]{1,256})$/u;

/** The name and group of each platform of the fake mirror, as the Hub's curated list says them. */
const PLATFORM_INFO: Readonly<Record<string, { readonly name: string; readonly group: string }>> = {
  "google-ads": { name: "Google Ads", group: "seo" },
  "open-web": { name: "Web aberta", group: "research" },
  "company-data": { name: "Dados de empresas", group: "enrichment" },
  "app-store": { name: "Lojas de apps", group: "reviews" },
  "market-data": { name: "Dados de mercado", group: "market" },
  "people-data": { name: "Pessoas e contatos", group: "enrichment" },
  "ai-judgment": { name: "Classificação por IA", group: "generation" },
  "ads-data": { name: "Dados de anúncios", group: "advertising" },
  "test-clean": { name: "Ferramentas de teste", group: "developer" },
  "test-errors": { name: "Erros de teste", group: "developer" },
};

/** One platform of the catalog entry (`platforms` of the contract). */
export interface FakePlatform {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly endpoints: number;
}

/** The states of a cost approval on the Hub page. `expired` and `used` follow from the clock and the call. */
export type FakeConfirmationState = "pending" | "approved" | "denied";

export interface FakeOrg {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  member: boolean;
  consented: boolean;
  capMicros: number;
  confirmAboveMicros: number;
  maxCostPerCallMicros: number;
  /** Opaque vendor tags, random per organization and per person (design §3.5). */
  readonly orgTag: string;
  readonly userTag: string;
  settledMicros: number;
  reservedMicros: number;
  warned: boolean;
  counterVersion: number;
  calls: number;
  platforms: Map<string, { settledMicros: number; calls: number }>;
  /** The organization's state of the connection, and the person's, as the catalog row says them. */
  orgState: "enabled" | "not_enabled" | "not_in_plan" | "paused" | "revoked";
  userState: "allowed" | "not_allowed" | "requested";
  /** The categories of the vendor catalog that the organization allows, by name. */
  categories: string[];
  /** The person's open requests to the admins, by kind: when the Hub took each one. */
  requests: Map<"access" | "more", number>;
}

/** One request of the person to the admins of an organization, as the Hub took it. */
export interface FakeAccessRequest {
  readonly orgId: string;
  readonly kind: "access" | "more";
  readonly repeated: boolean;
  readonly at: number;
}

export interface HubRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly status: number;
}

export interface FakeHub {
  readonly origin: string;
  readonly treg: FakeTreg;
  readonly session: { readonly access: string; readonly refresh: string };
  readonly orgs: Map<string, FakeOrg>;
  readonly requests: HubRequest[];
  /** Every proxy token that the fake issued. None may reach an agent or a log. */
  readonly issuedTokens: string[];
  /** Every confirmation id that the fake issued. None may reach an agent. */
  readonly issuedConfirmations: string[];
  /** Every request to the admins that the person sent, with the ones that the 7 days absorbed. */
  readonly accessRequests: FakeAccessRequest[];
  /** The kill switch: the capability of `/session` goes off and every call is refused. */
  setPaused(paused: boolean): void;
  /** `capabilities.connectionsUsage` of `/session`: whether the app may show Usage › Connections. */
  setConnectionsUsage(on: boolean): void;
  paused(): boolean;
  /**
   * `drop` closes each connection with no answer; `hang` keeps each one open with no answer, as a
   * Hub behind a captive portal; a number answers with that status and no body.
   */
  setDown(mode: "drop" | "hang" | number | null): void;
  /** `active` of `/session`: whether the account may use the LLM. It says nothing about connections. */
  setActive(active: boolean): void;
  /**
   * The renewal of the session (a refresh grant without `resource`) gives a new refresh token and
   * ends the old one at once, with no grace: a second use of the old one is `invalid_grant`.
   */
  setRotateOnRenew(on: boolean): void;
  /**
   * Delays the token route so that two grants overlap: a renewal rotates at once and answers after
   * `ms`; a proxy token request is checked `ms / 4` after it arrives.
   */
  setTokenDelay(ms: number): void;
  /** Every refresh grant that the Hub refused with `invalid_grant`. */
  readonly refusedGrants: string[];
  /** Every refresh grant, in the order that the Hub checked them, with the time of the check. */
  readonly grants: Array<{ readonly kind: "renewal" | "proxy"; readonly at: number; readonly ok: boolean }>;
  /** A second person, member of `org_a`, with a session of their own. */
  readonly sessionB: { readonly access: string; readonly refresh: string };
  /** The current tokens of a person, after rotations. */
  sessionOf(person: "a" | "b"): { readonly access: string; readonly refresh: string };
  /** Gives a person new tokens, as a new sign-in does: the app has never seen them. */
  newSession(person: "a" | "b"): { readonly access: string; readonly refresh: string };
  /** Moves the clock of the fake forward. */
  advance(ms: number): void;
  /** A proxy token, as the app gets one, for the checks that call the fake directly. */
  proxyToken(orgId: string | null): Promise<string>;
  /**
   * The `platforms` of the catalog entry: `"derived"` (the default) lists the platforms of the
   * allowed rows; a list sends those values as they are, also malformed ones; null leaves the field
   * out, as an older Hub does.
   */
  setPlatforms(rows: "derived" | readonly unknown[] | null): void;
  /** The platforms that `"derived"` sends. */
  platforms(): FakePlatform[];
  /**
   * False: `/session` has no `capabilities` (the organization did not turn a connection on), and a
   * proxy token request gets `connections_disabled`.
   */
  setCapabilities(on: boolean): void;
  /** The person approves or denies a cost on the Hub page of the confirmation. */
  decideConfirmation(id: string, state: FakeConfirmationState): void;
  /** The confirmation ends now, as one that nobody approved in its 5 minutes. */
  expireConfirmation(id: string): void;
  /** The status route says this state for the id, whatever its real state is: a Hub race. Null: the real one. */
  sayConfirmationState(id: string, state: string | null): void;
  /** Each read of the status route: the id, the organization of the token and the state that the fake gave. */
  readonly confirmationReads: Array<{ readonly id: string; readonly orgId: string; readonly state: string }>;
  close(): Promise<void>;
}

const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,79}$/u;
const ENDPOINT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SERVED_BY = /^[a-z0-9._-]{1,64}$/u;
const CREDENTIAL_NAME =
  /^(?:key|api[-_.]?key|x[-_.]?api[-_.]?key|token|access[-_.]?token|authorization|password|secret|cookies?|session|session[-_.]?id|li[-_.]?at|csrf(?:[-_.]?token)?|bearer|auth)$/iu;
const COOKIE_VALUE =
  /(?:^|[;\s])[A-Za-z0-9_.$-]{1,64}=[^;\s]*;\s*[A-Za-z0-9_.$-]{1,64}=|(?:li_at|sessionid|jsessionid|csrftoken)=/iu;
const JWT_VALUE = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\./u;
/** A query parameter of a URL in a text; its value is masked when its name is a credential (contract §6.3). */
const MASK_QUERY = /([?&;]([^=&#\s"'<>;]{1,64})=)([^&#\s"'<>;]+)/gu;
const MASK_BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** JSON with sorted keys, so a hash of the same body is the same whatever the key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): HubJsonObject | null {
  return isHubJsonObject(value) ? value : null;
}

function toBrl(microUsd: number): number {
  return Math.ceil((microUsd * RATE_PPM) / 1_000_000);
}

/** The ceiling header: micro-USD as USD with 6 decimals, rounded down. */
function usd(microUsd: number): string {
  return `${Math.floor(microUsd / 1_000_000)}.${String(microUsd % 1_000_000).padStart(6, "0")}`;
}

function isPrivateUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return true;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
  if (url.username || url.password || url.port) return true;
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(host) === 6) return true;
  return !host.includes(".") || /(?:^localhost|\.local|\.internal|\.ts\.net|\.lan|\.home\.arpa)$/u.test(host);
}

/** The Hub's own input checks (contract §"Input checks"): the second lock after the app's. */
function checkValue(schema: ParamSchema, value: unknown, field: string): string | null {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return field;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return field;
      if (schema.enum && !schema.enum.includes(value)) return field;
      if (COOKIE_VALUE.test(value) || JWT_VALUE.test(value)) return field;
      if ((schema.format === "uri" || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) && isPrivateUrl(value)) return field;
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return field;
      if (schema.minimum !== undefined && value < schema.minimum) return field;
      if (schema.maximum !== undefined && value > schema.maximum) return field;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : field;
    case "array":
      if (!Array.isArray(value) || value.length > schema.maxItems) return field;
      for (const [index, item] of value.entries()) {
        const refused = checkValue(schema.items, item, `${field}[${index}]`);
        if (refused) return refused;
      }
      return null;
    case "object":
      return checkObject(schema, value, field);
  }
}

function checkObject(schema: ObjectSchema, value: unknown, path: string): string | null {
  const object = record(value);
  if (!object) return path;
  for (const name of Object.keys(object)) {
    if (CREDENTIAL_NAME.test(name) || !Object.hasOwn(schema.properties, name)) return `${path}.${name}`;
  }
  for (const name of schema.required) if (object[name] === undefined) return `${path}.${name}`;
  for (const [name, item] of Object.entries(object)) {
    const property = schema.properties[name];
    if (property) {
      const refused = checkValue(property, item, `${path}.${name}`);
      if (refused) return refused;
    }
  }
  return null;
}

/** Masks credentials in a 2xx vendor body by shape (design §3.8 step 11, §3.14 item 8). */
function maskBody(value: HubJson): HubJson {
  if (typeof value === "string")
    return value
      .replace(MASK_QUERY, (whole: string, head: string, name: string) =>
        isCredentialName(name) ? `${head}[masked]` : whole,
      )
      .replace(MASK_BEARER, "$1[masked]");
  if (Array.isArray(value)) return value.map(maskBody);
  const object = record(value);
  if (!object) return value;
  // The same name rule as the input check of section 6.2 step 6 (`isCredentialName`).
  return Object.fromEntries(
    Object.entries(object).map(([name, item]) => [
      name,
      isCredentialName(name) && typeof item === "string" ? "[masked]" : maskBody(item),
    ]),
  );
}

async function readBody(request: IncomingMessage, limit = 64 * 1024): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): HubJson | undefined {
  try {
    const value: HubJson = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

interface Confirmation {
  readonly orgId: string;
  readonly endpointId: string;
  readonly bodyHash: string;
  readonly estimateMicros: number;
  expiresAt: number;
  used: boolean;
  /** What the person chose on the Hub page. The Hub accepts the id on a call only after `approved`. */
  state: FakeConfirmationState;
  /** A state that the status route says instead of the real one. */
  said: string | null;
}

interface Idempotent {
  readonly hash: string;
  readonly status: number;
  readonly body: unknown;
}

export async function startFakeHub(): Promise<FakeHub> {
  const treg = await startFakeTreg();
  let offset = 0;
  const now = () => Date.now() + offset;
  const session = { access: `hubat_${hex(20)}`, refresh: `hubrt_${hex(20)}` };
  const sessionB = { access: `hubat_${hex(20)}`, refresh: `hubrt_${hex(20)}` };
  /** The live tokens of each person; a rotation replaces them. */
  const people = { a: { ...session }, b: { ...sessionB } };
  const personOfRefresh = (refresh: string | null) =>
    refresh === people.a.refresh ? "a" : refresh === people.b.refresh ? "b" : null;
  const personOfAccess = (access: string) =>
    access === people.a.access ? "a" : access === people.b.access ? "b" : null;
  let active = true;
  let rotateOnRenew = false;
  let tokenDelayMs = 0;
  const refusedGrants: string[] = [];
  const grants: Array<{ kind: "renewal" | "proxy"; at: number; ok: boolean }> = [];
  const userId = "u_e2e_person";
  const makeOrg = (id: string, name: string, isDefault: boolean, capMicros: number): FakeOrg => ({
    id,
    name,
    isDefault,
    member: true,
    consented: true,
    capMicros,
    confirmAboveMicros: 250_000,
    maxCostPerCallMicros: 1_000_000,
    orgTag: `o_${hex(8)}`,
    userTag: `u_${hex(8)}`,
    settledMicros: 0,
    reservedMicros: 0,
    warned: false,
    counterVersion: 0,
    calls: 0,
    platforms: new Map(),
    orgState: "enabled",
    userState: "allowed",
    categories: ["SEO e palavras-chave", "Dados de empresas", "Lojas de apps", "Avaliações"],
    requests: new Map(),
  });
  const orgs = new Map<string, FakeOrg>([
    ["org_a", makeOrg("org_a", "Empresa A", true, 2_000_000)],
    ["org_b", makeOrg("org_b", "Empresa B", false, 5_000_000)],
  ]);
  const tokens = new Map<string, { orgId: string | null; expiresAt: number; person: "a" | "b" }>();
  const confirmations = new Map<string, Confirmation>();
  const idempotent = new Map<string, Idempotent>();
  const requests: HubRequest[] = [];
  const issuedTokens: string[] = [];
  const issuedConfirmations: string[] = [];
  const accessRequests: FakeAccessRequest[] = [];
  /** One request per person, connection, organization and kind counts in 7 days (contract §10.1). */
  const REQUEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  let pausedReason: string | null = null;
  let connectionsUsage = true;
  let capabilitiesOn = true;
  let platformRows: "derived" | readonly unknown[] | null = "derived";
  /** The device codes of the sign-ins that wait, with the client that asked for each. */
  const devices = new Map<string, string>();
  const confirmationReads: Array<{ id: string; orgId: string; state: string }> = [];
  let down: "drop" | "hang" | number | null = null;
  const hanging = new Set<ServerResponse>();
  let ledger = 0;

  const allowed = VENDOR_ROWS.filter((row) => row.skipHubAdmission === true || failedRule(row) === null);
  const allowedRow = (id: unknown) => allowed.find((row) => row.endpointId === id) ?? null;
  const cheapestUnit = Math.min(...allowed.map((row) => toBrl(row.unitPriceMicroUsd ?? 0)));
  /** One platform per platform of the allowed rows, with the count of its endpoints, in the mirror's order. */
  const derivedPlatforms = (): FakePlatform[] => {
    const counts = new Map<string, number>();
    for (const row of allowed) counts.set(row.platform, (counts.get(row.platform) ?? 0) + 1);
    return [...counts].map(([id, endpoints]) => ({
      id,
      name: PLATFORM_INFO[id]?.name ?? id,
      group: PLATFORM_INFO[id]?.group ?? "other",
      endpoints,
    }));
  };

  const available = (org: FakeOrg) => Math.max(0, org.capMicros - org.settledMicros - org.reservedMicros);
  const state = (org: FakeOrg) =>
    available(org) < cheapestUnit ? "reached" : org.settledMicros >= org.capMicros * 0.8 ? "warning" : "ok";
  const resetsAt = "2026-11-01T03:00:00.000Z";
  const counters = (org: FakeOrg) => ({
    currency: "BRL",
    availableMicros: available(org),
    effectiveAvailableMicros: available(org),
    bindingScope: "user",
    state: state(org),
    counterVersion: org.counterVersion,
    asOf: new Date(now()).toISOString(),
  });

  /** The time of an open request of this kind, within the 7 days, as ISO text; else null. */
  function openRequest(org: FakeOrg, kind: "access" | "more"): string | null {
    const at = org.requests.get(kind);
    return at !== undefined && now() - at < REQUEST_WINDOW_MS ? new Date(at).toISOString() : null;
  }

  function issueToken(orgId: string | null, person: "a" | "b" = "a"): string {
    const token = `cbp_${hex(24)}`;
    tokens.set(token, { orgId, expiresAt: now() + TOKEN_SECONDS * 1000, person });
    issuedTokens.push(token);
    return token;
  }

  /** The search, describe and call view of a mirror row, with prices in the organization's currency. */
  function view(row: VendorRow, org: FakeOrg) {
    const unit = toBrl(row.unitPriceMicroUsd ?? 0);
    return {
      endpointId: row.endpointId,
      title: triagedText(row).title,
      platform: row.platform,
      provider: row.provider,
      priceKind: row.priceKind,
      unitPriceMicros: unit,
      currency: "BRL",
      maxUnits: row.maxUnits,
      maxCostMicros: Math.min(unit * row.maxUnits, org.maxCostPerCallMicros),
      reliability: 0.97,
      // The row's own effect: a Hub that let a write endpoint through is what the app's lock must stop.
      effect: row.effect,
    };
  }

  function catalog() {
    const rows = [...orgs.values()].filter((org) => org.member);
    return {
      catalogVersion: "fake-1",
      ttlSeconds: 300,
      viewer: {
        userId,
        orgs: rows.map((org) => ({ id: org.id, name: org.name, role: "member", default: org.isDefault })),
        personal: false,
      },
      connections: [
        {
          id: CONNECTION,
          name: "Catálogo de ferramentas",
          tagline: "Dados externos pagos, com teto por pessoa",
          description:
            "Dados externos pagos para os agentes: SEO e palavras-chave, dados de empresas, lojas de apps e avaliações.",
          operations: [
            { id: "search", title: "Search", effect: "read", pricing: { unit: "call", basis: "fixed" } },
            { id: "describe", title: "Describe", effect: "read", pricing: { unit: "call", basis: "fixed" } },
            { id: "call", title: "Call", effect: "read", pricing: { unit: "call", basis: "metered" } },
          ],
          items: { count: allowed.length },
          ...(platformRows === null
            ? {}
            : { platforms: platformRows === "derived" ? derivedPlatforms() : platformRows }),
          dataPolicy: { vendor: "treg.to", region: "us", retentionDays: 0 },
          access: rows.map((org) => ({
            orgId: org.id,
            org: pausedReason ? "paused" : org.orgState,
            user: org.userState,
            consented: org.consented,
            categories: org.categories,
            priceFromMicros: cheapestUnit,
            requestedAt: openRequest(org, "access"),
            moreRequestedAt: openRequest(org, "more"),
            cap: { kind: "limited", amountMicros: org.capMicros },
            settledMicros: org.settledMicros,
            reservedMicros: org.reservedMicros,
            maxCostPerCallMicros: org.maxCostPerCallMicros,
            confirmAboveMicros: org.confirmAboveMicros,
            resetsAt,
            ...counters(org),
          })),
        },
      ],
    };
  }

  /** Units of one request (design §3.15 rule 3). The Hub writes `limit` itself for a per_row row. */
  function units(row: VendorRow, body: HubJsonObject): { units: number; body: HubJsonObject } {
    if (row.priceKind === "per_target" && row.unitsField) {
      const list = body[row.unitsField];
      return { units: Math.max(1, Array.isArray(list) ? list.length : 1), body };
    }
    if (row.priceKind === "per_row" && row.unitsField) {
      const asked = typeof body[row.unitsField] === "number" ? Number(body[row.unitsField]) : 20;
      const limit = Math.max(1, Math.min(asked, row.maxUnits));
      return { units: limit, body: { ...body, [row.unitsField]: limit } };
    }
    return { units: 1, body };
  }

  async function call(org: FakeOrg, payload: HubJsonObject): Promise<[number, unknown]> {
    const row = allowedRow(payload.endpointId);
    if (typeof payload.endpointId === "string" && /[/:]/u.test(payload.endpointId))
      return [404, { error: "endpoint_not_allowed" }];
    if (!row) return [404, { error: "endpoint_not_allowed" }];
    const origin = payload.origin;
    if (origin !== "owner_ui" && origin !== "routine" && origin !== "agent")
      return [422, { error: "input_refused", field: "origin" }];
    const query = record(payload.query ?? {});
    const body = record(payload.body ?? {});
    if (!query || !body) return [422, { error: "input_refused", field: "input" }];
    if (payload.query !== undefined) {
      const refused = row.query ? checkObject(row.query, query, "query") : "query";
      if (refused) return [422, { error: "input_refused", field: refused.replace(/^\./u, "") }];
    }
    if (payload.body !== undefined || row.body?.required.length) {
      const refused = row.body ? checkObject(row.body, body, "body") : "body";
      if (refused) return [422, { error: "input_refused", field: refused.replace(/^\./u, "") }];
    }
    const counted = units(row, body);
    const estimateMicroUsd = counted.units * (row.unitPriceMicroUsd ?? 0);
    const estimateMicros = toBrl(estimateMicroUsd);
    const maxCost = typeof payload.maxCostMicros === "number" ? payload.maxCostMicros : null;
    if (estimateMicros > org.maxCostPerCallMicros || (maxCost !== null && maxCost < estimateMicros))
      return [402, { error: "cost_above_limit", estimateMicros }];
    const bodyHash = createHash("sha256")
      .update(stable({ endpointId: row.endpointId, query: payload.query ?? null, body: payload.body ?? null }))
      .digest("hex");
    if (estimateMicros > org.confirmAboveMicros) {
      const id = payload.confirmationId;
      if (id === undefined) {
        const confirmationId = `cf_${hex(16)}`;
        issuedConfirmations.push(confirmationId);
        const expiresAt = now() + CONFIRMATION_MS;
        confirmations.set(confirmationId, {
          orgId: org.id,
          endpointId: row.endpointId,
          bodyHash,
          estimateMicros,
          expiresAt,
          used: false,
          state: "pending",
          said: null,
        });
        return [
          409,
          {
            needsPerson: "confirm_cost",
            currency: "BRL",
            estimateMicros,
            confirmationId,
            expiresAt: new Date(expiresAt).toISOString(),
          },
        ];
      }
      const held = typeof id === "string" ? confirmations.get(id) : undefined;
      if (
        !held ||
        held.used ||
        held.expiresAt <= now() ||
        held.orgId !== org.id ||
        held.endpointId !== row.endpointId ||
        held.bodyHash !== bodyHash ||
        estimateMicros > held.estimateMicros
      )
        return [409, { error: "input_refused", reason: "confirmation_invalid", field: "confirmationId" }];
      // The approval is the person's click on the Hub page, never the app's word (security fix).
      if (held.state === "denied") return [409, { error: "not_allowed", reason: "confirmation_denied" }];
      if (held.state !== "approved") return [409, { error: "not_allowed", reason: "confirmation_not_approved" }];
      held.used = true;
    }
    if (estimateMicros > available(org))
      return [
        402,
        {
          needsPerson: "cap_reached",
          currency: "BRL",
          availableMicros: available(org),
          effectiveAvailableMicros: available(org),
          neededMicros: estimateMicros,
          bindingScope: "user",
          resetsAt,
        },
      ];
    // Reserve, call the vendor with the closed header list, settle.
    ledger += 1;
    const ledgerId = `le_${ledger}_${hex(4)}`;
    org.reservedMicros += estimateMicros;
    org.counterVersion += 1;
    const release = () => {
      org.reservedMicros -= estimateMicros;
      org.counterVersion += 1;
    };
    const url = new URL(`/call/${row.endpointId}`, treg.origin);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = {
      "X-Treg-Token": FAKE_VENDOR_KEY,
      "X-Treg-Meta": `org=${org.orgTag},user=${org.userTag},origin=${origin},env=staging,req=${ledgerId}`,
      "X-Treg-Route-Max-Cost": usd(estimateMicroUsd),
      "Idempotency-Key": ledgerId,
      Accept: "application/json",
      "Cache-Control": "no-cache",
      ...(row.method === "POST" ? { "Content-Type": "application/json" } : {}),
    };
    let response: Response;
    try {
      response = await fetch(url, {
        method: row.method,
        headers,
        ...(row.method === "POST" ? { body: JSON.stringify(counted.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
      });
    } catch {
      release();
      return [502, { error: "upstream_unavailable" }];
    }
    const text = await response.text();
    if (text.length > VENDOR_BODY_LIMIT) {
      release();
      return [502, { error: "result_too_large" }];
    }
    const vendorError = response.headers.get("x-treg-error") === "1";
    const costHeader = response.headers.get("x-treg-cost-micro");
    const vendorCost = costHeader === null ? null : Number(costHeader);
    const value = parseJson(text);
    const settle = (microUsd: number | null) => {
      org.reservedMicros -= estimateMicros;
      const charged = microUsd === null ? estimateMicros : Math.min(toBrl(microUsd), estimateMicros);
      org.settledMicros += charged;
      org.counterVersion += 1;
      org.calls += 1;
      const platform = org.platforms.get(row.platform) ?? { settledMicros: 0, calls: 0 };
      org.platforms.set(row.platform, { settledMicros: platform.settledMicros + charged, calls: platform.calls + 1 });
      return charged;
    };
    const vendorCode = record(value)?.error;
    if (vendorError) {
      release();
      if (response.status === 402 && vendorCode === "insufficient_balance") {
        // The shared balance is out: the connection pauses for everyone (design §3.11).
        pausedReason = "vendor_balance";
        return [503, { error: "connection_unavailable", reason: "vendor_balance" }];
      }
      if (response.status === 402 && vendorCode === "route_max_cost")
        return [402, { error: "cost_above_limit", estimateMicros }];
      if (response.status === 429)
        return [
          429,
          { error: "rate_limited", scope: "provider", retryAfter: Number(response.headers.get("retry-after") ?? 60) },
        ];
      return [502, { error: "upstream_unavailable" }];
    }
    if (response.status === 202) {
      const charged = settle(null);
      return [502, { error: "upstream_unavailable", reason: "pending_not_supported", chargedMicros: charged }];
    }
    if (response.status >= 500) {
      release();
      return [502, { error: "provider_failed", providerStatus: response.status }];
    }
    if (response.status >= 400) {
      let charged = 0;
      if (vendorCost === null) release();
      else charged = settle(vendorCost);
      const message = String(record(value)?.message ?? "");
      return [
        422,
        {
          error: "provider_rejected_request",
          providerStatus: response.status,
          chargedMicros: charged,
          providerMessage: String(maskBody(message))
            .replace(/sk_live_[A-Za-z0-9]+/gu, "[masked]")
            .slice(0, 300),
        },
      ];
    }
    const charged = settle(vendorCost);
    const parsed = record(value) ?? {};
    const vendorBlock = record(parsed._treg) ?? {};
    const verification = record(vendorBlock.verification);
    const signals = {
      ...(typeof verification?.verdict === "string" ? { verificationVerdict: verification.verdict } : {}),
      ...(typeof vendorBlock.domain_match === "boolean" ? { domainMatch: vendorBlock.domain_match } : {}),
      ...(Array.isArray(vendorBlock.ignored_filters)
        ? { ignoredFilters: vendorBlock.ignored_filters.filter((name) => typeof name === "string") }
        : {}),
    };
    const { _treg: _dropped, ...providerBody } = parsed;
    const routed = "output" in providerBody ? (providerBody.output ?? null) : providerBody;
    const content = row.skipHubMask ? routed : maskBody(routed);
    const contentText = JSON.stringify(content);
    const servedBy = response.headers.get("x-treg-served-by") ?? "";
    const crossed = !org.warned && org.settledMicros >= org.capMicros * 0.8;
    if (crossed) org.warned = true;
    return [
      200,
      {
        requestId: ledgerId,
        endpointId: row.endpointId,
        servedBy: SERVED_BY.test(servedBy) ? servedBy : "unknown",
        providerStatus: response.status,
        orgId: org.id,
        chargedMicros: charged,
        estimateMicros,
        ...counters(org),
        warningCrossed: crossed,
        warnings: org.warned ? [{ code: "cap_warning", percent: 80 }] : [],
        signals,
        truncated: contentText.length > CONTENT_CHARS,
        content: contentText.length > CONTENT_CHARS ? contentText.slice(0, CONTENT_CHARS) : content,
      },
    ];
  }

  async function route(request: IncomingMessage, path: string, raw: string): Promise<[number, unknown]> {
    const auth = request.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // Dynamic client registration still answers, as the real Hub does; the app must not use it.
    if (path === "/api/mcp-oauth/register" && request.method === "POST")
      return [201, { client_id: `dyn_${hex(8)}`, client_name: "Builders Bot" }];
    if (path === "/api/mcp-oauth/device" && request.method === "POST") {
      const form = new URLSearchParams(raw);
      const clientId = form.get("client_id") ?? "";
      if (clientId === "" || form.get("scope") !== "builder-ai") return [400, { error: "invalid_request" }];
      const deviceCode = `dc_${hex(16)}`;
      devices.set(deviceCode, clientId);
      return [
        200,
        {
          device_code: deviceCode,
          user_code: "WXYZ-2345",
          verification_uri: "https://hub.culturabuilder.com/device",
          verification_uri_complete: "https://hub.culturabuilder.com/device?user_code=WXYZ-2345",
          expires_in: 600,
          interval: 1,
        },
      ];
    }
    if (path === "/api/mcp-oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") === DEVICE_GRANT) {
        // The person approved the code on the Hub at once. Each sign-in gives person A new tokens.
        const code = form.get("device_code") ?? "";
        const clientId = devices.get(code);
        if (clientId === undefined || clientId !== form.get("client_id")) return [400, { error: "invalid_grant" }];
        devices.delete(code);
        people.a.access = `hubat_${hex(20)}`;
        people.a.refresh = `hubrt_${hex(20)}`;
        // Only the listed client gets the refresh family that a proxy token needs.
        return [
          200,
          {
            access_token: people.a.access,
            ...(clientId === FAKE_HUB_CLIENT_ID ? { refresh_token: people.a.refresh } : {}),
            token_type: "Bearer",
            expires_in: 900,
          },
        ];
      }
      const renewal = form.get("resource") === null;
      // With a delay, a proxy token request is checked a moment after it arrives, while a renewal
      // rotates at once and answers late: a proxy token request that left with the refresh token
      // that a renewal in flight replaces is refused, as a strict Hub would.
      if (!renewal && tokenDelayMs > 0) await new Promise((done) => setTimeout(done, tokenDelayMs / 4));
      const person = personOfRefresh(form.get("refresh_token"));
      grants.push({ kind: renewal ? "renewal" : "proxy", at: Date.now(), ok: person !== null });
      if (form.get("grant_type") !== "refresh_token" || person === null) {
        refusedGrants.push(form.get("resource") ? "proxy" : "renewal");
        return [400, { error: "invalid_grant" }];
      }
      // The renewal of the session: a new access token, and with rotation a new refresh token.
      if (renewal) {
        const live = people[person];
        live.access = `hubat_${hex(20)}`;
        if (rotateOnRenew) live.refresh = `hubrt_${hex(20)}`;
        if (tokenDelayMs > 0) await new Promise((done) => setTimeout(done, tokenDelayMs));
        return [200, { access_token: live.access, refresh_token: live.refresh, token_type: "Bearer", expires_in: 900 }];
      }
      if (form.get("resource") !== PROXY_RESOURCE || form.get("scope") !== "builder-proxy")
        return [400, { error: "invalid_request" }];
      if (pausedReason || !capabilitiesOn) return [403, { error: "connections_disabled" }];
      const orgId = form.get("org");
      if (orgId !== null) {
        const org = ORG_ID.test(orgId) ? orgs.get(orgId) : undefined;
        if (!org?.member) return [403, { error: "not_member" }];
        if (!org.consented) return [403, { error: "consent_required" }];
      }
      // The proxy token request never rotates the refresh token (contract).
      return [
        200,
        {
          access_token: issueToken(orgId, person),
          token_type: "Bearer",
          expires_in: TOKEN_SECONDS,
          org: orgId ?? null,
        },
      ];
    }
    if (path === "/api/builder-ai/gateway/v1/session" && request.method === "GET") {
      if (personOfAccess(bearer) === null) return [401, { error: "unauthorized" }];
      return [
        200,
        {
          active,
          empresa: "Empresa A",
          ...(capabilitiesOn
            ? {
                capabilities: {
                  connections: {
                    [CONNECTION]: pausedReason ? { enabled: false, reason: "paused" } : { enabled: true },
                  },
                  connectionsUsage,
                },
              }
            : {}),
        },
      ];
    }
    if (!path.startsWith("/api/builder-ai/proxy/v1/")) return [404, { error: "not_found" }];
    // Every proxy route needs a live proxy token in the header; a token in the URL is refused.
    const held = tokens.get(bearer);
    if (!held || held.expiresAt <= now() || new URL(request.url ?? "/", "http://x").searchParams.has("token"))
      return [401, { error: "unauthorized" }];
    if (path === "/api/builder-ai/proxy/v1/connections" && request.method === "GET") return [200, catalog()];
    const org = held.orgId ? orgs.get(held.orgId) : undefined;
    if (!org) return [400, { error: "input_refused", reason: "org_required" }];
    // The person left the organization that this token pays with (design §3.16 step 7).
    if (!org.member) return [403, { needsPerson: "choose_org", reason: "not_member" }];
    // The use of person B is their own: nothing of person A's calls.
    const own = (value: number) => (held.person === "a" ? value : 0);
    if (path === "/api/builder-ai/proxy/v1/usage" && request.method === "GET")
      return [
        200,
        {
          org: { id: org.id },
          period: { key: "2026-10", resetsAt, timeZone: "America/Sao_Paulo" },
          currency: "BRL",
          asOf: new Date(now()).toISOString(),
          connections: [
            {
              id: CONNECTION,
              settledMicros: own(org.settledMicros),
              reservedMicros: own(org.reservedMicros),
              calls: own(org.calls),
              availableMicros: held.person === "a" ? available(org) : org.capMicros,
              effectiveAvailableMicros: held.person === "a" ? available(org) : org.capMicros,
              state: held.person === "a" ? state(org) : "ok",
              counterVersion: org.counterVersion,
              cap: { kind: "limited", amountMicros: org.capMicros },
              bindingScope: "user",
              platforms:
                held.person === "a" ? [...org.platforms].map(([platform, value]) => ({ platform, ...value })) : [],
            },
          ],
        },
      ];
    const confirmationPath = CONFIRMATION_PATH.exec(path);
    if (confirmationPath && request.method === "GET") {
      // The status of a cost approval, for the organization of the token only.
      const id = decodeURIComponent(confirmationPath[1] ?? "");
      const held = confirmations.get(id);
      if (!held || held.orgId !== org.id) return [404, { error: "not_found" }];
      const state = held.said ?? (held.used ? "used" : held.expiresAt <= now() ? "expired" : held.state);
      confirmationReads.push({ id, orgId: org.id, state });
      return [200, { confirmationId: id, state, expiresAt: new Date(held.expiresAt).toISOString() }];
    }
    if (request.method !== "POST") return [404, { error: "not_found" }];
    if (path === `/api/builder-ai/proxy/v1/connections/${CONNECTION}/access-requests`) {
      // A request to the admins works also while the connection is paused or not on for the person.
      const kind = record(parseJson(raw))?.kind;
      if (kind !== "access" && kind !== "more") return [422, { error: "input_refused", field: "kind" }];
      const open = openRequest(org, kind);
      const at = open ? Date.parse(open) : now();
      if (!open) org.requests.set(kind, at);
      accessRequests.push({ orgId: org.id, kind, repeated: open !== null, at: now() });
      return [
        200,
        {
          requestedAt: new Date(at).toISOString(),
          nextAllowedAt: new Date(at + REQUEST_WINDOW_MS).toISOString(),
          repeated: open !== null,
        },
      ];
    }
    if (pausedReason) return [503, { error: "connection_unavailable", reason: pausedReason }];
    if (org.orgState !== "enabled" || org.userState !== "allowed") return [403, { error: "not_allowed" }];
    const payload = record(parseJson(raw));
    if (!payload) return [422, { error: "input_refused", field: "body" }];
    if (path === `/api/builder-ai/proxy/v1/connections/${CONNECTION}/search`) {
      const query = typeof payload.query === "string" ? payload.query.toLowerCase() : "";
      if (query.trim() === "" || query.length > 200) return [422, { error: "input_refused", field: "query" }];
      const limit = typeof payload.limit === "number" ? Math.min(Math.max(payload.limit, 1), 10) : 10;
      const words = query.split(/[^a-z0-9]+/u).filter((word) => word.length > 2);
      const results = allowed
        .filter((row) => {
          const text = `${row.endpointId} ${row.title} ${row.summary} ${row.platform}`.toLowerCase();
          return words.some((word) => text.includes(word));
        })
        .filter((row) => typeof payload.platform !== "string" || row.platform === payload.platform)
        .slice(0, limit)
        .map((row) => view(row, org));
      return [200, { results, verdict: results.length > 0 ? "match" : "none" }];
    }
    if (path === `/api/builder-ai/proxy/v1/connections/${CONNECTION}/describe`) {
      const row =
        typeof payload.endpointId === "string" && ENDPOINT_ID.test(payload.endpointId)
          ? allowedRow(payload.endpointId)
          : null;
      if (!row) return [404, { error: "endpoint_not_allowed" }];
      const text = triagedText(row);
      return [
        200,
        {
          ...view(row, org),
          summary: text.summary,
          method: row.method,
          params: { query: row.query, body: row.body },
          example: row.body ? { note: "example" } : undefined,
          ...(row.personalData ? { personalData: true } : {}),
        },
      ];
    }
    if (path === `/api/builder-ai/proxy/v1/connections/${CONNECTION}/call`) {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8)
        return [400, { error: "input_refused", reason: "idempotency_key" }];
      const hash = createHash("sha256")
        .update(stable({ org: org.id, payload }))
        .digest("hex");
      const earlier = idempotent.get(`${org.id}\u0000${key}`);
      if (earlier)
        return earlier.hash === hash ? [earlier.status, earlier.body] : [409, { error: "idempotency_conflict" }];
      const [status, answer] = await call(org, payload);
      // Two rows that the fake answers outside the contract, for the app's checks of the answer.
      const lie = record(answer);
      const body =
        status === 200 && lie && payload.endpointId === "lie.org"
          ? { ...lie, orgId: org.id === "org_a" ? "org_b" : "org_a" }
          : status === 200 && lie && payload.endpointId === "lie.charge"
            ? { ...lie, chargedMicros: Number(lie.chargedMicros ?? 0) + org.confirmAboveMicros + 100_000 }
            : answer;
      idempotent.set(`${org.id}\u0000${key}`, { hash, status, body });
      return [status, body];
    }
    return [404, { error: "not_found" }];
  }

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const raw = (await readBody(request)) ?? "";
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    if (down === "drop") {
      requests.push({ method: request.method ?? "", path: url.pathname, headers, body: raw, status: 0 });
      request.socket.destroy();
      return;
    }
    if (down === "hang") {
      requests.push({ method: request.method ?? "", path: url.pathname, headers, body: raw, status: 0 });
      hanging.add(response);
      return;
    }
    let status: number;
    let body: unknown;
    if (typeof down === "number") [status, body] = [down, undefined];
    else
      [status, body] = await route(request, url.pathname, raw).catch((): [number, unknown] => [
        500,
        { error: "internal_error" },
      ]);
    requests.push({ method: request.method ?? "", path: url.pathname, headers, body: raw, status });
    const text = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, {
      ...(text ? { "Content-Type": "application/json" } : {}),
      "Content-Length": String(Buffer.byteLength(text)),
      "Cache-Control": "no-store",
    });
    response.end(text);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("The fake Hub has no port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    treg,
    session,
    orgs,
    requests,
    issuedTokens,
    issuedConfirmations,
    accessRequests,
    setPaused: (paused) => {
      pausedReason = paused ? "paused" : null;
    },
    paused: () => pausedReason !== null,
    setConnectionsUsage: (on) => {
      connectionsUsage = on;
    },
    setDown: (mode) => {
      down = mode;
      if (mode !== "hang") {
        for (const response of hanging) response.destroy();
        hanging.clear();
      }
    },
    setActive: (on) => {
      active = on;
    },
    setRotateOnRenew: (on) => {
      rotateOnRenew = on;
    },
    setTokenDelay: (ms) => {
      tokenDelayMs = ms;
    },
    refusedGrants,
    grants,
    sessionB,
    sessionOf: (person) => ({ ...people[person] }),
    newSession: (person) => {
      people[person].access = `hubat_${hex(20)}`;
      people[person].refresh = `hubrt_${hex(20)}`;
      return { ...people[person] };
    },
    advance: (ms) => {
      offset += ms;
    },
    proxyToken: async (orgId) => issueToken(orgId),
    setPlatforms: (rows) => {
      platformRows = rows;
    },
    platforms: derivedPlatforms,
    setCapabilities: (on) => {
      capabilitiesOn = on;
    },
    decideConfirmation: (id, state) => {
      const held = confirmations.get(id);
      if (held) held.state = state;
    },
    expireConfirmation: (id) => {
      const held = confirmations.get(id);
      if (held) held.expiresAt = now() - 1;
    },
    sayConfirmationState: (id, state) => {
      const held = confirmations.get(id);
      if (held) held.said = state;
    },
    confirmationReads,
    close: async () => {
      for (const response of hanging) response.destroy();
      hanging.clear();
      await new Promise<void>((done) => server.close(() => done()));
      await treg.close();
    },
  };
}

/** A fetch that sends the app's Hub requests to the fake Hub. Any other origin is refused. */
export function fakeHubFetch(hub: FakeHub): typeof fetch {
  const target = new URL(hub.origin);
  const fetcher = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://hub.culturabuilder.com") throw new Error(`The app called ${url.origin}.`);
    url.protocol = target.protocol;
    url.host = target.host;
    return fetch(url, init);
  };
  return Object.assign(fetcher, { preconnect: fetch.preconnect });
}
