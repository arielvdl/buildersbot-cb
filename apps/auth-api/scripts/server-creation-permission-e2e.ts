// Runs the real server creation permission of the account server on a migrated SQLite database: the
// rule (administrator, grant, revoked grant, bootstrap list, the "*" opt-in), each administrator route
// for a request with no session (401), for a person who is not an administrator (403) and for an
// administrator whose session is not a Cultura Builder sign-in (403), on the bearer path and on the
// browser path, the request flow, the self-grant and request-ID refusals, the limits, the hosted server
// create that uses the rule, and what the join dialog shows for each access. The bearer path reads the
// sessions with the real account repository. See docs/architecture/server-creation-permission.md.
//
// Run: bun run test:server-creation-permission
// It writes .openbot-build/server-creation-permission-e2e/report.json and exits non-zero on a failure.
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  parseServerCreationAccess,
  parseServerCreationAdminState,
  type ServerCreationAccess,
} from "@openbot/contracts/server-creation";
import { serverCreateAccessState } from "@openbot/ui/features/servers/server-create-access";
import { Effect } from "effect";
import { type BrowserApiServices, handleBrowserApi } from "../src/server/browser-api";
import { sha256 } from "../src/server/crypto";
import { D1AuthRepository } from "../src/server/d1-auth-repository";
import { type HostedServerBilling, HostedServerService } from "../src/server/hosted-server-service";
import { bearerServerCreationCaller, handleServerCreationApi } from "../src/server/server-creation-api";
import {
  readServerCreationPolicy,
  type ServerCreationBindings,
  ServerCreationPermission,
} from "../src/server/server-creation-permission";
import type { AuthUser } from "../src/server/types";
import { sqliteD1 } from "./sqlite-d1";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build", "server-creation-permission-e2e");
const MIGRATIONS = join(ROOT, "apps", "auth-api", "migrations");
const ORIGIN = "https://buildersbot.example.test";

const user = (id: string, email: string): AuthUser => ({
  id,
  email,
  name: null,
  avatarUrl: null,
  analyticsEnabled: null,
});
const ADMIN = user("admin-1", "admin@example.test");
const PERSON = user("person-1", "person@example.test");
const OTHER = user("person-2", "other@example.test");
const BOOT = user("boot-1", "Boot@Example.test");
const SECOND_ADMIN = user("admin-2", "second@example.test");
const PEOPLE = [ADMIN, PERSON, OTHER, BOOT, SECOND_ADMIN];

/**
 * The kinds of bearer session. `cultura` is the Cultura Builder sign-in of the desktop app. `claim` is the
 * session that a server gets when it redeems its claim: like an email code or a Mobile Connect session,
 * it has no `sign_in_method`.
 */
type SessionKind = "cultura" | "claim";
const SESSION_KINDS: readonly SessionKind[] = ["cultura", "claim"];
const sessionToken = (person: AuthUser, kind: SessionKind) => `${kind}-${person.id}-0000000000000000`;
const SESSION_HASHES = new Map(
  await Promise.all(
    PEOPLE.flatMap((person) =>
      SESSION_KINDS.map(async (kind) => {
        const token = sessionToken(person, kind);
        return [token, await Effect.runPromise(sha256(token))] as const;
      }),
    ),
  ),
);

const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
function check(name: string, passed: boolean, detail?: unknown) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).sort()) database.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  const insert = database.prepare(
    "INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, 1, 1)",
  );
  for (const person of PEOPLE) insert.run(person.id, person.id, person.email.toLowerCase());
  const session = database.prepare(
    `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at, sign_in_method)
     VALUES (?, ?, ?, ?, 1, 1, ?)`,
  );
  for (const person of PEOPLE) {
    for (const kind of SESSION_KINDS) {
      const token = sessionToken(person, kind);
      session.run(
        token,
        person.id,
        SESSION_HASHES.get(token) ?? "",
        Date.UTC(2100, 0, 1),
        kind === "cultura" ? kind : null,
      );
    }
  }
  return database;
}

let clock = Date.UTC(2026, 9, 31, 12);
const now = () => clock;

/** The database of each permission, so the bearer calls read the sessions of the same database. */
const DATABASES = new WeakMap<ServerCreationPermission, DatabaseSync>();

/** `creationAvailable` is false for a deployment with hosting off. */
function permissionFor(
  database: DatabaseSync,
  bindings: ServerCreationBindings,
  log?: (message: string) => void,
  creationAvailable = true,
) {
  const permission = new ServerCreationPermission(sqliteD1(database), readServerCreationPolicy(bindings, log), now, {
    creationAvailable,
  });
  DATABASES.set(permission, database);
  return permission;
}

/**
 * One call of the bearer routes, as `src/routes/v2/server-creation/$.ts` makes it: the real account
 * repository reads the session of the token (`authenticate`) and its kind (`authenticateCulturaSession`).
 */
async function bearer(
  permission: ServerCreationPermission,
  caller: AuthUser | null,
  method: string,
  route: string,
  body?: unknown,
  kind: SessionKind = "cultura",
) {
  const database = DATABASES.get(permission);
  if (!database) throw new Error("no database for this permission");
  const request = new Request(`${ORIGIN}/v2/server-creation/${route}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const path = new URL(request.url).pathname.slice(1);
  const repository = new D1AuthRepository(sqliteD1(database));
  const token = caller ? sessionToken(caller, kind) : null;
  const user = token ? await Effect.runPromise(repository.authenticate(token, now())) : null;
  const session = bearerServerCreationCaller(user, token, (value) =>
    repository.authenticateCulturaSession(value, now()),
  );
  const response = await Effect.runPromise(handleServerCreationApi(request, path, session, permission));
  if (!response) throw new Error(`no response for ${route}`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

const TOKENS = new Map<string, AuthUser>(PEOPLE.map((person) => [`session-${person.id}-0000000000000000`, person]));
const unused = () => Effect.die(new Error("unused"));

function browserServices(permission: ServerCreationPermission): BrowserApiServices {
  const fail = () => {
    throw new Error("unused");
  };
  return {
    auth: {
      authenticateWeb: (token) => Effect.succeed(TOKENS.get(token) ?? null),
      authenticate: unused,
      signInWithDeviceAccount: unused,
      enforceDeviceSignInRateLimit: unused,
      enforceTeamInviteRateLimit: unused,
      updateAnalytics: unused,
      updateName: unused,
      updateAvatar: unused,
      listAccountSessions: unused,
      revokeAccountSession: unused,
    },
    remote: {
      listHosts: unused,
      removeOwnedHost: unused,
      startSession: unused,
      issueSessionTicket: unused,
      endSession: unused,
      endAccountSession: unused,
      previewInvite: unused,
      acceptInvite: unused,
      listMembers: unused,
      listInvites: unused,
      createInvite: unused,
      revokeInvite: unused,
      changeMembership: unused,
      hostAsset: unused,
      emailableInvite: unused,
    },
    hostLogo: unused,
    hosting: fail,
    inviteEmailDelivery: () => null,
    attribution: fail,
    billing: () => null,
    avatarBucket: fail,
    hostedSites: fail,
    webPush: () => null,
    deviceBridge: () => null,
    serverCreation: () => permission,
    sourceIp: () => "203.0.113.9",
    errorResponse: () => Response.json({ error: { code: "internal_error" } }, { status: 500 }),
  };
}

/** One call of the browser routes. `crossSite` sends the write from another origin. */
async function browser(
  permission: ServerCreationPermission,
  caller: AuthUser | null,
  method: string,
  route: string,
  options: { body?: unknown; crossSite?: boolean } = {},
) {
  const token = caller ? `session-${caller.id}-0000000000000000` : null;
  const write = method !== "GET";
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `__Host-openbot-web=${token}`;
  if (write) {
    headers.Origin = options.crossSite ? "https://attacker.example" : ORIGIN;
    headers["X-OpenBot-Browser"] = "1";
    headers["Content-Type"] = "application/json";
  }
  const response = await handleBrowserApi(
    new Request(`${ORIGIN}/api/browser/v2/server-creation/${route}`, {
      method,
      headers,
      ...(write ? { body: JSON.stringify(options.body ?? {}) } : {}),
    }),
    browserServices(permission),
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

const code = (body: unknown) => (isDynamicRecord(body) && isDynamicRecord(body.error) ? body.error.code : undefined);

/** Each administrator route and method, with a body when it takes one. */
const ADMIN_ROUTES: { method: string; route: string; body?: unknown }[] = [
  { method: "GET", route: "admin" },
  { method: "GET", route: "admin/users?query=example" },
  { method: "GET", route: "admin/requests?status=pending" },
  { method: "POST", route: "admin/grants", body: { email: "other@example.test" } },
  { method: "DELETE", route: "admin/grants/person-2", body: {} },
  { method: "POST", route: "admin/requests/request-1/approve", body: {} },
  { method: "POST", route: "admin/requests/request-1/deny", body: {} },
];

const BINDINGS = { ADMIN_USER_IDS: "admin-1", HOSTED_SERVERS_ALLOWED_USER_IDS: "boot@example.test" };

async function rules() {
  const database = migratedDatabase();
  const logs: string[] = [];
  const canCreate = (permission: ServerCreationPermission, person: AuthUser) =>
    Effect.runPromise(permission.canCreate(person));

  const none = permissionFor(database, {});
  check(
    "with no settings nobody can create, also an administrator to be",
    !(await canCreate(none, ADMIN)) && !(await canCreate(none, PERSON)),
  );
  const empty = permissionFor(database, { ADMIN_USER_IDS: "", HOSTED_SERVERS_ALLOWED_USER_IDS: "" });
  check("an empty bootstrap list means nobody", !(await canCreate(empty, PERSON)));

  const configured = permissionFor(database, BINDINGS);
  check("an administrator can create", await canCreate(configured, ADMIN));
  check("an administrator is an administrator", configured.isAdministrator(ADMIN));
  check("a person is not an administrator", !configured.isAdministrator(PERSON));
  check("the bootstrap list matches the email with any letter case", await canCreate(configured, BOOT));
  check("a person with no grant cannot create", !(await canCreate(configured, PERSON)));
  check(
    "the bootstrap list matches an account ID",
    await canCreate(permissionFor(database, { HOSTED_SERVERS_ALLOWED_USER_IDS: "person-1" }), PERSON),
  );
  const adminByEmail = permissionFor(database, { ADMIN_USER_IDS: "admin@example.test,*" });
  check(
    "ADMIN_USER_IDS takes account IDs only: an email or * makes nobody an administrator",
    !adminByEmail.isAdministrator(ADMIN) && !(await canCreate(adminByEmail, PERSON)),
  );

  const everyone = permissionFor(database, { HOSTED_SERVERS_ALLOWED_USER_IDS: "*" }, (message) => logs.push(message));
  permissionFor(database, { HOSTED_SERVERS_ALLOWED_USER_IDS: "*" }, (message) => logs.push(message));
  check("the * opt-in lets each account create", await canCreate(everyone, OTHER));
  check("the * opt-in is logged once in the isolate", logs.length === 1 && logs[0]?.includes('"*"') === true, logs);
  check("the * opt-in does not make an administrator", !everyone.isAdministrator(OTHER));

  database.exec(
    "INSERT INTO server_creation_grants(user_id, granted_by, granted_at) VALUES ('person-1', 'admin-1', 1)",
  );
  check("an active grant lets the person create", await canCreate(configured, PERSON));
  database.exec("UPDATE server_creation_grants SET revoked_at = 2, revoked_by = 'admin-1' WHERE user_id = 'person-1'");
  check("a revoked grant does not", !(await canCreate(configured, PERSON)));
}

async function adminRoutes() {
  const database = migratedDatabase();
  const permission = permissionFor(database, BINDINGS);
  database.exec(`INSERT INTO server_creation_requests(id, user_id, reason, status, created_at)
    VALUES ('request-1', 'person-1', 'For the sales team', 'pending', 1)`);
  for (const { method, route, body } of ADMIN_ROUTES) {
    const anonymous = await bearer(permission, null, method, route, body);
    check(`bearer ${method} ${route} with no session answers 401`, anonymous.status === 401, anonymous);
    const person = await bearer(permission, PERSON, method, route, body);
    check(
      `bearer ${method} ${route} for a person who is not an administrator answers 403`,
      person.status === 403 && code(person.body) === "admin_required",
      person,
    );
    const anonymousBrowser = await browser(permission, null, method, route, { body });
    check(`browser ${method} ${route} with no session answers 401`, anonymousBrowser.status === 401, anonymousBrowser);
    const personBrowser = await browser(permission, PERSON, method, route, { body });
    check(
      `browser ${method} ${route} for a person who is not an administrator answers 403`,
      personBrowser.status === 403 && code(personBrowser.body) === "admin_required",
      personBrowser,
    );
    // The agents of a server that the administrator owns have this session. They must not manage grants.
    const claim = await bearer(permission, ADMIN, method, route, body, "claim");
    check(
      `bearer ${method} ${route} with the claim session of an administrator answers 403`,
      claim.status === 403 && code(claim.body) === "admin_session_required",
      claim,
    );
  }
  const claimAccess = await bearer(permission, ADMIN, "GET", "access", undefined, "claim");
  check(
    "a claim session still reads the access, which is not an administrator route",
    claimAccess.status === 200 && parseServerCreationAccess(claimAccess.body)?.administrator === true,
    claimAccess,
  );
  const users = await bearer(permission, PERSON, "GET", "admin/users?query=");
  check(
    "a person who is not an administrator cannot list accounts",
    users.status === 403 && !JSON.stringify(users.body).includes("@example.test"),
    users,
  );
  const stillPending = database.prepare("SELECT status FROM server_creation_requests WHERE id = 'request-1'").get();
  check("the refused decisions changed no request", stillPending?.status === "pending", stillPending);
  const grants = database.prepare("SELECT COUNT(*) AS count FROM server_creation_grants").get();
  check("the refused grants wrote no grant", grants?.count === 0, grants);

  const crossSite = await browser(permission, ADMIN, "POST", "admin/grants", {
    body: { email: "other@example.test" },
    crossSite: true,
  });
  check(
    "a browser write from another origin is refused, also for an administrator",
    crossSite.status === 403 && code(crossSite.body) === "browser_request_refused",
    crossSite,
  );
  const adminState = await browser(permission, ADMIN, "GET", "admin");
  check(
    "an administrator reads the state on the browser path",
    adminState.status === 200 && parseServerCreationAdminState(adminState.body)?.requests.length === 1,
    adminState,
  );
  const listed = await bearer(permission, ADMIN, "GET", "admin/users?query=PERSON");
  check(
    "an administrator searches the accounts",
    listed.status === 200 && JSON.stringify(listed.body).includes("person@example.test"),
    listed,
  );
}

async function requestFlow() {
  const database = migratedDatabase();
  const permission = permissionFor(database, BINDINGS);
  const access = async (person: AuthUser) =>
    parseServerCreationAccess((await bearer(permission, person, "GET", "access")).body);

  const first = await access(PERSON);
  check(
    "a new person cannot create and has no request",
    first?.canCreate === false &&
      first.administrator === false &&
      first.creationAvailable === true &&
      first.request === null,
    first,
  );
  const hostingOff = permissionFor(database, BINDINGS, undefined, false);
  const offAccess = parseServerCreationAccess((await bearer(hostingOff, PERSON, "GET", "access")).body);
  check(
    "with hosting off the access says that nothing can be created",
    offAccess?.creationAvailable === false,
    offAccess,
  );
  const offRequest = await bearer(hostingOff, PERSON, "POST", "requests", { reason: "For the sales team" });
  check(
    "with hosting off a request is refused, and no request is written",
    offRequest.status === 409 &&
      code(offRequest.body) === "hosting_unavailable" &&
      database.prepare("SELECT COUNT(*) AS count FROM server_creation_requests").get()?.count === 0,
    offRequest,
  );
  const adminAccess = await access(ADMIN);
  check(
    "an administrator can create and is told so",
    adminAccess?.canCreate === true && adminAccess.administrator,
    adminAccess,
  );

  const empty = await bearer(permission, PERSON, "POST", "requests", { reason: "   " });
  check("an empty reason is refused", empty.status === 400, empty);
  const long = await bearer(permission, PERSON, "POST", "requests", { reason: "x".repeat(501) });
  check("a reason over 500 characters is refused", long.status === 400, long);

  const requested = await bearer(permission, PERSON, "POST", "requests", { reason: "For the sales team" });
  const pending = parseServerCreationAccess(requested.body);
  check("a request is pending", requested.status === 201 && pending?.request?.status === "pending", requested);
  const twice = await bearer(permission, PERSON, "POST", "requests", { reason: "Again" });
  check(
    "a second request waits for the first",
    twice.status === 409 && code(twice.body) === "server_creation_request_pending",
    twice,
  );
  const adminRequest = await bearer(permission, ADMIN, "POST", "requests", { reason: "Me too" });
  check(
    "a person who can create needs no request",
    adminRequest.status === 409 && code(adminRequest.body) === "server_creation_allowed",
    adminRequest,
  );

  const requestId = pending?.request?.id ?? "";
  const state = parseServerCreationAdminState((await bearer(permission, ADMIN, "GET", "admin")).body);
  check(
    "the administrator sees the request with its reason",
    state?.requests.length === 1 &&
      state.requests[0]?.id === requestId &&
      state.requests[0]?.reason === "For the sales team" &&
      state.requests[0]?.email === "person@example.test",
    state,
  );

  const approved = await bearer(permission, ADMIN, "POST", `admin/requests/${requestId}/approve`, {});
  const approvedState = parseServerCreationAdminState(approved.body);
  check(
    "an approval grants the permission",
    approved.status === 200 && approvedState?.requests.length === 0 && approvedState.grants[0]?.userId === PERSON.id,
    approved,
  );
  const afterApproval = await access(PERSON);
  check(
    "the person can create after the approval",
    afterApproval?.canCreate === true && afterApproval.request?.status === "approved",
    afterApproval,
  );
  const again = await bearer(permission, ADMIN, "POST", `admin/requests/${requestId}/deny`, {});
  check(
    "a decided request cannot be decided again",
    again.status === 409 && code(again.body) === "server_creation_request_decided",
    again,
  );
  const unknown = await bearer(permission, ADMIN, "POST", "admin/requests/no-such-request/approve", {});
  check("an unknown request answers 404 to the administrator", unknown.status === 404, unknown);

  const revoked = await bearer(permission, ADMIN, "DELETE", `admin/grants/${PERSON.id}`, {});
  check("the administrator revokes the grant", revoked.status === 200, revoked);
  check("the person cannot create after the revoke", (await access(PERSON))?.canCreate === false);
  const revokedTwice = await bearer(permission, ADMIN, "DELETE", `admin/grants/${PERSON.id}`, {});
  check("a grant that is not active answers 404", revokedTwice.status === 404, revokedTwice);

  clock += 1_000;
  const second = parseServerCreationAccess(
    (await bearer(permission, PERSON, "POST", "requests", { reason: "A new team" })).body,
  );
  const denied = await bearer(permission, ADMIN, "POST", `admin/requests/${second?.request?.id ?? ""}/deny`, {});
  const afterDenial = await access(PERSON);
  check(
    "a denial leaves the person without the permission and shows the denial",
    denied.status === 200 && afterDenial?.canCreate === false && afterDenial.request?.status === "denied",
    afterDenial,
  );
  clock += 1_000;
  const third = await bearer(permission, PERSON, "POST", "requests", { reason: "Please look again" });
  check("after a denial the person can ask again", third.status === 201, third);
  const fourthId = parseServerCreationAccess(third.body)?.request?.id ?? "";
  await bearer(permission, ADMIN, "POST", `admin/requests/${fourthId}/deny`, {});
  clock += 1_000;
  const limited = await bearer(permission, PERSON, "POST", "requests", { reason: "One more" });
  check("a fourth request in 15 minutes is refused", limited.status === 429, limited);

  const granted = await bearer(permission, ADMIN, "POST", "admin/grants", { email: "OTHER@example.test", note: "Ops" });
  const grantedState = parseServerCreationAdminState(granted.body);
  check(
    "a grant by email gives the permission",
    granted.status === 201 &&
      grantedState?.grants.some((entry) => entry.userId === OTHER.id && entry.note === "Ops") === true,
    granted,
  );
  const missing = await bearer(permission, ADMIN, "POST", "admin/grants", { email: "nobody@example.test" });
  check("a grant for an unknown email answers 404", missing.status === 404, missing);
  const selfGrant = await bearer(permission, ADMIN, "POST", "admin/grants", { email: ADMIN.email });
  check(
    "nobody can grant the permission to themselves",
    selfGrant.status === 403 && code(selfGrant.body) === "self_grant_refused",
    selfGrant,
  );

  // A person who asked before they became an administrator cannot approve their own request.
  const before = permissionFor(database, BINDINGS);
  const own = parseServerCreationAccess(
    (await bearer(before, SECOND_ADMIN, "POST", "requests", { reason: "Before I was an admin" })).body,
  );
  const after = permissionFor(database, { ...BINDINGS, ADMIN_USER_IDS: "admin-1,admin-2" });
  const ownDecision = await bearer(after, SECOND_ADMIN, "POST", `admin/requests/${own?.request?.id ?? ""}/approve`, {});
  check(
    "nobody can decide their own request",
    ownDecision.status === 403 && code(ownDecision.body) === "self_grant_refused",
    ownDecision,
  );

  // Another administrator gives the permission directly: the pending request is approved too.
  clock += 1_000;
  const direct = await bearer(after, ADMIN, "POST", "admin/grants", { email: SECOND_ADMIN.email, note: "Ops lead" });
  const ownRequest = database
    .prepare("SELECT status, decided_by FROM server_creation_requests WHERE id = ?")
    .get(own?.request?.id ?? "");
  check(
    "a direct grant approves the pending request of that person",
    direct.status === 201 && ownRequest?.status === "approved" && ownRequest.decided_by === ADMIN.id,
    { direct, ownRequest },
  );

  const audit = database
    .prepare("SELECT action, request_id, note FROM server_creation_audit ORDER BY created_at, rowid")
    .all();
  const actions = audit.map((row) => row.action);
  check(
    "each write has one audit row, and a direct grant of a pending request also writes its approval",
    JSON.stringify(actions) ===
      JSON.stringify([
        "request",
        "approve",
        "revoke",
        "request",
        "deny",
        "request",
        "deny",
        "grant",
        "request",
        "approve",
        "grant",
      ]),
    actions,
  );
  check(
    "the approval of a direct grant names its request",
    audit.at(-2)?.action === "approve" && audit.at(-2)?.request_id === own?.request?.id,
    audit.at(-2),
  );
  check(
    "the audit keeps no free text: the notes of the grants stay on the grants only",
    audit.every((row) => row.note === null),
    audit,
  );
}

const CATALOG = { plans: [] };

/** The Stripe calls of the hosted server tests: each one is recorded, and none goes to the network. */
const stripe: { created: string[]; closed: string[]; renewals: string[] } = { created: [], closed: [], renewals: [] };

/** boat is never called for real: each call fails, as a provider that does not answer. */
const offlineBoat = async () => Response.json({ error: { code: "unavailable" } }, { status: 503 });

function hostedService(database: DatabaseSync, enabled = true) {
  const billing: HostedServerBilling = {
    catalog: () => Effect.succeed(CATALOG),
    createCheckout: (input) =>
      Effect.sync(() => {
        stripe.created.push(input.serverId);
        return { sessionId: `cs_${input.serverId}`, url: `https://checkout.stripe.com/c/pay/cs_${input.serverId}` };
      }),
    closeCheckout: (sessionId) =>
      Effect.sync(() => {
        stripe.closed.push(sessionId);
        return { status: "closed" as const, license: null };
      }),
    cancelServerPlans: unused,
    cancelSubscription: unused,
    refreshLapsedPlans: unused,
    setServerRenewal: (_userId, serverId) =>
      Effect.sync(() => {
        stripe.renewals.push(serverId);
        return { subscriptionId: "sub_existing", periodEnd: clock + 86_400_000 };
      }),
    subscriptionEnded: unused,
  };
  return new HostedServerService(
    {
      DB: sqliteD1(database),
      HOSTED_SERVERS_ENABLED: enabled ? "true" : "false",
      BOAT_API_KEY: "boat-key",
      HOSTED_SERVER_TEMPLATE: "template",
      REMOTE_TICKET_PRIVATE_JWK: "ticket-key",
      ...BINDINGS,
    },
    { billing, now, fetch: offlineBoat },
  );
}

/** Runs a hosted server call and returns its value, or the code of its failure. */
function result<A, E>(operation: Effect.Effect<A, E>) {
  return Effect.runPromise(
    operation.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error: unknown) =>
        Effect.succeed({ ok: false as const, code: isDynamicRecord(error) ? error.code : undefined }),
      ),
    ),
  );
}

async function hostedCreate() {
  const database = migratedDatabase();
  const hosting = (enabled: boolean) => hostedService(database, enabled);
  const service = hosting(true);
  check(
    "the hosting service says whether this deployment can create servers",
    service.creationConfigured && !hosting(false).creationConfigured,
  );

  const personList = await result(service.list(PERSON));
  check(
    "the server list tells a person without permission that hosted servers are not available",
    personList.ok && personList.value.available === false,
    personList,
  );
  const personPlans = await result(service.plans(PERSON));
  check(
    "the plans refuse a person without permission",
    !personPlans.ok && personPlans.code === "server_creation_not_allowed",
    personPlans,
  );
  const create = await result(
    service.create(
      PERSON,
      { name: "Server", plan: "standard", interval: "month", currency: "usd" },
      "request-0000000001",
      {
        target: "desktop",
        origin: ORIGIN,
      },
    ),
  );
  check(
    "a create by a person without permission is refused",
    !create.ok && create.code === "server_creation_not_allowed",
    create,
  );
  const rows = database.prepare("SELECT COUNT(*) AS count FROM hosted_servers").get();
  check("the refused create wrote no server", rows?.count === 0, rows);

  const adminList = await result(service.list(ADMIN));
  check("an administrator sees hosted servers as available", adminList.ok && adminList.value.available, adminList);
  const adminPlans = await result(service.plans(ADMIN));
  check("an administrator reads the plans", adminPlans.ok, adminPlans);

  database.exec(
    "INSERT INTO server_creation_grants(user_id, granted_by, granted_at) VALUES ('person-2', 'admin-1', 1)",
  );
  const grantedPlans = await result(service.plans(OTHER));
  check("a person with a grant reads the plans", grantedPlans.ok, grantedPlans);

  const off = await result(hosting(false).plans(ADMIN));
  check(
    "with hosting off an administrator still gets hosting_unavailable",
    !off.ok && off.code === "hosting_unavailable",
    off,
  );

  database.exec(`
    INSERT INTO hosted_servers(server_id, owner_user_id, name, size, plan, billing_interval, currency, desired_state,
      observed_state, idempotency_key, legacy_member_limits, created_at, updated_at)
      VALUES ('existing', 'person-1', 'Existing', 'default', 'standard', 'month', 'usd', 'running', 'running',
        'request-0000000002', 0, 1, 1),
             ('unpaid', 'person-1', 'Unpaid', 'default', 'standard', 'month', 'usd', 'running', 'awaiting_payment',
        'request-0000000003', 0, 1, 1);
  `);
  const existing = await result(service.list(PERSON));
  check(
    "a server that exists stays in the list of a person without permission",
    existing.ok && existing.value.servers.some((server) => server.serverId === "existing"),
    existing,
  );
  const unpaid = await result(service.checkout(PERSON, "unpaid", { target: "desktop", origin: ORIGIN }));
  check(
    "the payment page of a server that is not created yet needs the permission",
    !unpaid.ok && unpaid.code === "server_creation_not_allowed",
    unpaid,
  );
}

/** A server that exists keeps working for an owner without the permission: renewal, wake and plan changes. */
async function existingServers() {
  const database = migratedDatabase();
  const service = hostedService(database);
  database.exec(`
    INSERT INTO hosted_servers(server_id, owner_user_id, name, size, plan, billing_interval, currency, desired_state,
      observed_state, provider_sandbox_id, idempotency_key, legacy_member_limits, created_at, updated_at)
      VALUES ('ended', 'person-1', 'Ended', 'default', 'standard', 'month', 'usd', 'stopped', 'stopped', 'sandbox-1',
        'request-0000000011', 0, 1, 1),
             ('sleeping', 'person-1', 'Sleeping', 'default', 'standard', 'month', 'usd', 'idle', 'stopped', 'sandbox-2',
        'request-0000000012', 0, 1, 1),
             ('active', 'person-1', 'Active', 'default', 'standard', 'month', 'usd', 'running', 'running', NULL,
        'request-0000000013', 0, 1, 1);
  `);
  const renewal = await result(service.checkout(PERSON, "ended", { target: "desktop", origin: ORIGIN }));
  check(
    "the owner without permission renews a server whose plan ended",
    renewal.ok &&
      renewal.value.checkoutUrl === "https://checkout.stripe.com/c/pay/cs_ended" &&
      stripe.created.includes("ended"),
    renewal,
  );
  const wake = await result(service.wake(PERSON, "sleeping"));
  check(
    "the owner without permission wakes a server that sleeps",
    wake.ok &&
      database.prepare("SELECT desired_state FROM hosted_servers WHERE server_id = 'sleeping'").get()?.desired_state ===
        "running",
    wake,
  );
  const restart = await result(service.restart(PERSON, "active"));
  check("the owner without permission restarts a server", restart.ok, restart);
  const keep = await result(service.lifecycle(PERSON, "active", { serverId: "active", action: "cancel" }));
  check(
    "the owner without permission changes the renewal of a server",
    keep.ok && stripe.renewals.includes("active"),
    keep,
  );
}

/** A revoke closes the payment pages that the person opened before it, so they cannot create a server. */
async function revokeClosesCheckouts() {
  const database = migratedDatabase();
  const service = hostedService(database);
  const permission = new ServerCreationPermission(sqliteD1(database), readServerCreationPolicy(BINDINGS), now, {
    creationAvailable: true,
    onRevoke: (userId) => service.closeUnpaidCheckouts(userId),
  });
  DATABASES.set(permission, database);
  database.exec(`
    INSERT INTO server_creation_grants(user_id, granted_by, granted_at) VALUES ('person-1', 'admin-1', 1);
    INSERT INTO hosted_servers(server_id, owner_user_id, name, size, plan, billing_interval, currency, desired_state,
      observed_state, checkout_session_id, idempotency_key, legacy_member_limits, created_at, updated_at)
      VALUES ('opened', 'person-1', 'Opened', 'default', 'standard', 'month', 'usd', 'running', 'awaiting_payment',
        'cs_open', 'request-0000000021', 0, 1, 1),
             ('renewal', 'person-1', 'Renewal', 'default', 'standard', 'month', 'usd', 'stopped', 'stopped',
        'cs_renewal', 'request-0000000022', 0, 1, 1),
             ('others', 'person-2', 'Others', 'default', 'standard', 'month', 'usd', 'running', 'awaiting_payment',
        'cs_others', 'request-0000000023', 0, 1, 1);
  `);
  stripe.closed.length = 0;
  const revoked = await bearer(permission, ADMIN, "DELETE", `admin/grants/${PERSON.id}`, {});
  const rows = database
    .prepare("SELECT server_id, checkout_session_id FROM hosted_servers ORDER BY server_id")
    .all()
    .map((row) => `${row.server_id}:${row.checkout_session_id ?? "none"}`);
  check(
    "a revoke closes the open page of a server that waits for its first payment, and only that page",
    revoked.status === 200 &&
      JSON.stringify(stripe.closed) === JSON.stringify(["cs_open"]) &&
      JSON.stringify(rows) === JSON.stringify(["opened:none", "others:cs_others", "renewal:cs_renewal"]),
    { revoked, closed: stripe.closed, rows },
  );
  const again = await result(service.checkout(PERSON, "opened", { target: "desktop", origin: ORIGIN }));
  check(
    "after the revoke the person cannot open a new page for that server",
    !again.ok && again.code === "server_creation_not_allowed",
    again,
  );
}

/** The server list still works when the permission cannot be read, for example before the migration. */
async function listWithoutPermissionTable() {
  const database = migratedDatabase();
  database.exec(`
    DROP TABLE server_creation_grants;
    INSERT INTO hosted_servers(server_id, owner_user_id, name, size, plan, billing_interval, currency, desired_state,
      observed_state, idempotency_key, legacy_member_limits, created_at, updated_at)
      VALUES ('existing', 'person-1', 'Existing', 'default', 'standard', 'month', 'usd', 'running', 'running',
        'request-0000000031', 0, 1, 1);
  `);
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    const list = await result(hostedService(database).list(PERSON));
    check(
      "with no grants table the list still shows the servers that exist, with create off",
      list.ok && list.value.available === false && list.value.servers.some((server) => server.serverId === "existing"),
      list,
    );
    check(
      "the failed read is logged with no email or account ID",
      warnings.length === 1 && !JSON.stringify(warnings).includes("@") && !JSON.stringify(warnings).includes(PERSON.id),
      warnings,
    );
  } finally {
    console.warn = warn;
  }
}

/** The rule of the join dialog of the desktop app and the web client (`ServerCreateAccess`). */
function joinDialog() {
  const access = (
    canCreate: boolean,
    request: ServerCreationAccess["request"],
    creationAvailable = true,
  ): ServerCreationAccess => ({
    canCreate,
    administrator: false,
    creationAvailable,
    request,
  });
  const request = (status: "pending" | "approved" | "denied") => ({
    id: "request-1",
    status,
    createdAt: 1,
    decidedAt: null,
  });
  check("the join dialog hides the section when the access is not known", serverCreateAccessState(null, true) === null);
  check(
    "a person with permission sees Create remote server when the plans can open",
    serverCreateAccessState(access(true, null), true) === "allowed",
  );
  check(
    "a person with permission sees no section when the app has no create flow",
    serverCreateAccessState(access(true, null), false) === null,
  );
  check(
    "a person without permission sees Ask for permission",
    serverCreateAccessState(access(false, null), true) === "request" &&
      serverCreateAccessState(access(false, null), false) === "request",
  );
  check(
    "with hosting off nobody sees the section: no Create, no Ask, no pending or denied request",
    [
      access(true, null, false),
      access(false, null, false),
      access(false, request("pending"), false),
      access(false, request("denied"), false),
      access(false, request("approved"), false),
    ].every((value) => serverCreateAccessState(value, true) === null),
  );
  check(
    "a pending request shows that it waits",
    serverCreateAccessState(access(false, request("pending")), true) === "pending",
  );
  check(
    "a denied request shows the denial and lets the person ask again",
    serverCreateAccessState(access(false, request("denied")), true) === "denied",
  );
  check(
    "an approval whose grant was removed lets the person ask again",
    serverCreateAccessState(access(false, request("approved")), true) === "request",
  );
}

let passed = false;
try {
  await rules();
  await adminRoutes();
  await requestFlow();
  await hostedCreate();
  await existingServers();
  await revokeClosesCheckouts();
  await listWithoutPermissionTable();
  joinDialog();
  passed = checks.length > 0 && checks.every((item) => item.passed);
} finally {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
}
for (const item of checks) console.log(`${item.passed ? "ok  " : "FAIL"} ${item.name}`);
console.log(`Report: ${join(OUT, "report.json")}`);
if (!passed) process.exit(1);
