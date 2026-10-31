/**
 * The network egress proxy of one server (`egress-proxy-v1`), as the host, the desktop main
 * process, the preload and the renderer read it. See `docs/architecture/egress-proxy.md`.
 *
 * Everything here is pure: the paste parser runs in the renderer, and the same checks run again in
 * the host before it saves. The password never goes into a view.
 */

import { type DynamicRecord, isBoolean, isDynamicRecord, isOneOf, isString } from "./runtime-values";

export const EGRESS_PROXY_LIMITS = {
  host: 253,
  username: 256,
  password: 256,
  line: 1_024,
  bypassRules: 64,
  bypassRule: 253,
  ip: 64,
  place: 128,
} as const;

/** The country that the check expects when the admin sets none: Brazil. */
export const EGRESS_DEFAULT_COUNTRY = "BR";

/**
 * Local addresses and the Cultura Builder control plane: sign-in, the account service and Signal
 * never go through the proxy. Loopback is always direct, also when an admin removes it here.
 */
export const EGRESS_DEFAULT_BYPASS: readonly string[] = [
  "localhost",
  "127.0.0.0/8",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "fc00::/7",
  "fe80::/10",
  "*.local",
  "culturabuilder.com",
  "*.culturabuilder.com",
  "openbot.run",
  "*.openbot.run",
];

export const EGRESS_PROXY_STATES = ["off", "active", "error"] as const;
export type EgressProxyState = (typeof EGRESS_PROXY_STATES)[number];

/**
 * Why the state is `error`. `country`, `secret` and `incomplete` block every request that is not to
 * a bypass host. `unreachable`, `auth` and `check` keep the traffic on the proxy, which fails by
 * itself: never a direct connection.
 */
export const EGRESS_PROXY_ERROR_REASONS = ["unreachable", "auth", "country", "secret", "incomplete", "check"] as const;
export type EgressProxyErrorReason = (typeof EGRESS_PROXY_ERROR_REASONS)[number];

/** The reasons that stop all traffic except to the bypass hosts. */
export const EGRESS_PROXY_BLOCKING_REASONS: ReadonlySet<EgressProxyErrorReason> = new Set([
  "country",
  "secret",
  "incomplete",
]);

/** The result of one request through the proxy to a public IP location service. */
export interface EgressProxyCheck {
  ip: string;
  city: string | null;
  region: string | null;
  /** Two upper-case letters, or null when the service gave none. */
  country: string | null;
  checkedAt: string;
  countryMatches: boolean;
}

/** What an admin edits, except the password. */
export interface EgressProxySettings {
  enabled: boolean;
  host: string;
  port: number | null;
  username: string;
  bypass: string[];
  expectedCountry: string;
  blockOtherCountry: boolean;
}

/** What a view of a server's setting shows. The password is only `passwordSaved`. */
export interface EgressProxyView extends EgressProxySettings {
  passwordSaved: boolean;
  state: EgressProxyState;
  reason: EgressProxyErrorReason | null;
  /** When the state became `error`, or null. */
  failedAt: string | null;
  lastCheck: EgressProxyCheck | null;
}

/** The app default for new servers. It is never applied to this app's own server. */
export interface EgressProxyDefaultView extends EgressProxySettings {
  passwordSaved: boolean;
}

/** A change. With `password` absent the saved password stays; an empty string removes it. */
export interface EgressProxyUpdate extends EgressProxySettings {
  password?: string;
}

/** The fields of one pasted proxy line. */
export interface EgressProxyLine {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type EgressProxyLineError = "format" | "scheme" | "host" | "port" | "username" | "password";

export type EgressProxyLineResult = { ok: true; value: EgressProxyLine } | { ok: false; error: EgressProxyLineError };

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/iu;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const COUNTRY = /^[A-Z]{2}$/u;

function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

/** Eight 16-bit groups, or null. Accepts `::` and a trailing IPv4 part. */
export function parseIpv6(value: string): number[] | null {
  const text = value.toLowerCase();
  if (!/^[0-9a-f:.]+$/u.test(text) || text.length > 45 || !text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const result: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        if (index !== pieces.length - 1 || !isIpv4(piece)) return null;
        const bytes = piece.split(".").map(Number);
        result.push(((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(piece)) return null;
        result.push(Number.parseInt(piece, 16));
      }
    }
    return result;
  };
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** A host name, an IPv4 address or an IPv6 address without brackets. Lower case. */
export function normalizeEgressHost(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > EGRESS_PROXY_LIMITS.host) return null;
  if (isIpv4(host) || parseIpv6(host)) return host;
  return host.split(".").every((label) => HOST_LABEL.test(label)) ? host : null;
}

/** No control character: a line break in a user or password would end the proxy header early. */
function validCredential(value: string, limit: number): boolean {
  if (value.length > limit) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/u.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}

function lineResult(host: string, port: string, username: string, password: string): EgressProxyLineResult {
  const normalized = normalizeEgressHost(host);
  if (!normalized) return { ok: false, error: "host" };
  const parsedPort = parsePort(port);
  if (parsedPort === null) return { ok: false, error: "port" };
  if (!validCredential(username, EGRESS_PROXY_LIMITS.username) || username.includes(":"))
    return { ok: false, error: "username" };
  if (!validCredential(password, EGRESS_PROXY_LIMITS.password)) return { ok: false, error: "password" };
  if (password && !username) return { ok: false, error: "username" };
  return { ok: true, value: { host: normalized, port: parsedPort, username, password } };
}

function decodeUrlPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Reads one pasted proxy line: `host:port:user:password`, `host:port`, `user:password@host:port`
 * or `http://user:password@host:port`. In the colon form the password is the rest of the line, so it
 * can hold `:`. An IPv6 host needs the URL form with brackets.
 */
export function parseEgressProxyLine(text: string): EgressProxyLineResult {
  const line = text.trim();
  if (!line || line.length > EGRESS_PROXY_LIMITS.line || /\s/u.test(line)) return { ok: false, error: "format" };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(line);
  if (scheme || line.includes("@")) {
    if (scheme && scheme[1]?.toLowerCase() !== "http") return { ok: false, error: "scheme" };
    let url: URL;
    try {
      url = new URL(scheme ? line : `http://${line}`);
    } catch {
      return { ok: false, error: "format" };
    }
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return { ok: false, error: "format" };
    if (!url.port) return { ok: false, error: "port" };
    const username = decodeUrlPart(url.username);
    const password = decodeUrlPart(url.password);
    if (username === null) return { ok: false, error: "username" };
    if (password === null) return { ok: false, error: "password" };
    return lineResult(url.hostname, url.port, username, password);
  }
  const parts = line.split(":");
  if (parts.length === 2) return lineResult(parts[0] ?? "", parts[1] ?? "", "", "");
  if (parts.length < 4) return { ok: false, error: "format" };
  return lineResult(parts[0] ?? "", parts[1] ?? "", parts[2] ?? "", parts.slice(3).join(":"));
}

/**
 * One bypass rule in its stored form, or null. Forms: a host name, `*.example.com` (`.example.com`
 * becomes this), an IPv4 or IPv6 address, a CIDR range, and `<local>` (names with no dot).
 */
export function normalizeEgressBypassRule(value: string): string | null {
  const rule = value.trim().toLowerCase();
  if (!rule || rule.length > EGRESS_PROXY_LIMITS.bypassRule) return null;
  if (rule === "<local>") return rule;
  const cidr = /^([^/]+)\/(\d{1,3})$/u.exec(rule);
  if (cidr) {
    const address = cidr[1] ?? "";
    const prefix = Number(cidr[2]);
    if (isIpv4(address) && prefix <= 32) return `${address}/${prefix}`;
    if (parseIpv6(address) && prefix <= 128) return `${address}/${prefix}`;
    return null;
  }
  const wildcard = rule.startsWith("*.") ? rule.slice(2) : rule.startsWith(".") ? rule.slice(1) : null;
  if (wildcard !== null) {
    const host = normalizeEgressHost(wildcard);
    return host && !isIpv4(host) && !parseIpv6(host) ? `*.${host}` : null;
  }
  return normalizeEgressHost(rule);
}

/** The rules of a list in their stored form, without repeats. Throws on a rule that is not valid. */
export function parseEgressBypassList(values: readonly string[]): string[] {
  if (values.length > EGRESS_PROXY_LIMITS.bypassRules) throw new Error("Too many egress bypass rules.");
  const rules: string[] = [];
  for (const value of values) {
    const rule = normalizeEgressBypassRule(value);
    if (rule === null) throw new Error("Invalid egress bypass rule.");
    if (!rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

function ipv4Number(value: string): number {
  return value.split(".").reduce((total, byte) => total * 256 + Number(byte), 0);
}

function inIpv4Range(host: string, network: string, prefix: number): boolean {
  if (prefix === 0) return true;
  const size = 2 ** (32 - prefix);
  return Math.floor(ipv4Number(host) / size) === Math.floor(ipv4Number(network) / size);
}

function inIpv6Range(host: number[], network: number[], prefix: number): boolean {
  let bits = prefix;
  for (let index = 0; index < 8 && bits > 0; index += 1) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if (((host[index] ?? 0) & mask) !== ((network[index] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

/** Loopback is always direct: the gateway and the agents' own local servers live there. */
export function isEgressLoopback(host: string): boolean {
  const normalized = normalizeEgressHost(host);
  if (!normalized) return false;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIpv4(normalized)) return inIpv4Range(normalized, "127.0.0.0", 8);
  // `::1` is the only IPv6 loopback address: seven zero groups and a last group of 1.
  return parseIpv6(normalized)?.join(":") === "0:0:0:0:0:0:0:1";
}

/** Whether a request to `host` goes direct, by the stored rules. */
export function egressBypassMatches(host: string, rules: readonly string[]): boolean {
  const normalized = normalizeEgressHost(host);
  if (!normalized) return false;
  if (isEgressLoopback(normalized)) return true;
  const ipv4 = isIpv4(normalized);
  const ipv6 = ipv4 ? null : parseIpv6(normalized);
  for (const rule of rules) {
    if (rule === "<local>") {
      if (!ipv4 && !ipv6 && !normalized.includes(".")) return true;
      continue;
    }
    const cidr = /^([^/]+)\/(\d{1,3})$/u.exec(rule);
    if (cidr) {
      const network = cidr[1] ?? "";
      const prefix = Number(cidr[2]);
      if (ipv4 && isIpv4(network) && inIpv4Range(normalized, network, prefix)) return true;
      const networkGroups = ipv6 ? parseIpv6(network) : null;
      if (ipv6 && networkGroups && inIpv6Range(ipv6, networkGroups, prefix)) return true;
      continue;
    }
    if (rule.startsWith("*.")) {
      if (normalized.endsWith(rule.slice(1))) return true;
      continue;
    }
    if (rule === normalized) return true;
    if (ipv6 && parseIpv6(rule)?.join(":") === ipv6.join(":")) return true;
  }
  return false;
}

/** Whether the settings name a whole upstream: a host and a port, and a password when a user is set. */
export function egressSettingsComplete(settings: EgressProxySettings, passwordSaved: boolean): boolean {
  return settings.host.length > 0 && settings.port !== null && (settings.username.length === 0 || passwordSaved);
}

function decodeCheck(value: unknown): EgressProxyCheck {
  if (!isDynamicRecord(value)) throw new Error("Invalid egress proxy check.");
  const { ip, city, region, country, checkedAt, countryMatches } = value;
  const place = (field: unknown): string | null => {
    if (field === null) return null;
    if (!isString(field) || field.length > EGRESS_PROXY_LIMITS.place) throw new Error("Invalid egress proxy check.");
    return field;
  };
  if (!isString(ip) || ip.length > EGRESS_PROXY_LIMITS.ip || !isString(checkedAt) || !isBoolean(countryMatches))
    throw new Error("Invalid egress proxy check.");
  const code = place(country);
  if (code !== null && !COUNTRY.test(code)) throw new Error("Invalid egress proxy check.");
  return { ip, city: place(city), region: place(region), country: code, checkedAt, countryMatches };
}

/**
 * The settings fields of a payload, checked the same way on each boundary. A host or user that is
 * not valid, a port out of range, a bypass rule that is not valid or a country that is not two
 * letters throws: the shape check of an input, in English.
 */
function decodeSettings(value: DynamicRecord): EgressProxySettings {
  const { enabled, host, port, username, bypass, expectedCountry, blockOtherCountry } = value;
  if (!isBoolean(enabled) || !isBoolean(blockOtherCountry)) throw new Error("Invalid egress proxy flags.");
  if (!isString(host) || (host !== "" && normalizeEgressHost(host) !== host))
    throw new Error("Invalid egress proxy host.");
  if (port !== null && (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535))
    throw new Error("Invalid egress proxy port.");
  if (!isString(username) || !validCredential(username, EGRESS_PROXY_LIMITS.username) || username.includes(":"))
    throw new Error("Invalid egress proxy user.");
  if (!Array.isArray(bypass) || !bypass.every(isString)) throw new Error("Invalid egress bypass list.");
  if (!isString(expectedCountry) || !COUNTRY.test(expectedCountry)) throw new Error("Invalid egress proxy country.");
  return {
    enabled,
    host,
    port,
    username,
    bypass: parseEgressBypassList(bypass),
    expectedCountry,
    blockOtherCountry,
  };
}

/** The input of a save, from the renderer or from a client over the Team API. */
export function parseEgressProxyUpdate(value: unknown): EgressProxyUpdate {
  if (!isDynamicRecord(value)) throw new Error("Invalid egress proxy setting.");
  const settings = decodeSettings(value);
  const { password } = value;
  if (password === undefined) return settings;
  if (!isString(password) || !validCredential(password, EGRESS_PROXY_LIMITS.password))
    throw new Error("Invalid egress proxy password.");
  return { ...settings, password };
}

/** The app default, or null when none is saved. */
export function decodeEgressProxyDefaultView(value: unknown): EgressProxyDefaultView | null {
  if (value === null) return null;
  if (!isDynamicRecord(value) || !isBoolean(value.passwordSaved)) throw new Error("Invalid egress proxy default.");
  return { ...decodeSettings(value), passwordSaved: value.passwordSaved };
}

/** A view that a host or main sent. It fails closed on any field that is not in the contract. */
export function decodeEgressProxyView(value: unknown): EgressProxyView {
  if (!isDynamicRecord(value)) throw new Error("Invalid egress proxy view.");
  const { passwordSaved, state, reason, failedAt, lastCheck } = value;
  if (
    !isBoolean(passwordSaved) ||
    !isOneOf(EGRESS_PROXY_STATES, state) ||
    (reason !== null && !isOneOf(EGRESS_PROXY_ERROR_REASONS, reason)) ||
    (failedAt !== null && !isString(failedAt))
  )
    throw new Error("Invalid egress proxy view.");
  return {
    ...decodeSettings(value),
    passwordSaved,
    state,
    reason,
    failedAt,
    lastCheck: lastCheck === null ? null : decodeCheck(lastCheck),
  };
}
