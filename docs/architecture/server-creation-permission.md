# Server creation permission

Only a person with explicit permission can create a new remote server. Each signed-in person can
still join or add a server that exists.

## Two kinds of action

| Action | Who | Paths |
| --- | --- | --- |
| **Create** a new remote server in our infrastructure | An administrator, or a person with permission | Hosted server create (`POST /v2/hosting/servers`), its plans (`GET /v2/hosting/plans`) and its first payment page (`POST /v2/hosting/servers/{id}/checkout`), in the desktop app and the web client. The operator claim (`POST /v2/admin/server-claims`, `SERVER_CLAIMS_ADMIN_TOKEN`) and the sector servers on our AWS account (operator scripts with AWS administrator credentials) were already for administrators only. |
| **Join or add** a server that exists | Each signed-in person | Invite links (`/v2/remote/invites/...`), a person who signs in their own machine (`POST /v2/remote/hosts/register`), a server on this computer (`localServers`), the claim of a hosted server that was already created (`/v2/hosting/claims/redeem`) and of an operator claim (`/v2/server-claims/redeem`). |

Servers and hosts that exist do not change. A revoked permission does not stop, delete or lock a
server. Wake, restart, plan changes and delete of an existing hosted server do not check the
permission. A hosted server that waits for its first payment is not created yet: its payment page
needs the permission.

## The rule

`canCreateRemoteServer(user)` (`apps/auth-api/src/server/server-creation-permission.ts`) is true
when one of these is true:

1. The person is an **administrator**: the account ID is in `ADMIN_USER_IDS`.
2. The person has an **active grant**: a row in `server_creation_grants` with no `revoked_at`.
3. The person is on the **bootstrap list**: the account ID or email is in
   `HOSTED_SERVERS_ALLOWED_USER_IDS`.
4. `HOSTED_SERVERS_ALLOWED_USER_IDS` is `*`. This is an explicit opt-in only. It lets each account
   create, and the Worker logs a warning once in each isolate that reads this value.

An empty or absent `HOSTED_SERVERS_ALLOWED_USER_IDS` means nobody. `wrangler.jsonc` sets `""` in
production. The `preview` environment does not set it, and the `test` environment gets it as a secret
from `HOSTED_SERVERS_TEST_ALLOW_LIST` (named accounts only; `api:deploy:test` refuses `*`).
`*` is no longer a default anywhere.

Hosted servers also need `HOSTED_SERVERS_ENABLED=true`, the boat and Stripe secrets and the template.
`GET /v2/hosting/servers` answers `available: true` only when hosting is configured **and** the rule
is true. The developer key of the test Worker (`HOSTED_SERVERS_DEVELOPER_KEY`) keeps its old effect;
a packaged app never sends it.

## Who is an administrator

`ADMIN_USER_IDS` is a comma-separated list of account IDs (the `users.id` of D1). The repository has
no real ID. The owner sets it in the Cloudflare dashboard or with
`wrangler secret put ADMIN_USER_IDS`. It is not in the `vars` of `wrangler.jsonc`, because a deploy
with `--keep-vars` overwrites a dashboard value that has the same name in `vars`. Local development
reads it from the shell (`runtime-env.ts`).

To find an account ID:
`wrangler d1 execute buildersbot-auth --remote --command "SELECT id, email FROM users WHERE email = '<email>'"`.

### The Cultura Builder Hub

The Hub device grant answers `user.email`, `user.name` and `user.avatarUrl` only
(`device-bridge.ts`). It sends no role and no entitlement, so the Worker cannot read an administrator
from the Hub today. Hub-side requirement for a later change:

- The bridge poll answer (`POST /v1/auth/device/poll`, status 200) adds
  `user.entitlements: string[]`, and includes `buildersbot:server-admin` for a Cultura Builder
  administrator.
- The value comes from the Hub only, after the Hub checks the person. The bridge must not copy a value
  that the client sent.
- When the Worker reads it, it stores it on the session row, and a new sign-in replaces it. A person
  who loses the role loses it at the next sign-in. `ADMIN_USER_IDS` stays as the fallback.

## Data (D1 migration `0046_server_creation_permission.sql`)

| Table | Columns | Notes |
| --- | --- | --- |
| `server_creation_grants` | `user_id` (primary key), `granted_by`, `granted_at`, `revoked_at`, `revoked_by`, `note` | One row for each person. A new grant clears `revoked_at`. |
| `server_creation_requests` | `id`, `user_id`, `reason`, `status` (`pending`, `approved`, `denied`), `created_at`, `decided_by`, `decided_at` | A partial unique index allows one `pending` request for each person. |
| `server_creation_audit` | `id`, `actor_user_id`, `action` (`request`, `grant`, `revoke`, `approve`, `deny`), `target_user_id`, `request_id`, `note`, `created_at` | Each write adds one row in the same D1 batch. No API reads it; use `wrangler d1 execute`. |

The migration only adds tables. The Worker that runs before the deploy does not read them, so the
migration is backward compatible with it (`apps/auth-api/AGENTS.md`).

## API

All routes are on the bearer API (`Authorization: Bearer <session>`, used by the desktop app) and on
the browser API (`/api/browser/<same path>`, used by the web client). The browser API keeps its
checks for each write: the `Origin` must be the Worker origin, the `X-OpenBot-Browser: 1` header
must be there, the body must be JSON, and `Sec-Fetch-Site: cross-site` is refused. The web app
accepts only a Cultura Builder session.

### For each person

| Route | Answer |
| --- | --- |
| `GET /v2/server-creation/access` | `{ canCreate, administrator, request }`. `request` is the latest request of this person, or null. |
| `POST /v2/server-creation/requests` `{ reason }` | 201 and the new access. `reason` has 1 to 500 characters. 409 `server_creation_allowed` when the person can already create, 409 `server_creation_request_pending` when a request waits. At most 3 requests in 15 minutes. |

The routes take no request ID, so a person cannot read or change the request of another person.

### For administrators

Each route answers 401 with no session and 403 `admin_required` for a person who is not an
administrator. The administrator check runs first, before the route reads the body or the database.
At most 120 calls in 15 minutes for each administrator.

| Route | Job |
| --- | --- |
| `GET /v2/server-creation/admin` | The pending requests and the active grants. |
| `GET /v2/server-creation/admin/users?query=` | Up to 50 accounts whose email or name contains the text, each with its grant. |
| `GET /v2/server-creation/admin/requests?status=` | Up to 100 requests with the status (default `pending`). |
| `POST /v2/server-creation/admin/grants` `{ email or userId, note? }` | Grants the permission. Also approves a pending request of that person. |
| `DELETE /v2/server-creation/admin/grants/{userId}` | Revokes the active grant. |
| `POST /v2/server-creation/admin/requests/{id}/approve` | Approves a pending request and grants the permission. |
| `POST /v2/server-creation/admin/requests/{id}/deny` | Denies a pending request. |

One splat route (`src/routes/v2/server-creation/$.ts`) and the browser API call the same handler
(`server-creation-api.ts`). The writes answer the new state of `GET /v2/server-creation/admin`. Nobody can grant the permission
to themselves or decide their own request (403 `self_grant_refused`). A request that is not pending
answers 409. An unknown request or account answers 404 to an administrator only.

## Apps

The desktop app (`hostedServers` IPC group) and the web client (`/api/browser/...`) read the same
access.

- The plus button opens the hosted server plans only when `available` is true: hosting is configured
  and the person can create. The plans keep "Join with an invite" in "Other options".
- In all other cases the plus button opens the join dialog. The join dialog shows the section
  "Create a remote server":
  - allowed and hosting available: a "Create a remote server" button that opens the plans;
  - not allowed: "Ask the administrator for permission" and an "Ask for permission" button with a
    short reason;
  - a pending request: the request waits for the administrator;
  - a denied request: the text says so, and the person can ask again.
- An administrator sees the section "Server creation" in Settings › Profile (desktop) and in the
  account settings of the web client: the pending requests (approve, deny), the people with
  permission (revoke), and a form that grants the permission by email.

An app that cannot read the access (no network, an older Worker) hides the section. The Worker
checks the permission on each create, so a hidden or a shown button never changes what the Worker
allows.

## Tests

- `apps/auth-api/test/server-creation-permission-migration.test.ts`: the migration keeps each account,
  session and hosted server, and its checks and indexes.
- `apps/auth-api/scripts/server-creation-permission-e2e.ts` (`bun run test:server-creation-permission`):
  the real service and handlers on a migrated SQLite database. It writes
  `.openbot-build/server-creation-permission-e2e/report.json`.

## Security

- The administrator check is on each admin route and in each admin service method.
- A person cannot grant to themselves, approve their own request, or read a request by its ID.
- A person who is not an administrator cannot list accounts.
- Each write checks the state first (an active grant, a pending request) and writes its audit row in
  the same D1 batch, only when the write changed a row.
- `ADMIN_USER_IDS` holds IDs, not secrets. The admin routes use the session; they take no token, so
  they need no token comparison. The existing operator tokens keep their constant-time comparison
  (`admin-token.ts`).
- The logs show no email and no reason.
