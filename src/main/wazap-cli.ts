// The arguments that main gives the pinned wazap CLI, and the readers of what it prints. No I/O here:
// `whatsapp-accounts.ts` runs the commands. See docs/architecture/whatsapp-accounts.md.

import {
  cleanWhatsAppAccountName,
  E164_PATTERN,
  maskWhatsAppNumber,
  WAZAP_PACKAGE,
  WHATSAPP_ACCOUNT_ID_PATTERN,
  WHATSAPP_PAIRING_CODE_PATTERN,
  WHATSAPP_QR_MAX_MODULES,
  type WhatsAppAccount,
  type WhatsAppAccountNotice,
  type WhatsAppAccountState,
  type WhatsAppAccountsError,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";

/** What `npx` gets before the wazap command: the pinned package, and no prompt. */
export const WAZAP_NPX_ARGS: readonly string[] = ["-y", WAZAP_PACKAGE];

export type WazapCommand =
  | { kind: "status" }
  | { kind: "list" }
  | { kind: "add"; id: string; name: string }
  | { kind: "account"; verb: "enable" | "disable" | "default" | "remove"; id: string }
  | { kind: "writes"; id: string; on: boolean }
  | { kind: "logout"; id: string }
  | { kind: "login-code"; id: string; phone: string }
  | { kind: "login-qr"; id: string };

/** A value that must never reach the CLI: the caller decoded it badly. */
export class WazapArgumentError extends Error {}

function accountId(id: string): string {
  if (!WHATSAPP_ACCOUNT_ID_PATTERN.test(id)) throw new WazapArgumentError("Invalid wazap account id.");
  return id;
}

/**
 * The whole argument list after `npx`, one value per element. Each typed value is joined to its flag
 * with `=`, so a value that starts with `-` is never read as a flag. `dataDir` is for tests: the app
 * leaves it out, so wazap uses its default `~/.wazap`.
 */
export function wazapArgs(command: WazapCommand, dataDir?: string): string[] {
  const tail = dataDir === undefined ? [] : [`--data-dir=${dataDir}`];
  switch (command.kind) {
    case "status":
      return [...WAZAP_NPX_ARGS, "status", "--json", ...tail];
    case "list":
      return [...WAZAP_NPX_ARGS, "account", "list", ...tail];
    case "add": {
      const name = cleanWhatsAppAccountName(command.name);
      if (name === null) throw new WazapArgumentError("Invalid wazap account name.");
      return [...WAZAP_NPX_ARGS, "account", "add", accountId(command.id), `--name=${name}`, "--json", ...tail];
    }
    case "account":
      return [
        ...WAZAP_NPX_ARGS,
        "account",
        command.verb,
        accountId(command.id),
        ...(command.verb === "remove" ? ["--yes"] : []),
        ...tail,
      ];
    case "writes":
      return [
        ...WAZAP_NPX_ARGS,
        "config",
        "writes",
        command.on ? "on" : "off",
        `--account=${accountId(command.id)}`,
        ...tail,
      ];
    case "logout":
      return [...WAZAP_NPX_ARGS, "logout", `--account=${accountId(command.id)}`, ...tail];
    case "login-code":
      if (!E164_PATTERN.test(command.phone)) throw new WazapArgumentError("Invalid phone number.");
      return [
        ...WAZAP_NPX_ARGS,
        "login",
        `--account=${accountId(command.id)}`,
        `--phone=${command.phone}`,
        "--code",
        ...tail,
      ];
    case "login-qr":
      return [...WAZAP_NPX_ARGS, "login", `--account=${accountId(command.id)}`, "--qr", ...tail];
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Log text with phone numbers, pairing codes and quoted values (account ids and names) taken out.
 * Numbers come as digits, as E.164, as wazap's own mask (`+40 7xx xxx xxx`) or inside a WhatsApp id
 * (`40734…@s.whatsapp.net`).
 */
export function redactWazapText(text: string): string {
  return stripAnsi(text)
    .replace(/"[^"\n]*"/g, '"[value]"')
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[code]")
    .replace(/\+?\d[\dx][\dx\s().-]{4,}[\dx]/g, (match) => (/\d/.test(match) ? "[number]" : match))
    .replace(/\b\d{6,}(?=[:@])/g, "[number]");
}

/** One row of `accounts` in `wazap status --json`, with the number still whole: it stays in main. */
export interface WazapStatusAccount {
  id: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  /** Digits of the linked number. */
  number: string | null;
  /** Digits of the number that the account belonged to, from `owner`. */
  ownerNumber: string | null;
}

export interface WazapStorage {
  state: string;
  messages: number | null;
}

export interface WazapStatus {
  /** The data folder that wazap read, as it reports it. */
  dataDir: string | null;
  serverPid: number | null;
  accounts: WazapStatusAccount[];
  storage: ReadonlyMap<string, WazapStorage>;
}

/** The digits of an owner id such as `40734…:75@s.whatsapp.net`. */
export function ownerDigits(owner: string): string | null {
  const digits = owner.split(/[:@]/)[0] ?? "";
  return /^\d{6,15}$/.test(digits) ? digits : null;
}

function recordOrNull(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

/** The first JSON object in the text: `npx` can print a notice before it. */
function firstJsonObject(text: string): DynamicRecord | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return recordOrNull(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function digitsOf(value: unknown): string | null {
  return typeof value === "string" && /^\d{6,15}$/.test(value) ? value : null;
}

/** `wazap status --json`, or null when the text is not that report. Unknown fields are ignored. */
export function parseWazapStatus(stdout: string): WazapStatus | null {
  const report = firstJsonObject(stdout);
  if (!isDynamicRecord(report) || !Array.isArray(report.accounts)) return null;
  const accounts: WazapStatusAccount[] = [];
  for (const row of report.accounts) {
    if (!isDynamicRecord(row) || typeof row.id !== "string" || !WHATSAPP_ACCOUNT_ID_PATTERN.test(row.id)) continue;
    const linked = isDynamicRecord(row.account) ? row.account : null;
    accounts.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.trim() ? row.name : row.id,
      enabled: row.enabled !== false,
      isDefault: row.default === true,
      number: linked ? digitsOf(linked.number) : null,
      ownerNumber: typeof row.owner === "string" ? ownerDigits(row.owner) : null,
    });
  }
  const storage = new Map<string, WazapStorage>();
  const storageRows =
    isDynamicRecord(report.storage) && Array.isArray(report.storage.accounts) ? report.storage.accounts : [];
  for (const row of storageRows) {
    if (!isDynamicRecord(row) || typeof row.account !== "string") continue;
    const counts = isDynamicRecord(row.counts) ? row.counts : null;
    const messages = counts && typeof counts.messages === "number" && counts.messages >= 0 ? counts.messages : null;
    storage.set(row.account, { state: typeof row.state === "string" ? row.state : "absent", messages });
  }
  const pid = report.server_pid;
  return {
    dataDir: typeof report.data_dir === "string" ? report.data_dir : null,
    serverPid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null,
    accounts,
    storage,
  };
}

/** One line of `wazap account list`. The number is wazap's own mask, so only "linked" is read. */
export interface WazapListRow {
  id: string;
  enabled: boolean;
  isDefault: boolean;
  linked: boolean;
  name: string | null;
}

/** `wazap account list`: `<id>  enabled|disabled  <who>[  (default)]`. Other lines are skipped. */
export function parseWazapAccountList(text: string): WazapListRow[] {
  const rows: WazapListRow[] = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9-]{0,31})\s{2}(enabled|disabled)\s{2}(.+?)(\s{2}\(default\))?\s*$/.exec(raw.trim());
    if (!match) continue;
    const who = match[3] ?? "";
    const linked = who !== "not linked" && !who.startsWith("was ");
    const named = linked ? /^(.*) \(\+[\dx ]+\)$/.exec(who) : null;
    rows.push({
      id: match[1] ?? "",
      enabled: match[2] === "enabled",
      isDefault: match[4] !== undefined,
      linked,
      name: named?.[1] ?? null,
    });
  }
  return rows;
}

/** `wazap account add <id> --json`: one line, `{"account_id","created","enabled"}`. */
export function parseWazapAdd(stdout: string): { id: string; created: boolean } | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const value = firstJsonObject(line);
    if (isDynamicRecord(value) && typeof value.account_id === "string" && typeof value.created === "boolean") {
      return WHATSAPP_ACCOUNT_ID_PATTERN.test(value.account_id)
        ? { id: value.account_id, created: value.created }
        : null;
    }
  }
  return null;
}

/** How a `wazap login` run stands after the lines read so far. */
export interface WazapLoginProgress {
  code: string | null;
  /** The last whole QR that the CLI drew: rows of `1` (dark) and `0` (light). */
  qr: string[] | null;
  linked: boolean;
}

const QR_CHARS = /^[█▀▄ ]+$/;
const LIGHT_TOP = new Set(["█", "▀"]);
const LIGHT_BOTTOM = new Set(["█", "▄"]);

/**
 * A QR from the half-block drawing of `qrcode-terminal` (small mode): `█` is two light modules, `▀`
 * light over dark, `▄` dark over light, a space two dark modules. The top border's upper half and
 * the bottom border's lower half are outside the code; the light quiet zone is also cut off. Null
 * when the drawing is not a whole QR.
 */
export function parseQrDrawing(lines: readonly string[]): string[] | null {
  const matrix: string[] = [];
  for (const line of lines) {
    let top = "";
    let bottom = "";
    for (const ch of line) {
      top += LIGHT_TOP.has(ch) ? "0" : "1";
      bottom += LIGHT_BOTTOM.has(ch) ? "0" : "1";
    }
    matrix.push(top, bottom);
  }
  const allDark = (row: string) => /^1+$/.test(row);
  const allLight = (row: string) => /^0+$/.test(row);
  while (matrix.length > 0 && allDark(matrix[0] ?? "")) matrix.shift();
  while (matrix.length > 0 && allDark(matrix[matrix.length - 1] ?? "")) matrix.pop();
  while (matrix.length > 0 && allLight(matrix[0] ?? "")) matrix.shift();
  while (matrix.length > 0 && allLight(matrix[matrix.length - 1] ?? "")) matrix.pop();
  if (matrix.length === 0) return null;
  const width = Math.min(...matrix.map((row) => row.length));
  const column = (index: number) => matrix.map((row) => row[index]).join("");
  let left = 0;
  let right = width - 1;
  while (left < right && /^0+$/.test(column(left))) left++;
  while (right > left && /^0+$/.test(column(right))) right--;
  const rows = matrix.map((row) => row.slice(left, right + 1));
  const size = rows.length;
  const square = rows.every((row) => row.length === size);
  if (!square || size < 21 || size > Math.min(177, WHATSAPP_QR_MAX_MODULES) || (size - 17) % 4 !== 0) return null;
  return rows;
}

/** Reads what `wazap login` printed so far: the pairing code, the latest QR, and the end of a link. */
export function parseWazapLogin(text: string): WazapLoginProgress {
  const lines = stripAnsi(text).split(/\r?\n/);
  let code: string | null = null;
  let qr: string[] | null = null;
  let linked = false;
  let drawing: string[] = [];
  const closeDrawing = () => {
    if (drawing.length > 0) qr = parseQrDrawing(drawing) ?? qr;
    drawing = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.length > 0 && QR_CHARS.test(line) && /[█▀▄]/.test(line)) {
      drawing.push(line);
      continue;
    }
    closeDrawing();
    const pairing = /pairing code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(line);
    if (pairing?.[1] && WHATSAPP_PAIRING_CODE_PATTERN.test(pairing[1].toUpperCase())) code = pairing[1].toUpperCase();
    if (/\b(Already linked as|Linked as)\b/.test(line)) linked = true;
  }
  closeDrawing();
  return { code, qr, linked };
}

/** The error code of a wazap failure, from its output. The output itself never leaves main. */
export function wazapErrorCode(text: string): WhatsAppAccountsError {
  const output = stripAnsi(text);
  if (/is running \(pid \d+\)/.test(output)) return "server-running";
  if (/INVALID_PHONE|not a phone number in international format/.test(output)) return "invalid-phone";
  if (/Cannot remove the last account/.test(output)) return "last-account";
  if (/already exists/.test(output)) return "id-taken";
  if (/Invalid account id/.test(output)) return "invalid-id";
  if (/ACCOUNT_NOT_FOUND|No account "/.test(output)) return "account-not-found";
  if (/ACCOUNT_DISABLED/.test(output)) return "account-disabled";
  if (/ALREADY_LINKED|Already linked/.test(output)) return "already-linked";
  if (/RATE_LIMITED/.test(output)) return "rate-limited";
  if (/ACCOUNT_RESTRICTED/.test(output)) return "restricted";
  return "failed";
}

/** What a successful account change says about a running server. */
export function wazapNotice(text: string): WhatsAppAccountNotice | null {
  const output = stripAnsi(text);
  if (/keeps serving/.test(output)) return "kept-running";
  if (/restart it for this to apply/.test(output)) return "restart-needed";
  return null;
}

/** The `writes` flag of each account in `accounts.json`. Unreadable text gives no flags. */
export function parseWritesFlags(text: string): ReadonlyMap<string, boolean> {
  const flags = new Map<string, boolean>();
  try {
    const value = recordOrNull(JSON.parse(text));
    if (!value || !Array.isArray(value.accounts)) return flags;
    for (const row of value.accounts) {
      if (isDynamicRecord(row) && typeof row.id === "string" && typeof row.writes === "boolean")
        flags.set(row.id, row.writes);
    }
  } catch {
    /* No flags: every account follows the global setting. */
  }
  return flags;
}

/**
 * The panel row of one account. A disabled account reads as disabled, a database that wazap cannot
 * open as an error, and a pairing that runs now as linking.
 */
export function accountState(
  row: WazapStatusAccount,
  storage: WazapStorage | undefined,
  linking: boolean,
): WhatsAppAccountState {
  if (!row.enabled) return "disabled";
  if (row.number !== null) return storage?.state === "error" ? "error" : "linked";
  if (linking) return "linking";
  return storage?.state === "error" ? "error" : "not-linked";
}

export function toWhatsAppAccount(
  row: WazapStatusAccount,
  storage: WazapStorage | undefined,
  writes: boolean | undefined,
  linking: boolean,
): WhatsAppAccount {
  return {
    id: row.id,
    name: row.name,
    number: row.number === null ? null : maskWhatsAppNumber(row.number),
    formerNumber: row.number === null && row.ownerNumber !== null ? maskWhatsAppNumber(row.ownerNumber) : null,
    state: accountState(row, storage, linking),
    isDefault: row.isDefault,
    readOnly: writes === false,
    messages: storage?.messages ?? null,
  };
}

/**
 * Why a number cannot be linked into an account, or null when it can. One number is one account: a
 * number that another account has or had is refused, and so is a number other than the one that
 * this account belonged to. Linking one would set the earlier owner's history aside for deletion.
 */
export function linkRefusal(
  accounts: readonly WazapStatusAccount[],
  id: string,
  phoneDigits: string,
): WhatsAppAccountsError | null {
  const target = accounts.find((row) => row.id === id);
  if (!target) return "account-not-found";
  if (!target.enabled) return "account-disabled";
  if (target.number !== null) return "already-linked";
  if (target.ownerNumber !== null && target.ownerNumber !== phoneDigits) return "owner-mismatch";
  const elsewhere = accounts.some(
    (row) => row.id !== id && (row.number === phoneDigits || row.ownerNumber === phoneDigits),
  );
  return elsewhere ? "number-in-use" : null;
}
