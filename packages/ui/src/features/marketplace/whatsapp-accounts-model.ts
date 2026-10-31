import type {
  WhatsAppAccount,
  WhatsAppAccountActionInput,
  WhatsAppAccountAddInput,
  WhatsAppAccountNotice,
  WhatsAppAccountState,
  WhatsAppAccountsError,
  WhatsAppAccountsSnapshot,
  WhatsAppLinkInput,
  WhatsAppLinkState,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import type { IntegrationStatus } from "../settings/IntegrationLayout";

/**
 * The WhatsApp accounts of the wazap server on this computer, as the plugin page reads and changes
 * them. The desktop builds it from IPC calls; a story builds it from fixtures.
 */
export interface WhatsAppAccountsModel {
  /** Null until the first read ends. */
  snapshot: () => WhatsAppAccountsSnapshot | null;
  /** A read or a change runs. */
  busy: () => boolean;
  /** The last failed change. */
  error: () => WhatsAppAccountsError | null;
  notice: () => WhatsAppAccountNotice | null;
  clearMessages: () => void;
  refresh: () => Promise<void>;
  /** True when the account was added. */
  add: (input: WhatsAppAccountAddInput) => Promise<boolean>;
  /** True when the change was made. */
  act: (input: WhatsAppAccountActionInput) => Promise<boolean>;
  /** The pairing that the link dialog shows, until it is cancelled or closed. */
  link: () => { id: string; state: WhatsAppLinkState } | null;
  startLink: (input: WhatsAppLinkInput) => Promise<void>;
  /** Ends a pairing that waits. A linked account stays linked. */
  closeLink: () => Promise<void>;
}

export const WHATSAPP_STATE_LABEL = {
  linked: "plugin.whatsapp.state.linked",
  "not-linked": "plugin.whatsapp.state.notLinked",
  linking: "plugin.whatsapp.state.linking",
  disabled: "plugin.whatsapp.state.disabled",
  error: "plugin.whatsapp.state.error",
} as const satisfies Record<WhatsAppAccountState, AppTextKey>;

export const WHATSAPP_STATE_PILL = {
  linked: "connected",
  "not-linked": "idle",
  linking: "connecting",
  disabled: "unavailable",
  error: "attention",
} as const satisfies Record<WhatsAppAccountState, IntegrationStatus>;

export const WHATSAPP_ERROR_TEXT = {
  "unsupported-platform": "plugin.whatsapp.error.unsupportedPlatform",
  "command-not-found": "plugin.whatsapp.error.commandNotFound",
  timeout: "plugin.whatsapp.error.timeout",
  failed: "plugin.whatsapp.error.failed",
  "server-running": "plugin.whatsapp.error.serverRunning",
  "invalid-phone": "plugin.whatsapp.error.invalidPhone",
  "invalid-name": "plugin.whatsapp.invalidName",
  "invalid-id": "plugin.whatsapp.error.invalidId",
  "id-taken": "plugin.whatsapp.error.idTaken",
  "already-linked": "plugin.whatsapp.error.alreadyLinked",
  "owner-mismatch": "plugin.whatsapp.error.ownerMismatch",
  "number-in-use": "plugin.whatsapp.error.numberInUse",
  "account-not-found": "plugin.whatsapp.error.accountNotFound",
  "account-disabled": "plugin.whatsapp.error.accountDisabled",
  "last-account": "plugin.whatsapp.error.lastAccount",
  "rate-limited": "plugin.whatsapp.error.rateLimited",
  restricted: "plugin.whatsapp.error.restricted",
} as const satisfies Record<WhatsAppAccountsError, AppTextKey>;

export const WHATSAPP_NOTICE_TEXT = {
  "restart-needed": "plugin.whatsapp.notice.restartNeeded",
  "kept-running": "plugin.whatsapp.notice.keptRunning",
} as const satisfies Record<WhatsAppAccountNotice, AppTextKey>;

/** Whether an account can start a pairing from the panel. */
export function canLink(account: WhatsAppAccount): boolean {
  return account.state === "not-linked" || (account.state === "error" && account.number === null);
}

/** "m:ss" of the time left, never below zero. */
export function countdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
