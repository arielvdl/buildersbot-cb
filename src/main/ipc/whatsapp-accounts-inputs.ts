// Payload decoders of the WhatsApp accounts group. A value that fails here never reaches the wazap CLI.

import {
  cleanWhatsAppAccountName,
  E164_PATTERN,
  isDestructiveWhatsAppAction,
  WHATSAPP_ACCOUNT_ACTIONS,
  WHATSAPP_ACCOUNT_ID_PATTERN,
  WHATSAPP_LINK_METHODS,
  type WhatsAppAccountActionInput,
  type WhatsAppAccountAddInput,
  type WhatsAppLinkInput,
} from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import { isObject } from "./validation";

export function parseWhatsAppAccountId(input: unknown): string {
  if (typeof input !== "string" || !WHATSAPP_ACCOUNT_ID_PATTERN.test(input)) {
    throw new Error("WhatsApp account id is invalid.");
  }
  return input;
}

function phoneOrNull(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string" || !E164_PATTERN.test(input)) throw new Error("WhatsApp number is invalid.");
  return input;
}

export function parseWhatsAppAccountAdd(input: unknown): WhatsAppAccountAddInput {
  if (!isObject(input)) throw new Error("WhatsApp account is invalid.");
  const name = typeof input.name === "string" ? cleanWhatsAppAccountName(input.name) : null;
  if (name === null) throw new Error("WhatsApp account name is invalid.");
  return { id: parseWhatsAppAccountId(input.id), name, phone: phoneOrNull(input.phone) };
}

/** A destructive action needs `confirm` equal to the id, which only the confirmation dialog sets. */
export function parseWhatsAppAccountAction(input: unknown): WhatsAppAccountActionInput {
  if (!isObject(input) || !isOneOf(WHATSAPP_ACCOUNT_ACTIONS, input.action)) {
    throw new Error("WhatsApp account action is invalid.");
  }
  const id = parseWhatsAppAccountId(input.id);
  if (isDestructiveWhatsAppAction(input.action)) {
    if (input.confirm !== id) throw new Error("WhatsApp account action needs a confirmation.");
    return { action: input.action, id, confirm: id };
  }
  return { action: input.action, id };
}

/** A pairing code needs the number; a QR code does not. */
export function parseWhatsAppLink(input: unknown): WhatsAppLinkInput {
  if (!isObject(input) || !isOneOf(WHATSAPP_LINK_METHODS, input.method)) {
    throw new Error("WhatsApp link request is invalid.");
  }
  const phone = phoneOrNull(input.phone);
  if (input.method === "code" && phone === null) throw new Error("WhatsApp number is invalid.");
  return { id: parseWhatsAppAccountId(input.id), method: input.method, phone };
}
