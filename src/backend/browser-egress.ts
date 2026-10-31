// What the embedded browser needs from the egress proxy of its server. Main implements it
// (`src/main/egress-proxy-service.ts`); see docs/architecture/egress-proxy.md.

/** The `session.setProxy` option. The browser host passes it to Electron as it is. */
export interface BrowserProxyOption {
  mode: "fixed_servers" | "system";
  proxyRules?: string;
  proxyBypassRules?: string;
}

/** One Electron session of the browser host, in the calls that the egress proxy makes on it. */
export interface BrowserEgressSession {
  setProxy(option: BrowserProxyOption): Promise<void>;
  closeAllConnections(): Promise<void>;
  clearAuthCache(): Promise<void>;
  /** The request gate: resolves true to let a request go. Null removes the gate. */
  setGate(gate: ((url: string) => Promise<boolean>) | null): void;
}

/** The answer to a proxy challenge: credentials, a refusal, or null when the challenge is not for us. */
export type BrowserProxyLogin = { username: string; password: string } | "cancel" | null;

export interface BrowserEgress {
  /** Called for each session before its first request. */
  attachSession(session: BrowserEgressSession): void;
  proxyLogin(
    contentsId: number,
    url: string,
    authInfo: { isProxy: boolean; host: string; port: number },
  ): BrowserProxyLogin;
  /** Null leaves the tab as it is. */
  webRtcPolicy(): "default" | "disable_non_proxied_udp" | null;
  /** Called after each change of the proxy mode. */
  subscribe(listener: () => void): () => void;
  /** A main-frame load failed with this Chromium error code. */
  reportPageFailure(code: number): void;
  /** The sentence for an agent when the proxy stopped the page, or null. */
  pageFailureText(code: number): string | null;
}

/** Adapts one Electron session. The gate is the only `onBeforeRequest` listener of the browser sessions. */
export function electronEgressSession(target: {
  setProxy(option: BrowserProxyOption): Promise<void>;
  closeAllConnections(): Promise<void>;
  clearAuthCache(): Promise<void>;
  webRequest: {
    onBeforeRequest(
      listener: ((details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void) | null,
    ): void;
  };
}): BrowserEgressSession {
  return {
    setProxy: (option) => target.setProxy(option),
    closeAllConnections: () => target.closeAllConnections(),
    clearAuthCache: () => target.clearAuthCache(),
    setGate: (gate) => {
      if (!gate) {
        target.webRequest.onBeforeRequest(null);
        return;
      }
      target.webRequest.onBeforeRequest((details, callback) => {
        gate(details.url).then(
          (allowed) => callback(allowed ? {} : { cancel: true }),
          () => callback({ cancel: true }),
        );
      });
    },
  };
}
