// What main gives the renderer about Hub connections (docs/architecture/hub-connections.md): the
// Marketplace page, Usage › Connections and the cost lines of a chat. Main builds each value from the
// Hub's answers after its own decoders ran (hub-connections.ts). Nothing here is a credential: no
// token, no confirmation id, no Hub URL and no vendor key. The decoders below check each value again
// at the preload, as every payload from main is checked.

import {
  HUB_BINDING_SCOPES,
  HUB_CAP_STATES,
  HUB_CONNECTIONS_LIMITS,
  HUB_ORG_STATES,
  HUB_USER_STATES,
  type HubAccessRequestKind,
  type HubBindingScope,
  type HubCapState,
  type HubConnectionAccess,
  isHubAccessRequestKind,
  isHubConnectionId,
  isHubOrgId,
  isHubPlainText,
} from "./hub-connections";
import type { ConversationMessage } from "./ipc-conversation-messages";

export type { HubAccessRequestKind } from "./hub-connections";

import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/**
 * - `ready`: the catalog was read.
 * - `signed_out`: no Cultura Builder session on this computer.
 * - `off`: Cultura Builder has no connection on for this account (or the kill switch is on).
 * - `unavailable`: the Hub did not answer, or answered outside the contract.
 */
export const HUB_CONNECTIONS_VIEW_STATUSES = ["ready", "signed_out", "off", "unavailable"] as const;
export type HubConnectionsViewStatus = (typeof HUB_CONNECTIONS_VIEW_STATUSES)[number];

/** The organization id of the personal plan in an access row. */
export const HUB_PERSONAL_ORG_ID = "personal";

/** One access row of a connection, with the name of its organization. */
export type HubConnectionAccessView = HubConnectionAccess & {
  /** The organization's name, as the Hub sends it. Empty for the personal plan. */
  orgName: string;
  personal: boolean;
};

/**
 * Who pays the next call of a connection: `pay` (the organization in `payerOrgId`), `choose_org` (the
 * person must choose), or `none` (no row can pay: not enabled, not allowed, or no consent).
 */
export const HUB_CONNECTION_PAYER_STATES = ["pay", "choose_org", "none"] as const;
export type HubConnectionPayerState = (typeof HUB_CONNECTION_PAYER_STATES)[number];

export interface HubConnectionView {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** The titles of the read operations, in the Hub's order. */
  operations: string[];
  /** How many endpoints the organization allows. */
  itemsCount: number;
  dataPolicy: { vendor: string; region: string; retentionDays: number | null };
  access: HubConnectionAccessView[];
  payer: HubConnectionPayerState;
  payerOrgId: string | null;
  /**
   * The `/session` capability of the connection. False while Cultura Builder paused it (the kill
   * switch): the page says so, and no agent has the connection.
   */
  enabled: boolean;
}

export interface HubConnectionsView {
  status: HubConnectionsViewStatus;
  connections: HubConnectionView[];
  /** When main read the catalog. Null when it did not. */
  readAt: string | null;
}

export interface HubConnectionUsageRow {
  id: string;
  /** The connection's name from the catalog, or its id when the catalog did not answer. */
  name: string;
  settledMicros: number;
  reservedMicros: number;
  calls: number;
  availableMicros: number;
  effectiveAvailableMicros: number;
  state: HubCapState;
  cap: HubConnectionAccess["cap"] | null;
  bindingScope: HubBindingScope | null;
  /** The person's own spend by platform of the vendor catalog. */
  platforms: Array<{ platform: string; settledMicros: number; calls: number }>;
}

/** The person's own use of the connections that one organization pays for, in this period. */
export interface HubConnectionOrgUsage {
  orgId: string;
  orgName: string;
  personal: boolean;
  periodKey: string;
  resetsAt: string;
  timeZone: string;
  currency: string;
  asOf: string;
  connections: HubConnectionUsageRow[];
}

export interface HubConnectionUsageView {
  status: HubConnectionsViewStatus;
  orgs: HubConnectionOrgUsage[];
}

/** The person chose which organization pays a connection, on its Marketplace page. */
export interface HubConnectionPayerInput {
  connectionId: string;
  orgId: string;
}

/** The person asks the admins of an organization for access, or for more money in this period. */
export interface HubConnectionAccessRequestInput {
  connectionId: string;
  orgId: string;
  kind: HubAccessRequestKind;
}

export const HUB_ACCESS_REQUEST_FAILURES = [
  "signed_out",
  "offline",
  "hub_unavailable",
  "not_allowed",
  "rate_limited",
  "unknown_org",
] as const;
export type HubAccessRequestFailure = (typeof HUB_ACCESS_REQUEST_FAILURES)[number];

/** `already_sent`: the Hub had a request of the last 7 days, and sent no new notice. */
export interface HubConnectionAccessRequestResult {
  status: "sent" | "already_sent" | "failed";
  requestedAt: string | null;
  failure: HubAccessRequestFailure | null;
}

// --- Checks ----------------------------------------------------------------------------------------

const CURRENCY = /^[A-Z]{3}$/u;
const PERIOD_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const VENDOR_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function micros(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return isString(value) && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function nullable<T>(value: unknown, check: (value: unknown) => value is T): value is T | null {
  return value === null || check(value);
}

function isCap(value: unknown): value is HubConnectionAccess["cap"] {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "limited") return micros(value.amountMicros);
  return value.kind === "unlimited" && nullable(value.dailyMicros, micros);
}

function isTextList(value: unknown, items: number, chars: number): value is string[] {
  return Array.isArray(value) && value.length <= items && value.every((item) => isHubPlainText(item, chars));
}

function isAccessView(value: unknown): value is HubConnectionAccessView {
  return (
    isDynamicRecord(value) &&
    isHubOrgId(value.orgId) &&
    (value.orgName === "" || isHubPlainText(value.orgName, HUB_CONNECTIONS_LIMITS.nameChars)) &&
    isBoolean(value.personal) &&
    isOneOf(HUB_ORG_STATES, value.org) &&
    isOneOf(HUB_USER_STATES, value.user) &&
    isBoolean(value.consented) &&
    isString(value.currency) &&
    CURRENCY.test(value.currency) &&
    isCap(value.cap) &&
    micros(value.settledMicros) &&
    micros(value.reservedMicros) &&
    micros(value.availableMicros) &&
    micros(value.effectiveAvailableMicros) &&
    isOneOf(HUB_BINDING_SCOPES, value.bindingScope) &&
    isOneOf(HUB_CAP_STATES, value.state) &&
    micros(value.maxCostPerCallMicros) &&
    nullable(value.confirmAboveMicros, micros) &&
    timestamp(value.resetsAt) &&
    timestamp(value.asOf) &&
    micros(value.counterVersion) &&
    isTextList(value.categories, HUB_CONNECTIONS_LIMITS.categories, HUB_CONNECTIONS_LIMITS.categoryChars) &&
    nullable(value.priceFromMicros, micros) &&
    nullable(value.requestedAt, timestamp) &&
    nullable(value.moreRequestedAt, timestamp)
  );
}

function isConnectionView(value: unknown): value is HubConnectionView {
  if (!isDynamicRecord(value) || !isHubConnectionId(value.id)) return false;
  const policy = value.dataPolicy;
  return (
    isHubPlainText(value.name, HUB_CONNECTIONS_LIMITS.nameChars) &&
    (value.tagline === "" || isHubPlainText(value.tagline, HUB_CONNECTIONS_LIMITS.taglineChars)) &&
    (value.description === "" ||
      isHubPlainText(value.description, HUB_CONNECTIONS_LIMITS.connectionDescriptionChars)) &&
    isTextList(value.operations, HUB_CONNECTIONS_LIMITS.operations, HUB_CONNECTIONS_LIMITS.titleChars) &&
    isNumber(value.itemsCount) &&
    Number.isInteger(value.itemsCount) &&
    value.itemsCount >= 0 &&
    value.itemsCount <= 1_000_000 &&
    isDynamicRecord(policy) &&
    (policy.vendor === "" || isHubPlainText(policy.vendor, HUB_CONNECTIONS_LIMITS.taglineChars)) &&
    (policy.region === "" || isHubPlainText(policy.region, 40)) &&
    nullable(policy.retentionDays, micros) &&
    Array.isArray(value.access) &&
    value.access.length <= HUB_CONNECTIONS_LIMITS.accessRows &&
    value.access.every(isAccessView) &&
    isOneOf(HUB_CONNECTION_PAYER_STATES, value.payer) &&
    nullable(value.payerOrgId, isHubOrgId) &&
    (value.payer === "pay") === (value.payerOrgId !== null) &&
    isBoolean(value.enabled)
  );
}

export function isHubConnectionsView(value: unknown): value is HubConnectionsView {
  return (
    isDynamicRecord(value) &&
    isOneOf(HUB_CONNECTIONS_VIEW_STATUSES, value.status) &&
    Array.isArray(value.connections) &&
    value.connections.length <= HUB_CONNECTIONS_LIMITS.connections &&
    value.connections.every(isConnectionView) &&
    nullable(value.readAt, timestamp)
  );
}

function isPlatformUsage(value: unknown): value is HubConnectionUsageRow["platforms"][number] {
  return (
    isDynamicRecord(value) &&
    isString(value.platform) &&
    VENDOR_SLUG.test(value.platform) &&
    micros(value.settledMicros) &&
    micros(value.calls)
  );
}

function isUsageRow(value: unknown): value is HubConnectionUsageRow {
  return (
    isDynamicRecord(value) &&
    isHubConnectionId(value.id) &&
    isHubPlainText(value.name, HUB_CONNECTIONS_LIMITS.nameChars) &&
    micros(value.settledMicros) &&
    micros(value.reservedMicros) &&
    micros(value.calls) &&
    micros(value.availableMicros) &&
    micros(value.effectiveAvailableMicros) &&
    isOneOf(HUB_CAP_STATES, value.state) &&
    nullable(value.cap, isCap) &&
    nullable(value.bindingScope, (scope): scope is HubBindingScope => isOneOf(HUB_BINDING_SCOPES, scope)) &&
    Array.isArray(value.platforms) &&
    value.platforms.length <= 200 &&
    value.platforms.every(isPlatformUsage)
  );
}

function isOrgUsage(value: unknown): value is HubConnectionOrgUsage {
  return (
    isDynamicRecord(value) &&
    isHubOrgId(value.orgId) &&
    (value.orgName === "" || isHubPlainText(value.orgName, HUB_CONNECTIONS_LIMITS.nameChars)) &&
    isBoolean(value.personal) &&
    isString(value.periodKey) &&
    PERIOD_KEY.test(value.periodKey) &&
    timestamp(value.resetsAt) &&
    isHubPlainText(value.timeZone, 64) &&
    isString(value.currency) &&
    CURRENCY.test(value.currency) &&
    timestamp(value.asOf) &&
    Array.isArray(value.connections) &&
    value.connections.length <= HUB_CONNECTIONS_LIMITS.connections &&
    value.connections.every(isUsageRow)
  );
}

export function isHubConnectionUsageView(value: unknown): value is HubConnectionUsageView {
  return (
    isDynamicRecord(value) &&
    isOneOf(HUB_CONNECTIONS_VIEW_STATUSES, value.status) &&
    Array.isArray(value.orgs) &&
    value.orgs.length <= HUB_CONNECTIONS_LIMITS.accessRows &&
    value.orgs.every(isOrgUsage)
  );
}

export function isHubConnectionAccessRequestResult(value: unknown): value is HubConnectionAccessRequestResult {
  return (
    isDynamicRecord(value) &&
    isOneOf(["sent", "already_sent", "failed"] as const, value.status) &&
    nullable(value.requestedAt, timestamp) &&
    nullable(value.failure, (failure): failure is HubAccessRequestFailure =>
      isOneOf(HUB_ACCESS_REQUEST_FAILURES, failure),
    ) &&
    (value.status === "failed") === (value.failure !== null) &&
    (value.status === "failed") === (value.requestedAt === null)
  );
}

export function parseHubConnectionPayerInput(value: unknown): HubConnectionPayerInput {
  if (!isDynamicRecord(value) || !isHubConnectionId(value.connectionId) || !isHubOrgId(value.orgId))
    throw new Error("Invalid connection payer.");
  return { connectionId: value.connectionId, orgId: value.orgId };
}

export function parseHubConnectionAccessRequestInput(value: unknown): HubConnectionAccessRequestInput {
  if (
    !isDynamicRecord(value) ||
    !isHubConnectionId(value.connectionId) ||
    !isHubOrgId(value.orgId) ||
    !isHubAccessRequestKind(value.kind)
  )
    throw new Error("Invalid connection access request.");
  return { connectionId: value.connectionId, orgId: value.orgId, kind: value.kind };
}

// --- Cost lines in a chat ----------------------------------------------------------------------------

/**
 * The item type prefix of the lines that the app adds to a chat after a connection call: the amount
 * that a call cost and who paid (`paid`), the first call over 80 % of the cap (`warning`), and a call
 * that the cap stopped (`limit`). The text of the message is the JSON of `HubConnectionChatEvent`, as
 * the hosted site events do, so the screen writes the amounts in the reader's language.
 */
export const HUB_CONNECTION_ITEM_TYPE_PREFIX = "hub-connection:";
export const HUB_CONNECTION_CHAT_KINDS = ["paid", "warning", "limit"] as const;
export type HubConnectionChatKind = (typeof HUB_CONNECTION_CHAT_KINDS)[number];

export interface HubConnectionChatEvent {
  kind: HubConnectionChatKind;
  connectionId: string;
  connectionName: string;
  orgId: string;
  /** Empty for the personal plan. */
  orgName: string;
  personal: boolean;
  currency: string;
  /** `paid`: what the call cost. `warning` and `limit`: what is still available. */
  amountMicros: number;
  /** `paid`: the endpoint title. Null otherwise. */
  endpoint: string | null;
  /** `warning` and `limit`: when the period ends. Null when the Hub did not say. */
  resetsAt: string | null;
  /** `limit`: the person's cap (`user`) or the organization's budget (`org`). Null otherwise. */
  scope: "user" | "org" | null;
}

function isChatEvent(value: unknown): value is HubConnectionChatEvent {
  return (
    isDynamicRecord(value) &&
    isOneOf(HUB_CONNECTION_CHAT_KINDS, value.kind) &&
    isHubConnectionId(value.connectionId) &&
    isHubPlainText(value.connectionName, HUB_CONNECTIONS_LIMITS.nameChars) &&
    isHubOrgId(value.orgId) &&
    (value.orgName === "" || isHubPlainText(value.orgName, HUB_CONNECTIONS_LIMITS.nameChars)) &&
    isBoolean(value.personal) &&
    isString(value.currency) &&
    CURRENCY.test(value.currency) &&
    micros(value.amountMicros) &&
    nullable(value.endpoint, (text): text is string => isHubPlainText(text, HUB_CONNECTIONS_LIMITS.titleChars)) &&
    nullable(value.resetsAt, timestamp) &&
    nullable(value.scope, (scope): scope is "user" | "org" => scope === "user" || scope === "org") &&
    (value.kind === "limit") === (value.scope !== null)
  );
}

export function hubConnectionChatItemType(kind: HubConnectionChatKind): string {
  return `${HUB_CONNECTION_ITEM_TYPE_PREFIX}${kind}`;
}

/** The message text of a cost line. Throws for an event outside the shape, as no line may be half valid. */
export function hubConnectionChatText(event: HubConnectionChatEvent): string {
  if (!isChatEvent(event)) throw new Error("A valid connection chat event is required.");
  return JSON.stringify(event);
}

/** The cost line that a message holds, or null. A line whose item type and text disagree is null. */
export function hubConnectionChatEvent(message: ConversationMessage): HubConnectionChatEvent | null {
  if (message.author !== "system" || message.source !== "system" || message.status !== "completed") return null;
  if (!message.itemType?.startsWith(HUB_CONNECTION_ITEM_TYPE_PREFIX)) return null;
  const kind = message.itemType.slice(HUB_CONNECTION_ITEM_TYPE_PREFIX.length);
  let value: unknown;
  try {
    value = JSON.parse(message.text);
  } catch {
    return null;
  }
  return isChatEvent(value) && value.kind === kind ? value : null;
}
