# Hub connections

Hub connections are paid third-party APIs that Cultura Builder offers through its Hub. The vendor
key stays in the Hub vault. The app and the agent never hold it. The first connection is
`tool-catalog` (the treg.to tool catalog, option A+ of the treg design). The wire contract for the
Hub team is [hub-connections-contract.md](hub-connections-contract.md).

## Parts

| Part | Where | What it does |
| --- | --- | --- |
| Contract | `packages/contracts/src/hub-connections.ts` | Paths, limits, error codes and strict decoders of every Hub answer. A decoder keeps only the fields it knows and refuses markup, bad ids and unsafe amounts. |
| Hub client | `src/backend/hub-connections/hub-connection-client.ts` | Main process only. Reads `/session`, asks for proxy tokens (`cbp_…`, one per organization, memory only, at most 5 minutes), reads the catalog and runs `search`, `describe`, `call` and `usage`. 25-second timeout, `redirect: "error"`, a byte ceiling on each answer. No method returns a token and no error carries one. |
| Input checks | `hub-connection-input.ts` | The first lock before anything goes to the Hub (below). |
| Payer rule | `hub-connection-payer.ts` | Which organization pays. The agent has no field for it. |
| Tools | `hub-connection-tools.ts`, `hub-connection-tool-definitions.ts` | `openbot_connections.list` and `openbot_connections.call`: access, limits per turn and per hour, cost and payer cards, the untrusted envelope, masking. |
| Router | `src/backend/agent/openbot-tool-router.ts` | Runs the two tools with the Guard before (outbound) and after (inbound), and shows the cards through `AttentionRegistry.awaitToolApproval` (owner only, always asks). |
| Catalog | `src/backend/agent/tool-catalog.ts` | The two tools are deferred tools of a gated namespace. They are in `tool_search`, `tool_describe` and `tool_call` only for an agent that has them in this turn. |

## How an agent reaches a connection

The agent gets **no direct tool**. It finds `openbot_connections.list` and `.call` with
`tool_search` and runs them with `tool_call`, like every other deferred tool. Every provider has
these discovery tools: Codex (also a code-mode model, through the `openbot` namespace), Claude
Code, OpenCode and the MCP-only providers through `local-mcp-bridge.ts`. No vendor MCP server, skill
or CLI reaches an agent.

The router grants the namespace per call. It is absent when:

- the person is not signed in to Cultura Builder;
- `/session` has the connection off (the kill switch), fails, or answers outside the contract;
- the agent's own setting `connectionsOff` names the connection (`AgentSummary.connectionsOff`,
  stored on the agent record, local only, absent = every connection);
- the turn does not come from the person at this computer, one of the person's routines, or an
  agent that the person's turn started. A chat app thread (Slack, Discord, Telegram), a channel
  and a team member never get it (`hubTurnOrigin`, from the mailbox deliveries of the turn).

`tool-catalog` has three operations: `search` (by job), `describe` (closed schema and price) and
`call`. The texts that the agent reads are Builders Bot's own (`HUB_CONNECTION_GUIDANCE`), in
English, without vendor text. The vendor lines of the treg design §2.2 are masked in every Hub text
(`maskVendorPhrases`); a search row or a describe with such a title is dropped.

## Input checks before the Hub

`readCallInput` and `checkCallInput` run in the main process, in this order, and a refused input
never leaves the computer. The refusal names the rule and the field path, never the value.

1. Only `endpointId`, `query` and `body`. `confirmationId` and `maxCostMicros` from the model are
   dropped and named in `ignoredFields`: only the main process sets them.
2. At most 16 KB and 8 levels.
3. Credential names anywhere (`api_key`, `token`, `cookie`, `session`, `authorization`, `headers`,
   `proxy` …) and credential values: JWTs, cookie pairs and session cookies, `Bearer`/`Basic` values,
   known key prefixes and registered secrets (`findSecretValue`).
4. The closed schema of the mirrored endpoint: unknown field, missing field, type, enum, length,
   range, list size.
5. URLs: every `format: "uri"` field and every value that is a URL must be public `http(s)` on the
   default port, with no user, password or signature. Private, loopback, link-local and
   `100.64.0.0/10` (Tailscale) addresses, `.local`, `.internal`, `.ts.net`, `localhost` and `file:`
   are refused (`isPublicAddress`).

A `search` text gets rule 3 too (`valueRule`), so a key, a cookie or a token never leaves in a
search, also when the Guard is off. The cookie and token shapes are the Guard's own
(`cookieOrToken` in `guard-triage.ts`), so both locks refuse the same values; the Guard then stops a
cookie or a session that reaches it, with no card ([The Guard](guard.md#connection-tools)).

The Hub runs the same checks again.

## Calls about people

A describe answer with `personalData: true` (people and contact data, creators, people endpoints of
a social network) is an endpoint about people who did not agree to the lookup (the treg design §4.6
G3, question L4 for the lawyer). After the input checks and the Guard, the first such call of a
conversation shows a card that names the endpoint, the values that the call asks about (names,
domains, addresses; at most 300 characters) and where the data goes: Cultura Builder, treg.to (USA)
and the provider (`status.agent.connectionPeopleData`). **Allow** covers the next calls about
people in that conversation; **Deny** sends nothing, and the next call asks again. A routine run or
a turn that another agent started never makes such a call, also in a conversation where the person
allowed it: the result is `needsPerson: "people_data"` with no card.

## Who pays

`choosePayer` reads the catalog's access rows that can pay (`enabled`, `allowed`, `consented`):

- The anchor is the organization that the person chose, or the one that paid the last call.
- With no anchor: the only organization, else the personal plan when it is the only row.
- Several organizations, or an anchor that is gone: `choose_org`. In a person's own turn, a card
  asks about each organization in turn (at most three). A routine run or a turn that another agent
  started gets a refusal. The app never moves the cost to another organization by itself.
- A Hub answer `choose_org` (the person left the token's organization) drops that organization's
  token and catalog, so the next call asks again.

## Cost approval

A call above the organization's `confirmAboveMicros` gets `confirm_cost` from the Hub with a
`confirmationId`. The id stays in the main process. In a person's own turn, the app shows a card with
the endpoint, the amount and the payer (`status.agent.connectionConfirmCost`). Only the owner can
answer it (`ownerOnly`), and a Full access grant does not answer it (`alwaysAsk`). After **Allow**,
the app sends the id once, within 5 minutes and before the Hub's `expiresAt`, with
`maxCostMicros` equal to the approved estimate. A second `confirm_cost` for the same call is not
asked again. In a routine run or a turn that another agent started, the answer is a refusal with no
card.

## Results

- Every Hub text and every result reaches the agent inside
  `<connection_output untrusted="true" connection="…" endpoint="…" served_by="…">`, with `<` and
  `>` escaped in the content. Attributes are slugs only.
- Results are masked again in the app (`maskConnectionSecrets`): credential fields and query
  parameters, `Bearer` values and known prefixes. This catches a provider key that the Hub missed.
- The Guard reads the content of `list`, `search`, `describe` and `call`
  (`GUARD_TOOL_INBOUND`, `GUARD_INBOUND_PATHS["hub-connections"]`) and the input of `call`
  (`GUARD_TOOL_EGRESS`, `guardOutboundItem`).
- One call result is kept for the turn: the same input again is free (`repeated: true`), and
  `offset` pages a long result 30,000 characters at a time.
- In a turn that another agent started, results leave out the amounts and the payer: they would
  go to that agent's provider.
- A result that holds an email address or a phone number gets the field `contactData`, outside the
  envelope, with Builders Bot's fixed note (`CONTACT_DATA_NOTE`): the contacts are guesses of the
  provider, and the agent contacts none of them unless the person asks for that address (G9). The
  app does not stop a later send to such an address by itself: `messaging_post` posts only to places
  that the person connected, and a send in the browser or a shell is outside these tools.
- A vendor line that the app takes out of a result is replaced with `[vendor instruction removed]`,
  and the Guard puts its note in front of that result (G5).

## Limits

20 calls and 40 lookups per connection per turn; 200 paid calls per hour for all agents of the
computer. The Hub has its own velocity limits.

## Failure

The tools fail closed. Signed out, offline, Hub 5xx, an answer outside the contract, a refused token,
the kill switch: each one gives a fixed text and code (`FAILURE_TEXT`, `ERROR_TEXT`), never the
Hub's or the vendor's words. The app never retries by itself. A `connection_unavailable` answer or a
`connections_disabled` token error makes the next turn read `/session` again, so the tools leave the
catalog.

## Secrets

- The session tokens stay in the credential store and the main process. The proxy tokens stay in
  memory. Nothing of a connection is written to disk.
- `cbp_` (proxy token) and `treg_` (vendor key) are in `KNOWN_SECRET_PREFIXES` of
  `packages/logging`, so log redaction masks them without registration.
- The agent process gets no token: no environment variable, argument, file or tool result.

## The person's screens

Main gives a window, through the `hub-connections:*` IPC group, only views without a credential
(`packages/contracts/src/ipc-hub-connections.ts`): no token, confirmation id or Hub URL. The preload
decodes each value again (`src/preload/hub-connection-decoding.ts`). `HubConnectionTools` builds the
views (`hub-connection-views.ts`) from the catalog and `/session` answers that it already caches.

| Endpoint | What it gives |
| --- | --- |
| `getView`, `refresh` | The connections of the catalog: texts, the access row of each organization (cap, spend, state, categories, cheapest price, open requests), who pays the next call (`pay`, `choose_org`, `none`) and whether `/session` has the connection on. `refresh` reads the Hub again. A failure is a status (`signed_out`, `off`, `unavailable`), never an error. |
| `getUsage` | The person's own use for each organization whose row this app may spend, with the spend by platform. Off until `/session` says `connectionsUsage`. Each organization is read at most once in 30 seconds; a paid call drops its copy. |
| `choosePayer` | The organization that the person chooses on the page. Only a row that can pay is kept. The agent has no path to it. |
| `requestAccess` | "Ask the admin" (`access`) and "Ask the admin for more" (`more`), through the Hub route of the contract (§10.1). Never for the personal plan or an organization that is not in the catalog. |

### Marketplace

A connection is an app of the Apps tab (`kind: "connection"`), so the curated list decides if it
shows ([marketplace-apps-curation.md](marketplace-apps-curation.md#hub-connections)). It has its
own group, Connections, before the categories, and the side panel lists the ones in use under
"Your connections". The renderer adds the rows only when the Marketplace is for this computer
(`hubConnections` of `MarketplaceModal`): a joined server's agents do not use this computer's Hub
session.

The page (`MarketplaceConnectionPage.tsx`) follows the integration page rules: what it gives, the
categories that the organization allows, the person's cap with the bar and its 80 % mark (a
`progressbar` with a value text), who pays with "Pay with {org}" when more than one organization
can pay, a switch per agent of this computer, and "Where the data goes" ("Provided by {vendor}", the
flow to the Hub, the vendor and the provider, and the retention that the Hub declares). The alerts
say when Cultura Builder paused it, when the person must choose who pays, over 80 % and at the cap,
with "Ask the admin for more". A row that the person may not use names why, with "Ask the admin".
After a request, the page shows "Request sent on {date}" from the Hub's `requestedAt`.

The switch of an agent writes `connectionsOff` through `agent.updateAgent`: an agent with the
connection off has no `openbot_connections` in `tool_search`.

### Usage › Connections

`ConnectionUsageReport.tsx` under the model report of the local server: what Cultura Builder
charged this month, in the organization's currency, by organization and by platform. It is never
summed with the model estimate in USD. It shows only when `/session` says `connectionsUsage`.

### Cost lines in a chat

After a call in the person's own turn or routine, the router adds a system message to the chat
(`hub-connection:paid|warning|limit`, its text the JSON of `HubConnectionChatEvent`, as the hosted
site events do). The screen writes the line in the reader's language and money format:

- `paid`: "{endpoint}: paid by {org} · {amount}", after each call that ran.
- `warning`: the call that crossed 80 % of the cap (the Hub's `warningCrossed`, once a period).
- `limit`: a call that `cap_reached` or `org_budget_reached` stopped, once per turn and
  organization, with "Ask the admin for more" in a chat of this computer.

A turn that another agent started gets no line: it gets no amounts either. The agent's own
history tools can read these lines, as they read every message of the chat; the agent already got
the same amount and payer in the call result.

## Checks

`bun scripts/hub-connections-call-e2e.ts` drives the real agent service, router, Guard, cards and
Hub client with a fake Codex app-server against `scripts/fake-hub/` (a fake Hub and a fake vendor on
127.0.0.1). It writes `.buildersbot-build/hub-connections/tool-catalog.json`.

`bun scripts/hub-connections-usage-e2e.ts` checks the views of the screens from main's side: the
page view and its decoders, the payer that the person chooses, the requests to the admins, the cost
lines of a paid call, the 80 % line once, the limit line once per turn, the usage by platform and its
cache, the per-agent switch, the usage capability, the kill switch and a Hub that does not answer.
It writes `.buildersbot-build/hub-connections/usage.json`.

`bun scripts/hub-connections-surfaces-e2e.ts --storybook=<url>` drives the stories of the list, the
page in each state, Usage › Connections and the chat lines in a headless browser, in en and pt, dark
and light, at 1280 and 390 pixels, and writes screenshots and
`.buildersbot-build/hub-connections/surfaces/report.json`. Its `knownIssues` keeps one issue that
this change did not make: at 390 pixels in Portuguese, the model report of Usage (its breakdown
table) makes the Usage body scroll about 45 pixels sideways, also with no connection part. The check
of Usage covers the page and the connection part. Run it with the headless shell of Playwright:
`PLAYWRIGHT_BROWSERS_PATH=<folder> node node_modules/playwright-core/cli.js install --only-shell
chromium-headless-shell` installs one into a folder of your choice.

`bun scripts/hub-connections-safety-e2e.ts` checks the Guard rules G2, G3, G5, G6, G7, G9 and G11,
the person's own treg entry off in Codex and OpenCode, the Settings notice, the absence of the
vendor lines of §2.2 in every agent text and source file, and the Guard time. It writes
`.buildersbot-build/hub-connections/safety.json`. Both scripts share
`scripts/fake-hub/agent-harness.ts`.
