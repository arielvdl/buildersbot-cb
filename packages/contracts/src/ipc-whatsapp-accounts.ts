// The WhatsApp accounts of the wazap server that the WhatsApp plugin starts. wazap keeps them; the
// app reads and changes them through its CLI. See docs/architecture/whatsapp-accounts.md.

/** The npm package and version that the WhatsApp listing starts. Main runs the same one. */
export const WAZAP_PACKAGE = "wazap-mcp@1.6.0";

/** wazap's own rule for an account id. */
export const WHATSAPP_ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const WHATSAPP_ACCOUNT_ID_MAX = 32;
export const WHATSAPP_ACCOUNT_NAME_MAX = 64;

/** E.164: a plus sign and 8 to 15 digits, with no leading zero. wazap refuses other lengths. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export const WHATSAPP_ACCOUNT_STATES = ["linked", "not-linked", "linking", "disabled", "error"] as const;
export type WhatsAppAccountState = (typeof WHATSAPP_ACCOUNT_STATES)[number];

/** One wazap account, as the panel shows it. Numbers are masked in main and never sent whole. */
export interface WhatsAppAccount {
  id: string;
  /** The nickname: wazap's account name. */
  name: string;
  /** The linked number with only its last digits, such as "•••• 0100". */
  number: string | null;
  /**
   * The number that the account had before, when it is not linked now: the `owner` of
   * `accounts.json`, or the `owner` of the account database after an unlink. Masked as `number`.
   */
  formerNumber: string | null;
  /**
   * The account is not linked and keeps the history of a number that was unlinked. Only that number
   * can link to it again: another number would make wazap set the history aside and delete it.
   */
  unlinkedHistory: boolean;
  state: WhatsAppAccountState;
  isDefault: boolean;
  /** `writes: false` in accounts.json: agents can only read this account. */
  readOnly: boolean;
  /** Messages that the account keeps, when wazap counts them. */
  messages: number | null;
}

export const WHATSAPP_ACCOUNTS_ERRORS = [
  "unsupported-platform",
  "command-not-found",
  "timeout",
  "failed",
  /** A QR code needs a data folder that no server holds. */
  "qr-needs-free-folder",
  /** A wazap process holds the data folder and does not answer on its control line. */
  "server-busy",
  "invalid-phone",
  "invalid-name",
  "invalid-id",
  "id-taken",
  "already-linked",
  "owner-mismatch",
  /** The account keeps the history of an unlinked number, and the number to link is not that one. */
  "has-history",
  "number-in-use",
  "account-not-found",
  "account-disabled",
  "last-account",
  /** A running server serves only this account, so wazap does not remove it. */
  "only-served",
  "rate-limited",
  "restricted",
] as const;
export type WhatsAppAccountsError = (typeof WHATSAPP_ACCOUNTS_ERRORS)[number];

export type WhatsAppAccountsSnapshot =
  | {
      status: "ready";
      accounts: WhatsAppAccount[];
      serverRunning: boolean;
      /** `WAZAP_READ_ONLY` in the data folder's `.env`: no account can send, whatever its own flag. */
      globalReadOnly: boolean;
    }
  | { status: "unavailable"; error: WhatsAppAccountsError };

export const WHATSAPP_ACCOUNT_ACTIONS = [
  "enable",
  "disable",
  "default",
  "read-only",
  "writable",
  "unlink",
  "remove",
] as const;
export type WhatsAppAccountAction = (typeof WHATSAPP_ACCOUNT_ACTIONS)[number];

/**
 * Actions that delete something or take an account away from every agent. Main refuses them unless
 * `confirm` repeats the account id.
 */
export const WHATSAPP_DESTRUCTIVE_ACTIONS = [
  "unlink",
  "remove",
  "disable",
] as const satisfies readonly WhatsAppAccountAction[];

export function isDestructiveWhatsAppAction(
  action: WhatsAppAccountAction,
): action is (typeof WHATSAPP_DESTRUCTIVE_ACTIONS)[number] {
  return WHATSAPP_DESTRUCTIVE_ACTIONS.some((destructive) => destructive === action);
}

export interface WhatsAppAccountActionInput {
  action: WhatsAppAccountAction;
  id: string;
  /** The account id again. Only the confirmation dialog sets it, and only for a destructive action. */
  confirm?: string | undefined;
}

export interface WhatsAppAccountAddInput {
  id: string;
  name: string;
  /** The number in E.164, when the person gave one. Main checks that no other account has it. */
  phone: string | null;
}

/** `restart-needed`: a running server reads the change only when it starts again. */
export const WHATSAPP_ACCOUNT_NOTICES = ["restart-needed", "kept-running"] as const;
export type WhatsAppAccountNotice = (typeof WHATSAPP_ACCOUNT_NOTICES)[number];

export type WhatsAppAccountsResult =
  | { ok: true; snapshot: WhatsAppAccountsSnapshot; notice: WhatsAppAccountNotice | null }
  | { ok: false; error: WhatsAppAccountsError; snapshot: WhatsAppAccountsSnapshot | null };

export const WHATSAPP_LINK_METHODS = ["code", "qr"] as const;
export type WhatsAppLinkMethod = (typeof WHATSAPP_LINK_METHODS)[number];

export interface WhatsAppLinkInput {
  id: string;
  method: WhatsAppLinkMethod;
  /** E.164. A pairing code needs it; a QR code does not. */
  phone: string | null;
}

/** The longest side of a QR that main sends, in modules. A version 40 QR is 177. */
export const WHATSAPP_QR_MAX_MODULES = 200;

/**
 * Where one pairing is. `code` is the 8-character code as `XXXX-XXXX`. `qr` is the QR code as rows of
 * `1` (dark) and `0` (light), without the quiet zone. `expiresAt` is a time in milliseconds.
 * `otherNumber` on `linked`: the account linked to a number that is not the one that the person typed.
 */
export type WhatsAppLinkState =
  | { phase: "starting" }
  | { phase: "code"; code: string; expiresAt: number }
  | { phase: "qr"; rows: string[]; expiresAt: number }
  | { phase: "linked"; otherNumber: boolean }
  | { phase: "expired" }
  | { phase: "failed"; error: WhatsAppAccountsError };

export const WHATSAPP_PAIRING_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** A country of the number field: its region code, dial code and the length of a national number. */
export interface WhatsAppCountry {
  region: string;
  dial: string;
  min: number;
  max: number;
}

/** Brazil first: it is the default. The others follow by how often the users of the app need them. */
export const WHATSAPP_COUNTRIES: readonly WhatsAppCountry[] = [
  { region: "BR", dial: "55", min: 10, max: 11 },
  { region: "PT", dial: "351", min: 9, max: 9 },
  { region: "US", dial: "1", min: 10, max: 10 },
  { region: "ES", dial: "34", min: 9, max: 9 },
  { region: "AR", dial: "54", min: 10, max: 11 },
  { region: "MX", dial: "52", min: 10, max: 10 },
  { region: "CO", dial: "57", min: 10, max: 10 },
  { region: "CL", dial: "56", min: 9, max: 9 },
  { region: "PE", dial: "51", min: 9, max: 9 },
  { region: "UY", dial: "598", min: 8, max: 8 },
  { region: "PY", dial: "595", min: 9, max: 9 },
  { region: "GB", dial: "44", min: 10, max: 10 },
  { region: "FR", dial: "33", min: 9, max: 9 },
  { region: "DE", dial: "49", min: 7, max: 12 },
  { region: "IT", dial: "39", min: 9, max: 11 },
  { region: "AO", dial: "244", min: 9, max: 9 },
  { region: "MZ", dial: "258", min: 9, max: 9 },
];

export const DEFAULT_WHATSAPP_REGION = "BR";

/**
 * A number in E.164 (`+` and digits), or null when the text is not a number of that country.
 *
 * A text that starts with `+` is already international, and the country does not apply. Otherwise
 * spaces, dashes, dots and brackets go, a trunk `0` goes, and a dial code that the person typed
 * before the national number goes.
 */
export function normalizeWhatsAppPhone(input: string, region: string): string | null {
  const text = input.trim();
  if (text.length === 0 || text.length > 32 || !/^\+?[\d\s\-().]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) {
    const international = `+${digits}`;
    return E164_PATTERN.test(international) ? international : null;
  }
  const country = WHATSAPP_COUNTRIES.find((entry) => entry.region === region);
  if (!country) return null;
  const fits = (value: string) => value.length >= country.min && value.length <= country.max;
  let national = digits.replace(/^0+/, "");
  if (!fits(national) && national.startsWith(country.dial) && fits(national.slice(country.dial.length))) {
    national = national.slice(country.dial.length);
  }
  if (!fits(national)) return null;
  const international = `+${country.dial}${national}`;
  return E164_PATTERN.test(international) ? international : null;
}

/** Digits of a Brazilian mobile number without its ninth digit: `55 DD 9 XXXXXXXX` becomes `55 DD XXXXXXXX`. */
function withoutBrazilianNinthDigit(digits: string): string {
  return /^55\d{2}9\d{8}$/.test(digits) ? `${digits.slice(0, 4)}${digits.slice(5)}` : digits;
}

/**
 * Whether two numbers are the same WhatsApp number. Only the digits count, so E.164 and the digits
 * of a WhatsApp id compare. The WhatsApp id of many Brazilian mobile numbers has no ninth digit:
 * `+55 47 9 9999 0100` and `55 47 9999 0100` are the same number.
 */
export function sameWhatsAppNumber(a: string, b: string): boolean {
  const left = a.replace(/\D/g, "");
  const right = b.replace(/\D/g, "");
  if (left.length === 0 || right.length === 0) return false;
  return left === right || withoutBrazilianNinthDigit(left) === withoutBrazilianNinthDigit(right);
}

/** The digits of a number with only the last four shown: "•••• 0100". */
export function maskWhatsAppNumber(digits: string): string {
  const clean = digits.replace(/\D/g, "");
  return clean.length < 4 ? "••••" : `•••• ${clean.slice(-4)}`;
}

/**
 * A nickname that wazap can keep: trimmed, 1 to 64 characters, with no control character and no
 * brace or square bracket. `npx` runs the wazap command through `sh`, and its quoting leaves `{`, `}`,
 * `[` and `]` bare, so the shell would expand `Loja{1,2}` to `Loja2`.
 */
export function cleanWhatsAppAccountName(input: string): string | null {
  const name = input.trim();
  if (name.length === 0 || [...name].length > WHATSAPP_ACCOUNT_NAME_MAX) return null;
  if (/\p{Cc}|\p{Zl}|\p{Zp}|[{}[\]]/u.test(name)) return null;
  return name;
}

/**
 * The account id for a nickname: lowercase letters, digits and dashes, at most 32 characters, and
 * not one of `taken`. "WhatsApp do Ariel" is `whatsapp-do-ariel`; a second one is
 * `whatsapp-do-ariel-2`.
 */
export function whatsAppAccountSlug(name: string, taken: readonly string[] = []): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, WHATSAPP_ACCOUNT_ID_MAX)
      .replace(/-+$/g, "") || "account";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, WHATSAPP_ACCOUNT_ID_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Whether a stdio MCP server is wazap: the listing's `npx -y wazap-mcp@<version>`, or a global `wazap`. */
export function isWazapServer(server: { transport: string; command: string; args: readonly string[] }): boolean {
  if (server.transport !== "stdio") return false;
  const command = server.command.trim().split(/[\\/]/).pop() ?? "";
  if (command === "wazap" || command === "wazap-mcp") return true;
  return server.args.some((arg) => /^wazap-mcp(@[\w.-]+)?$/.test(arg.trim()));
}
