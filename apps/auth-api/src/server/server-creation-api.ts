import { isString } from "@openbot/contracts/runtime-values";
import {
  parseServerCreationAccessRequest,
  SERVER_CREATION_REASON_MAX_LENGTH,
} from "@openbot/contracts/server-creation";
import { sourceText } from "@openbot/i18n/source";
import { Cause, Effect } from "effect";
import { JsonBodyError, readJsonObject } from "./json-body";
import { requestStatusFilter, ServerCreationError, type ServerCreationPermission } from "./server-creation-permission";
import type { AuthUser } from "./types";

/**
 * The server creation routes, for the bearer API (`/v2/server-creation/...`) and the browser API
 * (`/api/browser/v2/server-creation/...`). The caller authenticates the request and gives the
 * account, or null. The browser API has already checked the Origin, the browser header and the content
 * type of a write. See docs/architecture/server-creation-permission.md.
 */

export const SERVER_CREATION_PATH = "v2/server-creation/";

/** The account of a request, and the kind of its session. */
export interface ServerCreationCaller {
  user: AuthUser;
  /**
   * True when the session is an interactive Cultura Builder sign-in (`auth_sessions.sign_in_method =
   * 'cultura'`, the rule of the web app). Only such a session can use the administrator routes. A session
   * of an email code, of Mobile Connect or of a server claim cannot: the agents of a server that an
   * administrator owns must not get the administrator power. Only the administrator routes read it.
   */
  culturaSession: () => Effect.Effect<boolean, unknown>;
}

/**
 * The caller of a bearer request: the account of the token, or null with no valid session. The session
 * kind uses `authenticateWeb`, the rule of the web app, and must find the same account.
 */
export function bearerServerCreationCaller<E>(
  user: AuthUser | null,
  token: string | null,
  authenticateWeb: (token: string) => Effect.Effect<AuthUser | null, E>,
): ServerCreationCaller | null {
  if (!user || !token) return null;
  return {
    user,
    culturaSession: () => authenticateWeb(token).pipe(Effect.map((account) => account?.id === user.id)),
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function failure(status: number, code: string, message: string, retryAfterSeconds?: number): Response {
  const response = json({ error: { code, message } }, status);
  if (retryAfterSeconds !== undefined) response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

function notFound(): Response {
  return failure(404, "not_found", "This operation is not available.");
}

/**
 * Answers one server creation request, or returns null for a path outside `v2/server-creation/`.
 * `path` has no leading slash. Each `admin` path checks the administrator and the Cultura Builder
 * session before it reads the body, the query or the database, so a person who is not an
 * administrator learns nothing from it.
 */
export const handleServerCreationApi = Effect.fn("ServerCreationApi.handle")(
  function* (
    request: Request,
    path: string,
    caller: ServerCreationCaller | null,
    permission: ServerCreationPermission,
  ) {
    if (!path.startsWith(SERVER_CREATION_PATH)) return null;
    const route = path.slice(SERVER_CREATION_PATH.length).replace(/\/$/u, "");
    if (!caller) return failure(401, "unauthorized", "Sign in is required.");
    const user = caller.user;
    const method = request.method;
    if (route === "access") return method === "GET" ? json(yield* permission.access(user)) : notFound();
    if (route === "requests") {
      if (method !== "POST") return notFound();
      const input = parseServerCreationAccessRequest(yield* readJsonObject(request));
      if (!input) {
        return failure(
          400,
          "invalid_server_creation_request",
          sourceText("error.remote.serverCreationInvalidReason", { max: String(SERVER_CREATION_REASON_MAX_LENGTH) }),
        );
      }
      return json(yield* permission.requestAccess(user, input.reason), 201);
    }
    if (route !== "admin" && !route.startsWith("admin/")) return notFound();
    if (!permission.isAdministrator(user)) {
      return failure(403, "admin_required", sourceText("error.remote.serverCreationAdminRequired"));
    }
    if (!(yield* caller.culturaSession())) {
      return failure(403, "admin_session_required", sourceText("error.remote.serverCreationAdminSession"));
    }
    const query = new URL(request.url).searchParams;
    if (route === "admin") return method === "GET" ? json(yield* permission.adminState(user)) : notFound();
    if (route === "admin/users" && method === "GET") {
      return json({ users: yield* permission.listAccounts(user, query.get("query") ?? "") });
    }
    if (route === "admin/requests" && method === "GET") {
      return json({ requests: yield* permission.listRequests(user, requestStatusFilter(query.get("status"))) });
    }
    if (route === "admin/grants" && method === "POST") {
      const body = yield* readJsonObject(request);
      return json(
        yield* permission.grant(user, {
          email: isString(body.email) ? body.email : undefined,
          userId: isString(body.userId) ? body.userId : undefined,
          note: isString(body.note) ? body.note : undefined,
        }),
        201,
      );
    }
    const [, grantUserId] = /^admin\/grants\/([^/]+)$/u.exec(route) ?? [];
    if (grantUserId !== undefined && method === "DELETE") {
      return json(yield* permission.revoke(user, decodeURIComponent(grantUserId)));
    }
    const [, requestId, decision] = /^admin\/requests\/([^/]+)\/(approve|deny)$/u.exec(route) ?? [];
    if (requestId !== undefined && (decision === "approve" || decision === "deny") && method === "POST") {
      return json(yield* permission.decide(user, decodeURIComponent(requestId), decision));
    }
    return notFound();
  },
  (operation) =>
    operation.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        if (error instanceof ServerCreationError)
          return Effect.succeed(failure(error.status, error.code, error.message, error.retryAfterSeconds));
        if (error instanceof JsonBodyError) return Effect.succeed(failure(error.status, error.code, error.message));
        if (error instanceof URIError) return Effect.succeed(notFound());
        return Effect.failCause(cause);
      }),
    ),
);
