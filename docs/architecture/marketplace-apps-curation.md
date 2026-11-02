# Curated Apps list in the Marketplace

The Apps tab of the Marketplace shows a short list of apps first. The other apps stay in the
catalog: "Show all apps", the search and a link reach each one. An organization profile from the
Cultura Builder Hub can replace the short list. Nothing here installs, removes or disables an app,
and nothing changes the tools of an agent.

## Where the apps come from

| Kind | Defined in | Id |
| --- | --- | --- |
| Connector (GitHub, Slack, Discord, Telegram, 1Password, Bitwarden) | `CONNECTOR_IDS` (`packages/contracts/src/marketplace-suggestion-events.ts`), names and marks in `packages/ui/src/features/connectors/connector-catalog.tsx` | the `ConnectorId` |
| Catalog plugin | `marketplace/plugin-catalog/plugins/<slug>/plugin.json`, generated into `src/renderer/src/features/settings/marketplace-plugin-catalog.ts` | the slug |
| Custom MCP server | a row that the host holds and no catalog app claims | `custom:<row id>` |

`marketplace-controller.ts` joins the three kinds in its `apps` memo. `createBrowseLists` in
`MarketplaceBrowse.tsx` filters them, and `appCategories` groups them by category. A category with
no app has no section, so a category that the short list empties is not shown.

## The rules

`curateApps` (`packages/ui/src/features/marketplace/marketplace-curation.ts`) decides the list. The
order of the rules:

1. "Show all apps" is on: every app.
2. An app in use is always in the list: a custom server, and an app that is connected, connecting
   or partly set up (status other than `idle`). Nobody loses an app that they use.
3. A valid organization profile applies: the apps in `apps.show`, and every app of a category in
   `categories`, without the apps in `apps.hide`. `hide` wins over `show` and `categories`.
4. No profile applies: the default apps.
5. Fail safe: a profile that names no app of this catalog does not apply (rule 4), and a list that
   would be empty shows every app.

The search reaches every app, also an app that the list does not show. A link
(`openbot://plugins/<slug>`, a chat suggestion, "Your apps") opens the page of any app: the pages
read the full `apps()` list, not the curated list. The side panel counts the rows of the list.

The status of a plugin comes from a read of the host's MCP servers. Until that read ends, an
installed plugin reads as `idle`, so it can show some moments after the list.

### The default apps

The owner chose this list on 2026-10-31 (`DEFAULT_SHOWN_APP_IDS`):

| Category | Shown | Hidden by default |
| --- | --- | --- |
| Coding | `github` | `linear`, `sentry`, `vercel`, `cloudflare`, `supabase`, `neon`, `prisma`, `netlify`, `railway`, `render` |
| Design | none | `canva`, `figma`, `paper` |
| Data & Analytics | none | `aave`, `airtable`, `posthog` |
| Productivity | `slack`, `telegram`, `whatsapp`, `trello`, `obsidian`, `notion`, `atlassian`, `apple-apps`, `discord`, `onepassword` | `todoist`, `cobrain`, `bitwarden` |
| Research | `context7` | `brave-search`, `firecrawl`, `huggingface` |
| Automation | `playwright` | `composio`, `resend` |
| Other | none | `stripe` |

A new catalog app is hidden by default until someone adds its id to the list or to a profile.

### Hub connections

A paid connection of Cultura Builder, such as the tool catalog (`tool-catalog`), is an app of the
list too (`kind: "connection"`, docs/architecture/hub-connections.md). `curateApps` does not change
for it:

- Its category is `research`, so a profile with `categories: ["research"]`, or with its id in
  `apps.show`, shows it, and `apps.hide` hides it.
- It is not in `DEFAULT_SHOWN_APP_IDS`: with no profile, it is hidden.
- It is in use, and so always shown, when its status is not `idle`: the organization turned it on
  and the person may use it (`connected`), or it needs the person (`attention`: 80 % or more of the
  cap, the cap reached, a payer to choose, a consent on the Hub), or it has spend in this period,
  also while Cultura Builder paused it (`connectionStatus`).
- The search and a link (`openbot://plugins/tool-catalog`) reach it, as any app.

The list draws connections in their own group, Connections, before the categories, and the side
panel names those in use under "Your connections".

The platforms of a connection (`platforms` of the Hub catalog) are tiles of the list, one per
platform (`kind: "connection-platform"`, id `<connection>:<platform>`, which no catalog slug can be).
The owner asked on 2026-10-31 that they take the place of the extra plugins that the default list
hides (Design, Data & Analytics, Research, Automation, Stripe), so each tile is in the category of its
group (`PLATFORM_CATEGORY` in `marketplace-connections.ts`):

| Platform group | Category |
| --- | --- |
| `seo`, `research`, `reviews`, `community` | Research |
| `enrichment`, `market`, `commerce` | Data & Analytics |
| `developer` | Coding |
| `generation` | Design |
| `advertising`, `social`, `other` | Other |

- A tile exists only while its connection is on (`enabled`) and not `idle` for the person. So it is
  always in use, and `curateApps` shows it; no profile hides it. An account without the capability,
  and a paused connection, have no tiles; the connection row stays as before.
- A tile has the platform name, "Via Cultura Builder · {n} tools", the status of the connection, the
  generic connection mark (no remote logo) and no install button. It opens the connection's page.
- The search finds a tile by its name. "Your apps" does not list tiles: "Your connections" names
  their connection.

## "Show all apps"

A small switch beside the search, on the Apps tab only. It shows while the list hides an app, or
while it is on. Below 560 pixels of list width it moves to its own line under the search
(a container query on `.marketplace-browse-head`), so nothing scrolls sideways. Only a toolbar that
holds the switch can wrap, so the toolbar of the Agents tab stays on one line.

The renderer keeps the choice in `localStorage` (`openbot:marketplace-show-all-apps`), as
`agent-steps-preference.ts` keeps its choice: per user of this computer, or per browser in the web
app. Blocked storage keeps the choice for the page only. Other windows of the page follow it through
the `storage` event.

## Organization app profile

### Contract

`packages/contracts/src/app-profile.ts`, version 1:

```json
{
  "version": 1,
  "tag": "Agência de design",
  "apps": { "show": ["figma", "canva", "slack"], "hide": ["stripe"] },
  "categories": ["design"],
  "updatedAt": "2026-10-31T12:00:00.000Z"
}
```

| Field | Rule | When the rule fails |
| --- | --- | --- |
| `version` | optional; the number `1`. Absent or `null` reads as `1` | the profile is refused |
| `tag` | plain text, 1 to 48 visible characters after trim, at most 256 UTF-16 units before; no `<`, `>`, control or bidi characters | refused |
| `apps.show` | list of at most 128 slugs (`^[a-z0-9][a-z0-9-]{0,62}$`), duplicates kept once; can be empty when `categories` is not. Not optional: `null` is refused | refused |
| `apps.hide` | optional, the same rule. Absent or `null` reads as an empty list | refused |
| `categories` | optional, at most 16 texts of at most 32 units; a category that this version does not know is dropped. Absent or `null` reads as an empty list | refused |
| `updatedAt` | ISO 8601 date and time, at most 40 units | refused |
| the profile after decoding, as JSON | at most 8,192 UTF-16 units (`decodeAppProfile`), so the client can keep each profile that it accepts | refused |
| the JSON text | at most 8,192 UTF-16 units (`decodeAppProfileText`) | refused |
| `show` and `categories` both empty | the profile would empty the list | refused |

The limits on each field keep the profile after decoding under about 17,000 units, so the size
check costs little. 128 ids of 62 characters in `show` and 128 in `hide` pass the field rules but
not the size rule.

A well-formed id that the catalog does not have is kept, for a newer catalog, and `curateApps`
ignores it. Fields that version 1 does not name are ignored, so the Hub can add an optional field. A
change of meaning needs version 2, which this client refuses, and then uses its default list.

The tag is only shown as text (a muted line under the description: "Selected for {tag}"), never as
markup. The tag shows only while the profile chooses the list.

### Source: the Hub, not the account Worker

The kind of company is a fact of the Cultura Builder account. The Hub
(`https://hub.culturabuilder.com`, outside this repository) holds it: `GET {gateway}/session`
already answers `{ active, empresa }` (`src/backend/cultura-builder-auth.ts`). The account Worker in
`apps/auth-api` holds OpenBot accounts, servers and memberships, and has no company or organization.
A table there would be a second source of truth for the company, so this change adds nothing to
`apps/auth-api`.

What the Hub team adds, in the same way as the `branding` block of the white-label design:

1. A field per company, admin-managed (SQL is enough at first): the profile JSON above.
2. In the answer of `GET /api/builder-ai/gateway/v1/session`, an optional `appProfile` field with
   that JSON for an account of a company with a profile. No field, or `null`, for a company without
   one. The answer stays under 8 KB, and `empresa` keeps its meaning.
3. In the same answer, a `userId` field: an opaque id of the Hub account that does not change, as
   text. The client binds the kept profile to it. `empresa` is not a good key: it is a display name,
   it changes when the company gets a new name, and two companies can have the same name.

Rules for the profile JSON: leave out an optional field, or send `null`; both read as absent.
`version` is optional and is `1`. `apps.show` is always a list.

### Adapter point

`receiveAppProfile(answer)` in `src/renderer/src/features/settings/marketplace-app-curation.ts` is
the one way in. Nothing calls it today, because the Hub does not send `appProfile`. Until then, the
default list applies.

The desktop backend reads `/session` (`readCulturaBuilderAccess` in
`src/backend/cultura-builder-auth.ts`, which `provider-drivers.ts` and `provider-runtime.ts` call),
not the renderer. So the profile must cross the renderer-to-main trust boundary, which `AGENTS.md`
protects. The planned place is the Hub read of
the white-label branding work, and the profile travels next to the branding block. The connection
needs these parts, in one change, as `src/main/ipc/AGENTS.md` and `src/preload/AGENTS.md` say:

1. `src/backend/cultura-builder-auth.ts`: add `userId` (optional text) and `appProfile` (any JSON
   value, not decoded) to the `GatewaySession` schema, and give both to the caller. The read keeps
   its size limit (`RESPONSE_LIMIT_BYTES`, 8 KB for the whole answer), so a profile in `/session`
   has a little less room than `APP_PROFILE_LIMITS.text`.
2. `packages/contracts/src/ipc-endpoints.ts`: an event that sends an `AppProfileAnswer` from main to
   each window after each read, sign-in and sign-out, and a request that gives the last answer to a
   window that opens later.
3. The handler in `src/main/ipc`, and the method in `src/renderer/src/preview/mock-openbot.ts`.
4. A preload decoder in a `src/preload/*-decoding.ts` file: it checks the `kind` and the `account`,
   and decodes the profile with `decodeAppProfile`. Preload payload decoding is a protected area, so
   it needs a vitest file there. Run `src/main/ipc-channel-coverage.test.ts` too.
5. The renderer subscribes to the event and calls `receiveAppProfile` with each answer.

| Answer | Effect |
| --- | --- |
| `{ kind: "answer", account, value }` with a valid profile | the profile applies and is kept for `account` |
| `{ kind: "answer", account, value }` with no, `null` or a malformed `value` | the kept profile goes; the default list applies |
| `{ kind: "unreachable", account }` (no network, a 5xx, a body over the limit) | the kept profile of the same `account` stays; a profile of another account goes |
| `{ kind: "signed-out" }` | the kept profile goes |

`account` is a stable key of the signed-in Cultura Builder account: the `userId` of `/session`
when the Hub sends it. Any text of 1 to 256 UTF-16 units that is not only spaces is accepted, also
`empresa`; other values read as signed out. It is never shown, and storage keeps only its SHA-256
hash. The kept profile is in `localStorage` (`openbot:marketplace-app-profile`) and is decoded again
at each read, because local storage is not a trusted source. Each profile that the decoder accepts
fits the read limit of the cache, so a kept profile is still there at the next start.

The kept profile applies only after an answer to the page names its account. When the app starts,
the default list shows until the first answer comes; an `unreachable` answer for the same account
then gives the kept profile back. A profile never applies to another account.

## WhatsApp logo

The listing's `iconUrl` is `https://www.whatsapp.com/favicon.ico`. That address answers `400` to a
request with a browser user agent (checked on 2026-10-31 with a Chrome user agent; a plain `curl`
gets the PNG). The renderer loads listing icons in an `<img>`, so the row showed the puzzle piece of
a failed icon.

The app now draws the WhatsApp mark itself, as it does for Slack, Discord and Telegram:

- `WHATSAPP_MARK_PATH` in `packages/brand/src/connector-mark-shape.ts`: one colour, 24 by 24, from
  Simple Icons (CC0, <https://simpleicons.org/?q=whatsapp>). The brand belongs to WhatsApp LLC; the
  mark only names the listing.
- `WhatsAppMark` in `packages/ui/src/features/settings/brand-marks.tsx`, in `currentColor`, so one
  mark serves the dark and the light theme.
- `LISTING_MARKS` in `MarketplaceParts.tsx`: a listing with a mark draws it on its row, its page
  header, its example chips, its app row and the suggestion card in a chat
  (`MarketplaceSuggestionChatCard.tsx`), and the app sends no request to whatsapp.com.

The catalog entry is unchanged. The mobile app and the public plugin page load the icon through the
account Worker (`/plugins/icon/<slug>`), which is not a browser.

## Tools in general

### What the research says

- Tool definitions cost context before any work starts. Anthropic measured 58 tools of five MCP
  servers at about 55,000 tokens, and GitHub alone at about 26,000. In its Tool Search example, a
  context that used about 77,000 tokens before any work used about 8,700 tokens with deferred
  loading, 85% less. Tool selection on its MCP evaluations went from 49% to 74% (Opus 4) and from
  79.5% to 88.1% (Opus 4.5). The advice: use tool search above about 10
  tools or 10,000 tokens of definitions, and keep the three to five most used tools loaded.
  ([Anthropic, Introducing advanced tool use, 2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use))
- "More tools don't always lead to better outcomes"; group related tools under a common prefix.
  ([Anthropic, Writing effective tools for agents, 2025-09-11](https://www.anthropic.com/engineering/writing-tools-for-agents))
- OpenAI: "Aim for fewer than 20 functions available at the start of a turn", defer the rest with
  `tool_search`, and use `allowed_tools` to limit a request to a subset without a change of the
  tool list, which keeps the prompt cache.
  ([OpenAI, Function calling](https://developers.openai.com/api/docs/guides/function-calling))
- Retrieval of the relevant tools for each request more than tripled tool-selection accuracy on
  the RAG-MCP benchmark (13.62% to 43.13%) and halved the prompt tokens.
  ([Gan and Sun, RAG-MCP, arXiv 2505.03275, 2025-05-06](https://arxiv.org/abs/2505.03275))
- Claude Code defers all MCP tools by default and loads them through tool search; `auto` mode
  loads them up front only while they take less than 10% of the context window.
  ([Claude Code, MCP](https://code.claude.com/docs/en/mcp))
- OpenCode, which runs the Cultura Builder models here, says each MCP server "adds to the context",
  and recommends to turn servers off globally and on per agent (`"<server>_*": false`).
  ([OpenCode, MCP servers](https://opencode.ai/docs/mcp-servers/))
- The MCP specification asks clients to show which tools the model can use, and to keep a person
  able to deny a tool call.
  ([MCP specification 2025-06-18, Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools))

### What this repository does

Checked in the code: the agent tool list is `McpGateway.enabled()`
(`src/backend/agent/mcp-gateway.ts`): the enabled MCP rows that the host holds, plus Computer Use
while its daemon runs, plus the GitHub connector's server only while GitHub is connected
(`GitHubConnectorService.mcpServer()` returns null otherwise). A catalog app makes a row only when
the user connects it. So an app that the Apps list hides and that is not installed adds nothing to
any agent, and the curation changes no tool list. This change does not touch which tools an
installed app gives.

The list is machine-wide: every agent on a host gets every enabled server ("The MCP list is
machine-scoped", in the same file).

### Recommendations for the owner (not in this change)

1. Per-agent apps: let an agent take a subset of the installed apps (an allow list in the agent
   settings), and pass only those servers at spawn. This is the largest saving for a host with many
   apps. The providers already read the server list at each spawn (`mcpServers` in
   `agent-service.ts`), and OpenCode documents per-agent tools.
2. Tool search where the provider has it: Claude Code already defers MCP tools; for the OpenAI and
   OpenCode paths, measure the tool count per agent and turn on deferral when it passes about 20.
3. Use the organization profile for installs too: a profile can later propose a starter set of apps
   to install for a new account, so a company gets its tools without a long list per agent.
4. Measure: log the number of MCP tools and their definition size at each spawn (no names or
   arguments), to know when an agent passes the limits above.
5. Agent prompt: `suggest_marketplace_app` in `src/backend/agent/tool-guidance.ts` tells the agent
   to say "Install the <service> plugin in Marketplace, on the Apps tab". A hidden app (Stripe,
   Linear, Figma) is not in that list until the user searches or turns on "Show all apps". The
   card in the chat still opens the app. A clearer text: "Search for <service> in Marketplace, on
   the Apps tab". This change does not touch the agent prompts.

### "Trag"

The owner asked to follow "the recommendations that the tag suggests", and then wrote that the name
is "Trag". This repository has no "Trag", and a web search found no tool or vendor with this name
that gives MCP recommendations. This part is blocked until the owner says what Trag is. Nothing in
this change comes from it.

## Tests

`scripts/marketplace-apps-curation-e2e.ts` runs against Storybook, with the curated stories of
`src/renderer/stories/Marketplace.stories.tsx` (real catalog, real curation store with
`receiveAppProfile` and local storage, real CSS) in a headless browser with a new profile:

```sh
bun run storybook --no-open   # note the URL it prints
bun scripts/marketplace-apps-curation-e2e.ts --storybook=http://localhost:6006
```

It checks 39 decoder cases (types, limits, markup, control and bidi characters, unknown ids and
categories, `null` fields, a missing version, the size limit after decoding, oversize text), the
default list and its categories, the WhatsApp mark on the row, the page and the chat card
(`WhatsAppInChat` in `MarketplaceSuggestionCard.stories.tsx`), the search of a hidden
app, the switch and the saved choice after a new page load, a profile, a malformed profile, a
profile near the size limit and one over it, the kept profile (it waits for an answer that names
its account, and applies after a new page load), an installed hidden app, a link to a hidden app,
the subtitles in en and pt, and that nothing scrolls sideways at 1280, 720 and 390 pixels, on the
Apps and the Agents tab. It writes `.openbot-build/marketplace-apps-curation-e2e/report.json` and a
screenshot of each state in en and pt, dark and light.

Each curated story sets the profile answer and the switch before it renders, so the order of the
stories in one browser changes nothing. `AppsSavedChoice` and `AppsBeforeAnswer` read what the
browser kept, by design.

Not covered here:

- The decoder cases call `decodeAppProfile` directly, in Node. `AGENTS.md` permits E2E tests only,
  outside the protected areas. When the profile crosses IPC, these cases belong in the vitest file
  of the preload decoder, which is a protected area. Until then the owner decides if they stay here.
- The Storybook run does not start the app. The line `curation: marketplaceAppCuration` in
  `marketplace-controller.ts`, links through `MarketplaceModal`, and an installed app that shows
  after the read of the host's MCP servers need a run of the dev app, for example an extension of
  `scripts/marketplace-page-e2e.ts` with `bun run dev`.

## Limits

- The mobile app has its own Marketplace screens and does not curate its Apps list yet.
- The profile is dormant until the Hub sends `appProfile` and a client calls `receiveAppProfile`.
