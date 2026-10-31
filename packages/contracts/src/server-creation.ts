// The permission to create a new remote server (docs/architecture/server-creation-permission.md).
// The account Worker sends these values; the desktop app and the web client decode them here.

import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/** The longest reason of a request, in characters. */
export const SERVER_CREATION_REASON_MAX_LENGTH = 500;
/** The longest note of a grant, in characters. */
export const SERVER_CREATION_NOTE_MAX_LENGTH = 200;

export const SERVER_CREATION_REQUEST_STATUSES = ["pending", "approved", "denied"] as const;
export type ServerCreationRequestStatus = (typeof SERVER_CREATION_REQUEST_STATUSES)[number];

/** The latest request of the signed-in person. */
export interface ServerCreationOwnRequest {
  id: string;
  status: ServerCreationRequestStatus;
  createdAt: number;
  decidedAt: number | null;
}

/** What the signed-in person can do. `canCreate` is the permission only: hosting can still be off. */
export interface ServerCreationAccess {
  canCreate: boolean;
  administrator: boolean;
  request: ServerCreationOwnRequest | null;
}

export interface ServerCreationAccessRequest {
  reason: string;
}

/** The person of a request or a grant, as an administrator sees them. */
export interface ServerCreationPerson {
  userId: string;
  email: string;
  name: string | null;
}

export interface ServerCreationRequest extends ServerCreationPerson {
  id: string;
  reason: string;
  status: ServerCreationRequestStatus;
  createdAt: number;
  decidedAt: number | null;
}

export interface ServerCreationGrant extends ServerCreationPerson {
  grantedAt: number;
  note: string | null;
}

/** The administrator section: the requests that wait and the people with an active grant. */
export interface ServerCreationAdminState {
  requests: ServerCreationRequest[];
  grants: ServerCreationGrant[];
}

export interface ServerCreationGrantInput {
  email: string;
  note?: string | undefined;
}

export interface ServerCreationDecisionInput {
  requestId: string;
  decision: "approve" | "deny";
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const EMAIL_MAX_LENGTH = 320;

function timestamp(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function nullableTimestamp(value: unknown): value is number | null {
  return value === null || timestamp(value);
}

function identifier(value: unknown): value is string {
  return isString(value) && IDENTIFIER.test(value);
}

/** Trims a text and returns it when it has 1 to `max` characters. */
function boundedText(value: unknown, max: number): string | null {
  if (!isString(value)) return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function parseOwnRequest(value: unknown): ServerCreationOwnRequest | null {
  if (
    !isDynamicRecord(value) ||
    !identifier(value.id) ||
    !isOneOf(SERVER_CREATION_REQUEST_STATUSES, value.status) ||
    !timestamp(value.createdAt) ||
    !nullableTimestamp(value.decidedAt)
  )
    return null;
  return { id: value.id, status: value.status, createdAt: value.createdAt, decidedAt: value.decidedAt };
}

/** Returns null for a value that is not an access answer. */
export function parseServerCreationAccess(value: unknown): ServerCreationAccess | null {
  if (!isDynamicRecord(value) || !isBoolean(value.canCreate) || !isBoolean(value.administrator)) return null;
  const request = value.request === null || value.request === undefined ? null : parseOwnRequest(value.request);
  if (value.request && !request) return null;
  return { canCreate: value.canCreate, administrator: value.administrator, request };
}

function parsePerson(value: DynamicRecord): ServerCreationPerson | null {
  if (!identifier(value.userId) || !isString(value.email) || value.email.length > EMAIL_MAX_LENGTH) return null;
  if (!(value.name === null || isString(value.name))) return null;
  return { userId: value.userId, email: value.email, name: value.name };
}

function parseAdminRequest(value: unknown): ServerCreationRequest | null {
  if (!isDynamicRecord(value)) return null;
  const person = parsePerson(value);
  const own = parseOwnRequest(value);
  if (!person || !own || !isString(value.reason) || value.reason.length > SERVER_CREATION_REASON_MAX_LENGTH)
    return null;
  return { ...person, ...own, reason: value.reason };
}

function parseGrant(value: unknown): ServerCreationGrant | null {
  if (!isDynamicRecord(value) || !timestamp(value.grantedAt)) return null;
  const person = parsePerson(value);
  if (!person || !(value.note === null || isString(value.note))) return null;
  return { ...person, grantedAt: value.grantedAt, note: value.note };
}

/** Returns null for a value that is not the administrator state. A malformed row fails the whole value. */
export function parseServerCreationAdminState(value: unknown): ServerCreationAdminState | null {
  if (!isDynamicRecord(value) || !Array.isArray(value.requests) || !Array.isArray(value.grants)) return null;
  const requests = value.requests.map(parseAdminRequest);
  const grants = value.grants.map(parseGrant);
  if (requests.some((entry) => entry === null) || grants.some((entry) => entry === null)) return null;
  return {
    requests: requests.filter((entry): entry is ServerCreationRequest => entry !== null),
    grants: grants.filter((entry): entry is ServerCreationGrant => entry !== null),
  };
}

/** The reason of a request, trimmed, or null when it is empty or too long. */
export function parseServerCreationAccessRequest(value: unknown): ServerCreationAccessRequest | null {
  if (!isDynamicRecord(value)) return null;
  const reason = boundedText(value.reason, SERVER_CREATION_REASON_MAX_LENGTH);
  return reason ? { reason } : null;
}

/** A grant by email, with an optional note. Returns null for an invalid value. */
export function parseServerCreationGrantInput(value: unknown): ServerCreationGrantInput | null {
  if (!isDynamicRecord(value)) return null;
  const email = boundedText(value.email, EMAIL_MAX_LENGTH);
  if (!email?.includes("@")) return null;
  if (value.note === undefined || value.note === null || value.note === "") return { email };
  const note = boundedText(value.note, SERVER_CREATION_NOTE_MAX_LENGTH);
  return note ? { email, note } : null;
}

export function parseServerCreationDecisionInput(value: unknown): ServerCreationDecisionInput | null {
  if (!isDynamicRecord(value) || !identifier(value.requestId)) return null;
  if (value.decision !== "approve" && value.decision !== "deny") return null;
  return { requestId: value.requestId, decision: value.decision };
}

/** An account ID, as the revoke route and IPC take it. */
export function isServerCreationUserId(value: unknown): value is string {
  return identifier(value);
}
