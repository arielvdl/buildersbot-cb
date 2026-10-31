// The egress proxy of this server process: its state, its check, and what each kind of traffic gets.
// See docs/architecture/egress-proxy.md for the rules, and the fail-closed table above all.
//
// No Electron import: the embedded browser sessions arrive as `EgressSessionPort`s, so the
// end-to-end check drives this service with fakes and a real gateway.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EGRESS_PROXY_BLOCKING_REASONS,
  type EgressProxyCheck,
  type EgressProxyErrorReason,
  type EgressProxyUpdate,
  type EgressProxyView,
  egressBypassMatches,
  egressSettingsComplete,
  normalizeEgressHost,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { PlaywrightEgressLaunch } from "../backend/agent/playwright-browser-access";
import type { BrowserEgress, BrowserEgressSession, BrowserProxyLogin } from "../backend/browser-egress";
import { runCauseEffect } from "../backend/effect-boundary";
import type { EgressGateway, EgressGatewayRoute, EgressTrafficResult } from "./egress-gateway";
import { checkEgressProxy, type EgressCheckResult } from "./egress-proxy-check";
import {
  type EgressGatewayAddress,
  type EgressMode,
  type EgressUpstream,
  egressEnvironment,
  electronProxyOption,
  type PlaywrightProxyOption,
  playwrightProxyOption,
} from "./egress-proxy-options";
import type { EgressProxyStore } from "./egress-proxy-store";

/** One embedded browser session, as `BrowserHost` gives it. */
export type EgressSessionPort = BrowserEgressSession;

interface AttachedSession {
  readonly port: EgressSessionPort;
  /** The mode signature that this session has applied, or null while none is. */
  applied: string | null;
  /** Whether `setProxy` ever ran here. A session that the switch never touched stays as it was. */
  touched: boolean;
  ready: Promise<void>;
}

export type EgressLoginAnswer = BrowserProxyLogin;

export interface EgressProxyServiceOptions {
  store: EgressProxyStore;
  gateway: EgressGateway;
  check?: (upstream: EgressUpstream) => Promise<EgressCheckResult>;
  now?: () => Date;
  log?: { warn: (message: string, detail?: unknown) => void };
}

/** The address of a gateway that did not start: closed, so a tool fails there instead of going direct. */
const CLOSED_GATEWAY: EgressGatewayAddress = { port: 9, username: "builders-bot", token: "unavailable" };
/** A second proxy challenge for the same page within this time means the credentials were refused. */
const LOGIN_RETRY_WINDOW_MS = 30_000;
const MAX_LOGIN_ATTEMPTS = 256;
/** Chromium errors that name the proxy: `PROXY_CONNECTION_FAILED`, and the two refused sign-ins. */
const PROXY_UNREACHABLE_CODES = new Set([-130]);
const PROXY_AUTH_CODES = new Set([-127, -115]);
/** `TUNNEL_CONNECTION_FAILED` and `BLOCKED_BY_CLIENT`: the proxy or the gate refused the page. */
const PROXY_PAGE_CODES = new Set([-111, -20, ...PROXY_UNREACHABLE_CODES, ...PROXY_AUTH_CODES]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);

export class EgressProxyService implements BrowserEgress {
  readonly #store: EgressProxyStore;
  readonly #gateway: EgressGateway;
  readonly #check: (upstream: EgressUpstream) => Promise<EgressCheckResult>;
  readonly #now: () => Date;
  readonly #log: EgressProxyServiceOptions["log"];
  readonly #sessions = new Set<AttachedSession>();
  readonly #listeners = new Set<(mode: EgressMode) => void>();
  readonly #loginAttempts = new Map<string, { generation: number; at: number }>();
  #failure: { reason: EgressProxyErrorReason; at: string } | null = null;
  #lastCheck: EgressProxyCheck | null = null;
  /** Bumped by each save, so a new password reaches the sessions and the sign-in retries start again. */
  #generation = 0;
  #signature: string | null = null;
  #checking: Promise<EgressProxyView> | null = null;
  #webRtcTouched = false;

  constructor(options: EgressProxyServiceOptions) {
    this.#store = options.store;
    this.#gateway = options.gateway;
    this.#check = options.check ?? ((upstream) => checkEgressProxy(upstream));
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log;
  }

  /** What the gateway does with a new connection. Off refuses too: a tool that has the address was told to use the proxy. */
  gatewayRoute(): EgressGatewayRoute {
    const mode = this.mode();
    return mode.kind === "proxy" ? { kind: "proxy", upstream: mode.upstream } : { kind: "blocked" };
  }

  /** Called by the gateway for each connection it ends or opens. */
  onTraffic(result: EgressTrafficResult): void {
    if (result === "ok") {
      if (this.#failure && (this.#failure.reason === "unreachable" || this.#failure.reason === "auth")) {
        this.#failure = null;
        this.#changed();
      }
      return;
    }
    this.#fail(result);
  }

  /** At the start of the server process: the gateway listens, and a check runs in the background. */
  async start(): Promise<void> {
    if (!this.#store.settings().enabled) return;
    await this.#startGateway();
    this.#changed();
    void this.test().catch((error: unknown) => this.#log?.warn("The egress proxy check did not run.", error));
  }

  async close(): Promise<void> {
    await this.#gateway.stop();
  }

  mode(): EgressMode {
    const settings = this.#store.settings();
    if (!settings.enabled) return { kind: "off" };
    const bypass = settings.bypass;
    if (this.#blockingReason() !== null) return { kind: "blocked", bypass };
    const upstream = this.#upstream();
    return upstream ? { kind: "proxy", upstream, bypass } : { kind: "blocked", bypass };
  }

  view(): EgressProxyView {
    const settings = this.#store.settings();
    const passwordSaved = this.#store.passwordSaved();
    const reason = settings.enabled ? (this.#blockingReason() ?? this.#failure?.reason ?? null) : null;
    return {
      ...settings,
      bypass: [...settings.bypass],
      passwordSaved,
      state: !settings.enabled ? "off" : reason ? "error" : "active",
      reason,
      failedAt: reason ? (this.#failure?.at ?? this.#now().toISOString()) : null,
      lastCheck: this.#lastCheck,
    };
  }

  /**
   * Saves a change from an admin. With the switch on, the setting must name a whole upstream, and
   * a check runs before the answer, so the admin sees the address and the country at once.
   */
  async update(input: EgressProxyUpdate): Promise<EgressProxyView> {
    const savedPassword = this.#store.unreadable() ? false : this.#store.passwordSaved();
    const passwordSaved = input.password === undefined ? savedPassword : input.password.length > 0;
    if (input.enabled && !egressSettingsComplete(input, passwordSaved))
      throw new Error(sourceText("error.host.egressIncomplete"));
    await runCauseEffect(this.#store.save(input));
    this.#generation += 1;
    this.#loginAttempts.clear();
    this.#failure = null;
    this.#lastCheck = null;
    if (input.enabled) await this.#startGateway();
    this.#changed();
    await this.#settled();
    return input.enabled ? this.test() : this.view();
  }

  /** The retry: checks the upstream again and applies the result. */
  test(): Promise<EgressProxyView> {
    this.#checking ??= this.#runCheck().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #runCheck(): Promise<EgressProxyView> {
    const settings = this.#store.settings();
    const upstream = this.#upstream();
    if (!settings.enabled || !upstream || this.#store.unreadable()) return this.view();
    const result = await this.#check(upstream);
    if (!result.ok) {
      this.#fail(result.reason);
      return this.view();
    }
    const countryMatches = result.country === settings.expectedCountry;
    this.#lastCheck = {
      ip: result.ip,
      city: result.city,
      region: result.region,
      country: result.country,
      checkedAt: this.#now().toISOString(),
      countryMatches,
    };
    if (!countryMatches && settings.blockOtherCountry) this.#fail("country");
    else if (this.#failure) {
      this.#failure = null;
      this.#changed();
    }
    await this.#settled();
    return this.view();
  }

  /** The variables of every process that an agent starts, read at each spawn. Empty while off. */
  environment(): Record<string, string> {
    const mode = this.mode();
    return egressEnvironment(mode, mode.kind === "off" ? null : (this.#gateway.address() ?? CLOSED_GATEWAY));
  }

  /** The `launchOptions.proxy` of the shared Playwright browser, or null while off. */
  playwrightProxy(): PlaywrightProxyOption | null {
    const mode = this.mode();
    return playwrightProxyOption(mode, mode.kind === "off" ? null : (this.#gateway.address() ?? CLOSED_GATEWAY));
  }

  /** Called on each change of the mode, with the new mode. */
  subscribe(listener: (mode: EgressMode) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A new embedded browser session. While the switch is on, its requests wait at the gate until the
   * proxy is set, so the first request of a restored tab cannot go direct.
   */
  attachSession(port: EgressSessionPort): void {
    // The signature follows the mode first, so the new session applies the mode of now.
    this.#changed();
    const session: AttachedSession = { port, applied: null, touched: false, ready: Promise.resolve() };
    this.#sessions.add(session);
    const mode = this.mode();
    if (mode.kind === "off") return;
    session.ready = this.#applyTo(session, mode, this.#signatureOf(mode));
  }

  /**
   * The answer to a `login` event of a browser tab. Only a challenge of the configured proxy is
   * answered. The same page asking again within a short time means that the proxy refused the
   * credentials: the sign-in is cancelled, never shown to the person, and the state says so.
   */
  proxyLogin(
    contentsId: number,
    url: string,
    authInfo: { isProxy: boolean; host: string; port: number },
  ): EgressLoginAnswer {
    if (!authInfo.isProxy) return null;
    const mode = this.mode();
    if (mode.kind === "off") return null;
    if (mode.kind === "blocked") return "cancel";
    const { upstream } = mode;
    if (normalizeEgressHost(authInfo.host) !== upstream.host || authInfo.port !== upstream.port) return null;
    if (!upstream.username) return "cancel";
    const now = this.#now().getTime();
    const key = `${contentsId} ${url}`;
    const attempt = this.#loginAttempts.get(key);
    if (attempt && attempt.generation === this.#generation && now - attempt.at < LOGIN_RETRY_WINDOW_MS) {
      this.#loginAttempts.delete(key);
      this.#fail("auth");
      return "cancel";
    }
    if (this.#loginAttempts.size >= MAX_LOGIN_ATTEMPTS) this.#loginAttempts.clear();
    this.#loginAttempts.set(key, { generation: this.#generation, at: now });
    return { username: upstream.username, password: upstream.password };
  }

  /**
   * The WebRTC policy of a browser tab: no UDP outside the proxy while the switch is on, so a page
   * cannot read the real address. Null leaves a tab that the switch never touched as it is.
   */
  webRtcPolicy(): "default" | "disable_non_proxied_udp" | null {
    if (this.mode().kind === "off") return this.#webRtcTouched ? "default" : null;
    this.#webRtcTouched = true;
    return "disable_non_proxied_udp";
  }

  /** A main-frame load failed with this Chromium code. The proxy codes change the state. */
  reportPageFailure(code: number): void {
    if (this.mode().kind !== "proxy") return;
    if (PROXY_UNREACHABLE_CODES.has(code)) this.#fail("unreachable");
    else if (PROXY_AUTH_CODES.has(code)) this.#fail("auth");
  }

  /** The sentence for an agent whose page did not load because of the proxy, or null. */
  pageFailureText(code: number): string | null {
    const mode = this.mode();
    if (mode.kind === "off" || !PROXY_PAGE_CODES.has(code)) return null;
    return mode.kind === "blocked" ? sourceText("error.host.egressBlocked") : sourceText("error.host.egressPageFailed");
  }

  #upstream(): EgressUpstream | null {
    const settings = this.#store.settings();
    const password = this.#store.password() ?? "";
    if (!egressSettingsComplete(settings, this.#store.passwordSaved()) || settings.port === null) return null;
    return { host: settings.host, port: settings.port, username: settings.username, password };
  }

  #blockingReason(): EgressProxyErrorReason | null {
    const settings = this.#store.settings();
    if (!settings.enabled) return null;
    if (this.#store.unreadable()) return "secret";
    if (!egressSettingsComplete(settings, this.#store.passwordSaved())) return "incomplete";
    if (this.#failure?.reason === "country" && settings.blockOtherCountry) return "country";
    return null;
  }

  #fail(reason: EgressProxyErrorReason): void {
    // A blocking reason stays until a check or a save clears it; traffic results do not replace it.
    if (
      this.#failure &&
      EGRESS_PROXY_BLOCKING_REASONS.has(this.#failure.reason) &&
      !EGRESS_PROXY_BLOCKING_REASONS.has(reason)
    )
      return;
    if (this.#failure?.reason === reason) return;
    this.#failure = { reason, at: this.#now().toISOString() };
    this.#changed();
  }

  async #startGateway(): Promise<void> {
    try {
      await this.#gateway.start();
    } catch (error) {
      // The agents then get a closed address: their requests fail, and none goes direct.
      this.#log?.warn("The egress gateway did not start.", error);
    }
  }

  #signatureOf(mode: EgressMode): string {
    if (mode.kind === "off") return "off";
    if (mode.kind === "blocked") return JSON.stringify(["blocked", mode.bypass]);
    const { host, port, username } = mode.upstream;
    return JSON.stringify(["proxy", host, port, username, this.#generation, mode.bypass]);
  }

  /** Applies the mode to every session when it changed, and tells the listeners. */
  #changed(): void {
    const mode = this.mode();
    const signature = this.#signatureOf(mode);
    if (signature === this.#signature) return;
    this.#signature = signature;
    for (const session of this.#sessions) {
      const previous = session.ready;
      session.ready = previous.then(() => this.#applyTo(session, mode, signature));
    }
    for (const listener of this.#listeners) {
      try {
        listener(mode);
      } catch (error) {
        this.#log?.warn("An egress proxy listener failed.", error);
      }
    }
  }

  /** Resolves when every session has applied the current mode. */
  async #settled(): Promise<void> {
    await Promise.all([...this.#sessions].map((session) => session.ready));
  }

  async #applyTo(session: AttachedSession, mode: EgressMode, signature: string): Promise<void> {
    // Each change is queued after the one before, so the last one queued is what the session keeps.
    if (mode.kind === "off" && !session.touched) {
      session.applied = signature;
      session.port.setGate(null);
      return;
    }
    session.applied = null;
    session.port.setGate((url) => this.#decide(session, url));
    try {
      await session.port.setProxy(electronProxyOption(mode));
      await session.port.closeAllConnections();
      await session.port.clearAuthCache();
    } catch (error) {
      // The gate stays and refuses: a session whose proxy is not known must not send a request.
      this.#log?.warn("The egress proxy did not apply to a browser session.", error);
      return;
    }
    session.touched = mode.kind !== "off";
    session.applied = signature;
    if (mode.kind !== "blocked") session.port.setGate(null);
  }

  async #decide(session: AttachedSession, url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!NETWORK_SCHEMES.has(parsed.protocol)) return true;
    const settings = this.#store.settings();
    if (egressBypassMatches(parsed.hostname, settings.bypass)) return true;
    // A change can queue behind the one awaited here, so wait until the session has the mode of now.
    for (let waits = 0; waits < 8; waits += 1) {
      const ready = session.ready;
      await ready.catch(() => undefined);
      const mode = this.mode();
      if (mode.kind === "blocked") return false;
      if (session.applied === this.#signatureOf(mode)) return true;
      if (session.ready === ready) return false;
    }
    return false;
  }
}

/** The profile folder of the server's own Playwright browser while the egress proxy is on. */
const PLAYWRIGHT_EGRESS_PROFILE = "playwright-egress-profile";
const PLAYWRIGHT_EGRESS_CONFIG = "openbot-playwright-egress.json";

/**
 * Writes the `@playwright/mcp` configuration file with the proxy of the browser, readable by this
 * user only. It holds the gateway token, which is valid on loopback and for this process only.
 */
export function writePlaywrightEgressConfig(userData: string, proxy: PlaywrightProxyOption): PlaywrightEgressLaunch {
  const configPath = join(userData, PLAYWRIGHT_EGRESS_CONFIG);
  const userDataDir = join(userData, PLAYWRIGHT_EGRESS_PROFILE);
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify({ browser: { launchOptions: { proxy } } })}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { configPath, userDataDir };
}
