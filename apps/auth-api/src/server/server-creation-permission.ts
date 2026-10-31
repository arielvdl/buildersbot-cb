import {
  isServerCreationUserId,
  SERVER_CREATION_NOTE_MAX_LENGTH,
  SERVER_CREATION_REASON_MAX_LENGTH,
  SERVER_CREATION_REQUEST_STATUSES,
  type ServerCreationAccess,
  type ServerCreationAdminState,
  type ServerCreationGrant,
  type ServerCreationOwnRequest,
  type ServerCreationRequest,
  type ServerCreationRequestStatus,
} from "@openbot/contracts/server-creation";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";
import { sha256 } from "./crypto";
import type { AuthUser, WorkerBindings } from "./types";

/**
 * Who can create a new remote server, and the requests and grants of that permission
 * (docs/architecture/server-creation-permission.md). Joining or adding a server that exists does not
 * come here: only a create does.
 */

/** The same window as the other limits in `auth_rate_limits`, which the retention job clears. */
const RATE_WINDOW_MS = 15 * 60_000;
const REQUEST_LIMIT = 3;
const ADMIN_LIMIT = 120;
const USER_SEARCH_LIMIT = 50;
const QUERY_MAX_LENGTH = 100;
const REQUEST_LIST_LIMIT = 100;
const GRANT_LIST_LIMIT = 500;

export type ServerCreationBindings = Pick<WorkerBindings, "ADMIN_USER_IDS" | "HOSTED_SERVERS_ALLOWED_USER_IDS">;

export interface ServerCreationPolicy {
  /** Account IDs of the administrators. */
  administrators: ReadonlySet<string>;
  /** Account IDs and lowercase emails of the bootstrap list. */
  bootstrap: ReadonlySet<string>;
  /** True only when the bootstrap list is `*`, the explicit opt-in that allows each account. */
  everyone: boolean;
}

let everyoneLogged = false;

function accountList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reads the policy from the Worker settings. An empty or absent value means nobody. `*` in the bootstrap
 * list allows each account; the Worker logs this once in each isolate, because it is a dangerous setting.
 * `ADMIN_USER_IDS` takes account IDs only: an email or `*` there does not make anybody an administrator.
 */
export function readServerCreationPolicy(
  bindings: ServerCreationBindings,
  log: (message: string) => void = (message) => console.warn(message),
): ServerCreationPolicy {
  const administrators = new Set(accountList(bindings.ADMIN_USER_IDS).filter(isServerCreationUserId));
  const allowed = accountList(bindings.HOSTED_SERVERS_ALLOWED_USER_IDS).map((entry) =>
    entry.includes("@") ? entry.toLowerCase() : entry,
  );
  const everyone = allowed.includes("*");
  if (everyone && !everyoneLogged) {
    everyoneLogged = true;
    log('server creation: HOSTED_SERVERS_ALLOWED_USER_IDS is "*", so each account can create a remote server.');
  }
  return { administrators, bootstrap: new Set(allowed.filter((entry) => entry !== "*")), everyone };
}

/** A refusal with its HTTP status and public code. The message is English source text. */
export class ServerCreationError extends Schema.TaggedError<ServerCreationError>()("ServerCreationError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Number),
}) {
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super({ status, code, message, retryAfterSeconds });
  }
}

/** A database or crypto failure. Its cause stays private; the route answers a generic 500. */
export class ServerCreationStoreError extends Schema.TaggedError<ServerCreationStoreError>()(
  "ServerCreationStoreError",
  {},
) {}

export type ServerCreationFailure = ServerCreationError | ServerCreationStoreError;

function adminRequired(): ServerCreationError {
  return new ServerCreationError(403, "admin_required", sourceText("error.remote.serverCreationAdminRequired"));
}

function selfGrant(): ServerCreationError {
  return new ServerCreationError(403, "self_grant_refused", sourceText("error.remote.serverCreationSelfGrant"));
}

function requestNotFound(): ServerCreationError {
  return new ServerCreationError(
    404,
    "server_creation_request_not_found",
    sourceText("error.remote.serverCreationRequestNotFound"),
  );
}

function requestDecided(): ServerCreationError {
  return new ServerCreationError(
    409,
    "server_creation_request_decided",
    sourceText("error.remote.serverCreationRequestDecided"),
  );
}

interface RequestRow {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  reason: string;
  status: ServerCreationRequestStatus;
  created_at: number;
  decided_at: number | null;
}

interface GrantRow {
  user_id: string;
  email: string;
  name: string | null;
  granted_at: number;
  note: string | null;
}

interface UserGrantRow {
  id: string;
  email: string;
  name: string | null;
  granted_at: number | null;
  note: string | null;
}

/** An account as the administrator search shows it: its grant, or null. */
export interface ServerCreationAccount {
  userId: string;
  email: string;
  name: string | null;
  grant: { grantedAt: number; note: string | null } | null;
}

export interface ServerCreationGrantTarget {
  email?: string | undefined;
  userId?: string | undefined;
  note?: string | undefined;
}

function adminRequest(row: RequestRow): ServerCreationRequest {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function grant(row: GrantRow): ServerCreationGrant {
  return { userId: row.user_id, email: row.email, name: row.name, grantedAt: row.granted_at, note: row.note };
}

export class ServerCreationPermission {
  readonly #database: D1Database;
  readonly #policy: ServerCreationPolicy;
  readonly #now: () => number;

  constructor(database: D1Database, policy: ServerCreationPolicy, now: () => number = Date.now) {
    this.#database = database;
    this.#policy = policy;
    this.#now = now;
  }

  isAdministrator(user: Pick<AuthUser, "id">): boolean {
    return this.#policy.administrators.has(user.id);
  }

  /** `canCreateRemoteServer`: an administrator, the bootstrap list, the `*` opt-in, or an active grant. */
  readonly canCreate = Effect.fn("ServerCreationPermission.canCreate")(function* (
    this: ServerCreationPermission,
    user: Pick<AuthUser, "id" | "email">,
  ) {
    if (this.isAdministrator(user) || this.#policy.everyone) return true;
    if (this.#policy.bootstrap.has(user.id) || this.#policy.bootstrap.has(user.email.toLowerCase())) return true;
    const row = yield* this.#call(() =>
      this.#database
        .prepare("SELECT 1 AS active FROM server_creation_grants WHERE user_id = ? AND revoked_at IS NULL")
        .bind(user.id)
        .first<{ active: number }>(),
    );
    return row !== null;
  }).bind(this);

  /** What the person can do, and their latest request. */
  readonly access = Effect.fn("ServerCreationPermission.access")(function* (
    this: ServerCreationPermission,
    user: AuthUser,
  ) {
    const canCreate = yield* this.canCreate(user);
    const row = yield* this.#call(() =>
      this.#database
        .prepare(
          `SELECT id, status, created_at, decided_at FROM server_creation_requests
           WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .bind(user.id)
        .first<{ id: string; status: ServerCreationRequestStatus; created_at: number; decided_at: number | null }>(),
    );
    const request: ServerCreationOwnRequest | null = row
      ? { id: row.id, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at }
      : null;
    return { canCreate, administrator: this.isAdministrator(user), request } satisfies ServerCreationAccess;
  }).bind(this);

  /** Adds a pending request. One request waits at a time, and a person who can create needs none. */
  readonly requestAccess = Effect.fn("ServerCreationPermission.requestAccess")(function* (
    this: ServerCreationPermission,
    user: AuthUser,
    reason: string,
  ) {
    const text = reason.trim();
    if (text.length === 0 || text.length > SERVER_CREATION_REASON_MAX_LENGTH) {
      return yield* new ServerCreationError(
        400,
        "invalid_server_creation_request",
        sourceText("error.remote.serverCreationInvalidReason", { max: String(SERVER_CREATION_REASON_MAX_LENGTH) }),
      );
    }
    if (yield* this.canCreate(user)) {
      return yield* new ServerCreationError(
        409,
        "server_creation_allowed",
        sourceText("error.remote.serverCreationAlreadyAllowed"),
      );
    }
    if (yield* this.#hasPendingRequest(user.id)) return yield* requestPending();
    yield* this.#limit(`request:user:${user.id}`, REQUEST_LIMIT);
    const id = crypto.randomUUID();
    const now = this.#now();
    const [inserted] = yield* this.#call(() =>
      this.#database.batch([
        this.#database
          .prepare(
            `INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
             SELECT ?, ?, ?, 'pending', ?
             WHERE NOT EXISTS(SELECT 1 FROM server_creation_requests WHERE user_id = ? AND status = 'pending')`,
          )
          .bind(id, user.id, text, now, user.id),
        this.#audit("request", user.id, user.id, id, null, now, "SELECT 1 FROM server_creation_requests WHERE id = ?", [
          id,
        ]),
      ]),
    );
    if (inserted?.meta.changes !== 1) return yield* requestPending();
    return yield* this.access(user);
  }).bind(this);

  /** The pending requests and the active grants. */
  readonly adminState = Effect.fn("ServerCreationPermission.adminState")(function* (
    this: ServerCreationPermission,
    admin: AuthUser,
  ) {
    yield* this.#requireAdmin(admin);
    return yield* this.#adminState();
  }).bind(this);

  /** Up to 50 accounts whose email or name contains `query`, each with its grant. */
  readonly listAccounts = Effect.fn("ServerCreationPermission.listAccounts")(function* (
    this: ServerCreationPermission,
    admin: AuthUser,
    query: string,
  ) {
    yield* this.#requireAdmin(admin);
    const text = query.trim().toLowerCase().slice(0, QUERY_MAX_LENGTH);
    const rows = yield* this.#call(() =>
      this.#database
        .prepare(
          `SELECT u.id, u.email, u.name, g.granted_at, g.note FROM users u
           LEFT JOIN server_creation_grants g ON g.user_id = u.id AND g.revoked_at IS NULL
           WHERE ? = '' OR instr(lower(u.email), ?) > 0 OR instr(lower(coalesce(u.name, '')), ?) > 0
           ORDER BY u.email LIMIT ?`,
        )
        .bind(text, text, text, USER_SEARCH_LIMIT)
        .all<UserGrantRow>(),
    );
    return rows.results.map(
      (row): ServerCreationAccount => ({
        userId: row.id,
        email: row.email,
        name: row.name,
        grant: row.granted_at === null ? null : { grantedAt: row.granted_at, note: row.note },
      }),
    );
  }).bind(this);

  /** Up to 100 requests with the status, the newest first. */
  readonly listRequests = Effect.fn("ServerCreationPermission.listRequests")(function* (
    this: ServerCreationPermission,
    admin: AuthUser,
    status: ServerCreationRequestStatus,
  ) {
    yield* this.#requireAdmin(admin);
    return yield* this.#requests(status);
  }).bind(this);

  /** Gives the permission to the account of the email or ID. A pending request of that person is approved. */
  readonly grant = Effect.fn("ServerCreationPermission.grant")(function* (
    this: ServerCreationPermission,
    admin: AuthUser,
    target: ServerCreationGrantTarget,
  ) {
    yield* this.#requireAdmin(admin);
    const note = target.note?.trim() || null;
    const email = target.email?.trim().toLowerCase() ?? "";
    const userId = target.userId ?? "";
    if (
      (note !== null && note.length > SERVER_CREATION_NOTE_MAX_LENGTH) ||
      (email === "") === (userId === "") ||
      (email !== "" && (!email.includes("@") || email.length > 320)) ||
      (userId !== "" && !isServerCreationUserId(userId))
    ) {
      return yield* new ServerCreationError(
        400,
        "invalid_server_creation_grant",
        sourceText("error.remote.serverCreationInvalidGrant", { max: String(SERVER_CREATION_NOTE_MAX_LENGTH) }),
      );
    }
    const account = yield* this.#call(() =>
      (email
        ? this.#database.prepare("SELECT id FROM users WHERE lower(email) = ?").bind(email)
        : this.#database.prepare("SELECT id FROM users WHERE id = ?").bind(userId)
      ).first<{ id: string }>(),
    );
    if (!account) {
      return yield* new ServerCreationError(
        404,
        "account_not_found",
        sourceText("error.remote.serverCreationAccountNotFound"),
      );
    }
    if (account.id === admin.id) return yield* selfGrant();
    const now = this.#now();
    yield* this.#call(() =>
      this.#database.batch([
        this.#upsertGrant(account.id, admin.id, now, note),
        this.#database
          .prepare(
            `UPDATE server_creation_requests SET status = 'approved', decided_by = ?, decided_at = ?
             WHERE user_id = ? AND status = 'pending'`,
          )
          .bind(admin.id, now, account.id),
        this.#audit("grant", admin.id, account.id, null, note, now),
      ]),
    );
    return yield* this.#adminState();
  }).bind(this);

  /** Removes the active grant. Servers that the person created stay as they are. */
  readonly revoke = Effect.fn("ServerCreationPermission.revoke")(function* (
    this: ServerCreationPermission,
    admin: AuthUser,
    userId: string,
  ) {
    yield* this.#requireAdmin(admin);
    if (!isServerCreationUserId(userId)) return yield* grantNotFound();
    const active = yield* this.#call(() =>
      this.#database
        .prepare("SELECT 1 AS active FROM server_creation_grants WHERE user_id = ? AND revoked_at IS NULL")
        .bind(userId)
        .first<{ active: number }>(),
    );
    if (!active) return yield* grantNotFound();
    const now = this.#now();
    const [revoked] = yield* this.#call(() =>
      this.#database.batch([
        this.#database
          .prepare(
            `UPDATE server_creation_grants SET revoked_at = ?, revoked_by = ?
             WHERE user_id = ? AND revoked_at IS NULL`,
          )
          .bind(now, admin.id, userId),
        this.#audit(
          "revoke",
          admin.id,
          userId,
          null,
          null,
          now,
          "SELECT 1 FROM server_creation_grants WHERE user_id = ? AND revoked_at = ? AND revoked_by = ?",
          [userId, now, admin.id],
        ),
      ]),
    );
    if (revoked?.meta.changes !== 1) return yield* grantNotFound();
    return yield* this.#adminState();
  }).bind(this);

  /** Approves (and grants) or denies a pending request. Nobody decides their own request. */
  readonly decide = Effect.fn("ServerCreationPermission.decide")(function* (
    this: ServerCreationPermission,
    admin: AuthUser,
    requestId: string,
    decision: "approve" | "deny",
  ) {
    yield* this.#requireAdmin(admin);
    if (!isServerCreationUserId(requestId)) return yield* requestNotFound();
    const request = yield* this.#call(() =>
      this.#database
        .prepare("SELECT user_id, status FROM server_creation_requests WHERE id = ?")
        .bind(requestId)
        .first<{ user_id: string; status: ServerCreationRequestStatus }>(),
    );
    if (!request) return yield* requestNotFound();
    if (request.user_id === admin.id) return yield* selfGrant();
    if (request.status !== "pending") return yield* requestDecided();
    const now = this.#now();
    const status = decision === "approve" ? "approved" : "denied";
    const decided =
      "SELECT 1 FROM server_creation_requests WHERE id = ? AND status = ? AND decided_by = ? AND decided_at = ?";
    const decidedValues = [requestId, status, admin.id, now];
    const statements = [
      this.#database
        .prepare(
          `UPDATE server_creation_requests SET status = ?, decided_by = ?, decided_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(status, admin.id, now, requestId),
      this.#audit(decision, admin.id, request.user_id, requestId, null, now, decided, decidedValues),
    ];
    if (decision === "approve")
      statements.push(this.#upsertGrant(request.user_id, admin.id, now, null, decided, decidedValues));
    const [updated] = yield* this.#call(() => this.#database.batch(statements));
    if (updated?.meta.changes !== 1) return yield* requestDecided();
    return yield* this.#adminState();
  }).bind(this);

  readonly #adminState = Effect.fn("ServerCreationPermission.readAdminState")(function* (
    this: ServerCreationPermission,
  ) {
    const requests = yield* this.#requests("pending");
    const grants = yield* this.#call(() =>
      this.#database
        .prepare(
          `SELECT g.user_id, u.email, u.name, g.granted_at, g.note FROM server_creation_grants g
           JOIN users u ON u.id = g.user_id
           WHERE g.revoked_at IS NULL ORDER BY g.granted_at DESC LIMIT ?`,
        )
        .bind(GRANT_LIST_LIMIT)
        .all<GrantRow>(),
    );
    return { requests, grants: grants.results.map(grant) } satisfies ServerCreationAdminState;
  }).bind(this);

  readonly #requests = Effect.fn("ServerCreationPermission.readRequests")(function* (
    this: ServerCreationPermission,
    status: ServerCreationRequestStatus,
  ) {
    const rows = yield* this.#call(() =>
      this.#database
        .prepare(
          `SELECT r.id, r.user_id, u.email, u.name, r.reason, r.status, r.created_at, r.decided_at
           FROM server_creation_requests r JOIN users u ON u.id = r.user_id
           WHERE r.status = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
        )
        .bind(status, REQUEST_LIST_LIMIT)
        .all<RequestRow>(),
    );
    return rows.results.map(adminRequest);
  }).bind(this);

  readonly #hasPendingRequest = Effect.fn("ServerCreationPermission.hasPendingRequest")(function* (
    this: ServerCreationPermission,
    userId: string,
  ) {
    const row = yield* this.#call(() =>
      this.#database
        .prepare("SELECT 1 AS pending FROM server_creation_requests WHERE user_id = ? AND status = 'pending'")
        .bind(userId)
        .first<{ pending: number }>(),
    );
    return row !== null;
  }).bind(this);

  /** The administrator check of each admin method, and the limit of each administrator. */
  readonly #requireAdmin = Effect.fn("ServerCreationPermission.requireAdmin")(function* (
    this: ServerCreationPermission,
    user: AuthUser,
  ) {
    if (!this.isAdministrator(user)) return yield* adminRequired();
    yield* this.#limit(`admin:user:${user.id}`, ADMIN_LIMIT);
  }).bind(this);

  readonly #limit = Effect.fn("ServerCreationPermission.limit")(function* (
    this: ServerCreationPermission,
    key: string,
    limit: number,
  ) {
    const now = this.#now();
    const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
    const keyHash = yield* sha256(`server-creation:${key}`).pipe(
      Effect.mapError(() => new ServerCreationStoreError({})),
    );
    const row = yield* this.#call(() =>
      this.#database
        .prepare(
          `INSERT INTO auth_rate_limits(key_hash, window_start, attempts) VALUES (?, ?, 1)
           ON CONFLICT(key_hash, window_start) DO UPDATE SET attempts = attempts + 1
           RETURNING attempts`,
        )
        .bind(keyHash, windowStart)
        .first<{ attempts: number }>(),
    );
    if ((row?.attempts ?? limit + 1) > limit) {
      return yield* new ServerCreationError(
        429,
        "rate_limited",
        sourceText("error.remote.serverCreationRateLimited"),
        Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1_000)),
      );
    }
  }).bind(this);

  /**
   * Adds or renews the grant of `userId`. With `condition`, only when that query finds a row, so the
   * grant of an approval is written only when the same batch made the decision.
   */
  #upsertGrant(
    userId: string,
    grantedBy: string,
    now: number,
    note: string | null,
    condition = "SELECT 1",
    values: (string | number)[] = [],
  ): D1PreparedStatement {
    return this.#database
      .prepare(
        `INSERT INTO server_creation_grants(user_id, granted_by, granted_at, revoked_at, revoked_by, note)
         SELECT ?, ?, ?, NULL, NULL, ? WHERE EXISTS(${condition})
         ON CONFLICT(user_id) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at,
           revoked_at = NULL, revoked_by = NULL, note = excluded.note`,
      )
      .bind(userId, grantedBy, now, note, ...values);
  }

  /** One audit row, written only when `condition` finds a row in the same batch. */
  #audit(
    action: "request" | "grant" | "revoke" | "approve" | "deny",
    actorUserId: string,
    targetUserId: string,
    requestId: string | null,
    note: string | null,
    now: number,
    condition = "SELECT 1",
    values: (string | number)[] = [],
  ): D1PreparedStatement {
    return this.#database
      .prepare(
        `INSERT INTO server_creation_audit(id, actor_user_id, action, target_user_id, request_id, note, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(${condition})`,
      )
      .bind(crypto.randomUUID(), actorUserId, action, targetUserId, requestId, note, now, ...values);
  }

  #call<A>(operation: () => Promise<A>): Effect.Effect<A, ServerCreationStoreError> {
    return Effect.tryPromise({ try: operation, catch: () => new ServerCreationStoreError({}) });
  }
}

function requestPending(): ServerCreationError {
  return new ServerCreationError(
    409,
    "server_creation_request_pending",
    sourceText("error.remote.serverCreationRequestPending"),
  );
}

function grantNotFound(): ServerCreationError {
  return new ServerCreationError(
    404,
    "server_creation_grant_not_found",
    sourceText("error.remote.serverCreationGrantNotFound"),
  );
}

/** The status filter of the request list. An unknown value reads as `pending`. */
export function requestStatusFilter(value: string | null): ServerCreationRequestStatus {
  return SERVER_CREATION_REQUEST_STATUSES.find((status) => status === value) ?? "pending";
}
