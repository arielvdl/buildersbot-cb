// The proxy options that each consumer reads, built from one server's egress setting. Pure: no
// Electron and no Node import, so the end-to-end check runs them as they are.
// See docs/architecture/egress-proxy.md.

import { parseIpv6 } from "@openbot/contracts/ipc";
import type { BrowserProxyOption } from "../backend/browser-egress";

/** Where the upstream proxy is, with its credentials. Main keeps it; no agent process gets it. */
export interface EgressUpstream {
  host: string;
  port: number;
  username: string;
  password: string;
}

/** The loopback gateway that agent processes and the Playwright browser use. */
export interface EgressGatewayAddress {
  port: number;
  username: string;
  token: string;
}

/** What the proxy means for traffic now. `blocked` refuses all but the bypass hosts. */
export type EgressMode =
  | { kind: "off" }
  | { kind: "proxy"; upstream: EgressUpstream; bypass: readonly string[] }
  | { kind: "blocked"; bypass: readonly string[] };

/** The variable names that tools read, in both cases: curl reads lower case first, Go and Node upper case. */
export const EGRESS_ENVIRONMENT_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

/** Always direct, whatever the list says: the gateway and the agents' own local servers are here. */
const LOOPBACK_ENTRIES = ["localhost", "127.0.0.1", "::1"];

function bracketed(host: string): string {
  return parseIpv6(host) ? `[${host}]` : host;
}

/**
 * The Chromium bypass list (`proxyBypassRules`, `--proxy-bypass-list`, Playwright `bypass`): a
 * comma-separated list. An IPv6 address takes brackets; a CIDR range does not.
 */
export function chromiumBypassList(rules: readonly string[]): string {
  const entries = rules.map((rule) => (rule.includes("/") ? rule : bracketed(rule)));
  return [...new Set([...entries, "localhost", "127.0.0.1", "[::1]"])].join(",");
}

/**
 * `NO_PROXY`: hosts, `.example.com` for a whole domain, addresses and CIDR ranges. `*.example.com`
 * gives both `example.com` forms, because the tools read a leading dot in different ways. Not every
 * tool reads a CIDR range, so the loopback addresses are named too.
 */
export function noProxyValue(rules: readonly string[]): string {
  const entries: string[] = [...LOOPBACK_ENTRIES];
  for (const rule of rules) {
    if (rule === "<local>") continue;
    if (rule.startsWith("*.")) entries.push(rule.slice(1));
    else entries.push(rule);
  }
  return [...new Set(entries)].join(",");
}

/** The gateway URL with its token, as a tool reads it from `HTTP_PROXY`. */
export function gatewayProxyUrl(gateway: EgressGatewayAddress): string {
  return `http://${encodeURIComponent(gateway.username)}:${encodeURIComponent(gateway.token)}@127.0.0.1:${gateway.port}`;
}

/**
 * The variables of every process that an agent starts. Off gives none, so nothing changes. Proxy and
 * blocked both point at the gateway: the gateway refuses in the blocked mode, so a tool never goes
 * direct. `NODE_USE_ENV_PROXY` makes the `fetch` of Node 24 read the variables.
 */
export function egressEnvironment(mode: EgressMode, gateway: EgressGatewayAddress | null): Record<string, string> {
  if (mode.kind === "off" || !gateway) return {};
  const url = gatewayProxyUrl(gateway);
  const noProxy = noProxyValue(mode.bypass);
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: noProxy,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1",
  };
}

/** The Electron `session.setProxy` option for one mode. */
export type ElectronProxyOption = BrowserProxyOption;

/**
 * The embedded browser goes to the upstream directly. No `direct://` is in the rules, so Chromium
 * cannot fall back to a direct connection when the proxy fails. The blocked mode keeps the last
 * proxy rule out: the request gate cancels each request, so a dead address is the rule.
 */
export function electronProxyOption(mode: EgressMode): ElectronProxyOption {
  if (mode.kind === "off") return { mode: "system" };
  const bypass = chromiumBypassList(mode.bypass);
  // Port 9 on loopback (discard) is closed on macOS, Linux and Windows by default, so a request that
  // the gate did not see fails at once instead of going direct.
  const rule =
    mode.kind === "proxy" ? `http://${bracketed(mode.upstream.host)}:${mode.upstream.port}` : "http://127.0.0.1:9";
  return { mode: "fixed_servers", proxyRules: rule, proxyBypassRules: bypass };
}

/** The Playwright `launchOptions.proxy` of the shared browser: the gateway, with its token. */
export interface PlaywrightProxyOption {
  server: string;
  username: string;
  password: string;
  bypass: string;
}

export function playwrightProxyOption(
  mode: EgressMode,
  gateway: EgressGatewayAddress | null,
): PlaywrightProxyOption | null {
  if (mode.kind === "off" || !gateway) return null;
  return {
    server: `http://127.0.0.1:${gateway.port}`,
    username: gateway.username,
    password: gateway.token,
    bypass: chromiumBypassList(mode.bypass),
  };
}

/** The `Proxy-Authorization` value for the upstream, or null when it needs no sign-in. */
export function upstreamAuthorization(upstream: EgressUpstream): string | null {
  if (!upstream.username) return null;
  return `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`, "utf8").toString("base64")}`;
}
