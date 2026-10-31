// The Cultura Builder sign-in, and the gateway that the provider's models run on.
//
// The Hub is the account system of Cultura Builder, and the private LLM sits behind its proxy. The
// sign-in is the OAuth 2.1 device grant of the Hub's own authorization server, the same one the MCP
// connector and the `builder` CLI use: a short code the user confirms on any device, traded for a
// bearer token. The token is what the gateway wants; the session read below says whether the account
// may use the LLM at all, which is what "Reauthenticate" is for.
//
// Everything here is data, so it runs under a unit test: the fetch is injected, and no module-level
// state survives a sign-in.

import { sourceText } from "@openbot/i18n/source";
import { Effect, Option, Schema } from "effect";
import { type ProviderClientOperationError, ProviderSignInError, providerFailure } from "./provider-client-effects";

export const CULTURA_BUILDER_PROVIDER = "cultura-builder" as const;

/** The Hub origin, and the OpenAI-compatible gateway that the provider's models run on. */
export const CULTURA_BUILDER_HUB = "https://hub.culturabuilder.com";
export const CULTURA_BUILDER_GATEWAY = `${CULTURA_BUILDER_HUB}/api/builder-ai/gateway/v1`;

const REGISTER_PATH = "/api/mcp-oauth/register";
const DEVICE_PATH = "/api/mcp-oauth/device";
const TOKEN_PATH = "/api/mcp-oauth/token";
const REVOKE_PATH = "/api/mcp-oauth/revoke";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "builder-ai";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 8 * 1024;
const DEFAULT_INTERVAL_MS = 5_000;

/**
 * The models the gateway serves. The list is static because the provider must show a model before the
 * first answer: the gateway's own `/models` needs a token, and a signed-out row would have none. The
 * order is the gateway's, with `builder-auto` first as the default.
 */
export const CULTURA_BUILDER_MODELS = [
  { id: "builder-auto", name: "Cultura Builder" },
  { id: "builder-plan", name: "Builder Plan" },
  { id: "builder-code", name: "Builder Code" },
  { id: "builder-fast", name: "Builder Fast" },
  { id: "builder-review", name: "Builder Review" },
] as const;

/** One stored sign-in. It is kept as JSON under the provider's credential. */
export interface CulturaBuilderSession {
  readonly access: string;
  readonly refresh: string;
  /** Epoch milliseconds. A token without one is used until the gateway refuses it. */
  readonly expires: number;
  /** The account's company on the Hub, shown where an e-mail would be. */
  readonly empresa: string | null;
}

/** What the gateway's `/session` answers: whether the account may use the LLM, and for which company. */
export interface CulturaBuilderAccess {
  readonly active: boolean;
  readonly empresa: string | null;
}

export interface CulturaBuilderDeviceCode {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly verificationUrlComplete: string | undefined;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

export type CulturaBuilderTokenPoll =
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "ready"; readonly session: CulturaBuilderSession }
  | { readonly status: "stop" };

type Fetcher = typeof fetch;

/** What the Hub answers to a register, a device authorization, a token and a session read. */
const RegisteredClient = Schema.Struct({ client_id: Schema.String });
const DeviceAuthorization = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Finite),
  interval: Schema.optional(Schema.Finite),
});
const TokenGrant = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
});
const GatewaySession = Schema.Struct({
  active: Schema.optional(Schema.Boolean),
  empresa: Schema.optional(Schema.NullOr(Schema.String)),
});
const StoredSession = Schema.Struct({
  access: Schema.String,
  refresh: Schema.optional(Schema.String),
  expires: Schema.optional(Schema.Finite),
  empresa: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One JSON text as `schema` names it, or null when it does not have that shape. */
function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(text: string, schema: S): S["Type"] | null {
  try {
    return Option.getOrNull(Schema.decodeUnknownOption(schema)(JSON.parse(text)));
  } catch {
    return null;
  }
}

/** The stored session, or null. A legacy plain key is read as a session that never expires. */
export function readCulturaBuilderSession(raw: string | null): CulturaBuilderSession | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text.startsWith("{")) return { access: text, refresh: "", expires: 0, empresa: null };
  const stored = decodeJson(text, StoredSession);
  if (!stored || stored.access === "") return null;
  return {
    access: stored.access,
    refresh: stored.refresh ?? "",
    expires: stored.expires ?? 0,
    empresa: stored.empresa ?? null,
  };
}

/**
 * The stored session, or a sign-in error when there is none.
 *
 * A missing session is a signed-out provider, not a broken one. As a `ProviderSignInError` the
 * provider status says "sign-in required", and the start is not counted as a failure. A plain error
 * made the row read "Unavailable" and counted toward the starts that stop the provider.
 */
export function requireCulturaBuilderSession(
  raw: string | null,
): Effect.Effect<CulturaBuilderSession, ProviderSignInError> {
  const session = readCulturaBuilderSession(raw);
  return session
    ? Effect.succeed(session)
    : Effect.fail(new ProviderSignInError({ message: sourceText("error.provider.culturaLoginRequired") }));
}

export function serializeCulturaBuilderSession(session: CulturaBuilderSession): string {
  return JSON.stringify(session);
}

/** A token that is still good, or one within a minute of ending. */
export function sessionIsFresh(session: CulturaBuilderSession, now = Date.now()): boolean {
  return session.expires > now + 60_000;
}

/**
 * Reads a JSON answer with a ceiling, so a Hub that streams forever cannot hold a sign-in. An
 * unreadable body is null, which the callers treat as the failure they already are.
 */
async function readJson<S extends Schema.ConstraintDecoder<unknown>>(
  response: Response,
  schema: S,
): Promise<S["Type"] | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await response.text().catch(() => "");
  if (text.length > RESPONSE_LIMIT_BYTES) return null;
  return decodeJson(text, schema);
}

/** Registers the device client. The Hub's MCP register requires a redirect that this flow never uses. */
async function registerClient(fetcher: Fetcher): Promise<string> {
  const response = await fetcher(`${CULTURA_BUILDER_HUB}${REGISTER_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Builders Bot",
      redirect_uris: ["http://127.0.0.1:0/callback"],
      token_endpoint_auth_method: "none",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const value = await readJson(response, RegisteredClient);
  if (!response.ok || !value) {
    throw new Error(`Cultura Builder client registration failed (${response.status})`);
  }
  return value.client_id;
}

/**
 * Starts the sign-in: registers a client, asks for a code, and returns what the dialog shows. The
 * caller polls with `pollCulturaBuilderToken`.
 */
export function startCulturaBuilderSignIn(
  fetcher: Fetcher = fetch,
): Effect.Effect<CulturaBuilderDeviceCode, ProviderClientOperationError> {
  return Effect.tryPromise({
    try: async () => {
      const clientId = await registerClient(fetcher);
      const response = await fetcher(`${CULTURA_BUILDER_HUB}${DEVICE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const value = await readJson(response, DeviceAuthorization);
      if (!response.ok || !value) {
        throw new Error(`Cultura Builder device authorization failed (${response.status})`);
      }
      return {
        clientId,
        deviceCode: value.device_code,
        userCode: value.user_code,
        verificationUrl: value.verification_uri,
        verificationUrlComplete: value.verification_uri_complete || undefined,
        expiresAt: Date.now() + (value.expires_in ?? 900) * 1_000,
        intervalMs: Math.max(1, value.interval ?? DEFAULT_INTERVAL_MS / 1_000) * 1_000,
      };
    },
    catch: providerFailure,
  });
}

/** One poll. `authorization_pending` and `slow_down` are part of the flow, not failures. */
export function pollCulturaBuilderToken(
  flow: Pick<CulturaBuilderDeviceCode, "clientId" | "deviceCode">,
  fetcher: Fetcher = fetch,
): Effect.Effect<CulturaBuilderTokenPoll> {
  return Effect.tryPromise({
    try: async (): Promise<CulturaBuilderTokenPoll> => {
      let response: Response;
      try {
        response = await fetcher(`${CULTURA_BUILDER_HUB}${TOKEN_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            client_id: flow.clientId,
            device_code: flow.deviceCode,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // A dropped network does not end the sign-in: the next poll tries again while the code lives.
        return { status: "pending" };
      }
      const value = await readJson(response, TokenGrant);
      if (response.ok) {
        // A 200 with no token is a malformed answer, not a refusal - the same reasoning as the
        // unrecognised error case below.
        if (!value?.access_token) return { status: "pending" };
        return {
          status: "ready",
          session: {
            access: value.access_token,
            refresh: value.refresh_token ?? "",
            expires: Date.now() + (value.expires_in ?? 900) * 1_000,
            empresa: null,
          },
        };
      }
      if (value?.error === "authorization_pending") return { status: "pending" };
      if (value?.error === "slow_down") return { status: "slow_down" };
      // RFC 8628 has exactly two terminal errors; everything else - an error code this flow does not
      // know, a malformed body, a transient 5xx from the Hub - is a hiccup, not a refusal. The
      // deadline in `#pollCulturaLogin` is what actually ends an unanswered flow, so treating the
      // unknown case as fatal only trades one bad round-trip for the whole sign-in.
      if (value?.error === "access_denied" || value?.error === "expired_token") return { status: "stop" };
      return { status: "pending" };
    },
    catch: () => ({ status: "pending" as const }),
  }).pipe(Effect.catch(() => Effect.succeed({ status: "pending" as const })));
}

/**
 * Exchanges the refresh token for a new access token.
 *
 * A session with no refresh token, and a refresh token that the Hub refuses (OAuth `invalid_grant`,
 * or a 401), end the sign-in: the failure is a `ProviderSignInError`, so the row asks for a new
 * sign-in and the start does not count as a failure. Other failures, such as a Hub that does not
 * answer, stay plain errors.
 */
export function refreshCulturaBuilderSession(
  session: CulturaBuilderSession,
  fetcher: Fetcher = fetch,
): Effect.Effect<CulturaBuilderSession, ProviderClientOperationError> {
  return Effect.tryPromise({
    try: async () => {
      const expired = () => new ProviderSignInError({ message: sourceText("error.provider.culturaSessionExpired") });
      if (session.refresh === "") throw expired();
      const response = await fetcher(`${CULTURA_BUILDER_HUB}${TOKEN_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refresh }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const value = await readJson(response, TokenGrant);
      if (response.status === 401 || (response.status === 400 && value?.error === "invalid_grant")) throw expired();
      if (!response.ok || !value?.access_token) {
        throw new Error(`Cultura Builder token refresh failed (${response.status})`);
      }
      return {
        access: value.access_token,
        refresh: value.refresh_token || session.refresh,
        expires: Date.now() + (value.expires_in ?? 900) * 1_000,
        empresa: session.empresa,
      };
    },
    catch: providerFailure,
  });
}

/** Tells the Hub to drop the refresh token. A failure is not worth failing a sign-out over. */
export function revokeCulturaBuilderSession(
  session: CulturaBuilderSession,
  fetcher: Fetcher = fetch,
): Effect.Effect<void> {
  if (session.refresh === "") return Effect.void;
  return Effect.tryPromise({
    try: async () => {
      await fetcher(`${CULTURA_BUILDER_HUB}${REVOKE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ token: session.refresh, token_type_hint: "access_token" }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    },
    catch: () => new Error("revoke failed"),
  }).pipe(Effect.ignore);
}

/**
 * Reads whether the account may use the LLM. This is the check that "Reauthenticate" ends with: a
 * token that the gateway refuses, or an account with `builderAi` off, is the answer the row shows.
 */
export function readCulturaBuilderAccess(
  access: string,
  fetcher: Fetcher = fetch,
): Effect.Effect<CulturaBuilderAccess, ProviderClientOperationError | ProviderSignInError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetcher(`${CULTURA_BUILDER_GATEWAY}/session`, {
        headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        throw new ProviderSignInError({ message: sourceText("error.provider.culturaLoginRequired") });
      }
      const value = await readJson(response, GatewaySession);
      if (!response.ok) throw new Error(`Cultura Builder access check failed (${response.status})`);
      return { active: value?.active === true, empresa: value?.empresa || null };
    },
    catch: providerFailure,
  });
}

/**
 * A fresh access token for the stored session, refreshing and saving when it is close to ending.
 * `save` is the credential store, so a refreshed token reaches the next spawn.
 */
export function ensureCulturaBuilderToken(
  raw: string | null,
  save: (value: string) => Effect.Effect<void>,
  fetcher: Fetcher = fetch,
): Effect.Effect<string, ProviderClientOperationError | ProviderSignInError> {
  return requireCulturaBuilderSession(raw).pipe(
    Effect.flatMap((session): Effect.Effect<string, ProviderClientOperationError> => {
      if (sessionIsFresh(session)) return Effect.succeed(session.access);
      if (session.refresh === "") return Effect.succeed(session.access);
      return refreshCulturaBuilderSession(session, fetcher).pipe(
        Effect.tap((refreshed) => save(serializeCulturaBuilderSession(refreshed))),
        Effect.map((refreshed) => refreshed.access),
      );
    }),
  );
}
