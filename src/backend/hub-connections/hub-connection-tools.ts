// Owns `openbot_connections.list` and `openbot_connections.call` in the main process: whether an
// agent has them, the input checks, the payer, the cost approval and the untrusted envelope of every
// result. The tool router calls it after the Guard check of the input, and the Guard reads its result.
//
// The agent never gets a token, a confirmation id or a Hub text outside the envelope. A cost approval
// and a payer choice come only from the person's click on an approval card.

import { createHash, randomUUID } from "node:crypto";
import {
  HUB_CONFIRMATION_REFUSALS,
  HUB_CONNECTIONS_LIMITS,
  HUB_PAGES,
  type HubAccessRequestKind,
  type HubConfirmationState,
  type HubConnectionEntry,
  type HubErrorAnswer,
  type HubNeedsPersonAnswer,
  type HubSessionConnections,
  isHubEndpointId,
  isHubPlainText,
  TOOL_CATALOG_CONNECTION_ID,
  type ToolCatalogCallAnswer,
  type ToolCatalogCallOutcome,
  type ToolCatalogCallRequest,
  type ToolCatalogDescribeAnswer,
  toolCatalogSearchRequest,
} from "@openbot/contracts/hub-connections";
import type {
  HubAccessRequestFailure,
  HubConnectionAccessRequestResult,
  HubConnectionChatEvent,
  HubConnectionOrgUsage,
  HubConnectionsView,
  HubConnectionUsageView,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect, Option, Result } from "effect";
import { z } from "zod";
import { CULTURA_BUILDER_HUB } from "../cultura-builder-auth";
import type { DynamicToolResult } from "../protocol";
import { type HubConnectionClient, HubConnectionFailure, type HubOperationOutcome } from "./hub-connection-client";
import { checkCallInput, type InputRefusal, readCallInput, valueRule } from "./hub-connection-input";
import { canPay, choosePayer, type PayerDecision, PERSONAL_ORG } from "./hub-connection-payer";
import { callConnectionToolSchema, HUB_CONNECTION_GUIDANCE } from "./hub-connection-tool-definitions";
import { connectionsView, failureStatus, orgUsageView, usageOrgs } from "./hub-connection-views";
import { maskedResultJson, maskedResultText, maskResultValue } from "./result-mask";
import { CONNECTION_ORIGINS, type HubTurnOrigin } from "./turn-origin";
import { hasVendorPhrase } from "./vendor-lines";

export { type HubDeliveryOrigin, type HubTurnOrigin, hubTurnOrigin } from "./turn-origin";

const NO_CONNECTIONS: readonly string[] = [];

/** The `input` object of a call, as the tool schema parsed it. Each operation reads its own fields. */
type ToolInput = z.infer<typeof callConnectionToolSchema>["input"];

export interface HubConnectionContext {
  readonly agentId: string;
  /** The agent's public thread id: the conversation in which the person answers a card. */
  readonly threadId: string;
  readonly turnId: string;
  readonly origin: HubTurnOrigin;
}

/** The person's answer on an approval card. `cancel`: the turn ended, and nobody waits. */
export type HubConnectionAnswer = "accept" | "decline" | "cancel";

/** Shows one approval card with this reason and waits for the person. Only the owner may answer. */
export type HubConnectionAsk = (reason: string) => Effect.Effect<HubConnectionAnswer>;

/** The Guard check of what a call sends out. `result` answers the agent; null means nobody waits. */
export type HubConnectionGuard = () => Effect.Effect<
  { readonly proceed: true } | { readonly proceed: false; readonly result: DynamicToolResult | null }
>;

/**
 * Adds a cost line to the chat of the call: what a call cost and who paid, the first call over 80 %
 * of the cap, or a call that the cap stopped. Only for the person's own turns and routines: a turn that
 * another agent started gets no amounts.
 */
export type HubConnectionNotify = (event: HubConnectionChatEvent) => void;

/** What the router gives each call: the approval card and the Guard, both of the router's own path. */
export interface HubConnectionHooks {
  readonly ask: HubConnectionAsk;
  readonly guard: HubConnectionGuard;
  readonly notify?: HubConnectionNotify | undefined;
  /** Aborts when the turn ends: a wait for the person's approval on the Hub stops, and nothing is sent. */
  readonly signal?: AbortSignal | undefined;
}

export interface HubConnectionToolsOptions {
  readonly client: HubConnectionClient;
  /** False when the person turned paid connections off on this computer. */
  readonly enabledOnComputer?: () => boolean;
  /** The connections that the agent's own setting turns off. */
  readonly agentConnectionsOff?: (agentId: string) => readonly string[];
  /**
   * Opens a page of the Hub in the person's browser: main's `shell.openExternal`. Only the URLs that
   * `isHubPageUrl` accepts reach it. Absent: no page opens, so no cost can be approved.
   */
  readonly openHub?: ((url: string) => Promise<void>) | undefined;
  readonly now?: () => number;
}

/** Whether the connections are open to a turn, or why not. */
type ConnectionAccess =
  | { readonly kind: "open"; readonly connections: readonly string[] }
  | { readonly kind: "closed"; readonly failure: HubConnectionFailure["code"] | "origin" | "computer" };

const logger = createBuildersBotLogger("hub-connections");

/** The most calls of one connection in one turn, and of all agents of this computer in one hour. */
export const HUB_CALL_LIMITS = { perTurn: 20, lookupsPerTurn: 40, perHour: 200, page: 30_000 } as const;
/** How long tool discovery waits for `/session` before it answers without the connection tools. */
export const DISCOVERY_WAIT_MS = 750;
/** A confirmation id is good for 5 minutes at most, whatever the Hub says. */
const CONFIRMATION_MS = 5 * 60_000;
/** How often the app reads the state of a cost approval while the person decides on the Hub page. */
const CONFIRMATION_POLL_MS = 2_000;
/** The pages of the Hub that the app may open: the connections page, and the page of one cost approval. */
const HUB_PAGE_PATH = /^\/builder-ai\/conexoes(?:\/aprovar\/[A-Za-z0-9_-]{16,128})?$/u;
const DESCRIBE_CACHE_MS = 5 * 60_000;
const TURN_LIMIT = 64;
/** The most conversations whose people-data approval is kept; the oldest goes first. */
const PEOPLE_DATA_THREADS = 256;
/** The most characters of the input values that the people-data card shows. */
const PEOPLE_DATA_SUBJECTS = 300;
/** The person's use is read again at most this often (the PROXY design, §13.5). */
const USAGE_CACHE_MS = 30_000;
/** The most organizations whose use one read asks the Hub for. */
const USAGE_ORGS = 10;

/**
 * Whether a URL is a page of the Hub that the app may open in the browser: the Hub origin over https,
 * the connections page or the page of one cost approval, with no user, query or fragment. Main checks
 * it again before `shell.openExternal`.
 */
export function isHubPageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.origin === CULTURA_BUILDER_HUB &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    HUB_PAGE_PATH.test(url.pathname)
  );
}

/** An email address in a result. */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/u;
/**
 * A phone number in a result: a leading `+` and 8 to 15 digits, or digits with separators that a
 * phone number has (`(11) 98765-4321`, `415-555-0132`), or any value of a field named for a phone. A
 * plain run of digits, such as a timestamp or a count, is not one.
 */
const PHONE =
  /(?:^|[^\w+])\+\d(?:[\s.()-]{0,2}\d){7,14}\b|\(\d{2,4}\)\s{0,2}\d{3,5}[\s.-]\d{4}\b|\b\d{3}[.-]\d{3,4}[.-]\d{4}\b|"(?:phone|phones|phone_number|phoneNumber|mobile|telefone|celular|whatsapp|tel)"\s{0,4}:\s{0,4}"[^"]{4,}"/iu;

/**
 * The note on a result that holds an email or a phone number (the treg design, §4.6 G9). It is the
 * app's own text, outside the envelope: found contacts are often guessed by the provider.
 */
export const CONTACT_DATA_NOTE =
  "Unverified contact data: this result holds emails or phone numbers that a provider found or guessed. They are not facts. Do not send a message, an email or an invitation to any of them unless the person asks for that address.";

/** Whether a result text holds an email or a phone number. */
export function holdsContactData(text: string): boolean {
  return EMAIL.test(text) || PHONE.test(text);
}

/** Every string value of a call input, for the people-data card: the names and the addresses that it asks about. */
function inputSubjects(input: { readonly query?: unknown; readonly body?: unknown }): string {
  const values: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || values.length > 64) return;
    if (typeof value === "string") values.push(value.trim());
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (value !== null && typeof value === "object")
      for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(input.query, 0);
  walk(input.body, 0);
  const text = values.filter(Boolean).join(", ").replace(/[<>]/gu, " ");
  return text.length > PEOPLE_DATA_SUBJECTS ? `${text.slice(0, PEOPLE_DATA_SUBJECTS)}…` : text;
}

interface TurnState {
  readonly calls: Map<string, number>;
  readonly lookups: Map<string, number>;
  /** The limit lines that this turn already added, by connection and organization: one each. */
  readonly limits: Set<string>;
  /** Full result text of each call of the turn, by input hash, for `offset` and a repeated call. */
  readonly results: Map<string, StoredResult>;
}

const ENDPOINT_ATTR = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

/** The JSON of a value, with `<` and `>` escaped, so no text inside can close or open a tag. */
function escapedJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
}

/** Text from outside, as the agent reads it: a data block that says it is untrusted. */
export function connectionEnvelope(attributes: Record<string, string>, body: string): string {
  const attrs = Object.entries(attributes)
    .filter(([, value]) => ENDPOINT_ATTR.test(value))
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  return `<connection_output untrusted="true"${attrs}>\n${body}\n</connection_output>`;
}

/** Amounts for the person, cut down to cents as the Hub contract says. */
export function formatConnectionMoney(micros: number, currency: string): string {
  const cents = Math.floor(micros / 10_000);
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
  if (micros > 0 && cents === 0) return `< ${formatter.format(0.01)}`;
  return formatter.format(cents / 100);
}

/** A field of a tool result: JSON that the app writes. An `undefined` field is left out. */
type ResultValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ResultValue[]
  | { readonly [key: string]: ResultValue };
type ResultFields = { readonly [key: string]: ResultValue };

/** A call result kept for the turn: the app's fields, the envelope attributes and the content text. */
interface StoredResult {
  readonly header: ResultFields;
  readonly attributes: { readonly endpoint: string; readonly served_by: string };
  readonly text: string;
}

function result(value: ResultFields, envelope?: string): DynamicToolResult {
  return {
    success: true,
    contentItems: [
      { type: "inputText", text: envelope ? `${JSON.stringify(value)}\n${envelope}` : JSON.stringify(value) },
    ],
  };
}

function refusal(value: ResultFields, envelope?: string): DynamicToolResult {
  return { ...result(value, envelope), success: false };
}

const INPUT_RULE_TEXT: Record<InputRefusal["rule"], string> = {
  too_large: "The input is larger than 16 KB.",
  too_deep: "The input is nested deeper than 8 levels.",
  not_an_object: "The input must be a JSON object.",
  unknown_field: "The endpoint does not declare this field. Use only the fields that describe gives.",
  missing_field: "The endpoint needs this field.",
  wrong_type: "This field has the wrong type.",
  not_in_enum: "This field must be one of the values that describe gives.",
  too_long: "This field is longer than the endpoint allows.",
  out_of_range: "This number is outside the range that the endpoint allows.",
  too_many_items: "This list has more items than the endpoint allows.",
  credential_name: "A connection never takes a key, token, password, cookie, session or header field.",
  credential_value: "This value looks like a key or a credential. Connections never take one.",
  cookie_value: "This value looks like a cookie. Cookies and sessions never go to a connection.",
  token_value: "This value looks like a session token. Tokens never go to a connection.",
  url_refused:
    "This URL is refused: only public http or https addresses on the default port, with no user, password or signature.",
  bad_endpoint: "endpointId must be an id that search or describe gave.",
};

const FAILURE_TEXT: Record<HubConnectionFailure["code"], string> = {
  signed_out:
    "Cultura Builder is not signed in on this computer, so connections are not available. Tell the person to sign in with Cultura Builder in Builders Bot.",
  offline: "The Cultura Builder Hub did not answer. Connections are not available now. Do not retry in this turn.",
  hub_unavailable: "The Cultura Builder Hub is not available now. Do not retry in this turn.",
  unauthorized: "Cultura Builder refused the access of this computer. Do not retry in this turn; tell the person.",
  token_refused: "Cultura Builder refused this connection for the organization. Tell the person.",
  disabled: "Cultura Builder turned this connection off. Do not use it.",
};

const ERROR_TEXT: Record<HubErrorAnswer["error"], string> = {
  upstream_unavailable: "The tool catalog is not available now. Do not use this connection again in this turn.",
  connection_unavailable: "Cultura Builder paused this connection. Do not use it again in this turn.",
  cost_above_limit: "The cost of this call is above the limit. Ask for fewer rows or targets.",
  rate_limited: "Too many calls now. Wait for retryAfterSeconds before another call.",
  not_allowed: "The organization does not allow this for the person. Tell the person where to ask for access.",
  endpoint_not_allowed: "This endpoint is not allowed. Search for another one.",
  input_refused: "Cultura Builder refused the input. Correct the field that it names.",
  internal_error: "The tool catalog failed. Do not retry in this turn.",
  provider_unavailable: "The provider is not available now. You may use one of the alternatives, if any.",
  provider_rejected_request: "The provider refused the input. Correct the input; do not try another provider.",
  provider_failed: "The provider failed. You may try one other allowed endpoint.",
  no_result: "The call found no result. Do not repeat the same call.",
  result_too_large: "The result is too large. Ask for fewer rows.",
  idempotency_in_progress: "The call still runs at Cultura Builder. Wait for retryAfterSeconds.",
  idempotency_conflict: "Cultura Builder refused a repeated call with another input.",
  result_expired: "The result of this call is no longer kept. Call again only if the person agrees to pay again.",
  unauthorized: "Cultura Builder refused the access of this computer. Do not retry in this turn; tell the person.",
};

const NEEDS_PERSON_TEXT: Record<HubNeedsPersonAnswer["needsPerson"], string> = {
  cap_reached: "The person reached the monthly limit of this connection. Stop calling it and tell the person.",
  org_budget_reached:
    "The organization's budget for this connection is spent for this month. Stop calling it and tell the person.",
  confirm_cost: "This call costs more than the amount that runs without approval.",
  choose_org: "The person must choose which organization pays for this connection.",
  not_allowed: "The person may not use this connection now. Tell the person where to ask for access.",
};

export class HubConnectionTools {
  readonly #client: HubConnectionClient;
  readonly #enabledOnComputer: () => boolean;
  readonly #agentConnectionsOff: (agentId: string) => readonly string[];
  readonly #openHub: ((url: string) => Promise<void>) | null;
  readonly #now: () => number;
  readonly #turns = new Map<string, TurnState>();
  readonly #hourly: number[] = [];
  readonly #described = new Map<string, { readonly answer: ToolCatalogDescribeAnswer; readonly until: number }>();
  /** The organization that the person chose for each connection, on a card or in a setting. */
  readonly #chosen = new Map<string, string>();
  /** The organization that paid the last call of each connection. */
  readonly #lastPaid = new Map<string, string>();
  /** The conversations in which the person allowed calls about people (G3), by agent and public thread. */
  readonly #peopleDataThreads = new Set<string>();
  /** The person's own use, by organization, for at most 30 seconds. Memory only. */
  readonly #usage = new Map<string, { readonly value: HubConnectionOrgUsage; readonly until: number }>();

  constructor(options: HubConnectionToolsOptions) {
    this.#client = options.client;
    this.#enabledOnComputer = options.enabledOnComputer ?? (() => true);
    this.#agentConnectionsOff = options.agentConnectionsOff ?? (() => []);
    this.#openHub = options.openHub ?? null;
    this.#now = options.now ?? Date.now;
  }

  /** Every connection id that this sign-in may have: the tool catalog and those of the last `/session`. */
  knownConnectionIds(): string[] {
    return [...new Set([TOOL_CATALOG_CONNECTION_ID, ...this.#client.knownConnectionIds()])];
  }

  /** Sets the payer of a connection. The person does this; the agent has no path to it. */
  choosePayer(connectionId: string, orgId: string | null): void {
    if (orgId === null) this.#chosen.delete(connectionId);
    else this.#chosen.set(connectionId, orgId);
  }

  /**
   * Forgets every token, cache, payer, approval and use of the session's person: at a sign-out and at
   * a sign-in, which can be another person's.
   */
  forget(): void {
    this.#client.forget();
    this.#forgetPerson();
  }

  #forgetPerson(): void {
    this.#described.clear();
    this.#chosen.clear();
    this.#lastPaid.clear();
    this.#peopleDataThreads.clear();
    this.#usage.clear();
    this.#turns.clear();
  }

  /**
   * Forgets the person's state when no session is stored, also when the sign-out did not go through
   * this app's sign-out: the next session can be another person's.
   */
  #signedIn(): boolean {
    if (this.#client.signedIn()) return true;
    this.#forgetPerson();
    return false;
  }

  /**
   * The connections for the Marketplace page: the catalog, the states and caps, and who pays the next
   * call. `fresh` reads `/session` and the catalog again. A failure is a status, never an error.
   */
  readonly view = Effect.fn("HubConnectionTools.view")(function* (this: HubConnectionTools, fresh: boolean) {
    const empty = (status: HubConnectionsView["status"]): HubConnectionsView => ({
      status,
      connections: [],
      readAt: null,
    });
    if (!this.#signedIn()) return empty("signed_out");
    const capabilities = yield* Effect.result(this.#client.capabilities(fresh));
    if (Result.isFailure(capabilities)) return empty(failureStatus(capabilities.failure.code));
    // `active` says whether the account may use the LLM, not the connections (contract §3): only the
    // capability of each connection opens it.
    const session = capabilities.success;
    // No capability at all: the organization has no connection on for the account, so the page shows
    // none and the catalog is not read. A connection that the Hub paused still has its entry.
    if (Object.keys(session.connections).length === 0) return empty("off");
    const catalog = yield* Effect.result(this.#client.catalog(fresh));
    if (Result.isFailure(catalog)) return empty(failureStatus(catalog.failure.code));
    return connectionsView(
      catalog.success,
      (id) => session.connections[id],
      (id) => this.#anchor(id),
      new Date(this.#now()).toISOString(),
    );
  }).bind(this);

  /**
   * The person's own use of the connections in this period, for each organization whose rows this app
   * may spend. Off until `/session` says `connectionsUsage`. Each organization is read at most once in
   * 30 seconds.
   */
  readonly usage = Effect.fn("HubConnectionTools.usage")(function* (this: HubConnectionTools) {
    const empty = (status: HubConnectionUsageView["status"]): HubConnectionUsageView => ({ status, orgs: [] });
    if (!this.#signedIn()) return empty("signed_out");
    const capabilities = yield* Effect.result(this.#client.capabilities());
    if (Result.isFailure(capabilities)) return empty(failureStatus(capabilities.failure.code));
    if (!capabilities.success.connectionsUsage) return empty("off");
    const catalog = yield* Effect.result(this.#client.catalog());
    if (Result.isFailure(catalog)) return empty(failureStatus(catalog.failure.code));
    const orgs: HubConnectionOrgUsage[] = [];
    let failed: HubConnectionsView["status"] | null = null;
    for (const orgId of usageOrgs(catalog.success).slice(0, USAGE_ORGS)) {
      const cached = this.#usage.get(orgId);
      if (cached && cached.until > this.#now()) {
        orgs.push(cached.value);
        continue;
      }
      const outcome = yield* Effect.result(this.#client.usage(orgId));
      if (Result.isFailure(outcome)) {
        failed = failureStatus(outcome.failure.code);
        continue;
      }
      if (outcome.success.kind !== "answer") continue;
      const value = orgUsageView(outcome.success.answer, catalog.success);
      this.#usage.set(orgId, { value, until: this.#now() + USAGE_CACHE_MS });
      orgs.push(value);
    }
    return orgs.length === 0 && failed ? empty(failed) : { status: "ready" as const, orgs };
  }).bind(this);

  /**
   * The person chose the payer of a connection on its page. Only an organization that can pay is kept;
   * any other value changes nothing. The agent has no path to this.
   */
  readonly choosePayerFor = Effect.fn("HubConnectionTools.choosePayerFor")(function* (
    this: HubConnectionTools,
    connectionId: string,
    orgId: string,
  ) {
    const catalog = yield* Effect.result(this.#client.catalog());
    if (Result.isSuccess(catalog)) {
      const entry = catalog.success.connections.find((candidate) => candidate.id === connectionId);
      if (entry?.access.some((row) => row.orgId === orgId && canPay(row))) this.#chosen.set(connectionId, orgId);
    }
    return yield* this.view(false);
  }).bind(this);

  /**
   * Opens the connections page of the Hub in the person's browser, where the person allows this app to
   * spend an organization's connections. One fixed URL: the renderer sends none.
   */
  readonly openConsent = Effect.fn("HubConnectionTools.openConsent")(function* (this: HubConnectionTools) {
    yield* this.#openPage(`${CULTURA_BUILDER_HUB}${HUB_PAGES.connections}`);
  }).bind(this);

  /** Opens a Hub page in the browser. False when no opener is set, the URL is not a Hub page, or it failed. */
  readonly #openPage = Effect.fn("HubConnectionTools.openPage")(function* (this: HubConnectionTools, url: string) {
    const open = this.#openHub;
    if (!open || !isHubPageUrl(url)) return false;
    const opened = yield* Effect.result(Effect.tryPromise(() => open(url)));
    if (Result.isFailure(opened)) logger.warn("The Hub page did not open in the browser.");
    return Result.isSuccess(opened);
  });

  /**
   * The person asks the admins of an organization for access to a connection, or for more money in
   * this period. The Hub keeps one request per 7 days and tells the admins.
   */
  readonly requestAccess = Effect.fn("HubConnectionTools.requestAccess")(function* (
    this: HubConnectionTools,
    connectionId: string,
    orgId: string,
    kind: HubAccessRequestKind,
  ) {
    const failed = (failure: HubAccessRequestFailure): HubConnectionAccessRequestResult => ({
      status: "failed",
      requestedAt: null,
      failure,
    });
    if (!this.#signedIn()) return failed("signed_out");
    const catalog = yield* Effect.result(this.#client.catalog());
    if (Result.isFailure(catalog)) return failed(requestFailure(catalog.failure));
    const entry = catalog.success.connections.find((candidate) => candidate.id === connectionId);
    // Only an organization of the person's catalog row, never the personal plan: it has no admins.
    if (orgId === PERSONAL_ORG || !entry?.access.some((row) => row.orgId === orgId)) return failed("unknown_org");
    const outcome = yield* Effect.result(this.#client.requestAccess(orgId, connectionId, kind));
    if (Result.isFailure(outcome)) return failed(requestFailure(outcome.failure));
    const answer = outcome.success;
    if (answer.kind === "needs-person") return failed("not_allowed");
    if (answer.kind === "error")
      return failed(
        answer.error === "rate_limited"
          ? "rate_limited"
          : answer.error === "not_allowed" || answer.error === "unauthorized"
            ? "not_allowed"
            : "hub_unavailable",
      );
    // The catalog row carries the request date: the next read shows "Request sent".
    this.#client.forgetCatalog();
    return {
      status: answer.answer.repeated ? "already_sent" : "sent",
      requestedAt: answer.answer.requestedAt,
      failure: null,
    } satisfies HubConnectionAccessRequestResult;
  }).bind(this);

  /**
   * The connections that an agent has in this turn, or none. The kill switch of the Hub, a sign-out,
   * the setting of this computer, the agent's own setting and the origin of the turn all remove them.
   * Any failure removes them too: the tools fail closed.
   */
  readonly enabledConnections = Effect.fn("HubConnectionTools.enabledConnections")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
  ) {
    const access = yield* this.#access(context);
    return access.kind === "open" ? access.connections : NO_CONNECTIONS;
  }).bind(this);

  /**
   * The connections of the turn, or why there are none. A Hub that does not answer, or that answers
   * outside the contract, gives a failure: the tools fail closed and say why.
   */
  readonly #access = Effect.fn("HubConnectionTools.access")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    /** Tool discovery waits at most `DISCOVERY_WAIT_MS` for `/session`; past it, closed. */
    quick = false,
  ): Effect.fn.Return<ConnectionAccess> {
    if (!CONNECTION_ORIGINS.has(context.origin)) return { kind: "closed", failure: "origin" };
    if (!this.#enabledOnComputer()) return { kind: "closed", failure: "computer" };
    if (!this.#signedIn()) return { kind: "closed", failure: "signed_out" };
    const read = Effect.result(this.#client.capabilities());
    // The read that the timeout leaves goes on in the client, which keeps its answer for the next turn.
    const capabilities = quick
      ? Option.getOrElse(yield* read.pipe(Effect.timeoutOption(DISCOVERY_WAIT_MS)), () =>
          Result.fail(new HubConnectionFailure({ code: "offline" })),
        )
      : yield* read;
    if (Result.isFailure(capabilities)) return { kind: "closed", failure: capabilities.failure.code };
    // Each connection's own capability is its kill switch; `active` is about the LLM (contract §3).
    const session: HubSessionConnections = capabilities.success;
    const off = new Set(this.#agentConnectionsOff(context.agentId));
    const connections = Object.entries(session.connections)
      .filter(([id, capability]) => capability.enabled && !off.has(id))
      .map(([id]) => id);
    return connections.length > 0 ? { kind: "open", connections } : { kind: "closed", failure: "disabled" };
  });

  /**
   * Whether the agent has the tools in this turn, for tool discovery: every `tool_search` of every
   * agent reads it, so a Hub that does not answer holds it at most `DISCOVERY_WAIT_MS`, and the tools
   * stay out until the Hub answers.
   */
  readonly available = Effect.fn("HubConnectionTools.available")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
  ) {
    return (yield* this.#access(context, true)).kind === "open";
  }).bind(this);

  /** Runs one tool call. Null when the turn ended while the person had a card. */
  readonly handle = Effect.fn("HubConnectionTools.handle")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    tool: string,
    args: unknown,
    hooks: HubConnectionHooks,
  ) {
    const access = yield* this.#access(context);
    if (access.kind === "closed")
      return refusal({
        error: access.failure === "origin" || access.failure === "computer" ? "unavailable" : access.failure,
        message:
          access.failure === "origin"
            ? "Connections are not available in this conversation: only the person at this computer and the person's routines can use them."
            : access.failure === "computer"
              ? "The person turned paid connections off on this computer."
              : FAILURE_TEXT[access.failure],
      });
    const enabled = access.connections;
    if (tool === "list") return yield* this.#list(context, enabled);
    if (tool !== "call") return refusal({ error: "unknown_tool", message: "openbot_connections has list and call." });
    const parsed = callConnectionToolSchema.safeParse(args);
    if (!parsed.success)
      return refusal({
        error: "invalid_arguments",
        message: `${z.prettifyError(parsed.error)}\nCorrect the arguments.`,
      });
    const { connection, operation, input, offset } = parsed.data;
    if (!enabled.includes(connection) || connection !== TOOL_CATALOG_CONNECTION_ID)
      return refusal({ error: "unavailable", connection, message: FAILURE_TEXT.disabled });
    const state = this.#turn(context.turnId);
    const counter = operation === "call" ? state.calls : state.lookups;
    const limit = operation === "call" ? HUB_CALL_LIMITS.perTurn : HUB_CALL_LIMITS.lookupsPerTurn;
    if ((counter.get(connection) ?? 0) >= limit)
      return refusal({
        error: "turn_limit",
        connection,
        message: `This turn reached ${limit} ${operation === "call" ? "calls" : "lookups"} of ${connection}. Stop and tell the person.`,
      });
    if (operation === "call" && !this.#hourlyRoom())
      return refusal({
        error: "hour_limit",
        connection,
        message: `The agents of this computer made ${HUB_CALL_LIMITS.perHour} paid calls in the last hour. Stop and tell the person.`,
      });
    const payer = yield* this.#payer(context, connection, hooks.ask);
    if (payer.kind === "stop") return payer.result;
    counter.set(connection, (counter.get(connection) ?? 0) + 1);
    switch (operation) {
      case "search":
        return yield* this.#search(context, payer.orgId, input, hooks);
      case "describe":
        return yield* this.#describeTool(context, payer.orgId, input, hooks);
      case "call":
        return yield* this.#call(context, payer.orgId, payer.name, input, offset ?? 0, hooks);
    }
  }).bind(this);

  #turn(turnId: string): TurnState {
    let state = this.#turns.get(turnId);
    if (!state) {
      state = { calls: new Map(), lookups: new Map(), limits: new Set(), results: new Map() };
      this.#turns.set(turnId, state);
      while (this.#turns.size > TURN_LIMIT) {
        const oldest = this.#turns.keys().next().value;
        if (oldest === undefined) break;
        this.#turns.delete(oldest);
      }
    }
    return state;
  }

  #hourlyRoom(): boolean {
    const since = this.#now() - 3_600_000;
    while (this.#hourly.length > 0 && (this.#hourly[0] ?? 0) < since) this.#hourly.shift();
    return this.#hourly.length < HUB_CALL_LIMITS.perHour;
  }

  readonly #list = Effect.fn("HubConnectionTools.list")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    enabled: readonly string[],
  ) {
    const catalog = yield* Effect.result(this.#client.catalog());
    if (Result.isFailure(catalog))
      return refusal({ error: catalog.failure.code, message: FAILURE_TEXT[catalog.failure.code] });
    const amounts = context.origin !== "agent";
    const rows: ResultFields[] = [];
    const names: { [id: string]: ResultFields } = {};
    for (const id of enabled) {
      const entry = catalog.success.connections.find((candidate) => candidate.id === id);
      if (!entry) {
        rows.push({ id, state: "unavailable", reason: "not_in_catalog" });
        continue;
      }
      const decision = choosePayer(entry, catalog.success.orgs, this.#anchor(id));
      const operations = entry.operations.filter((operation) => operation.effect === "read").map((op) => op.id);
      names[id] = { name: entry.name, tagline: entry.tagline };
      if (decision.kind === "pay") {
        const access = decision.access;
        rows.push({
          id,
          operations,
          state: access.state,
          ...(amounts
            ? {
                currency: access.currency,
                availableMicros: access.availableMicros,
                effectiveAvailableMicros: access.effectiveAvailableMicros,
                maxCostPerCallMicros: access.maxCostPerCallMicros,
                confirmAboveMicros: access.confirmAboveMicros,
                resetsAt: access.resetsAt,
              }
            : {}),
        });
        // A turn that another agent started gets no payer, as it gets no amounts.
        if (amounts) names[id] = { name: entry.name, tagline: entry.tagline, paidBy: payerName(decision) };
      } else if (decision.kind === "choose_org") {
        rows.push({ id, operations, state: "choose_org" });
      } else {
        rows.push({ id, operations, state: "unavailable", reason: unavailableReason(entry) });
      }
    }
    return result(
      { connections: rows, guidance: HUB_CONNECTION_GUIDANCE },
      connectionEnvelope({ connection: "hub" }, escapedJson(maskResultValue(names))),
    );
  });

  #anchor(connectionId: string): string | null {
    return this.#chosen.get(connectionId) ?? this.#lastPaid.get(connectionId) ?? null;
  }

  /**
   * The organization that pays this call. When the person must choose, an approval card asks about
   * each organization in turn, at most three; a routine or a delegated turn cannot ask, so it stops.
   */
  readonly #payer = Effect.fn("HubConnectionTools.payer")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    connectionId: string,
    ask: HubConnectionAsk,
  ) {
    type Payer =
      | { readonly kind: "pay"; readonly orgId: string; readonly name: string }
      | { readonly kind: "stop"; readonly result: DynamicToolResult | null };
    const catalog = yield* Effect.result(this.#client.catalog());
    if (Result.isFailure(catalog))
      return {
        kind: "stop",
        result: refusal({ error: catalog.failure.code, message: FAILURE_TEXT[catalog.failure.code] }),
      } satisfies Payer;
    const entry = catalog.success.connections.find((candidate) => candidate.id === connectionId);
    if (!entry)
      return {
        kind: "stop",
        result: refusal({ error: "unavailable", message: FAILURE_TEXT.disabled }),
      } satisfies Payer;
    const decision: PayerDecision = choosePayer(entry, catalog.success.orgs, this.#anchor(connectionId));
    if (decision.kind === "pay")
      return { kind: "pay", orgId: decision.access.orgId, name: payerName(decision) } satisfies Payer;
    if (decision.kind === "none")
      return {
        kind: "stop",
        result: refusal({
          needsPerson: "not_allowed",
          reason: unavailableReason(entry),
          message: NEEDS_PERSON_TEXT.not_allowed,
        }),
      } satisfies Payer;
    const choices = decision.candidates.map((candidate) => ({
      orgId: candidate.access.orgId,
      name: candidate.name,
    }));
    // A turn that another agent started gets no organization names, as it gets no amounts.
    const stopChoose = (extra: string) =>
      ({
        kind: "stop",
        result: refusal(
          {
            needsPerson: "choose_org",
            reason: decision.reason,
            message: `${NEEDS_PERSON_TEXT.choose_org} ${extra}`,
          },
          context.origin === "agent"
            ? undefined
            : connectionEnvelope(
                { connection: connectionId },
                escapedJson(maskResultValue({ organizations: choices.map((c) => c.name) })),
              ),
        ),
      }) satisfies Payer;
    if (context.origin !== "owner_ui")
      return stopChoose(
        "Nobody can choose in a routine run or in a turn that another agent started. The call did not run. Report it.",
      );
    const connectionName = entry.name;
    for (const choice of choices.slice(0, 3)) {
      const answer = yield* ask(
        choice.orgId === PERSONAL_ORG
          ? sourceText("status.agent.connectionChoosePayerPersonal", { connection: connectionName })
          : sourceText("status.agent.connectionChoosePayer", { connection: connectionName, org: choice.name }),
      );
      if (answer === "cancel") return { kind: "stop", result: null } satisfies Payer;
      if (answer === "accept") {
        this.#chosen.set(connectionId, choice.orgId);
        return { kind: "pay", orgId: choice.orgId, name: choice.name } satisfies Payer;
      }
    }
    return stopChoose("The person chose none. The call did not run. Do not call this connection again in this turn.");
  });

  readonly #search = Effect.fn("HubConnectionTools.search")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    orgId: string,
    input: ToolInput,
    hooks: HubConnectionHooks,
  ) {
    const body = toolCatalogSearchRequest({ query: input.query, platform: input.platform, limit: input.limit });
    const extra = Object.keys(input).filter((name) => name !== "query" && name !== "platform" && name !== "limit");
    if (!body || extra.length > 0)
      return refusal({
        error: "input_refused",
        message:
          "search takes {query (1 to 200 characters of plain text), platform?, limit? (1 to 10)} and nothing else.",
      });
    // The same lock as a call: no key, cookie, session or token leaves in a search text, also with the Guard off.
    const refused = valueRule(body.query);
    if (refused)
      return refusal({
        error: "input_refused",
        rule: refused,
        message: `${INPUT_RULE_TEXT[refused]} Nothing was sent.`,
      });
    const before = yield* hooks.guard();
    if (!before.proceed) return before.result;
    const outcome = yield* Effect.result(this.#client.search(orgId, body));
    const answer = this.#operationAnswer(outcome, orgId, context.origin !== "agent");
    if (answer.kind !== "answer") return answer.result;
    const results = answer.answer.results.filter((entry) => !hasVendorPhrase(entry.title));
    return result(
      {
        connection: TOOL_CATALOG_CONNECTION_ID,
        operation: "search",
        verdict: results.length > 0 ? answer.answer.verdict : "none",
        count: results.length,
      },
      connectionEnvelope({ connection: TOOL_CATALOG_CONNECTION_ID }, escapedJson(maskResultValue({ results }))),
    );
  });

  readonly #describeTool = Effect.fn("HubConnectionTools.describeTool")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    orgId: string,
    input: ToolInput,
    hooks: HubConnectionHooks,
  ) {
    const extra = Object.keys(input).filter((name) => name !== "endpointId");
    const endpointId = input.endpointId;
    if (extra.length > 0 || !isHubEndpointId(endpointId))
      return refusal({ error: "input_refused", message: "describe takes {endpointId} and nothing else." });
    const before = yield* hooks.guard();
    if (!before.proceed) return before.result;
    const described = yield* this.#describe(orgId, endpointId, context.origin !== "agent");
    if (described.kind !== "answer") return described.result;
    const answer = described.answer;
    return result(
      { connection: TOOL_CATALOG_CONNECTION_ID, operation: "describe", endpointId: answer.endpointId },
      connectionEnvelope(
        { connection: TOOL_CATALOG_CONNECTION_ID, endpoint: answer.endpointId },
        // Each mirrored text is read decoded, so a vendor line split by a line break is found too.
        escapedJson(
          maskResultValue({
            title: answer.title,
            summary: answer.summary,
            method: answer.method,
            query: answer.query,
            body: answer.body,
            priceKind: answer.priceKind,
            unitPriceMicros: answer.unitPriceMicros,
            currency: answer.currency,
            maxUnits: answer.maxUnits,
            maxCostMicros: answer.maxCostMicros,
            example: answer.example,
          }),
        ),
      ),
    );
  });

  /** A description from the cache of 5 minutes, or from the Hub. Vendor lines are refused. */
  readonly #describe = Effect.fn("HubConnectionTools.describe")(function* (
    this: HubConnectionTools,
    orgId: string,
    endpointId: string,
    amounts: boolean,
  ) {
    const key = `${orgId}\u0000${endpointId}`;
    const cached = this.#described.get(key);
    if (cached && cached.until > this.#now()) return { kind: "answer" as const, answer: cached.answer };
    const outcome = yield* Effect.result(this.#client.describe(orgId, endpointId));
    const answer = this.#operationAnswer(outcome, orgId, amounts);
    if (answer.kind !== "answer") return answer;
    if (hasVendorPhrase(answer.answer.title))
      return {
        kind: "stop" as const,
        result: refusal({ error: "endpoint_not_allowed", message: ERROR_TEXT.endpoint_not_allowed }),
      };
    this.#described.set(key, { answer: answer.answer, until: this.#now() + DESCRIBE_CACHE_MS });
    return { kind: "answer" as const, answer: answer.answer };
  });

  /** `amounts`: whether the turn may read amounts (not a turn that another agent started). */
  #operationAnswer<Answer>(
    outcome: Result.Result<HubOperationOutcome<Answer>, HubConnectionFailure>,
    orgId: string,
    amounts: boolean,
  ): { kind: "answer"; answer: Answer } | { kind: "stop"; result: DynamicToolResult } {
    if (Result.isFailure(outcome)) return { kind: "stop", result: this.#failureResult(outcome.failure) };
    const value = outcome.success;
    if (value.kind === "answer") return { kind: "answer", answer: value.answer };
    if (value.kind === "needs-person") return { kind: "stop", result: this.#needsPersonResult(value, orgId, amounts) };
    return { kind: "stop", result: this.#errorResult(value, amounts) };
  }

  #failureResult(failure: HubConnectionFailure): DynamicToolResult {
    if (failure.code === "unauthorized" || failure.code === "token_refused") this.#client.forgetCatalog();
    if (failure.code === "token_refused" && failure.tokenError === "connections_disabled")
      this.#client.forgetCapabilities();
    if (failure.code === "token_refused" && failure.tokenError === "consent_required")
      return refusal({
        needsPerson: "not_allowed",
        reason: "consent_required",
        message: "This app may not spend this organization's connections yet. The person allows it on the Hub.",
      });
    if (failure.code === "token_refused" && failure.tokenError === "not_member")
      return refusal({
        needsPerson: "choose_org",
        reason: "anchor_gone",
        message: `${NEEDS_PERSON_TEXT.choose_org} The organization that paid is no longer available. The call did not run.`,
      });
    return refusal({ error: failure.code, message: FAILURE_TEXT[failure.code] });
  }

  #needsPersonResult(answer: HubNeedsPersonAnswer, orgId: string | null, amounts: boolean): DynamicToolResult {
    if (answer.needsPerson === "not_allowed") this.#client.forgetCatalog();
    // The Hub no longer lets this organization pay for the person: its token goes, and the next call
    // asks the person again. The payer is never moved to another organization without the person.
    if (answer.needsPerson === "choose_org" && orgId !== null) this.#client.forgetOrg(orgId);
    return refusal({
      needsPerson: answer.needsPerson,
      ...(answer.reason ? { reason: answer.reason } : {}),
      message: NEEDS_PERSON_TEXT[answer.needsPerson],
      ...(answer.bindingScope ? { bindingScope: answer.bindingScope } : {}),
      ...(amounts
        ? {
            ...(answer.currency ? { currency: answer.currency } : {}),
            ...(answer.availableMicros === null ? {} : { availableMicros: answer.availableMicros }),
            ...(answer.neededMicros === null ? {} : { neededMicros: answer.neededMicros }),
            ...(answer.resetsAt ? { resetsAt: answer.resetsAt } : {}),
          }
        : {}),
    });
  }

  #errorResult(answer: HubErrorAnswer, amounts: boolean): DynamicToolResult {
    if (answer.error === "not_allowed" || answer.error === "unauthorized") this.#client.forgetCatalog();
    // The kill switch: the next turn reads `/session` again, so the tools leave the agent's catalog.
    if (answer.error === "connection_unavailable") this.#client.forgetCapabilities();
    const fields: ResultFields = {
      error: answer.error,
      message: ERROR_TEXT[answer.error],
      ...(answer.reason ? { reason: answer.reason } : {}),
      ...(answer.scope ? { scope: answer.scope } : {}),
      ...(answer.retryAfterSeconds === null ? {} : { retryAfterSeconds: answer.retryAfterSeconds }),
      ...(!amounts || answer.estimateMicros === null ? {} : { estimateMicros: answer.estimateMicros }),
      ...(!amounts || answer.chargedMicros === null ? {} : { chargedMicros: answer.chargedMicros }),
      ...(answer.providerStatus === null ? {} : { providerStatus: answer.providerStatus }),
      ...(answer.field ? { field: answer.field } : {}),
      ...(answer.alternatives.length > 0 ? { alternatives: answer.alternatives } : {}),
    };
    // A provider message that still shows a secret after the mask is left out.
    const providerMessage = answer.providerMessage ? maskedResultText(answer.providerMessage) : null;
    return providerMessage
      ? refusal(
          fields,
          connectionEnvelope({ connection: TOOL_CATALOG_CONNECTION_ID }, escapedJson({ providerMessage })),
        )
      : refusal(fields);
  }

  readonly #call = Effect.fn("HubConnectionTools.call")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    orgId: string,
    paidBy: string,
    rawInput: ToolInput,
    offset: number,
    hooks: HubConnectionHooks,
  ) {
    const read = readCallInput(rawInput);
    if ("refusal" in read) return inputRefused(read.refusal);
    const { input, dropped } = read;
    const hash = createHash("sha256")
      .update(JSON.stringify([orgId, input.endpointId, input.query ?? null, input.body ?? null]))
      .digest("hex");
    const state = this.#turn(context.turnId);
    const kept = state.results.get(hash);
    // The same call in the same turn: the kept result, at the asked offset, with no new charge.
    if (kept) return page(kept, offset, true);
    if (offset > 0)
      return refusal({ error: "invalid_arguments", message: "offset needs the same call earlier in this turn." });
    const amounts = context.origin !== "agent";
    const described = yield* this.#describe(orgId, input.endpointId, amounts);
    if (described.kind !== "answer") return described.result;
    const refused = checkCallInput(input, described.answer);
    if (refused) return inputRefused(refused);
    // The Guard reads only an input that passed the checks: a refused one never leaves the computer.
    const before = yield* hooks.guard();
    if (!before.proceed) return before.result;
    if (described.answer.personalData) {
      const people = yield* this.#allowPeopleData(context, described.answer, input, hooks.ask);
      if (people) return people.result;
    }
    const body: ToolCatalogCallRequest = {
      endpointId: input.endpointId,
      // Only these three origins get the tools (`#access`), so no other origin reaches this line.
      origin: context.origin === "owner_ui" || context.origin === "routine" ? context.origin : "agent",
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.body === undefined ? {} : { body: input.body }),
    };
    this.#hourly.push(this.#now());
    let outcome = yield* Effect.result(this.#client.call(orgId, body, randomUUID()));
    /** The most that the person approved for this call: the cost card's amount, else the no-card limit. */
    let approvedMicros = (yield* this.#catalogEntry(TOOL_CATALOG_CONNECTION_ID))?.access.find(
      (row) => row.orgId === orgId,
    )?.confirmAboveMicros;
    if (Result.isSuccess(outcome) && outcome.success.kind === "needs-person") {
      const needs = outcome.success;
      if (needs.needsPerson === "confirm_cost") {
        const confirmed = yield* this.#confirm(context, orgId, paidBy, described.answer, body, needs, hooks);
        if (confirmed.kind === "stop") return confirmed.result;
        outcome = confirmed.outcome;
        approvedMicros = confirmed.approvedMicros;
      }
    }
    if (Result.isFailure(outcome)) return this.#failureResult(outcome.failure);
    const answer = outcome.success;
    if (answer.kind === "needs-person") {
      if (answer.needsPerson === "cap_reached" || answer.needsPerson === "org_budget_reached")
        yield* this.#notifyLimit(context, hooks, orgId, paidBy, answer);
      return this.#needsPersonResult(answer, orgId, amounts);
    }
    if (answer.kind === "error") return this.#errorResult(answer, amounts);
    // The Hub answers for the organization of the token, always (contract §6.3). Another one is a Hub
    // that does not keep the contract: the payer is not known, so the result is held and not kept.
    if (answer.orgId !== orgId) {
      logger.warn("The Hub answered a connection call for another organization; the result is held.", {
        connection: TOOL_CATALOG_CONNECTION_ID,
      });
      return refusal({ error: "hub_unavailable", message: FAILURE_TEXT.hub_unavailable });
    }
    this.#lastPaid.set(TOOL_CATALOG_CONNECTION_ID, answer.orgId);
    // The use changed: the next read of Usage asks the Hub.
    this.#usage.delete(answer.orgId);
    yield* this.#notifyCall(context, hooks, paidBy, described.answer.title, answer);
    if (approvedMicros !== undefined && approvedMicros !== null && answer.chargedMicros > approvedMicros) {
      logger.warn("The Hub charged a connection call more than the person approved.", {
        connection: TOOL_CATALOG_CONNECTION_ID,
        chargedMicros: answer.chargedMicros,
        approvedMicros,
      });
      yield* this.#notifyOvercharge(context, hooks, paidBy, described.answer.title, answer, approvedMicros);
    }
    const header: ResultFields = {
      connection: TOOL_CATALOG_CONNECTION_ID,
      operation: "call",
      endpointId: answer.endpointId,
      requestId: answer.requestId,
      providerStatus: answer.providerStatus,
      state: answer.state,
      warnings: answer.warnings,
      ...(amounts
        ? {
            currency: answer.currency,
            chargedMicros: answer.chargedMicros,
            estimateMicros: answer.estimateMicros,
            availableMicros: answer.availableMicros,
            effectiveAvailableMicros: answer.effectiveAvailableMicros,
            bindingScope: answer.bindingScope,
          }
        : {}),
      ...(answer.warningCrossed
        ? { notice: "The person passed 80 percent of the monthly limit of this connection. Make fewer calls." }
        : {}),
      ...(dropped.length > 0
        ? { ignoredFields: dropped, ignoredReason: "Only Builders Bot sets these fields, never an agent." }
        : {}),
      hubTruncated: answer.truncated,
    };
    // The second lock after the Hub's mask: credentials by field name and by shape, and vendor lines,
    // read in the decoded answer. A secret that still shows holds the whole result back.
    const masked = maskedResultJson({
      ...(amounts ? { paidBy } : {}),
      signals: answer.signals,
      content: answer.content,
    });
    if (masked === null) {
      logger.warn("A connection result held a credential after the mask; it is held back.", {
        connection: TOOL_CATALOG_CONNECTION_ID,
        endpoint: answer.endpointId,
      });
      return refusal({
        ...header,
        error: "result_withheld",
        message:
          "The result held a credential that Builders Bot could not mask, so it is held back. The call ran and was paid. Do not repeat it; tell the person.",
      });
    }
    const content = masked.slice(0, HUB_CONNECTIONS_LIMITS.contentChars);
    const text = content.replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
    const stored: StoredResult = {
      // Found contacts are guesses of the provider: the agent reads the app's note with them (G9).
      header: holdsContactData(content) ? { ...header, contactData: CONTACT_DATA_NOTE } : header,
      attributes: { endpoint: answer.endpointId, served_by: answer.servedBy },
      text,
    };
    state.results.set(hash, stored);
    return page(stored, 0, false);
  });

  /** The catalog entry of a connection, from the cache of the catalog. */
  readonly #catalogEntry = Effect.fn("HubConnectionTools.catalogEntry")(function* (
    this: HubConnectionTools,
    connectionId: string,
  ) {
    const catalog = yield* Effect.result(this.#client.catalog());
    return Result.isSuccess(catalog)
      ? catalog.success.connections.find((candidate) => candidate.id === connectionId)
      : undefined;
  });

  /** The fields of a cost line that name the connection and the payer. */
  #chatBase(entry: HubConnectionEntry | undefined, orgId: string, paidBy: string, currency: string) {
    const personal = orgId === PERSONAL_ORG;
    return {
      connectionId: TOOL_CATALOG_CONNECTION_ID,
      connectionName: entry?.name ?? TOOL_CATALOG_CONNECTION_ID,
      orgId,
      orgName: personal || !isHubPlainText(paidBy, HUB_CONNECTIONS_LIMITS.nameChars) ? "" : paidBy,
      personal,
      currency,
    };
  }

  /**
   * The cost line of a call that ran: what it cost and who paid, and the line of the first call over
   * 80 % of the cap. A turn that another agent started gets no amounts, so no line either.
   */
  readonly #notifyCall = Effect.fn("HubConnectionTools.notifyCall")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    hooks: HubConnectionHooks,
    paidBy: string,
    endpoint: string,
    answer: ToolCatalogCallAnswer,
  ) {
    const notify = hooks.notify;
    if (!notify || context.origin === "agent") return;
    const entry = yield* this.#catalogEntry(TOOL_CATALOG_CONNECTION_ID);
    const base = this.#chatBase(entry, answer.orgId, paidBy, answer.currency);
    notify({
      ...base,
      kind: "paid",
      amountMicros: answer.chargedMicros,
      endpoint: isHubPlainText(endpoint, HUB_CONNECTIONS_LIMITS.titleChars) ? endpoint : null,
      resetsAt: null,
      scope: null,
    });
    if (answer.warningCrossed)
      notify({
        ...base,
        kind: "warning",
        amountMicros: answer.effectiveAvailableMicros,
        endpoint: null,
        resetsAt: entry?.access.find((row) => row.orgId === answer.orgId)?.resetsAt ?? null,
        scope: null,
      });
  });

  /** The line of a call that the cap stopped, once per turn and organization, with "Ask the admin for more". */
  readonly #notifyLimit = Effect.fn("HubConnectionTools.notifyLimit")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    hooks: HubConnectionHooks,
    orgId: string,
    paidBy: string,
    answer: HubNeedsPersonAnswer,
  ) {
    const notify = hooks.notify;
    if (!notify || context.origin === "agent") return;
    const limits = this.#turn(context.turnId).limits;
    const key = `${TOOL_CATALOG_CONNECTION_ID}\u0000${orgId}`;
    if (limits.has(key)) return;
    limits.add(key);
    const entry = yield* this.#catalogEntry(TOOL_CATALOG_CONNECTION_ID);
    const row = entry?.access.find((candidate) => candidate.orgId === orgId);
    notify({
      ...this.#chatBase(entry, orgId, paidBy, answer.currency ?? row?.currency ?? "BRL"),
      kind: "limit",
      amountMicros: answer.effectiveAvailableMicros ?? answer.availableMicros ?? 0,
      endpoint: null,
      resetsAt: answer.resetsAt ?? row?.resetsAt ?? null,
      scope: answer.needsPerson === "cap_reached" ? "user" : "org",
    });
  });

  /** The line of a call that the Hub charged more than the person approved (contract §6.4). */
  readonly #notifyOvercharge = Effect.fn("HubConnectionTools.notifyOvercharge")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    hooks: HubConnectionHooks,
    paidBy: string,
    endpoint: string,
    answer: ToolCatalogCallAnswer,
    approvedMicros: number,
  ) {
    const notify = hooks.notify;
    if (!notify || context.origin === "agent") return;
    const entry = yield* this.#catalogEntry(TOOL_CATALOG_CONNECTION_ID);
    notify({
      ...this.#chatBase(entry, answer.orgId, paidBy, answer.currency),
      kind: "overcharged",
      amountMicros: answer.chargedMicros,
      approvedMicros,
      endpoint: isHubPlainText(endpoint, HUB_CONNECTIONS_LIMITS.titleChars) ? endpoint : null,
      resetsAt: null,
      scope: null,
    });
  });

  /**
   * The approval of a call about people (the treg design, §4.6 G3): the first such call of a
   * conversation shows a card with the values that it asks about, such as names and addresses. A
   * routine run or a turn that another agent started cannot show a card, so the call stops, also in a
   * conversation where the person allowed such calls before. Null when
   * the call may go on; otherwise the result for the agent, or null in `result` when the turn ended.
   */
  readonly #allowPeopleData = Effect.fn("HubConnectionTools.allowPeopleData")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    described: ToolCatalogDescribeAnswer,
    input: { readonly query?: unknown; readonly body?: unknown },
    ask: HubConnectionAsk,
  ) {
    // A routine run or a delegated turn never looks up people, also in a conversation where the
    // person allowed it: nobody is there to see what it asks about.
    if (context.origin !== "owner_ui")
      return {
        result: refusal({
          needsPerson: "people_data",
          refused: true,
          message:
            "This endpoint looks up data about people. Only the person can allow that, in a conversation, and nobody can in a routine run or in a turn that another agent started. The call did not run. Report it.",
        }),
      };
    const key = `${context.agentId}\u0000${context.threadId}`;
    if (this.#peopleDataThreads.has(key)) return null;
    const answer = yield* ask(
      sourceText("status.agent.connectionPeopleData", {
        endpoint: described.title,
        subjects: inputSubjects(input) || described.endpointId,
      }),
    );
    if (answer === "cancel") return { result: null };
    if (answer !== "accept")
      return {
        result: refusal({
          needsPerson: "people_data",
          declined: true,
          message:
            "The person did not allow this lookup of data about people. The call did not run. Do not call it again unless the person asks.",
        }),
      };
    this.#peopleDataThreads.add(key);
    while (this.#peopleDataThreads.size > PEOPLE_DATA_THREADS) {
      const oldest = this.#peopleDataThreads.values().next().value;
      if (oldest === undefined) break;
      this.#peopleDataThreads.delete(oldest);
    }
    return null;
  });

  /**
   * The cost approval (contract §6.4). The person approves on the Hub, not on a card of this app: the
   * Hub no longer trusts the app's word. The card says so; Allow opens the Hub page of the confirmation
   * in the browser, and this process reads the state of the confirmation every 2 seconds until the
   * person decides, the offer ends, or the turn ends. Only `approved` sends the call, once, with the
   * id and the approved estimate as the ceiling. The confirmation id stays in this process: the agent
   * never sees it, and it goes only to the Hub.
   */
  readonly #confirm = Effect.fn("HubConnectionTools.confirm")(function* (
    this: HubConnectionTools,
    context: HubConnectionContext,
    orgId: string,
    paidBy: string,
    described: ToolCatalogDescribeAnswer,
    body: ToolCatalogCallRequest,
    needs: HubNeedsPersonAnswer,
    hooks: HubConnectionHooks,
  ) {
    type Confirmed =
      | { readonly kind: "stop"; readonly result: DynamicToolResult | null }
      | {
          readonly kind: "sent";
          readonly outcome: Result.Result<ToolCatalogCallOutcome, HubConnectionFailure>;
          /** The amount on the card that the person approved: the Hub may charge less, never more. */
          readonly approvedMicros: number;
        };
    const estimate = needs.estimateMicros ?? 0;
    const currency = needs.currency ?? "BRL";
    // A turn that another agent started gets no amounts.
    const costFields =
      context.origin === "agent"
        ? { needsPerson: "confirm_cost" }
        : { needsPerson: "confirm_cost", currency, estimateMicros: estimate };
    const stop = (fields: ResultFields): Confirmed => ({ kind: "stop", result: refusal({ ...costFields, ...fields }) });
    if (context.origin !== "owner_ui")
      return stop({
        refused: true,
        message: `${NEEDS_PERSON_TEXT.confirm_cost} Nobody can approve a cost in a routine run or in a turn that another agent started, so the call did not run. Report it, or use a cheaper call.`,
      });
    const confirmationId = needs.confirmationId;
    const offered = Date.parse(needs.expiresAt ?? "");
    const deadline = Math.min(Number.isFinite(offered) ? offered : 0, this.#now() + CONFIRMATION_MS);
    if (!confirmationId || deadline <= this.#now())
      return stop({ message: "Cultura Builder gave no valid cost offer. Do not retry." });
    const endpoint = described.title;
    const amount = formatConnectionMoney(estimate, currency);
    const answer = yield* hooks.ask(
      orgId === PERSONAL_ORG
        ? sourceText("status.agent.connectionConfirmCostOnHubPersonal", { endpoint, amount })
        : sourceText("status.agent.connectionConfirmCostOnHub", { endpoint, amount, org: paidBy }),
    );
    if (answer === "cancel") return { kind: "stop", result: null } satisfies Confirmed;
    const declined = {
      declined: true,
      message: "The person declined this cost. The call did not run. Do not call it again unless the person asks.",
    };
    const expired = {
      expired: true,
      message:
        "Nobody approved this cost on the Cultura Builder Hub before the offer ended, so the call did not run. Call it again for a new offer only if the person asks.",
    };
    if (answer === "decline") return stop(declined);
    if (this.#now() > deadline) return stop(expired);
    const opened = yield* this.#openPage(`${CULTURA_BUILDER_HUB}${HUB_PAGES.approval(confirmationId)}`);
    if (!opened)
      return stop({
        message:
          "Builders Bot could not open the Cultura Builder Hub, where the person approves this cost. The call did not run. Tell the person.",
      });
    const state = yield* this.#awaitApproval(orgId, confirmationId, deadline, hooks.signal);
    switch (state) {
      case "approved":
        break;
      case "canceled":
        return { kind: "stop", result: null } satisfies Confirmed;
      case "denied":
        return stop(declined);
      case "expired":
      case "timeout":
        return stop(expired);
      case "used":
        return stop({ message: "Cultura Builder says that this approval was already used. The call did not run." });
      default:
        return stop({
          message:
            "Cultura Builder did not confirm the approval of this cost, so the call did not run. Do not retry in this turn.",
        });
    }
    // The approved amount is the ceiling: the Hub may charge less, never more than the person saw.
    // `maxCostMicros` only lowers the Hub's ceiling, and only this process sets it.
    const outcome = yield* Effect.result(
      this.#client.call(orgId, { ...body, confirmationId, maxCostMicros: estimate }, randomUUID()),
    );
    if (Result.isSuccess(outcome)) {
      const sent = outcome.success;
      // A second cost question for the same call is not asked again: it would be a loop of cards.
      if (sent.kind === "needs-person" && sent.needsPerson === "confirm_cost")
        return stop({ message: "Cultura Builder asked again for the same call. The call did not run." });
      // The Hub has no approval of the person for this id: it decides, not this app.
      if (sent.kind === "error" && sent.error === "not_allowed" && isConfirmationRefusal(sent.reason))
        return stop({
          ...(sent.reason === "confirmation_denied" ? { declined: true } : {}),
          message:
            "Cultura Builder has no approval of this cost from the person, so the call did not run. Do not call it again unless the person asks.",
        });
    }
    return { kind: "sent", outcome, approvedMicros: estimate } satisfies Confirmed;
  });

  /**
   * Reads the state of a cost approval every 2 seconds until the person decides on the Hub, the offer
   * ends (`deadline`, and the Hub's own `expiresAt`), or the turn ends (`signal`). A read that fails for
   * the network or a 5xx is read again; a signed-out session, a refused token or an answer outside the
   * contract ends the wait as `failed`.
   */
  readonly #awaitApproval = Effect.fn("HubConnectionTools.awaitApproval")(function* (
    this: HubConnectionTools,
    orgId: string,
    confirmationId: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ) {
    type Wait = Exclude<HubConfirmationState, "pending"> | "timeout" | "canceled" | "failed";
    let until = deadline;
    for (;;) {
      const left = until - this.#now();
      if (left <= 0) return "timeout" satisfies Wait;
      yield* Effect.sleep(Math.min(CONFIRMATION_POLL_MS, left));
      if (signal?.aborted) return "canceled" satisfies Wait;
      const read = yield* Effect.result(this.#client.confirmation(orgId, confirmationId));
      if (Result.isFailure(read)) {
        const code = read.failure.code;
        if (code === "signed_out" || code === "token_refused" || code === "disabled") return "failed" satisfies Wait;
        continue;
      }
      if (read.success.kind !== "answer") return "failed" satisfies Wait;
      const status = read.success.answer;
      if (status.state !== "pending") return status.state satisfies Wait;
      const expires = Date.parse(status.expiresAt);
      if (Number.isFinite(expires)) until = Math.min(until, expires);
    }
  });
}

/** Whether a `not_allowed` reason says that the Hub has no approval of the person for the confirmation. */
function isConfirmationRefusal(reason: string | null): boolean {
  return HUB_CONFIRMATION_REFUSALS.some((refusalReason) => refusalReason === reason);
}

function payerName(decision: Extract<PayerDecision, { kind: "pay" }>): string {
  return decision.access.orgId === PERSONAL_ORG ? "personal plan" : decision.name;
}

/** What the person reads when an access request did not reach the admins. */
function requestFailure(failure: HubConnectionFailure): HubAccessRequestFailure {
  if (failure.code === "signed_out") return "signed_out";
  if (failure.code === "offline") return "offline";
  if (failure.code === "token_refused" || failure.code === "unauthorized" || failure.code === "disabled")
    return "not_allowed";
  return "hub_unavailable";
}

function unavailableReason(entry: HubConnectionEntry): string {
  const states = new Set(entry.access.flatMap((access) => [access.org, access.user]));
  for (const reason of ["paused", "revoked", "not_in_plan", "not_enabled", "not_allowed", "requested"] as const)
    if (states.has(reason)) return reason;
  if (entry.access.some((access) => !access.consented)) return "consent_required";
  return "no_organization";
}

function inputRefused(refusalValue: InputRefusal): DynamicToolResult {
  return refusal({
    error: "input_refused",
    rule: refusalValue.rule,
    ...(refusalValue.field ? { field: refusalValue.field } : {}),
    message: `${INPUT_RULE_TEXT[refusalValue.rule]} Nothing was sent to Cultura Builder.`,
  });
}

/** One page of a call result: the fields of the app, and the content in its envelope. */
function page(stored: StoredResult, offset: number, repeated: boolean): DynamicToolResult {
  const { text } = stored;
  const start = Math.min(offset, text.length);
  const end = Math.min(start + HUB_CALL_LIMITS.page, text.length);
  const truncated = end < text.length;
  return result(
    {
      ...stored.header,
      ...(repeated ? { repeated: true, chargedMicros: 0 } : {}),
      offset: start,
      truncated,
      ...(truncated ? { nextOffset: end } : {}),
    },
    connectionEnvelope({ connection: TOOL_CATALOG_CONNECTION_ID, ...stored.attributes }, text.slice(start, end)),
  );
}
