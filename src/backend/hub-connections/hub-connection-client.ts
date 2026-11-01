// The app side of the Hub connections contract (packages/contracts/src/hub-connections.ts).
//
// This client runs in the main process only. It holds two kinds of credential and gives neither to
// anything else:
// - the person's Cultura Builder session (access and refresh token), read from the credential store
//   through `session()`. The access token reads `/session`; the refresh token asks for proxy tokens.
// - proxy tokens (`cbp_…`), one per organization, in memory only, for at most 5 minutes. They are
//   the only credential that the proxy routes accept, so the LLM token that the agent process has
//   cannot call a connection.
// No method returns a token, and no error carries one: a failure holds a code and the HTTP status.

import { createHash } from "node:crypto";
import {
  decodeHubAccessRequestAnswer,
  decodeHubConnectionCatalog,
  decodeHubConnectionUsage,
  decodeHubError,
  decodeHubNeedsPerson,
  decodeHubProxyToken,
  decodeHubProxyTokenError,
  decodeHubSessionConnections,
  decodeToolCatalogCallOutcome,
  decodeToolCatalogDescribeAnswer,
  decodeToolCatalogSearchAnswer,
  HUB_CONNECTIONS_CONTRACT_HEADER,
  HUB_CONNECTIONS_CONTRACT_VALUE,
  HUB_CONNECTIONS_LIMITS,
  HUB_CONNECTIONS_PATHS,
  HUB_PROXY_SCOPE,
  type HubAccessRequestAnswer,
  type HubAccessRequestKind,
  type HubConnectionCatalog,
  type HubConnectionUsage,
  type HubErrorAnswer,
  type HubJson,
  type HubNeedsPersonAnswer,
  type HubProxyTokenError,
  type HubSessionConnections,
  TOOL_CATALOG_CONNECTION_ID,
  type ToolCatalogCallOutcome,
  type ToolCatalogCallRequest,
  type ToolCatalogSearchRequest,
} from "@openbot/contracts/hub-connections";
import { Effect, Schema } from "effect";
import {
  CULTURA_BUILDER_HUB,
  ensureCulturaBuilderToken,
  readCulturaBuilderSession,
  serializeCulturaBuilderSession,
} from "../cultura-builder-auth";

/**
 * Why a request did not give a contract answer. The agent and the person read a fixed text for each
 * code, never the Hub's own words:
 * - `signed_out`: no Cultura Builder session on this computer.
 * - `offline`: no answer (network error, DNS, timeout).
 * - `hub_unavailable`: a 5xx, or an answer outside the contract.
 * - `unauthorized`: the Hub refused the proxy token (401).
 * - `token_refused`: the Hub refused to give a proxy token; `tokenError` says why.
 * - `disabled`: the capability is off in `/session` (the kill switch).
 */
export const HUB_CLIENT_FAILURES = [
  "signed_out",
  "offline",
  "hub_unavailable",
  "unauthorized",
  "token_refused",
  "disabled",
] as const;
export type HubClientFailureCode = (typeof HUB_CLIENT_FAILURES)[number];

export class HubConnectionFailure extends Schema.TaggedError<HubConnectionFailure>()("HubConnectionFailure", {
  code: Schema.Literals(HUB_CLIENT_FAILURES),
  status: Schema.optional(Schema.Number),
  tokenError: Schema.optional(Schema.String),
}) {}

/** What an operation request gives back when the Hub answers with a contract body. */
export type HubOperationOutcome<Answer> =
  | { readonly kind: "answer"; readonly answer: Answer }
  | HubNeedsPersonAnswer
  | HubErrorAnswer;

export interface HubConnectionClientOptions {
  /** The stored Cultura Builder session, as the credential store keeps it. */
  session(): string | null;
  /** Saves a session whose tokens changed, so the next reader gets them. */
  saveSession(value: string): Effect.Effect<void>;
  /** Injected by tests. Production uses the global fetch, always to the Hub origin. */
  fetch?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  readonly token: string;
  readonly renewAt: number;
  readonly expiresAt: number;
}

const PROXY_RESOURCE = `${CULTURA_BUILDER_HUB}${HUB_CONNECTIONS_PATHS.proxyResource}`;
/** The key of the catalog token, which names no organization. */
const CATALOG_TOKEN = "\u0000catalog";

class HubRequestFailed extends Error {
  constructor(
    readonly code: HubClientFailureCode,
    readonly status?: number,
    readonly tokenError?: HubProxyTokenError,
  ) {
    super(`Hub request failed: ${code}${status === undefined ? "" : ` (${status})`}`);
  }
}

function failure(cause: unknown): HubConnectionFailure {
  if (cause instanceof HubRequestFailed)
    return new HubConnectionFailure({
      code: cause.code,
      ...(cause.status === undefined ? {} : { status: cause.status }),
      ...(cause.tokenError === undefined ? {} : { tokenError: cause.tokenError }),
    });
  // A thrown fetch, an abort or a decode of a broken stream: the Hub gave no answer.
  return new HubConnectionFailure({ code: "offline" });
}

/**
 * Reads a body with a byte ceiling, so a Hub that streams forever cannot hold the main process.
 * Null when the body is longer than `limit` or does not read.
 */
async function readLimited(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The parsed body, or undefined when it is empty or not JSON. The decoders check its shape. */
function parseJson(text: string | null): HubJson | undefined {
  if (text === null || text === "") return undefined;
  try {
    const parsed: HubJson = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The Hub client of the connections. One instance per main process. Caches are in memory only:
 * nothing of a connection is written to disk.
 */
export class HubConnectionClient {
  readonly #options: HubConnectionClientOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tokens = new Map<string, CachedToken>();
  readonly #pendingTokens = new Map<string, Promise<string>>();
  #session: { value: HubSessionConnections; until: number } | null = null;
  #pendingSession: Promise<HubSessionConnections> | null = null;
  #catalog: { value: HubConnectionCatalog; until: number } | null = null;
  #pendingCatalog: Promise<HubConnectionCatalog> | null = null;
  /** Bumped by `forget`, so an answer that a forgotten request brings back is not cached. */
  #generation = 0;
  /** A hash of the refresh token that the caches belong to. Another sign-in drops them. */
  #sessionKey: string | null = null;

  constructor(options: HubConnectionClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Drops every token and cache: after a sign-out, a revocation or a kill switch. */
  forget(): void {
    this.#generation += 1;
    this.#tokens.clear();
    this.#pendingTokens.clear();
    this.#session = null;
    this.#pendingSession = null;
    this.#catalog = null;
    this.#pendingCatalog = null;
  }

  /** Drops the catalog only, so the next read sees a change of organization or access. */
  forgetCatalog(): void {
    this.#catalog = null;
    this.#pendingCatalog = null;
  }

  /**
   * Drops the capabilities of `/session` and the catalog: after the Hub paused a connection, the next
   * turn reads the kill switch again instead of the copy of up to 5 minutes.
   */
  forgetCapabilities(): void {
    this.#generation += 1;
    this.#session = null;
    this.#pendingSession = null;
    this.forgetCatalog();
  }

  /** Drops the proxy token of one organization: the Hub said that it no longer pays for the person. */
  forgetOrg(orgId: string): void {
    this.#tokens.delete(orgId);
    this.#pendingTokens.delete(orgId);
    this.forgetCatalog();
  }

  /** Whether a Cultura Builder session is stored. It reads no network. */
  signedIn(): boolean {
    const session = readCulturaBuilderSession(this.#options.session());
    return session !== null && session.refresh !== "";
  }

  /**
   * Drops every token and cache when the stored session is not the one they came from: after a
   * sign-out and a sign-in as another person, no token of the first person is used.
   */
  #followSession(): void {
    const refresh = readCulturaBuilderSession(this.#options.session())?.refresh ?? "";
    const key = refresh === "" ? null : createHash("sha256").update(refresh).digest("hex");
    if (key === this.#sessionKey) return;
    this.forget();
    this.#sessionKey = key;
  }

  /** The connection capabilities of `/session`, cached for 5 minutes. */
  readonly capabilities = Effect.fn("HubConnectionClient.capabilities")((fresh = false) =>
    Effect.tryPromise({
      try: () => this.#capabilities(fresh),
      catch: failure,
    }),
  );

  /** The connection catalog, cached for its `ttlSeconds` (at most 5 minutes). */
  readonly catalog = Effect.fn("HubConnectionClient.catalog")((fresh = false) =>
    Effect.tryPromise({
      try: () => this.#readCatalog(fresh),
      catch: failure,
    }),
  );

  readonly search = Effect.fn("HubConnectionClient.search")((orgId: string, body: ToolCatalogSearchRequest) =>
    Effect.tryPromise({
      try: () =>
        this.#operation(orgId, "search", body, HUB_CONNECTIONS_LIMITS.operationBytes, decodeToolCatalogSearchAnswer),
      catch: failure,
    }),
  );

  readonly describe = Effect.fn("HubConnectionClient.describe")((orgId: string, endpointId: string) =>
    Effect.tryPromise({
      try: () =>
        this.#operation(
          orgId,
          "describe",
          { endpointId },
          HUB_CONNECTIONS_LIMITS.operationBytes,
          decodeToolCatalogDescribeAnswer,
        ),
      catch: failure,
    }),
  );

  /** One call. `idempotencyKey` is new for each logical call; the app never retries by itself. */
  readonly call = Effect.fn("HubConnectionClient.call")(
    (orgId: string, body: ToolCatalogCallRequest, idempotencyKey: string) =>
      Effect.tryPromise({
        try: () => this.#call(orgId, body, idempotencyKey),
        catch: failure,
      }),
  );

  readonly usage = Effect.fn("HubConnectionClient.usage")((orgId: string, period: string | null = null) =>
    Effect.tryPromise({
      try: async (): Promise<HubOperationOutcome<HubConnectionUsage>> => {
        const query = new URLSearchParams({ scope: "me", ...(period ? { period } : {}) });
        const { status, value } = await this.#proxyRequest(
          orgId,
          `${HUB_CONNECTIONS_PATHS.usage}?${query}`,
          "GET",
          undefined,
          HUB_CONNECTIONS_LIMITS.usageBytes,
        );
        return this.#outcome(status, value, decodeHubConnectionUsage);
      },
      catch: failure,
    }),
  );

  /**
   * Asks the admins of the organization for access to a connection, or for more money in this
   * period. The proxy token of that organization carries who asks; the body names only the kind.
   */
  readonly requestAccess = Effect.fn("HubConnectionClient.requestAccess")(
    (orgId: string, connectionId: string, kind: HubAccessRequestKind) =>
      Effect.tryPromise({
        try: async (): Promise<HubOperationOutcome<HubAccessRequestAnswer>> => {
          const { status, value } = await this.#proxyRequest(
            orgId,
            HUB_CONNECTIONS_PATHS.accessRequests(connectionId),
            "POST",
            { kind },
            HUB_CONNECTIONS_LIMITS.accessRequestBytes,
          );
          return this.#outcome(status, value, decodeHubAccessRequestAnswer);
        },
        catch: failure,
      }),
  );

  async #capabilities(fresh: boolean): Promise<HubSessionConnections> {
    this.#followSession();
    const cached = this.#session;
    if (!fresh && cached && cached.until > this.#now()) return cached.value;
    if (this.#pendingSession) return this.#pendingSession;
    const generation = this.#generation;
    const pending = this.#readSession().finally(() => {
      if (this.#pendingSession === pending) this.#pendingSession = null;
    });
    this.#pendingSession = pending;
    const value = await pending;
    if (generation === this.#generation)
      this.#session = { value, until: this.#now() + HUB_CONNECTIONS_LIMITS.sessionCacheSeconds * 1000 };
    return value;
  }

  async #readSession(): Promise<HubSessionConnections> {
    const raw = this.#options.session();
    if (!this.signedIn()) throw new HubRequestFailed("signed_out");
    const access = await Effect.runPromise(
      ensureCulturaBuilderToken(raw, this.#options.saveSession, this.#fetch).pipe(
        Effect.mapError(() => new HubRequestFailed("signed_out")),
      ),
    ).catch((cause: unknown) => {
      throw cause instanceof HubRequestFailed ? cause : new HubRequestFailed("signed_out");
    });
    const response = await this.#send(`${CULTURA_BUILDER_HUB}${HUB_CONNECTIONS_PATHS.session}`, {
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new HubRequestFailed("signed_out", response.status);
    }
    const value = parseJson(await readLimited(response, HUB_CONNECTIONS_LIMITS.sessionBytes));
    if (!response.ok) throw new HubRequestFailed("hub_unavailable", response.status);
    const decoded = decodeHubSessionConnections(value);
    if (!decoded) throw new HubRequestFailed("hub_unavailable", response.status);
    return decoded;
  }

  async #readCatalog(fresh: boolean): Promise<HubConnectionCatalog> {
    this.#followSession();
    const cached = this.#catalog;
    if (!fresh && cached && cached.until > this.#now()) return cached.value;
    if (this.#pendingCatalog) return this.#pendingCatalog;
    const generation = this.#generation;
    const pending = (async () => {
      const { status, value } = await this.#proxyRequest(
        null,
        HUB_CONNECTIONS_PATHS.connections,
        "GET",
        undefined,
        HUB_CONNECTIONS_LIMITS.catalogBytes,
      );
      if (status !== 200) throw new HubRequestFailed("hub_unavailable", status);
      const catalog = decodeHubConnectionCatalog(value);
      if (!catalog) throw new HubRequestFailed("hub_unavailable", status);
      return catalog;
    })().finally(() => {
      if (this.#pendingCatalog === pending) this.#pendingCatalog = null;
    });
    this.#pendingCatalog = pending;
    const catalog = await pending;
    const ttl = Math.min(catalog.ttlSeconds, HUB_CONNECTIONS_LIMITS.sessionCacheSeconds);
    if (generation === this.#generation && ttl > 0) this.#catalog = { value: catalog, until: this.#now() + ttl * 1000 };
    return catalog;
  }

  async #operation<Answer>(
    orgId: string,
    operation: "search" | "describe",
    body: unknown,
    limit: number,
    decode: (value: unknown) => Answer | null,
  ): Promise<HubOperationOutcome<Answer>> {
    const { status, value } = await this.#proxyRequest(
      orgId,
      HUB_CONNECTIONS_PATHS.operation(TOOL_CATALOG_CONNECTION_ID, operation),
      "POST",
      body,
      limit,
    );
    return this.#outcome(status, value, decode);
  }

  async #call(orgId: string, body: ToolCatalogCallRequest, idempotencyKey: string): Promise<ToolCatalogCallOutcome> {
    const { status, value } = await this.#proxyRequest(
      orgId,
      HUB_CONNECTIONS_PATHS.operation(TOOL_CATALOG_CONNECTION_ID, "call"),
      "POST",
      body,
      HUB_CONNECTIONS_LIMITS.callBytes,
      idempotencyKey,
    );
    const outcome = decodeToolCatalogCallOutcome(value);
    // A success needs a 200, and a refusal its own body: anything else is a Hub that did not answer.
    if (!outcome || (outcome.kind === "result" && status !== 200)) {
      throw new HubRequestFailed("hub_unavailable", status);
    }
    return outcome;
  }

  #outcome<Answer>(
    status: number,
    value: unknown,
    decode: (value: unknown) => Answer | null,
  ): HubOperationOutcome<Answer> {
    const needsPerson = decodeHubNeedsPerson(value);
    if (needsPerson) return needsPerson;
    const error = decodeHubError(value);
    if (error) return error;
    const answer = status === 200 ? decode(value) : null;
    if (answer === null) throw new HubRequestFailed("hub_unavailable", status);
    return { kind: "answer", answer };
  }

  async #proxyRequest(
    orgId: string | null,
    path: string,
    method: "GET" | "POST",
    body: unknown,
    limit: number,
    idempotencyKey?: string,
  ): Promise<{ status: number; value: HubJson | undefined }> {
    this.#followSession();
    const key = orgId ?? CATALOG_TOKEN;
    const token = await this.#proxyToken(key, orgId);
    const response = await this.#send(`${CULTURA_BUILDER_HUB}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      // The Hub revoked or rotated it. The next request asks for a new one; this one is not repeated.
      this.#tokens.delete(key);
      await response.body?.cancel().catch(() => undefined);
      throw new HubRequestFailed("unauthorized", 401);
    }
    const text = await readLimited(response, limit);
    if (text === null) throw new HubRequestFailed("hub_unavailable", response.status);
    const value = parseJson(text);
    // A 5xx without a contract body is the Hub itself failing, not a vendor error that it mapped.
    if (response.status >= 500 && !decodeHubError(value))
      throw new HubRequestFailed("hub_unavailable", response.status);
    return { status: response.status, value };
  }

  #send(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(HUB_CONNECTIONS_CONTRACT_HEADER, HUB_CONNECTIONS_CONTRACT_VALUE);
    return this.#fetch(url, {
      ...init,
      headers,
      // A redirect could carry the bearer to another host.
      redirect: "error",
      signal: AbortSignal.timeout(HUB_CONNECTIONS_LIMITS.timeoutMs),
    });
  }

  /** A proxy token for the organization, from memory or from one request at a time. */
  async #proxyToken(key: string, orgId: string | null): Promise<string> {
    const cached = this.#tokens.get(key);
    if (cached && cached.renewAt > this.#now()) return cached.token;
    const running = this.#pendingTokens.get(key);
    if (running) return running;
    const generation = this.#generation;
    const pending = this.#requestToken(orgId)
      .then((token) => {
        if (generation === this.#generation) this.#tokens.set(key, token);
        return token.token;
      })
      .finally(() => {
        if (this.#pendingTokens.get(key) === pending) this.#pendingTokens.delete(key);
      });
    this.#pendingTokens.set(key, pending);
    return pending;
  }

  async #requestToken(orgId: string | null): Promise<CachedToken> {
    const session = readCulturaBuilderSession(this.#options.session());
    if (!session || session.refresh === "") throw new HubRequestFailed("signed_out");
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refresh,
      resource: PROXY_RESOURCE,
      scope: HUB_PROXY_SCOPE,
      ...(orgId ? { org: orgId } : {}),
    });
    const response = await this.#send(`${CULTURA_BUILDER_HUB}${HUB_CONNECTIONS_PATHS.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    });
    const value = parseJson(await readLimited(response, HUB_CONNECTIONS_LIMITS.tokenBytes));
    if (!response.ok) {
      const tokenError = decodeHubProxyTokenError(value);
      if (tokenError === "invalid_grant") throw new HubRequestFailed("signed_out", response.status);
      if (tokenError) throw new HubRequestFailed("token_refused", response.status, tokenError);
      throw new HubRequestFailed("hub_unavailable", response.status);
    }
    const token = decodeHubProxyToken(value);
    if (!token || token.orgId !== orgId) throw new HubRequestFailed("hub_unavailable", response.status);
    if (token.rotatedRefresh) {
      // The contract says the proxy token request does not rotate the refresh token. If the Hub did,
      // the old one is dead, so the new one must be kept or the person is signed out.
      await Effect.runPromise(
        this.#options.saveSession(serializeCulturaBuilderSession({ ...session, refresh: token.rotatedRefresh })),
      );
    }
    const now = this.#now();
    const lifetime = token.expiresInSeconds * 1000;
    return {
      token: token.token,
      expiresAt: now + lifetime,
      renewAt: now + lifetime - Math.min(60_000, lifetime / 2),
    };
  }
}
