import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  type BrowserSignInCookie,
  browserSignInCookieFitsHost,
} from "@openbot/contracts/team-protocol/browser-sign-in-v1";

const run = promisify(execFile);

const CHROME_ROOT = join(homedir(), "Library", "Application Support", "Google", "Chrome");
const CHROME_KEYCHAIN_SERVICE = "Chrome Safe Storage";
const CHROME_KEYCHAIN_ACCOUNT = "Chrome";
/** Chrome counts cookie times in microseconds since 1601, too large for a JavaScript number: the query divides them. */
const WINDOWS_EPOCH_OFFSET_S = 11_644_473_600;
const SAME_SITE: Record<number, BrowserSignInCookie["sameSite"]> = {
  0: "no_restriction",
  1: "lax",
  2: "strict",
};
/** More cookies than a login ever needs. The import refuses to carry a whole browser. */
const MAX_COOKIES = 150;

interface CookieRow {
  host_key: string;
  name: string;
  path: string;
  /** Seconds since 1601, or 0 for a cookie that ends with the session. */
  expires_s: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  last_access_s: number;
  encrypted_value: Uint8Array;
  value: string;
}

/** The key Chrome derives from its keychain secret for the `v10` cookie format on macOS. */
export function chromeCookieKey(secret: string): Buffer {
  return pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
}

/**
 * The value of one `v10` cookie. Chrome 130 and later put the SHA-256 of the cookie's host in front
 * of the value before encrypting, so a value whose first 32 bytes are that hash loses them.
 */
export function decryptChromeCookie(encrypted: Uint8Array, key: Buffer, hostKey: string): string | null {
  const bytes = Buffer.from(encrypted);
  if (bytes.length < 3 || bytes.subarray(0, 3).toString("latin1") !== "v10") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
    const hash = createHash("sha256").update(hostKey).digest();
    const value = plain.length >= 32 && plain.subarray(0, 32).equals(hash) ? plain.subarray(32) : plain;
    return value.toString("utf8");
  } catch {
    return null;
  }
}

/** The `host_key` values of Chrome that can belong to this host: itself and each parent domain. */
export function cookieHostKeys(hostname: string): string[] {
  const labels = hostname.toLowerCase().split(".");
  const keys = new Set<string>([hostname.toLowerCase(), `.${hostname.toLowerCase()}`]);
  for (let index = 1; index < labels.length - 1; index += 1) keys.add(`.${labels.slice(index).join(".")}`);
  return [...keys];
}

export function toSignInCookie(row: CookieRow, value: string, now: number): BrowserSignInCookie | null {
  const expirationDate = row.expires_s === 0 ? null : row.expires_s - WINDOWS_EPOCH_OFFSET_S;
  if (expirationDate !== null && expirationDate <= now) return null;
  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || "/",
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    sameSite: SAME_SITE[row.samesite] ?? "unspecified",
    expirationDate,
  };
}

export interface ChromeSiteSessionIo {
  /** The secret Chrome keeps in the keychain. macOS asks the person the first time. */
  keychainSecret(): Promise<string>;
  /** Profile folders of Chrome, the one used last first. */
  profiles(): Promise<string[]>;
  /** The cookie database of a profile copied to a private file, or null when the profile has none. */
  copyCookieDatabase(profile: string, into: string): Promise<string | null>;
  now(): number;
}

/** The profile folders that a `Local State` file names, the one used last first. */
export function profilesFromLocalState(state: unknown): string[] {
  const profile = isDynamicRecord(state) ? state.profile : undefined;
  if (!isDynamicRecord(profile)) return [];
  const all = isDynamicRecord(profile.info_cache) ? Object.keys(profile.info_cache) : [];
  const last = profile.last_used;
  return isString(last) && all.includes(last) ? [last, ...all.filter((name) => name !== last)] : all;
}

/** One row of the cookie table, or null when Chrome's schema is not what this reads. */
export function parseCookieRow(raw: unknown): CookieRow | null {
  if (!isDynamicRecord(raw)) return null;
  const { host_key, name, path, expires_s, is_secure, is_httponly, samesite, last_access_s, encrypted_value, value } =
    raw;
  if (
    !isString(host_key) ||
    !isString(name) ||
    !isString(path) ||
    !isNumber(expires_s) ||
    !isNumber(is_secure) ||
    !isNumber(is_httponly) ||
    !isNumber(samesite) ||
    !isNumber(last_access_s) ||
    !(encrypted_value instanceof Uint8Array) ||
    !isString(value)
  )
    return null;
  return { host_key, name, path, expires_s, is_secure, is_httponly, samesite, last_access_s, encrypted_value, value };
}

async function chromeProfiles(): Promise<string[]> {
  try {
    const profiles = profilesFromLocalState(JSON.parse(await readFile(join(CHROME_ROOT, "Local State"), "utf8")));
    return profiles.length > 0 ? profiles : ["Default"];
  } catch {
    return ["Default"];
  }
}

async function copyCookieDatabase(profile: string, into: string): Promise<string | null> {
  for (const relative of [join("Network", "Cookies"), "Cookies"]) {
    const target = join(into, `${profile.replaceAll(/[^A-Za-z0-9]/gu, "_")}.db`);
    try {
      await copyFile(join(CHROME_ROOT, profile, relative), target);
      return target;
    } catch {}
  }
  return null;
}

const DEFAULT_IO: ChromeSiteSessionIo = {
  async keychainSecret() {
    const { stdout } = await run("/usr/bin/security", [
      "find-generic-password",
      "-w",
      "-s",
      CHROME_KEYCHAIN_SERVICE,
      "-a",
      CHROME_KEYCHAIN_ACCOUNT,
    ]);
    return stdout.trim();
  },
  profiles: chromeProfiles,
  copyCookieDatabase,
  now: () => Date.now() / 1000,
};

/**
 * The sign-in cookies that the person's Chrome holds for one site, and nothing of any other site.
 *
 * Only the cookies of the host and of its parent domains are selected, from the one Chrome profile
 * that used them last, so two accounts of the same site never mix. The values are decrypted here
 * and handed to the caller; nothing is logged or stored.
 */
export async function readChromeSiteCookies(
  hostname: string,
  io: ChromeSiteSessionIo = DEFAULT_IO,
): Promise<BrowserSignInCookie[]> {
  const folder = await mkdtemp(join(tmpdir(), "bb-site-session-"));
  try {
    let best: { rows: CookieRow[]; lastAccess: number } | null = null;
    for (const profile of await io.profiles()) {
      const file = await io.copyCookieDatabase(profile, folder);
      if (!file) continue;
      const database = new DatabaseSync(file, { readOnly: true });
      try {
        const keys = cookieHostKeys(hostname);
        const rows = database
          .prepare(
            `SELECT host_key, name, path, expires_utc / 1000000 AS expires_s, is_secure, is_httponly, samesite,
                    last_access_utc / 1000000 AS last_access_s,
                    encrypted_value, value FROM cookies WHERE host_key IN (${keys.map(() => "?").join(",")})`,
          )
          .all(...keys)
          .map(parseCookieRow)
          .filter((row): row is CookieRow => row !== null);
        const fitting = rows.filter((row) => browserSignInCookieFitsHost(row.host_key, hostname));
        if (fitting.length === 0) continue;
        const lastAccess = Math.max(...fitting.map((row) => row.last_access_s));
        if (!best || lastAccess > best.lastAccess) best = { rows: fitting, lastAccess };
      } finally {
        database.close();
      }
    }
    if (!best) return [];
    const key = chromeCookieKey(await io.keychainSecret());
    const now = io.now();
    const cookies: BrowserSignInCookie[] = [];
    for (const row of best.rows) {
      const value = row.value || decryptChromeCookie(row.encrypted_value, key, row.host_key);
      if (value === null) continue;
      const cookie = toSignInCookie(row, value, now);
      if (cookie) cookies.push(cookie);
    }
    return cookies.slice(0, MAX_COOKIES);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
