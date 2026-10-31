// Runs the real server creation permission of the account server on a migrated SQLite database: the
// rule (administrator, grant, revoked grant, bootstrap list, the "*" opt-in), each administrator route
// for a request with no session (401) and for a person who is not an administrator (403), on the bearer
// path and on the browser path, the request flow, the self-grant and request-ID refusals, the limits,
// and the hosted server create that uses the rule. See docs/architecture/server-creation-permission.md.
//
// Run: bun run test:server-creation-permission
// It writes .openbot-build/server-creation-permission-e2e/report.json and exits non-zero on a failure.
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { parseServerCreationAccess, parseServerCreationAdminState } from "@openbot/contracts/server-creation";
import { Effect } from "effect";
import { type BrowserApiServices, handleBrowserApi } from "../src/server/browser-api";
import { type HostedServerBilling, HostedServerService } from "../src/server/hosted-server-service";
import { handleServerCreationApi } from "../src/server/server-creation-api";
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
  return database;
}

let clock = Date.UTC(2026, 9, 31, 12);
const now = () => clock;

function permissionFor(database: DatabaseSync, bindings: ServerCreationBindings, log?: (message: string) => void) {
  return new ServerCreationPermission(sqliteD1(database), readServerCreationPolicy(bindings, log), now);
}

/** One call of the bearer routes, as `src/routes/v2/server-creation/$.ts` makes it. */
async function bearer(
  permission: ServerCreationPermission,
  caller: AuthUser | null,
  method: string,
  route: string,
  body?: unknown,
) {
  const request = new Request(`${ORIGIN}/v2/server-creation/${route}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const path = new URL(request.url).pathname.slice(1);
  const response = await Effect.runPromise(handleServerCreationApi(request, path, caller, permission));
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
  }
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
    first?.canCreate === false && first.administrator === false && first.request === null,
    first,
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
    granted.status === 201 && grantedState?.grants.some((entry) => entry.userId === OTHER.id && entry.note === "Ops"),
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

  const audit = database.prepare("SELECT action FROM server_creation_audit ORDER BY created_at, rowid").all();
  const actions = audit.map((row) => row.action);
  check(
    "each write has one audit row",
    JSON.stringify(actions) ===
      JSON.stringify(["request", "approve", "revoke", "request", "deny", "request", "deny", "grant", "request"]),
    actions,
  );
}

const CATALOG = { plans: [] };

async function hostedCreate() {
  const database = migratedDatabase();
  const billing: HostedServerBilling = {
    catalog: () => Effect.succeed(CATALOG),
    createCheckout: unused,
    closeCheckout: unused,
    cancelServerPlans: unused,
    cancelSubscription: unused,
    refreshLapsedPlans: unused,
    setServerRenewal: unused,
    subscriptionEnded: unused,
  };
  const hosting = (enabled: boolean) =>
    new HostedServerService(
      {
        DB: sqliteD1(database),
        HOSTED_SERVERS_ENABLED: enabled ? "true" : "false",
        BOAT_API_KEY: "boat-key",
        HOSTED_SERVER_TEMPLATE: "template",
        REMOTE_TICKET_PRIVATE_JWK: "ticket-key",
        ...BINDINGS,
      },
      { billing, now },
    );
  const service = hosting(true);
  const result = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.runPromise(
      operation.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error: unknown) =>
          Effect.succeed({ ok: false as const, code: isDynamicRecord(error) ? error.code : undefined }),
        ),
      ),
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

let passed = false;
try {
  await rules();
  await adminRoutes();
  await requestFlow();
  await hostedCreate();
  passed = checks.length > 0 && checks.every((item) => item.passed);
} finally {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
}
for (const item of checks) console.log(`${item.passed ? "ok  " : "FAIL"} ${item.name}`);
console.log(`Report: ${join(OUT, "report.json")}`);
if (!passed) process.exit(1);
