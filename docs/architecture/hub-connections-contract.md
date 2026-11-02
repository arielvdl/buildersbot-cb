# Hub connections contract, version 1

This document is for the Cultura Builder Hub team. It gives the routes, bodies, answers, errors,
cap rules, vendor headers and tables that the Hub must build so that Builders Bot can use paid
connections. The first connection is `tool-catalog`: the vendor tool catalog (treg.to) behind the
Hub, with the operations `search`, `describe` and `call`.

The app side is built and tested against a fake of this contract (`scripts/fake-hub/`). The code
form of the contract is `packages/contracts/src/hub-connections.ts`. A change in one file is a change
in the other. A change of meaning needs version 2.

Base designs: `.buildersbot-build/perf-review/PROXY-WEB-ACCESS-DESIGN.md` (sections 10 to 15) and
`.buildersbot-build/treg/DESIGN.md` (option A+). Those files are in the owner's checkout only.

## 1. Rules for every route

- **Origin.** `https://hub.culturabuilder.com`. The app never follows a redirect (`redirect: "error"`).
- **Contract header.** The app sends `X-Builders-Bot-Contract: hub-connections/1` on each request.
  The Hub can refuse a version that it does not know with `400 { "error": "internal_error" }`.
- **Timeout.** The app stops waiting after 25 seconds. The Hub must answer in less: its own vendor
  deadline is 25 seconds (design §3.8 step 9), so the Hub must answer a slow vendor with
  `upstream_unavailable` before the app gives up.
- **Authentication.** Every route needs a token. There is no public route and no admin route
  without authentication. CORS stays closed: the app is not a browser page.
- **No token in a URL.** The Hub refuses a request with a token in the query string (`401`).
- **JSON.** Answers are `application/json`, UTF-8. Unknown fields are allowed: the app drops them.
- **Text.** Every text field is plain text: no HTML, no markup (`<tag`, `<!`, `<?`), no control
  characters other than tab and line breaks. The app refuses a field that breaks this rule.
- **Ids.** Connection ids: `^[a-z0-9][a-z0-9-]{1,39}$`. Endpoint ids: `^[a-z0-9][a-z0-9._-]{0,127}$`
  (no `/` and no `:`, so a team tool path or a full URL is never an id). Organization ids:
  `^[A-Za-z0-9][A-Za-z0-9_:.-]{0,79}$`. Platform and provider names: `^[a-z0-9][a-z0-9._-]{0,63}$`.
- **Money.** Every amount is an integer of micros (millionths of the currency unit) and a safe
  JavaScript integer. `currency` is three capital letters (`BRL`). The app shows amounts cut down
  to cents.
- **Times.** ISO 8601 with a time zone, at most 40 characters.

### 1.1 Size limits of the app

| Answer | Limit |
| --- | --- |
| `/session` | 8 KB |
| Token | 8 KB |
| Catalog | 256 KB, at most 100 connections, 50 operations each, 51 access rows each |
| `search`, `describe` | 64 KB |
| `call` | 1 MB (content at most 200,000 characters) |
| `usage` | 256 KB |

An answer above its limit is a failed answer (`hub_unavailable` in the app).

## 2. Tokens

### 2.0 The client of Builders Bot

Builders Bot is one public OAuth client of the Hub, with a fixed id:
`28244c0a-7d6b-4256-be9b-9933cf0e6e94` (client name "Builders Bot"). It is not a secret. The device
sign-in sends it as `client_id` to `POST /api/mcp-oauth/device` and in the `device_code` grant of
`POST /api/mcp-oauth/token`, and never calls `POST /api/mcp-oauth/register`. Every build (release,
development, debug) uses the same id. The Hub lists it for the proxy routes (`BUILDER_AI_PROXY_CLIENT_IDS`),
so a sign-in with it gets the refresh family that a proxy token request needs. The refresh grants of
section 2.2 do not send `client_id` (unchanged). A session that an earlier version made with a
registered client has no such family; the person signs in again.

### 2.1 The two credentials

| | Session token | Proxy token |
| --- | --- | --- |
| What | The existing Cultura Builder sign-in (device grant, scope `builder-ai`) | A new short token for connections, scope `builder-proxy` |
| Where in the app | Encrypted credential store, main process only | Main process memory only, at most 5 minutes |
| Used for | `GET /session` (access token); proxy token requests (refresh token) | Every `/api/builder-ai/proxy/v1/*` route |
| In the agent process | The LLM access token is in the agent environment today (PROXY §11.5 layer 8) | **Never** |

The Hub must refuse an LLM access token on every proxy route. Only a proxy token opens them. The
RFC 8693 exchange from an LLM token to a proxy token is forbidden.

### 2.2 `POST /api/mcp-oauth/token` (proxy token)

Form body (`application/x-www-form-urlencoded`):

| Field | Value |
| --- | --- |
| `grant_type` | `refresh_token` |
| `refresh_token` | The session refresh token |
| `resource` | `https://hub.culturabuilder.com/api/builder-ai/proxy` |
| `scope` | `builder-proxy` |
| `org` | The organization that pays. Absent for a token that only reads the catalog. |

Answer `200`:

```json
{ "access_token": "cbp_…", "token_type": "Bearer", "expires_in": 300, "org": "org_123" }
```

- `access_token` starts with `cbp_`. The app and its log redaction know the prefix, so no token is
  ever registered or logged. Characters: `[A-Za-z0-9._~+/=-]`, 8 to 4,096.
- `expires_in` at most 3,600; the app keeps a token at most 300 seconds and asks for a new one 60
  seconds before the end.
- `org` must be the `org` of the request (or `null`). Another value is refused.
- **Do not rotate the refresh token** on this request. If the Hub does rotate it, it must send the
  new one as `refresh_token`; the app saves it. A rotation per proxy token would multiply rotations
  and revoke the family on two parallel requests.
- **A proxy token request is never a reuse.** The session renewal (the same grant without
  `resource`) can rotate the refresh token. The app sends one grant at a time (a lock over the
  renewal and every proxy token request, which reads the session again once it holds the lock), but
  a second app process or a request that was already on the network can still send the token that
  a renewal just replaced. So the Hub accepts the previous refresh token for 60 seconds after it
  rotated it, for both grants, and does not revoke the family for that use. A use after the 60
  seconds is `invalid_grant`.
- Each token carries the claims `sub` (person), `org`, `client_id`, `sid` (session family) and scope
  `api.tool-catalog`. The Hub checks on each call that the `sid` family is alive.

Errors, as `4xx { "error": <code> }`:

| Code | When | What the app does |
| --- | --- | --- |
| `invalid_grant` | The refresh token is dead | Signed out |
| `not_member` | The person is not in `org` | `choose_org` for the next call |
| `consent_required` | This installation has no `builder-proxy` consent for `org` | Tells the person to allow it on the Hub |
| `connections_disabled` | The kill switch is on | Reads `/session` again; the tools leave the agent catalog |

## 3. `GET /api/builder-ai/gateway/v1/session` (extension)

The existing route, with the session access token. Add `capabilities`:

```json
{
  "active": true,
  "empresa": "Empresa X",
  "capabilities": {
    "connections": { "tool-catalog": { "enabled": true } },
    "connectionsUsage": true
  }
}
```

- `connections[id].enabled: false` with an optional `reason` code (for example `paused`) is the
  **kill switch**. The app keeps this answer at most 5 minutes; after a `connection_unavailable`
  answer or a `connections_disabled` token error it reads it again at once.
- `active` keeps its meaning: whether the account may use the Builder AI LLM (`builderAi`). It
  **does not** turn connections on or off. A person whose organization pays a connection and who
  has no LLM access still gets the connection, its page and Usage › Connections. Only
  `connections[id].enabled` opens a connection, and only `connectionsUsage` opens Usage.
- A missing `capabilities` means every connection is off. The app then shows no connection and reads
  no catalog; a catalog connection that `capabilities.connections` does not name is not shown.
- Keep the whole answer under 8 KB.
- The app waits at most 750 ms for this answer when an agent looks for tools: past that, the agent
  gets no connection tools in that search, and the answer, when it comes, is kept for the next one.
  A failed read (no answer in 25 seconds, a 5xx, an answer outside the contract) is kept 60 seconds:
  in that time the connections stay closed with no new request, except the person's Refresh.

## 4. `GET /api/builder-ai/proxy/v1/connections` (catalog)

Proxy token, with or without `org`. The catalog is per person: it has one `access` row per
organization of the person (and `personal` when the personal plan exists), whatever the `org` of
the token.

```json
{
  "catalogVersion": "2026-10-31.1",
  "ttlSeconds": 300,
  "viewer": {
    "userId": "u_…",
    "orgs": [{ "id": "org_a", "name": "Empresa A", "role": "member", "default": true }],
    "personal": false
  },
  "connections": [
    {
      "id": "tool-catalog",
      "name": "Catálogo de ferramentas",
      "tagline": "Dados externos pagos, com teto por pessoa",
      "description": "Dados externos pagos para os agentes: SEO e palavras-chave, dados de empresas, lojas de apps e avaliações.",
      "operations": [
        { "id": "search", "title": "Search", "effect": "read", "pricing": { "unit": "call", "basis": "fixed" } },
        { "id": "describe", "title": "Describe", "effect": "read", "pricing": { "unit": "call", "basis": "fixed" } },
        { "id": "call", "title": "Call", "effect": "read", "pricing": { "unit": "call", "basis": "metered" } }
      ],
      "items": { "count": 312 },
      "platforms": [{ "id": "google-ads", "name": "Google Ads", "group": "seo", "endpoints": 6 }],
      "dataPolicy": { "vendor": "treg.to", "region": "us", "retentionDays": 0 },
      "access": [
        {
          "orgId": "org_a",
          "org": "enabled",
          "user": "allowed",
          "consented": true,
          "currency": "BRL",
          "cap": { "kind": "limited", "amountMicros": 25000000 },
          "settledMicros": 1230000,
          "reservedMicros": 0,
          "availableMicros": 23770000,
          "effectiveAvailableMicros": 23770000,
          "bindingScope": "user",
          "state": "ok",
          "maxCostPerCallMicros": 1000000,
          "confirmAboveMicros": 250000,
          "resetsAt": "2026-11-01T03:00:00Z",
          "asOf": "2026-10-31T15:00:00.123Z",
          "counterVersion": 615,
          "categories": ["SEO e palavras-chave", "Dados de empresas", "Lojas de apps", "Avaliações"],
          "priceFromMicros": 10000,
          "requestedAt": null,
          "moreRequestedAt": null
        }
      ]
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `name` | At most 60 characters. `tagline` at most 120. `description` (optional) at most 2,000: what the connection gives, on its Marketplace page. |
| `platforms` | Optional, `tool-catalog` only. The platforms of the vendor catalog that the organization allows, at most 40: `id` (a platform slug, `^[a-z0-9][a-z0-9._-]{0,63}$`, unique), `name` (plain text, at most 60 characters), `group` (`seo`, `enrichment`, `reviews`, `market`, `research`, `developer`, `community`, `commerce`, `social`, `advertising`, `generation`, `other`) and `endpoints` (an integer ≥ 1). The app makes one tile of the Apps tab of each one. A row that breaks a rule is dropped alone, a second row with the same `id` is dropped, an unknown `group` reads as `other`, and the app keeps the first 40. |
| `dataPolicy` | `vendor`: the name that the page shows as "Provided by {vendor}" and in "Where the data goes" (`treg.to`, at most 120 characters). `region`: a code (`us`); the app writes `us` as "USA" in the reader's language and shows any other value as it is. `retentionDays`: the retention that Cultura Builder declares, or `null`. |
| `operations[].effect` | `read` or `external`. An operation with another value, or another `pricing.unit` (`call`, `page`, `result`, `1k_tokens`) or `pricing.basis` (`fixed`, `metered`), is hidden. Phase 1 and 2: `read` only. |
| `access[].org` | `enabled`, `not_enabled`, `not_in_plan`, `paused`, `revoked`. |
| `access[].user` | `allowed`, `not_allowed`, `requested`. |
| `access[].consented` | Whether this installation may spend this organization's connections (`builder-proxy` consent). |
| `cap` | `{ "kind": "limited", "amountMicros" }` or `{ "kind": "unlimited", "dailyMicros" }`. |
| `availableMicros` | `max(0, cap − settled − reserved + credit)` of the person × connection counter. |
| `effectiveAvailableMicros`, `bindingScope` | `min(person, organization × connection, organization total)`, and which scope binds: `user`, `org_connection`, `org_total`. |
| `state` | `ok`, `warning` (at or above 80 %), `reached` (section 7). |
| `maxCostPerCallMicros` | Required. The hard ceiling of one call. |
| `confirmAboveMicros` | A call with an estimate above it needs the person's approval (section 6.4). `null` = never. |
| `categories` | Optional. The categories of the vendor catalog that the organization allows, by name, in the language of `Accept-Language` (at most 40, each at most 60 characters of plain text). The page lists them; the app does not filter by them. |
| `priceFromMicros` | Optional. The cheapest price of one unit that the organization allows, for "from R$ 0.01 a call". |
| `requestedAt`, `moreRequestedAt` | Optional. When the person asked the admins for access, or for more money in this period (section 10.1), while that request is open (7 days). `null` when there is none. |

A row that breaks a rule is dropped alone; a bad envelope fails the whole catalog.

### 4.1 Who pays (app rule, for the Hub's information)

The app picks the payer in the main process, from the rows with `org: enabled`, `user: allowed`
and `consented: true`. The agent has no field for it:

1. The organization that the person chose for the connection, or the one that paid its last call.
2. With no choice yet: the only organization; else the personal plan when it is the only row.
3. Several organizations and no choice: `choose_org`. The person picks on a card. The Hub's
   `default` only puts that organization first on the cards.
4. When the chosen or last organization is gone, the app asks again (`choose_org`). It never moves
   the cost to another organization or to the personal plan by itself. A routine run gets a refusal.

## 5. `search` and `describe`

Both are `POST /api/builder-ai/proxy/v1/connections/tool-catalog/<operation>`, with a proxy token
for the paying organization. They are free: no ledger entry, only the rate limits of PROXY §14.
They read the Hub mirror, so the agent's query never goes to the vendor (design D17).

### 5.1 `search`

Body: `{ "query": "keyword volume", "platform"?: "google-ads", "limit"?: 10 }`. `query` is 1 to 200
characters of plain text; `limit` 1 to 10. The app refuses a `query` that holds a key, a token, a
cookie or a session before it sends anything; the Hub refuses it too, with
`422 { "error": "input_refused", "field": "query" }`.

```json
{
  "results": [
    {
      "endpointId": "seo.keyword-volume",
      "title": "Keyword search volume",
      "platform": "google-ads",
      "provider": "kwdata",
      "priceKind": "per_target",
      "unitPriceMicros": 50000,
      "currency": "BRL",
      "maxUnits": 10,
      "maxCostMicros": 500000,
      "reliability": 0.97,
      "effect": "read"
    }
  ],
  "verdict": "match"
}
```

`priceKind`: `per_call`, `per_row` or `per_target`. Only `effect: read` rows reach the app; the app
drops others. `title` at most 80 characters.

### 5.2 `describe`

Body: `{ "endpointId": "seo.keyword-volume" }`.

```json
{
  "endpointId": "seo.keyword-volume",
  "title": "Keyword search volume",
  "summary": "Monthly search volume for a list of keywords.",
  "method": "POST",
  "params": {
    "query": null,
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": ["keywords"],
      "properties": {
        "keywords": { "type": "array", "maxItems": 10, "items": { "type": "string", "maxLength": 80 } },
        "country": { "type": "string", "enum": ["br", "us"] }
      }
    }
  },
  "priceKind": "per_target",
  "unitPriceMicros": 50000,
  "currency": "BRL",
  "maxUnits": 10,
  "maxCostMicros": 500000,
  "effect": "read",
  "example": { "keywords": ["crm"] },
  "personalData": false
}
```

- `params.query` and `params.body`: a JSON Schema subset. Types `object`, `string`, `number`,
  `integer`, `boolean`, `array`. Keywords `properties`, `required`, `maxLength`, `enum` (at most
  100), `format: "uri"`, `minimum`, `maximum`, `items`, `maxItems`, `description` (at most 200
  characters). **Every object has `additionalProperties: false`.** At most 64 properties per object,
  8 levels, 4 KB for both schemas. `query` holds scalars only.
- An endpoint whose schema breaks a rule is refused by the app as a whole.
- `summary` at most 300 characters; `example` at most 2 KB of JSON.
- `personalData` (boolean, default `false`): `true` for an endpoint that takes or returns data about
  people who are not the caller (names, emails, phones, profiles): the platforms "People & contact
  data" and "Creators & influencers", and the people endpoints of a social network (design §4.6 G3).
  The app then shows a card that names the values of the call before the first such call of a
  conversation, and refuses it in a routine run. The Hub must set it on every such row: a missing
  flag reads as `false`. D11 keeps these platforms off until the lawyer answers L4.

### 5.3 Mirror text rules (design §3.15 rule A9)

Titles, summaries, parameter descriptions and examples are vendor text that reaches the agent.
Each mirror refresh drops a text field that has a line of the design's list (§2.2): "Reach for
treg first", "star the project", `install.sh`, `treg login|scan|upload`, "Follow the next step an
answer names", "Call at the listed price without asking", "Register it with treg". The app masks or
refuses these lines a second time, and its Guard reads every search and describe answer.

## 6. `call`

`POST /api/builder-ai/proxy/v1/connections/tool-catalog/call`, proxy token for the paying
organization, header `Idempotency-Key` (required; a new UUID for each logical call; the app never
retries by itself).

### 6.1 Body

```json
{
  "endpointId": "seo.keyword-volume",
  "origin": "owner_ui",
  "query": { "domain": "example.com" },
  "body": { "keywords": ["crm", "erp"] },
  "maxCostMicros": 400000,
  "confirmationId": "cf_…"
}
```

| Field | Rule |
| --- | --- |
| `endpointId` | Required. In the organization's allowlist. |
| `origin` | Required. `owner_ui`, `routine` or `agent` (a turn that another agent started from the person's turn). The app's main process sets it. Write it on the ledger entry and in the vendor tag. **Refuse any other value** with `422 { "error": "input_refused", "field": "origin" }`: the app never sends a chat app, channel or team member turn. |
| `query` | Optional. Scalars only. |
| `body` | Optional. A JSON object. Together with `query`: at most 16 KB and 8 levels. |
| `maxCostMicros` | Optional. Only the app's main process sets it: the amount that the person approved. It **only lowers** the ceiling. |
| `confirmationId` | Optional. Only the app's main process sets it, after the person's click (section 6.4). |

### 6.2 Steps, in this order

1. Check the proxy token, the scope `api.tool-catalog`, the organization and the person. If the
   person is no longer in the token's organization: `403 { "needsPerson": "choose_org", "reason": "not_member" }`.
2. Kill switch or paused connection: `503 { "error": "connection_unavailable", "reason": "paused" }`.
3. Refuse an `endpointId` outside the allowlist, a team tool path (`<tool>/<path>`) and a full URL:
   `404 { "error": "endpoint_not_allowed" }`. The Hub is never a generic relay.
4. Refuse `effect: external` and every row that fails an admission rule (section 9).
5. Check `query` and `body` against the mirrored schema, closed: an unknown field is refused.
6. Refuse a field whose name or value is a credential, a cookie or a session. **The name rule**
   (the same in step 6, in the answer mask of section 6.3 and in the app): remove case, `-`, `_`
   and `.` from the name. It is a credential when the result is one of `key`, `apikey`, `xapikey`,
   `token`, `accesstoken`, `refreshtoken`, `idtoken`, `authtoken`, `auth`, `authorization`,
   `proxyauthorization`, `bearer`, `password`, `passwd`, `pass`, `secret`, `clientsecret`,
   `privatekey`, `cookie`, `cookies`, `session`, `sessionid`, `sid`, `liat`, `csrf`, `csrftoken`,
   `xcsrftoken`, `header`, `headers`, `proxy`, `sig`, `signature`; or when it contains `cookie`,
   `session`, `password`, `secret`, `authorization`, `bearer`, `csrf` or `apikey`; or when one of its
   words (split at case changes, `-`, `_`, `.`) is `token`, `auth`, `secret`, or two words make
   `apikey` or `privatekey` (`apiToken`, `X-Auth-Token`, `client_secret`, `private_key`). These
   pagination and count names are data, not credentials: `page_token`, `next_token`,
   `next_page_token`, `prev_token`, `previous_token`, `prev_page_token`, `previous_page_token`,
   `continuation_token`, `cursor`, `token_count`, `max_tokens`. Refused values: known key prefixes,
   cookie pairs (`a=b; c=d`, `li_at=`, `sessionid=`, `csrftoken=`), JWTs, or `Bearer`/`Basic`
   credentials. Answer `422 { "error": "input_refused", "field": "body.cookies" }`. Never echo the value.
7. Every `format: "uri"` field, every value that is a URL and **every URL inside a text value**:
   `http` or `https`, default port, a public host (no private, loopback, link-local,
   CGNAT/Tailscale `100.64.0.0/10`, IETF `192.0.0.0/24`, documentation `192.0.2.0/24`,
   `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`, benchmark `198.18.0.0/15`, NAT64
   `64:ff9b::/96`, `.local`, `.internal`, `.ts.net`), no user or password, no signed query (a query
   name `x-amz-signature`, `x-amz-credential`, `x-goog-signature`, `x-goog-credential`, `signature`,
   `sig`, `token`, `access_token`, `key`, `api_key`, `apikey`, `auth`, `code`, or a name with the word
   `signature`, `sig` or `credential`). Refuse a value that starts with `//` (a protocol-relative URL).
   Read a special scheme (`http`, `https`, `ftp`, `ws`, `wss`, `file`) as a WHATWG URL parser reads
   it: `http:\\host`, `http:/host` and `https:host` name `host`, as a whole value and inside a text.
   Resolve the name and check the address again before the vendor call.
8. Estimate (section 7.1). If the estimate is above `maxCostPerCallMicros`, or above the body's
   `maxCostMicros`: `402 { "error": "cost_above_limit", "estimateMicros" }`. The vendor is not called.
9. Cost approval (section 6.4).
10. Reserve the estimate in the ledger (conditional `UPDATE`). If it does not fit:
    `402 { "needsPerson": "cap_reached" | "org_budget_reached", "currency", "availableMicros", "effectiveAvailableMicros", "neededMicros", "bindingScope", "resetsAt" }`.
11. Call the vendor (section 8), at most 25 seconds, `redirect: "error"`, at most 2 MB of answer.
12. Settle (section 7.2), build `content` (section 6.3), write the ledger entry, then answer.

### 6.3 Answer `200`

```json
{
  "requestId": "le_01J9Z3K7Q2",
  "endpointId": "seo.keyword-volume",
  "servedBy": "kwdata",
  "providerStatus": 200,
  "orgId": "org_a",
  "chargedMicros": 100000,
  "estimateMicros": 100000,
  "currency": "BRL",
  "availableMicros": 23670000,
  "effectiveAvailableMicros": 23670000,
  "bindingScope": "user",
  "state": "ok",
  "warningCrossed": false,
  "warnings": [],
  "counterVersion": 616,
  "asOf": "2026-10-31T15:01:00.000Z",
  "signals": { "verificationVerdict": "verified", "domainMatch": true, "ignoredFilters": ["country"] },
  "truncated": false,
  "content": { "rows": [] }
}
```

- `orgId`: **always the organization of the proxy token**. The app refuses an answer with another
  `orgId` as `hub_unavailable`: it does not show the result, and it does not move the payer.
- `chargedMicros`: never more than the amount that the person approved (`maxCostMicros`) or, with
  no approval, than `confirmAboveMicros`. The app logs a larger charge and adds a line to the
  conversation that tells the person to tell an admin.
- `requestId`: the ledger entry id, `^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`.
- `servedBy`: from `X-Treg-Served-By` only when it matches `^[a-z0-9._-]{1,64}$`, else `unknown`.
- `warnings`: `[{ "code": "cap_warning", "percent": 80 }]` while the person is at or above 80 %.
  `warningCrossed: true` only on the call that crossed the mark (once per organization, connection
  and period).
- `signals`: typed values taken from the vendor's `_treg` block. `verificationVerdict` is one of
  `verified`, `unverified`, `mismatch`, `unknown`. `ignoredFilters` holds declared parameter names
  only. **Never copy `_treg.advice` or any other vendor free text.**
- `content`: the provider body only. Drop the `_treg` block. For a routed answer
  `{ output, raw, _treg }`, send `output` only. Keep provider fields such as `help`: they are data,
  and the app's Guard reads them. Mask credentials in the decoded JSON, never in its text: the
  value of each JSON field whose name is a credential by the name rule of section 6.2 step 6, at
  every depth under that field (nested objects and lists too), numbers included; and the value of
  each URL query parameter whose name, decoded from percent-encoding, is a credential by that rule
  or a signed-query name of step 7; `Bearer` values; known key prefixes. Under a credential name a
  boolean and null stay, and a number stays only when the name is a count (it ends in `count` or
  `total`, or it is the plural of a credential name: a `sessions` count is data). Outside a
  credential field, numbers and booleans stay. An
  `echoFieldExceptions` entry of a rule (section 11) may keep one reviewed field of one endpoint.
  Cut to 200,000 characters and set `truncated`. The app masks a second time with the same rule,
  in one pass, and holds the whole result back (`result_withheld`) when a secret still shows.
- Never copy a vendor header into the answer.

### 6.4 Cost approval (`confirm_cost`)

The person approves a cost on a page of the Hub. The Hub does not trust an approval that the app
declares (security fix of 2026-11-01): a `confirmationId` opens a call only after the person
approved it on that page.

When the estimate is above `confirmAboveMicros` and the body has no valid `confirmationId`:

```json
{ "needsPerson": "confirm_cost", "currency": "BRL", "estimateMicros": 400000,
  "confirmationId": "cf_…", "expiresAt": "2026-10-31T15:06:00Z" }
```

- Status `409`. Reserve nothing. Call nothing.
- `confirmationId`: `^[A-Za-z0-9_-]{16,128}$`, single use, valid 5 minutes, bound to (organization,
  person, endpoint, hash of `endpointId` + `query` + `body` with sorted keys, estimate).
- Accept it only when all five match and the new estimate is not higher. Else answer
  `409 { "error": "input_refused", "reason": "confirmation_invalid", "field": "confirmationId" }`.
  A used or expired id gets the same answer.
- The approval page is `https://hub.culturabuilder.com/builder-ai/conexoes/aprovar/<confirmationId>`
  (the id URL-encoded). The person signs in to the Hub there, sees the endpoint, the amount and the
  organization, and approves or denies. Only the person of the confirmation may decide.
- The app shows a card that says the approval is on the Hub. After **Allow**, it opens the approval
  page in the person's default browser, and reads the state (section 6.4.1) every 2 seconds, until a
  final state, `expiresAt` (at most 5 minutes) or the end of the turn. After `approved`, it sends the
  call once, with the id and `maxCostMicros` equal to the approved estimate. After `denied`,
  `expired`, `used` or the deadline it sends nothing. A routine or a turn that another agent started
  gets a refusal, no card and no page. The agent never sees the id or the page URL.
- A call with a `confirmationId` that passes the checks above, but that the person has not approved:
  `409 { "error": "not_allowed", "reason": "confirmation_not_approved" }`; one that the person
  denied: `409 { "error": "not_allowed", "reason": "confirmation_denied" }`. The app reads both as a
  refusal with no new card.

#### 6.4.1 `GET /api/builder-ai/proxy/v1/connections/tool-catalog/confirmations/<confirmationId>`

Proxy token of the organization of the confirmation. Answer `200`, at most 4 KB:

```json
{ "confirmationId": "cf_…", "state": "pending", "expiresAt": "2026-10-31T15:06:00Z" }
```

`state` is `pending`, `approved`, `denied`, `expired` (after `expiresAt`) or `used` (after the one
call that the Hub accepted). An unknown id, or an id of another organization or person, gets an
`{ "error": … }` body (`404 { "error": "not_found" }` in the fake), and the app stops waiting with a
refusal. The app reads only this route, never a list of confirmations.

### 6.5 Errors

Every error is `{ "error": <code>, ... }` with these optional fields: `reason` and `scope` (codes),
`retryAfter` (seconds, 0 to 86,400), `estimateMicros`, `chargedMicros`, `providerStatus` (100 to
599), `providerMessage` (at most 300 characters of the provider's refusal, masked; the app puts it in
the untrusted envelope), `field` (the refused input field), `alternatives` (at most 5 endpoint ids).

| Code | Status | When |
| --- | --- | --- |
| `upstream_unavailable` | 502 | Network error or timeout to the vendor; vendor 5xx with `X-Treg-Error`; `202 pending` (`reason: pending_not_supported`, settle by the reservation) |
| `connection_unavailable` | 503 | Kill switch or pause (`reason: paused`); vendor `402 insufficient_balance` (`reason: vendor_balance`, pause for everyone); vendor `429 platform_daily_cap_reached` (`reason: vendor_daily_limit`, `retryAfter` to 00:00 UTC); vendor `401` (`reason: vendor_auth`) |
| `cost_above_limit` | 402 | Estimate above a ceiling; vendor `402 route_max_cost` (refresh the mirror row) |
| `rate_limited` | 429 | Hub velocity limits; organization daily share (`scope: org_daily_share`); vendor `429 tag_spend_cap_reached` (`scope: daily_brake`); vendor `share_busy` or provider `429` (`scope: provider`) |
| `not_allowed` | 403 | The person or organization may not use the connection; vendor `403 tag_blocked` |
| `endpoint_not_allowed` | 404 | Section 6.2 steps 3 and 4 |
| `input_refused` | 422 / 409 / 400 | Section 6.2 steps 5 to 7; `confirmation_invalid`; missing `Idempotency-Key` (`reason: idempotency_key`) |
| `internal_error` | 500 | Hub bug; vendor `422` malformed tags; vendor pin conflict `403` |
| `provider_unavailable` | 503 | Vendor `503 provider_capacity_unavailable` or `403 capability_pinned`, with `alternatives` |
| `provider_rejected_request` | 422 | Provider 4xx (not 429) without `X-Treg-Error`; settle with `X-Treg-Cost-Micro` when present |
| `provider_failed` | 502 | Provider 5xx without `X-Treg-Error` |
| `no_result` | 200 / 502 | Vendor `502 route_failed` or `X-Treg-Upstream-Failed`, with `chargedMicros` |
| `result_too_large` | 502 | Answer above 2 MB |
| `idempotency_in_progress` | 409 | The same `Idempotency-Key` is still running |
| `idempotency_conflict` | 409 | The same `Idempotency-Key` with another body |
| `result_expired` | 410 | The stored answer of that key is gone |
| `unauthorized` | 401 | Bad or expired proxy token |

**Never forward a vendor error body** (it holds the balance and a top-up URL) and never a vendor
header. An unknown code reaches the agent as `internal_error`.

`needsPerson` answers: `cap_reached`, `org_budget_reached`, `confirm_cost`, `choose_org`,
`not_allowed` (with `reason`, for example `consent_required`).

## 7. Money and caps

### 7.1 Estimate and reservation (design §3.15)

- Units: `per_call` = 1. `per_row` = `min(limit of the input, schema maximum, maxUnits)`; with no
  `limit`, the Hub writes 20 into the request. `per_target` = the number of items in the target list,
  at most `maxItems` and `maxUnits`.
- `estimateMicroUsd = units × unitPriceMicroUsd`; `estimateMicros = ceil(estimateMicroUsd × rate)`
  with the period rate in parts per million.
- Ceiling = `min(maxCostMicros of the body, estimateMicros, maxCostPerCallMicros)`.

### 7.2 Settlement

- `settled = min(ceil(X-Treg-Cost-Micro × rate), reservation)`. A 2xx without
  `X-Treg-Cost-Micro` settles by the reservation and pages operations.
- An overrun (vendor cost above the reservation) is paid by Cultura Builder, alerts, and removes the
  endpoint from the allowlist.
- Answer only after the settlement commit.

### 7.3 The 80 % and 100 % rules

- **80 %:** the settlement `UPDATE` sets the warning mark once per (organization, connection,
  period). That answer has `warningCrossed: true` and `warnings: [{ "code": "cap_warning", "percent": 80 }]`.
  The Hub sends one email to the person; one email to the admins at 80 % of the organization budget.
- **`reached`:** the effective available amount is less than the cheapest one-unit price of the
  endpoints that the organization allows. No call fits.
- **100 %:** the reservation fails: `402 cap_reached` or `402 org_budget_reached`. The vendor is
  not called and charges nothing. No tolerance.
- Period: calendar month, 00:00 on day 1 in `America/Sao_Paulo`.

## 8. What the Hub sends to the vendor

`POST|GET https://treg.to/call/<endpointId>` with **only** these headers:

| Header | Value |
| --- | --- |
| `X-Treg-Token` | The organization's pinned agent token, from the vault |
| `X-Treg-Meta` | `org=<o_ tag>,user=<u_ tag>,origin=<owner_ui\|routine\|agent>,env=<prod\|staging>,req=<ledger entry id>` |
| `X-Treg-Route-Max-Cost` | `estimateMicroUsd` as USD with 6 decimals, rounded down |
| `Idempotency-Key` | The ledger entry id |
| `Content-Type` | `application/json` (POST only) |
| `Accept` | `application/json` |
| `Cache-Control` | `no-cache`, **always** |
| `X-Treg-Route-Waterfall`, `X-Treg-Route-Strict-Filters`, `X-Treg-Route-Verify` | Only when the mirror row needs them |

- **Never `Authorization`** (the vendor relays it to the provider), **never a cookie**, never
  `X-Forwarded-*`, never a header of the app's request. Headers that HTTP itself adds (`Host`,
  `Content-Length`, `Connection`, `User-Agent`, `Accept-Encoding`) are the only others.
- Tags are random opaque ids (`o_` and `u_` plus 12 to 32 hex), never an email or a hash of one.
- The query parameters of `query` go in the URL; `body` goes as JSON.
- The vendor token never leaves the vault: not in logs (mask `X-Treg-Token` and the `treg_`
  prefix), not in an answer, not in the admin panel (last 4 characters only).

## 9. Admission rules of the mirror (design §3.15)

A mirror row reaches the allowlist only when it passes all of these. Deny wins.

| # | Rule |
| --- | --- |
| A1 | Known price, `per_call`, `per_row` or `per_target` |
| A2 | The reservation is a true ceiling (no `settle: usage` row without a ceiling parameter) |
| A3 | `maxUnits × unit price` is at most the largest per-call ceiling |
| A4 | No async task, no inline media, no spooled answer |
| A5 | A routed id only when every provider of its plan passes A1 to A4 and is synchronous |
| A6 | Vendor overflow is off for the team |
| A7 | No parameter named like a cookie, session, header, auth, bearer, token, `li_at`, `sessionid`, `csrf` or proxy, and no free object of headers |
| A8 | The echo test passed in staging (no request part or key echoed in the answer) |
| A9 | Vendor text is clean (section 5.3) |
| A10 | p95 latency at most 15 seconds over at least 20 staging calls |
| A11 | `effect: read`, not Reddit, not a blocked job |

## 10. `GET /api/builder-ai/proxy/v1/usage?scope=me[&period=YYYY-MM]`

Proxy token for the organization.

```json
{
  "org": { "id": "org_a" },
  "period": { "key": "2026-10", "resetsAt": "2026-11-01T03:00:00Z", "timeZone": "America/Sao_Paulo" },
  "currency": "BRL",
  "asOf": "2026-10-31T15:00:00Z",
  "connections": [
    {
      "id": "tool-catalog",
      "settledMicros": 1330000,
      "reservedMicros": 0,
      "calls": 14,
      "availableMicros": 23670000,
      "effectiveAvailableMicros": 23670000,
      "state": "ok",
      "counterVersion": 616,
      "platforms": [{ "platform": "google-ads", "settledMicros": 900000, "calls": 9 }]
    }
  ]
}
```

Each row can also carry the person's `cap` (the same shape as in the catalog) and its `bindingScope`;
the app shows "R$ 3.60 left of R$ 25.00" when they are there.

`platforms` is for the person's own view only. The admin view has no routines, agents or times.

The app reads `/usage` only while `/session` has `capabilities.connectionsUsage: true`, for each
organization whose catalog row it may spend, and keeps each answer at most 30 seconds.

### 10.1 `POST /api/builder-ai/proxy/v1/connections/{id}/access-requests`

The person asks the admins of one organization for access to a connection ("Ask the admin"), or for
more money in this period after the cap ("Ask the admin for more"). The proxy token names the
organization; the body names only the kind. The app never sends this by itself: only a click of the
person on the Marketplace page or on the limit line of a chat sends it.

Body: `{ "kind": "access" | "more" }`. Answer `200`:

```json
{ "requestedAt": "2026-11-18T14:05:00Z", "nextAllowedAt": "2026-11-25T14:05:00Z", "repeated": false }
```

- One request per person, connection, organization and kind counts in 7 days. A second request in
  that time answers `repeated: true` with the first `requestedAt`, and sends no new notice to the
  admins.
- The Hub notifies the admins of the organization (email or panel), with the person, the connection
  and the kind. For `more`: the person's cap, what was spent and the date of renewal. Never the input
  or the output of a call.
- The catalog row then carries the date in `requestedAt` or `moreRequestedAt`, so the page shows
  "Request sent on {date}" on any computer of the person.
- The route works while the connection is paused or not on for the person: it is how the person asks.
- Errors: `422 { "error": "input_refused", "field": "kind" }`; `403 { "needsPerson": "choose_org",
  "reason": "not_member" }` when the person left the organization; `429 { "error": "rate_limited",
  "scope": "access_request", "retryAfter" }` for a flood of requests. The app says "The request did
  not reach Cultura Builder" for any other answer.

## 11. What the Hub stores

In addition to the PROXY §12.1 tables (`connection_plan`, `ledger_entry`, counters, audit):

| Table | Main fields | Note |
| --- | --- | --- |
| `vendor_account` | `id`, `vendor`, `env`, `vendorTeamId`, `ownerMailbox`, `archiveOptOutAt`, `overflowOptOutAt`, `dailyCapMicroUsd`, `balanceAlertMicroUsd`, `status` | One row per vendor team. No secret. |
| `vendor_token` | `id`, `vendorAccountId`, `kind` (`org_agent`, `admin`), `orgId`, `agentName`, `vendorAgentUserId`, `vaultRef`, `vendorKeyId`, `pinnedTags`, `dailyCallCap`, `createdAt`, `rotatedAt`, `disabledAt`, `revokedAt` | The value lives only in the vault. |
| `vendor_subject` | `kind` (`org`, `user`), `hubId`, `orgId`, `vendorTag`, `createdAt`, `blockedAt`, `deleteAfter`, `deletedAt` | The random tags. A person who comes back gets a new tag. |
| `tool_catalog_rule` | `scope`, `match`, `decision`, `effect`, `paramExceptions`, `echoFieldExceptions`, `reason`, `reviewedBy`, `reviewedAt` | The curated allowlist. Deny wins. |
| `tool_catalog_mirror` | `endpointId`, `platform`, `provider`, `title`, `summary`, `method`, `params`, `strictQuery`, `priceKind`, `unitPriceMicroUsd`, `unitsField`, `maxUnits`, `settleKind`, `ceilingParam`, `overflowPriceUsd`, `asyncTask`, `inlineMedia`, `routedPlan`, `p95Ms`, `echoCheckedAt`, `textTriage`, `reliability`, `priceVersion`, `refreshedAt` | Refreshed once a day. A change of price, plan or parameters sends the row to review. |
| `ledger_entry` (new columns) | `vendor`, `vendorCostMicroUsd`, `vendorOriginalCostMicroUsd`, `vendorReplay`, `vendorServedBy`, `endpointId`, `platform`, `priceKind`, `units`, `estimateMicroUsd`, `origin` | No input, no output, no URL, no query. |
| `vendor_call_link` | `ledgerEntryId`, `vendorCallId`, `createdAt`, `deleteAfter` | Deleted after 90 days. |
| `vendor_reconciliation` | (`date`, `vendorAccountId`, `tagKey`), `hubSettledMicroUsd`, `tregTotalMicroUsd`, `attributedMicroUsd`, `unattributedMicroUsd`, `diffMicroUsd`, `status` | Nightly; never sum `org` and `user`. |
| `confirmation` | `id`, `orgId`, `userId`, `endpointId`, `bodyHash`, `estimateMicros`, `expiresAt`, `usedAt` | Section 6.4. |
| `idempotency` | (`orgId`, `key`), `bodyHash`, `status`, `answer`, `expiresAt` | Section 6.5, PROXY §12.4. |
| `access_request` | (`orgId`, `userId`, `connectionId`, `kind`), `requestedAt`, `notifiedAt` | Section 10.1. One open row per key for 7 days; no input or output of a call. |

## 12. Before the first call (design §3.3, hard requirements)

1. Vendor archive off (`archive: false`) and overflow off (`platform_overflow: false`) for the team.
2. `Cache-Control: no-cache` on every call (section 8).
3. A team daily cap that is never `0` (0 means no limit).
4. The nightly check of these settings pauses the connection when one changes.

## 12.1 Pages of the Hub that the app opens

The app opens only these pages, in the person's default browser, from the main process:

| Page | When |
| --- | --- |
| `https://hub.culturabuilder.com/builder-ai/conexoes/aprovar/<confirmationId>` | The person allowed the cost card (section 6.4). |
| `https://hub.culturabuilder.com/builder-ai/conexoes` | "Open the Hub" on the connection page, when this app has no `builder-proxy` consent of an organization (`consented: false`). The person allows it there, then refreshes the page. |

## 13. How the app checks this contract

`bun scripts/hub-connections-call-e2e.ts` runs the real app modules against `scripts/fake-hub/`
and writes `.buildersbot-build/hub-connections/tool-catalog.json`. `bun scripts/hub-connections-usage-e2e.ts`
checks the catalog fields of the page, `/usage` and the access requests of section 10.1, and writes
`.buildersbot-build/hub-connections/usage.json`. `bun scripts/hub-connections-treg-live-e2e.ts` checks
the fixed client of section 2.0, the `platforms` of section 4, the approval on the Hub of section 6.4
and the pages of section 12.1, and writes `.buildersbot-build/hub-connections/treg-live.json`. The fake
Hub follows this document; the Hub team can read it as a reference implementation of sections 2 to
10.
