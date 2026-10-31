// What main answers about the WhatsApp accounts. Each value is checked before the page reads it.

import {
  WHATSAPP_ACCOUNT_ID_PATTERN,
  WHATSAPP_ACCOUNT_NAME_MAX,
  WHATSAPP_ACCOUNT_NOTICES,
  WHATSAPP_ACCOUNT_STATES,
  WHATSAPP_ACCOUNTS_ERRORS,
  WHATSAPP_PAIRING_CODE_PATTERN,
  WHATSAPP_QR_MAX_MODULES,
  type WhatsAppAccount,
  type WhatsAppAccountsResult,
  type WhatsAppAccountsSnapshot,
  type WhatsAppLinkState,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";

const MAX_ACCOUNTS = 100;
/** Main masks numbers to their last digits; anything longer is not what main sends. */
const MASKED_NUMBER = /^•••• \d{4}$|^••••$/;

function invalid(): never {
  throw new Error("Invalid WhatsApp accounts answer.");
}

function maskedOrNull(value: unknown): string | null {
  if (value === null) return null;
  return isString(value) && MASKED_NUMBER.test(value) ? value : invalid();
}

function decodeAccount(value: unknown): WhatsAppAccount {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !WHATSAPP_ACCOUNT_ID_PATTERN.test(value.id) ||
    !isString(value.name) ||
    value.name.length === 0 ||
    [...value.name].length > WHATSAPP_ACCOUNT_NAME_MAX * 2 ||
    !isOneOf(WHATSAPP_ACCOUNT_STATES, value.state) ||
    !isBoolean(value.isDefault) ||
    !isBoolean(value.readOnly) ||
    !(
      value.messages === null ||
      (typeof value.messages === "number" && Number.isSafeInteger(value.messages) && value.messages >= 0)
    )
  ) {
    return invalid();
  }
  return {
    id: value.id,
    name: value.name,
    number: maskedOrNull(value.number),
    formerNumber: maskedOrNull(value.formerNumber),
    state: value.state,
    isDefault: value.isDefault,
    readOnly: value.readOnly,
    messages: value.messages,
  };
}

export function decodeWhatsAppAccountsSnapshot(value: unknown): WhatsAppAccountsSnapshot {
  if (!isDynamicRecord(value)) return invalid();
  if (value.status === "unavailable") {
    return isOneOf(WHATSAPP_ACCOUNTS_ERRORS, value.error) ? { status: "unavailable", error: value.error } : invalid();
  }
  if (
    value.status !== "ready" ||
    !isBoolean(value.serverRunning) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > MAX_ACCOUNTS
  ) {
    return invalid();
  }
  return { status: "ready", serverRunning: value.serverRunning, accounts: value.accounts.map(decodeAccount) };
}

export function decodeWhatsAppAccountsResult(value: unknown): WhatsAppAccountsResult {
  if (!isDynamicRecord(value) || !isBoolean(value.ok)) return invalid();
  if (value.ok) {
    const notice = value.notice === null || isOneOf(WHATSAPP_ACCOUNT_NOTICES, value.notice) ? value.notice : invalid();
    return { ok: true, snapshot: decodeWhatsAppAccountsSnapshot(value.snapshot), notice };
  }
  if (!isOneOf(WHATSAPP_ACCOUNTS_ERRORS, value.error)) return invalid();
  return {
    ok: false,
    error: value.error,
    snapshot: value.snapshot === null ? null : decodeWhatsAppAccountsSnapshot(value.snapshot),
  };
}

function expiry(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : invalid();
}

function qrRows(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 21 || value.length > WHATSAPP_QR_MAX_MODULES) return invalid();
  const size = value.length;
  return value.map((row) => (isString(row) && row.length === size && /^[01]+$/.test(row) ? row : invalid()));
}

export function decodeWhatsAppLinkState(value: unknown): WhatsAppLinkState {
  if (!isDynamicRecord(value)) return invalid();
  switch (value.phase) {
    case "starting":
    case "linked":
    case "expired":
      return { phase: value.phase };
    case "code":
      return isString(value.code) && WHATSAPP_PAIRING_CODE_PATTERN.test(value.code)
        ? { phase: "code", code: value.code, expiresAt: expiry(value.expiresAt) }
        : invalid();
    case "qr":
      return { phase: "qr", rows: qrRows(value.rows), expiresAt: expiry(value.expiresAt) };
    case "failed":
      return isOneOf(WHATSAPP_ACCOUNTS_ERRORS, value.error) ? { phase: "failed", error: value.error } : invalid();
    default:
      return invalid();
  }
}

export function decodeOptionalWhatsAppLinkState(value: unknown): WhatsAppLinkState | null {
  return value === null ? null : decodeWhatsAppLinkState(value);
}
