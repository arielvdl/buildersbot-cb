# Browser

## Browser client

`apps/auth-api` serves `/app`. Its lazy route mounts the interactive client after browser startup.
`src/renderer/src/features/web-client` owns the browser composition and its typed
`WebWorkspaceRuntime` interface. It mounts the existing account login, page rail, server rail,
sidebar, and full conversation view. `ConversationRuntime` routes host actions through
the browser connection; its desktop default is the preload API. The desktop `WorkspaceShell` and the
web client draw the same `WorkspaceFrame` under `LayoutProvider`, so the rail geometry, the sidebar
resizer and compact modes, the compatibility screen, and the usage report slot are the same on both.
The rail column holds the section rail or the server rail, as Settings > General > Left column
chooses (`layout.railColumnVisible`). Both use the `server-rail` classes, so the frame, the window
styles and the small-screen panes place and hide them in the same way.
The overlays that both clients raise - join, marketplace, shared agent, server settings, global
search and channel creation - are prop-driven views in `WorkspaceOverlayViews.tsx`.
`WorkspaceOverlays` fills them from the desktop contexts, and the web client fills them from its
host connection, so what an overlay decides from its server is decided in one place.
The web client gives `PlatformProvider` a fixed `appInfo` in place of the main-process answer.
There is no separate web dashboard.
Small screens switch between the same conversation and workspace components. The shared browser
panel receives the web live-view runtime and hides unsupported native controls. `BrowserLiveView`
accepts an explicit runtime; desktop and the existing preview still default to the preload-compatible
API. The web Storybook runtime uses
`preview/mock-openbot.ts` through `preview/mock-web-runtime.ts`.

The browser runtime uses `packages/team-client` for the directory, authenticated WebRTC peer,
Signal recovery, file transfers, and browser-view streams. The stream codec lives in contracts;
the old main-process import re-exports that codec without changing its wire format. Account
requests use a closed list of `/api/browser/*` operations. They cannot carry chat requests.
Browser tickets and session termination require the same account-session hash that created the
remote session. Existing bearer-token endpoints retain their behavior. The browser edits the
account's name, avatar, and sessions through `v1/me/profile`, `v1/me/avatar`, and `v1/me/sessions`,
which call the same `AuthService` methods and avatar storage (`avatar-storage.ts`) as the bearer
routes. The avatar upload is the one write that is not JSON; the origin and `X-OpenBot-Browser`
checks still apply. `web-account.ts` makes these calls, and the Profile tab of the web Settings dialog
(`WebAccountSettings.tsx`) shows them.

An owner or admin gets the host controls of a desktop remote admin. Shared components keep their
desktop port as the default and take injected calls: `web-server-settings.ts` gives
`ServerSettingsModal` the host identity, MCP, and storage routes through
`@openbot/team-client/team-admin-requests`, and member and invitation calls through the closed
`/api/browser/*` list. The Worker applies the same `RemoteControlPlane` role checks as the bearer
routes. A member or role change revokes every session on the host; the browser reconnects once when
the directory still lists the host. `ConversationRuntime.admin` carries the skills and shared-table
calls to the agent settings panel, which shows only Skills and Tables in the browser. Memories,
routines, and files stay on the desktop. The Permissions select writes access and auto-approve through
the agent-admin route. `web-marketplace.ts` gives `MarketplaceModal` its calls: the public catalog routes of
the account service that serves `/app` (`@openbot/team-client/marketplace-catalog`), and installs on
the host over `skills-admin-v1`, `agent-install-v1`, `agent-update-v1`, and `mcp-servers-v1`. Try skill and a plugin
prompt add a line to the agent's draft, as on desktop. A shared agent page also links
`/app?agent=<id>`: `WebApp` reads the id once, removes the query, and keeps it through sign-in;
`AgentTemplateInstall` then shows the preview, and the host adds the agent over `agent-install-v1`.
A browser submits nothing to the marketplace. It can publish a host agent's share link over
`agent-publish-v1`, in `ConversationRuntime.admin.agentTemplates`: the host builds the template,
checks it for secrets and publishes it with the account signed in on the host; the browser draws only
the share card from the preview. An agent that the host added from a
listing gets Update when the host serves `agent-update-v1`; the host downloads the current version.
`web-provider-admin.ts` answers the desktop `providerAdmin` group over the `providers-v1` routes, so
the Providers section of `ServerSettingsModal` uses the same runtime, key, custom provider, and code
sign-in logic (`provider-connection.ts`, `ProviderSettingsSection.tsx`) as the desktop app. On
desktop the section shows the providers of the active server only, because provider state exists
only for that server; for another server it offers to switch. The
browser applies host `status` events, and reads the status every 3 seconds while a code sign-in waits.
A provider key stays in the dialog input until it is sent to the host.

Browser sign-in, account reads, and connection tickets are always available. No host or D1
migration is needed. See [web client delivery](../web-client.md) for the seven review scopes, local
commands, and release checks.

Browser chat pages, drafts, file bytes, and chat visibility preferences stay in memory. A protected
cookie holds the account credential. Local storage holds account-scoped trusted host public keys,
the shared file panel's width, and for each account and host the pinned item ids, collapsed section
ids and selected channel id, not chat content. The channel UI takes a `ChannelsPort` runtime; its
desktop default is the preload API. A Web Lock permits one live tab per account
and host because the existing control plane reuses that credential's logical host session.
Host switches discard the prior host's chat state. Temporary connection loss keeps drafts; a
failed send stays in the chat and is never sent again on its own. BroadcastChannel, account
checks on focus, and signed session invalidation clear access when a session ends.

MP3 and MOV attachments use the existing file attachment contract with no inline preview. Import
copies and hashes the original bytes under the shared attachment limits; it does not run media
codecs or extract frames or transcripts. MIME types come from the file extension for these formats,
so a supplied image or text MIME type cannot enable a preview. Remote support is additive through
the `media-attachments` capability; released protocol adapters keep their existing meanings.

ZIP attachments use the same contract with `application/zip` and no inline preview. Import copies
and hashes the archive; Builders Bot never extracts it. Remote support is additive through the
`zip-attachments` capability.

MP4 attachments use the MP3 and MOV contract with `video/mp4`. Remote support is additive through
the `mp4-attachments` capability, because a host with only `media-attachments` refuses MP4.

## Browser tool execution

`browser-tools.ts` defines provider schemas and parses each call into a typed tool and its arguments.
`browser-tool-actions.ts` maps input tools to CDP operations. It does not own tabs or import the host.
`BrowserHost` owns tab access checks, operation queues, focus, deadlines, and persistent browser state.
Targeted typing checks that the target still holds focus before the End key, the text, and the
Enter key. A page focus or input handler that moves focus stops it with an error that says if the
text is already in the field. The check also reads each frame element that holds the target,
because a frame in another process can keep its active element after the page takes focus.
`bun run test:browser --scenario=typing-focus` covers it and writes
`.openbot-build/browser-typing-focus.json`.
The browser session and service-worker fallback remove the `Builders Bot/` and `Electron/` user-agent
tokens. They keep the installed Chromium version and host platform. Requests to `accounts.google.com`
keep the `Electron/` token because Google rejects the account identifier step without it. This
exception does not change the page identity or the identity sent to other sites.
Electron provides native `navigator.userAgentData` but no client-hint request headers. On HTTPS and
loopback HTTP, the host supplies the brand list, desktop flag, and platform hints. The brand list must
be the same as `navigator.userAgentData.brands`, with the GREASE brand and its order (Chromium
chooses both from the major version). Cloudflare rejects a request whose brands differ from the page.
It preserves hints supplied by Chromium and does not add high-entropy hints. The focused check is
`bun run test:browser --scenario=identity`; add `--google-live` for the Google identifier check.
The local identity report is `.openbot-build/browser-identity.json`.
Website popups are adopted into managed `WebContentsView` tabs through Electron's window creation
hook. Native guests retain their opener, request body, and the browser session of the opener. Local tab and
agent tool results expose `openerTabId` while that relationship is live. Independent `noopener`
tabs survive parent closure; dependent popups close with the parent. Closing a popup returns to its
opener. Saved popup URLs omit OAuth callback credentials. Popup state is not restored as a live
JavaScript relationship after an app restart.
Connected pages in a native opener group can retain references to each other's documents, including
a document that received a secret. The browser blocks that access between sites, so a secure input
card is available in a connected tab only when no frame in another live connected tab has the
secret's site. The host checks this when the card opens and again before the fill; otherwise the tab
requires human takeover. The site check uses the last two host labels, which can refuse two sites
under one public suffix but cannot allow one site. Independent tabs remain eligible for secure input. Account selection without secret entry remains automated.
Agents use `list_tabs` after sign-in actions and inspect the new tab before continuing. Secure input
and takeover still handle passwords, codes, CAPTCHA, and passkeys. Blocked requests produce a
reason without including authentication URLs or request data.
Agent instructions keep the viewport stable during sign-in and require fresh targets after page
changes or covered-target errors. X Google sign-in starts on the landing page after cookie consent.
X can retain a Google callback for a removed login dialog and report `Input2SSO: Unsupported provider`.
For that error in the current attempt, agents may reload the signed-out landing page and retry once,
then verify authenticated navigation. This recovery does not run during secure handoff or discard
non-login work. The host does not rewrite site scripts or weaken cross-origin security policies.
Input dispatch runs inside those checks and queues. Upload staging also uses the shared parser before
it checks local file access.

### Fill inspected ordinary fields

`openbot_browser.fill_fields` is a deferred tool in the original browser catalog. It replaces
1 to 16 main-frame native text inputs or textareas from one fresh snapshot revision. The combined
literal text has a 16 KiB UTF-8 limit. The total operation deadline, including its final capture,
is at most 30 seconds. It performs no submit, Enter, click, navigation, target search, or caller
script. Existing individual controls keep their behavior. Its control event uses the released
`type` action.

The engine retains the exact native handles for every field in one CDP lease. Preflight resolves
and checks the full set before any input. It refuses duplicate or unavailable refs, hidden,
disabled or readonly fields, contenteditable, frames, password inputs, one-time-code autocomplete,
and payment-card autocomplete. It accepts native input types `text`, `search`, `tel`, `url`, and
`email`, plus textarea. HTML metadata is not a complete detector for secrets or form side effects.
Agents must first inspect the ordinary form. Authentication, payments, and uncertain user
decisions use the existing secure input or takeover flow.

Each fill rechecks the same native handle, snapshot fingerprint, original field value, editable
metadata, main-frame document and origin. It does not find a replacement for a changed target.
The native navigation generation and document node identity detect same-URL reloads. Focus handlers
receive a second check before trusted input. The host rechecks tab ownership, secret protection,
and takeover before each field and before it releases a final capture. CDP emulates page focus;
the operation requests no native window or application focus.

One tab queue slot owns all fields, one final page settle, and one bounded final semantic snapshot. Successful input is
confirmed by its native field value. The result contains zero-based `confirmed` indices,
`failedIndex`, and `uncertainIndex`, without field text or page exceptions in the progress record.
`partial` means earlier fields can remain changed. An input sent without confirmed completion is
uncertain. `inputCompleted: true` with `status: snapshot_failed` means input completed but capture
failed. Callers must read the page before they decide how to continue. No automatic retry, undo,
or atomic transaction is promised.

Cancellation prevents undispatched fields. Dispatched input and its confirmation drain before the
queue slot ends. A response deadline can return sooner, but later tab operations still wait for
that owned work. An external debugger that the host cannot cancel must drain its command. The
engine releases retained handles and its lease at completion. Known failures use fixed reason
codes; page exceptions do not enter the new progress result or diagnostic action.

`bun scripts/browser-fill-fields-e2e.ts` compiles only its native fixture and uses an owned hidden
Electron process with a temporary profile and synthetic loopback forms. It must not make a window
visible or request native focus to obtain a passing result. It is a local check, not a CI step; on
Linux, run it under `xvfb-run -a`. The report is `.openbot-build/browser-fill-fields-e2e/report.json`.
It includes actual runtime versions, completed cases, three warm-up pairs and twenty measured pairs,
serialized result bytes, and observed snapshot counts. Measurements include tool execution and loopback fixture
confirmation. They do not measure provider tokens, model speed, or billable cost.

### Run many steps in one call

Each single action tool takes one model turn, and the model reads the page with a separate snapshot.
`openbot_browser.run_script` does many actions in one call and returns one final snapshot, so a long
task takes fewer turns.

`run_script` takes JavaScript that awaits helpers named after the action tools (`navigate`, `click`,
`type`, `press`, `hover`, `scroll`, `selectOption`, `setChecked`, `waitFor`, `evaluate`, and
`snapshot`), or `step({ action, ...fields })` with the fields of that tool and no `tabId`. Each
helper sends one step to the host. The script returns a JSON value of at most 64 KB.

An earlier `run_steps` tool took a fixed list of steps. A benchmark with Claude Haiku 5.5 on 10 public
site tasks (3 repeats) gave `run_script` 118k median input tokens and 30 of 30 correct answers, and
`run_steps` 130k. With both tools in the catalog, agents used both, at 198k. So the catalog has only
`run_script` (`bun run bench:browser-tools`). With the shipped guidance and no hint in the prompt,
agents used 216k until a browser search also returned `run_script` (see
[Providers](providers.md)); then 149k. These runs were before input actions returned a short status
in place of a snapshot, so the token counts can be different now.

The script runs each step through the same code as the single tool, with its own tab queue slot.
Before each step, the host checks the tab again: ownership, secret protection, takeover, and user
control. The action steps read no result. `evaluate` keeps the scripted-origin
record and the secret-document check. When a person takes control of the tab, the call stops and
returns its partial results with status `user_control`. It does not wait for the release. The
control event uses the released `click` action, so the Team API wire values do not change.

An `evaluate` step returns `null` when the expression gives `undefined`, such as a click statement.
The single `evaluate` tool still refuses that value. If the step failed after the click, the agent
would click again. In a script, `waitFor` also takes a page function: the page polls it every
100 ms until it returns a truthy value, in one `evaluate` step (at most 25 seconds). A script that
fails without a final snapshot returns the tab's `url`, because the steps before the failure stay
done and the agent must not start again from the wrong page. When the final snapshot fails after
the last step, the result keeps the script's value and log. It has `snapshotError`, or the
`user_control` status when a person took the tab.

The script runs in a QuickJS WebAssembly sandbox (`src/backend/browser-script.ts`), not in
`node:vm`, because the backend process holds the vault. The sandbox has no modules, network, files,
timers, or process. Its limits are 64 MiB of memory, a 1 MiB stack, 200 steps, and a total deadline
of `timeoutMs` (default 60 seconds, at most 120 seconds). An interrupt handler stops a script that
loops without steps. Each script gets its own runtime, which the host disposes at the end. The
backend bundle keeps the QuickJS packages external, so the WebAssembly file loads from
`node_modules`.

`bun run test:browser-steps` compiles its native fixture and drives a hidden Electron process with
loopback pages, like the fill fields check. CI runs it in the `browser` job under `xvfb-run -a`.
The report is `.openbot-build/browser-steps-e2e/report.json`.

### Browser sessions

Each agent has one **browser profile**: the persistent partition that its new tabs open in. The agent
fields `ownBrowserSession` and `browserProfileId` (`agent_json`) select it:

| Choice | Partition |
| --- | --- |
| Shared (default) | `persist:openbot-browser` |
| Only this agent | `persist:openbot-browser-agent-<key>`. The key is the first 32 hex characters of the SHA-256 of the agent id. |
| Named profile | `persist:openbot-browser-profile-<id>`. The id is 32 random hex characters. |

Named profiles are rows of the `browser_profiles` table (migration 45). Many agents can use one
profile, so they share its sign-ins; a profile has no owner agent, and the tab rules below do not
change. The name is a label only and never becomes a path or a partition, so a rename keeps the
data. An agent with `browserProfileId` also has `ownBrowserSession: true`. After a downgrade, an
older build thus opens such an agent in a session of its own, never in the shared one. A duplicate
and an imported agent start with Shared. The user's tabs in an agent's panel use the agent's partition, so
the user can sign in for the agent there.

`openPrivate` opens a sign-in page for another person in an in-memory partition. The tab is not
saved, and its storage is cleared when its last tab closes.

A tab keeps its partition for its life, and its popups use the same partition. The state file
saves an agent key as `agentSession`, and a named profile as `profile` together with an
`agentSession` key made from the profile id, which an older build reads. A restart restores each tab
in its saved partition, whatever the setting is now. A tab without a key, such as a tab from an older
version, opens in the shared partition. A tab with a malformed key or profile id, or with the id of a
deleted profile, is dropped, so it never opens signed in to another account. A new tab for an agent
whose profile no longer exists fails with `browserProfileMissing`; it never falls back to Shared.
`#configureSession` applies the same user agent, headers, permissions and download policy to every
partition. Shutdown and `flushPersistentStorage` flush every persistent partition.

The CacheStorage of service workers has no limit but the storage quota of Chromium: the shared
partition had 138 MB of it, from two sites, after 1.6 days. After the first window load,
`trimSiteCaches` (`src/main/startup-maintenance.ts`) measures each partition that
`BrowserHost.persistentSessions()` gives (the shared one, and each agent or profile session that is
open). It measures each origin folder in `Service Worker/CacheStorage` and reads the origin of the
folder from its `index.txt` (`cacheStorageIndexOrigin`: field 2 of the protobuf
`CacheStorageIndex`, never the name of a cache). For each origin past 100 MB, it calls
`clearStorageData({ origin, storages: ["cachestorage", "serviceworkers"] })`; the other origins keep
their caches and service workers. A folder past the limit with no origin that can be read stays.
When the `Code Cache` of the partition is past 100 MB, `clearCodeCaches({})` clears the code cache of
all its sites. Cookies, local storage and IndexedDB stay, so the sign-ins stay. A site registers its
service worker again on the next visit, and its first load after a trim is slower. The HTTP cache
keeps the limit of Chromium. A partition of an agent or profile that no tab opened in this launch is
not measured.

`src/main/browser-profile-service.ts` owns the operations: list, create (name of 1 to 60
characters, unique, at most 100 profiles), update (name or color), clear data, delete, and assign.
Clear and delete close the tabs in the partition before they clear its storage and cache. Delete also
moves the profile's agents to Shared. Each named profile has a color (`hue`), one of the agent avatar
hues. Create gives the color that the fewest profiles use (`nextBrowserProfileHue`); Server settings >
Browser profiles changes it. The browser view shows a profile label with its color on the toolbar, a line in
that color under the tab, and the name in the tab tooltip of a tab outside the shared profile
(`agent:admin:list-browser-tab-profiles`). The select marks Shared with a gray dot, a color that no
named profile has. "Only this agent" has no color, and the select offers it only to an agent that
already uses it, so the agent keeps its sign-ins. An owner or admin of a joined server uses the same
operations through `browser-profiles-v1` (`route-browser-profiles.ts`); each member reads the labels of
the tabs that they can see, and a private tab is hidden from a member. A host without the capability
answers `agentSettingsUnsupported`, and the client shows no select, section or label for it. A host
with `browser-profiles-events-v1` sends `browser-profiles-changed` after each change, so every open
list and agent setting reads the profiles again. The phone shows the same operations in Server
settings > Browser profiles and in Agent info > Advanced > Browser profile.

### Tab lifetime

The agent decides when a tab closes. Nothing closes a tab when a turn ends: `close_tab` is the only
cleanup path, and the prompt asks the agent to use it once a task no longer needs the tab. A tab
therefore outlives its turn by design, which is what lets the next turn in the same thread carry on in
the page the last one left, and what lets the user read the result afterwards.

There is no user-owned tab. A tab carries `ownerThreadId` and `ownerAgentId`, and an agent may read
and close any tab in its own thread, including one the user opened there. The one hard block is a
takeover: while the user holds a tab, no agent tool touches it. That is enforced in
`BrowserHost.#requireToolTab`, which is the lowest point every tab-bearing tool passes through, so it
holds for callers that never reach `AgentService` -- the view gateway and remote hosts. The agent-wide
refusal in `AgentService` stays beside it rather than being folded in: it also covers `open` and
`list_tabs`, which name no tab, and it answers with a refusal instead of an error.

| Event | Tabs |
| --- | --- |
| Turn succeeds | Stay open unless the agent called `close_tab`. |
| Cancelled, interrupted, or failed | Stay open. Completion clears the control session only. |
| Retry | Same thread and agent, so the same tabs are still reachable. |
| Restart | Restored from the browser's own state file. |
| Idle 30 min (5 min when memory is low; on a Mac only when the agent runs no turn) | Stays open, but its page unloads. The next use loads the page again. |
| Agent deleted | That agent's tabs are closed, including a legacy tab holding only its thread id. Its own browser session is cleared. |
| Browser profile changed | That agent's tabs are closed. Its next tab opens in the profile it chose. Both profiles keep their data. |
| Profile cleared or deleted | Every tab in that profile is closed, then its data is cleared. |
| Takeover held | No agent tool touches that tab, `close_tab` included. |

Deleting an agent is the one sweep, and it exists because those tabs are otherwise unreachable: no
agent passes the owner check for them, and the renderer lists tabs per agent, so they would hold a
view the user cannot see to close, across restarts. Closing is idempotent -- `close()` returns early
on an id it does not hold -- and tab ids are UUIDs with no reorder feature at any layer, so a stale id
can never name a tab that took its place.

### Page dialogs

A page `alert` or `confirm` that an agent action opens goes to that agent; every other dialog stays in
Electron's native box for a person. `runTabAction` watches for a dialog only while the agent's own
input action runs (`BrowserDialogTurn` names the thread and turn), and until the page settles after it.
The engine then sends `Page.enable` on its own debugger and keeps the debugger attached while a watch
runs, so it also sees a dialog that a page load or a timer opens with no command in flight. A tab
queue drain ends the watch. `Page.javascriptDialogOpening` ends the action with the dialog:
an opaque id, the type, and the message, scrubbed and redacted like snapshot text. A `run_script` step
stops with status `dialog`. The agent answers with `handle_dialog`, which sends
`Page.handleJavaScriptDialog` and returns the next dialog or the page status. Until then, every other
tool on that tab is refused; `close_tab` still works.

Electron shows its own box for the same dialog, after the CDP event. After the CDP answer, the engine
emits Electron's internal `-cancel-dialogs` on the tab (`ElectronCdpTarget.dialogBox`, in
`browser-cdp-target.ts`), which aborts the box without its callback. The
agent gets a dialog only when the engine owns the debugger and Electron has a `-cancel-dialogs`
listener. Otherwise, for example under an external debugger, the result says that a person must answer.
`scripts/browser-dialogs-e2e.ts` fails if an Electron upgrade changes these internal events.

| Event | Dialog |
| --- | --- |
| Person's click, or a tool that is not an input action | Native box. The agent is not told. |
| Turn ends | Handed off: the box stays for a person, and the agent can no longer answer it. |
| Person answers first | `handle_dialog` fails with "This dialog is closed". |
| Tab closed or browser destroyed | The engine detaches its debugger, so the tab queue drains. Then it cancels every box of the tab, a person's box too, also a box that shows after the close: Electron keeps a box open after its page closes. |
| `prompt()` or `beforeunload` | Electron answers `prompt` with no box, and `will-prevent-unload` handles `beforeunload`. Not intercepted. |

The agent never gets a dialog that an `evaluate`, `wait_for`, or `fill_fields` call opens, or one in a
cross-origin frame: those dialogs stay native.

A member on a remote server cannot see the host's tab, because the tab is a native view on the host's
own screen. `browser-view-gateway.ts` answers that with a session and a websocket: `BrowserHost`
streams the tab through CDP, and the gateway sends each frame as bytes and dispatches the pointer and
key input that comes back, in fractions of the last frame, through the same access checks. Frames stay
outside the per-tab operation queue, so watching never delays a tool call. `browser-view-client.ts` is
the client half, and it reuses the Remote Desktop websocket tunnel rather than adding a WebRTC channel.
The `browser-view` capability says whether a host has both.

The mobile app (iOS and Android) draws the pointer itself, so it needs the page's cursor. A host with
`browser-view-cursor` sends a `cursor` text message, from the tab's `cursor-changed` event, to a
socket opened with `cursor=1`; desktop and web clients do not ask. The phone uses the
`browser-view-clipboard` inputs of the desktop and web clients: `paste`, `copy` (answered with
`copied` or `copyTooLarge`) and `cut`, and Cmd+A for Select All. A client that reads only the
`copied` answer never asks for a cursor or a menu, so it gets no other text message. A host with
`browser-view-context-menu` sends the menu of a
right-click to the socket that made it (opened with `menu=1`) as a `context-menu` message, and opens
no native menu: that menu would show on the host's screen. Only http and https addresses go in the
message. A host with `browser-view-viewport` holds the page at the size a socket asks for with
`viewport=WxH` while that socket is open, through the same device metrics override as an agent's
`set_environment`, so a resize of the host's window does not change the page. A tab with a custom
size from `set_environment` keeps it. The phone asks for 1280x800. On the phone, the view runs in the
hidden page that holds the Team peer (`features/browser/model/browser-view-bridge.ts`). That page
sends each frame to the screen as base64 and holds the newest frame until the screen has drawn the
previous one. Back, forward, reload, new tab and close tab use the released `browser-control`
routes. The account server's `browser` mobile feature flag turns the phone's browser off for an app
version (`apps/auth-api/src/server/mobile-features-config.ts`).

## One Playwright server for all agents

`PlaywrightBroker` (`src/main/playwright-broker.ts`) runs one Playwright MCP server for each tab
group: `@playwright/mcp --extension --shared-browser-context --port 0 --host 127.0.0.1`. The server
attaches to the open browser through the Playwright extension. Builders Bot starts no browser. Each
agent is one MCP session of the server of its group. Before, each agent started its own
`@playwright/mcp`, and a few at once used all the memory. When web access is the Builders Bot
browser, providers get no Playwright.

### Tab groups and tab reuse

The upstream keeps its connection to the extension only while one MCP session holds a browser
(`factory.create` and `dispose` in playwright-core `tools/mcp/program.ts`). The agent CLIs end their
session at the end of each turn, so each turn made a new connection. The extension then opened its
connect page as a new tab, in a new group named after the MCP client (`Playwright · codex-mcp-client`),
and took the focus. A new session also starts on the first tab of the shared context, so a second
agent drove the tab of the first. The broker now prevents this:

| Rule | How |
| --- | --- |
| One group for each project | The gateway hands each agent `endpoint().agentUrl(agentId)`: the broker URL with `?agent=` and an opaque key (HMAC-SHA256 of the agent id with the bearer, 22 characters). `projectOf` (`AgentService.browserProject`) gives the project: the person's sidebar section of the agent, else the agent. Each project gets its own upstream, so its own connection and group, up to `limits.projects` (3). Past the limit, a project with no session gives its place; else the agent uses the shared group, `Builders Bot`. An address with no known key uses the shared group too. With the egress proxy on, all agents use the shared group (`projectGroups`), because the server then starts a browser with one profile. |
| The connection stays between turns | At the first tool call of a group, before the agent's own call, the broker opens a session of its own in the upstream (`initialize` with `clientInfo.name` = the project name) and calls `browser_tabs` `list`. That session makes the connection, so the extension names the group `Playwright · <project>`, and it holds the connection while agent sessions come and go. It opens no event stream, so the upstream sends it no ping. The broker checks it again at most every 30 s, at an agent's call. |
| The agent finds its tab | At the first tool call of an agent session (not `browser_tabs`), the broker lists the tabs in that session and selects, in this order: the tab with the page that the same agent had last; a tab whose page is not the page of another session of the group with a call in the last 2 min; else a new tab, within the limits. |
| The last tab is not closed | The extension ends its connection when the last tab of the group closes (`RelayConnection._checkLastTabDetached`). A `browser_tabs` `close` of the last tab is answered by the broker: it navigates the tab to `about:blank` and says so. |
| Tabs left by ended turns count | Before a `browser_tabs` `new`, the broker lists the tabs of the group. The total limit compares the open tabs of all groups, not only the tabs that live sessions opened. |
| The agent is told | The `initialize` answer gets `instructions`, and the `tools/list` answer gets a note on `browser_tabs` and `browser_navigate`: reuse the current tab, a new tab only for two pages at the same time, close extra tabs. |
| Put away | After 10 min with no agent session in a group, the broker closes its `about:blank` and connect-page tabs through its own session, then stops the upstream. Tabs with a page stay open, out of the group: the person may read them. |

The broker reads the tabs only from its own `browser_tabs` `list` calls, never from the result of an
agent's call: a page writes part of that text (a script result, a title, a URL), and could copy a tab
list or a `Page URL` line. A list is read only when it is a whole JSON-RPC answer whose text starts
with `### Result` and each line of that section is a tab line with the indexes in order; else nothing
changes (`listedTabs`, `playwright-broker-policy.ts`). A tab line with more than one `](` has no URL
for the broker, so it is neither chosen for an agent nor closed as blank. After an agent's call the
broker marks the session's page as unknown, and reads it again with a list in that session when
another session needs it, or before the session ends. The Guard checks an agent's call before the
broker lists or selects a tab for it. The broker's own calls carry ids that start with `builders-bot-`. The extension shows `Playwright · ` before the
project name; only an extension of our own can remove it. When the person closes the group, the next
agent call makes a new connection, as before. `scripts/browser-tab-reuse-e2e.ts` runs the broker
against an upstream that copies this lifecycle.

The broker is a door on a loopback port. It checks each request in this order: the `Host` must be
`127.0.0.1:PORT` or `localhost:PORT` (403); the bearer is compared in constant time
(`timingSafeEqual`, 401); the path must be `/mcp` (404); the method must be `POST`, `GET` or
`DELETE` (405); an `mcp-session-id` that the broker did not record gets 404. A body of more than
1,000,000 bytes (413), a body that is not JSON, and a batch of more than one message (400) are
refused. `GET`, `DELETE` and each `POST` other than `initialize` need a session id. Only a fixed list
of headers goes to the upstream, so the `Authorization` of the agent stays in the broker.

The upstream is guarded too, because the door is not the only way to its port. The broker makes a new
token each time it starts the upstream and gives it to the process in `BB_BROKER_TOKEN`. The process
loads `playwright-broker-guard.cjs` (`installGuard`, written to `userData` with mode 0600) through
`NODE_OPTIONS=--require`. The guard wraps `http.Server.prototype.emit` and answers 401 to each HTTP
request that does not carry the token in `x-bb-broker`, before the server reads anything else. It
fails closed: with no token in its environment it refuses everything. WebSocket upgrades are another
event; the extension relay uses only those. If the guard file cannot be written,
`createApplicationServices` makes no broker. Do not use the `Host` as a secret instead: the Playwright
403 prints the hosts that it accepts.

`BrowserLedger` (`playwright-broker-policy.ts`) holds the limits (`DEFAULT_BROWSER_LIMITS`):

| Limit | Value | Refusal |
| --- | --- | --- |
| Agent sessions | 64 | A JSON-RPC error on `initialize`, with the request id. |
| Tabs for one session | 4 | A tool result with `isError: true` that tells the agent to close a tab with `browser_tabs` action `close`, or to reuse an open tab. |
| Tabs for all sessions | 12 | The same. |

A session is not a browsing agent. Each live agent CLI opens one when it starts and keeps it until it
stops, also while it does nothing, so the number of sessions is the number of agents that are on. The
tabs are what use the memory, and the tab limits are the ones that matter. A low session limit refuses
agents that only run, and a client that is refused at start does not offer the tool for the rest of its
life: the first limit of 8 did this, with 9 agent CLIs alive.

The counts come from the upstream response, not from the request. A successful `browser_tabs`
action `new` adds 1. A successful `browser_tabs` action `close` or `browser_close` removes 1. A
failed call changes nothing, and a count never goes below 0. A session that ends gives its tabs back
to its own count; the tabs stay in the group and count toward the total.
The broker reads about the first 256,000 bytes of a response to count; a longer response goes to the
agent but is not counted. Two `initialize` requests at the same time can both pass the session check.

`start()` only listens. The upstream starts at the first request that passes the door, one time. A
session with no request for 3 hours is ended, and the broker sends `DELETE` for it to the upstream. The
long time is for the session that a closed agent leaves behind: a client that reads 404 is not sure to
start a new session, so an idle agent must keep its own. A timer checks every 30 s. After 10 min with
no agent session in a group, the group is put away and its upstream stops, so the person's browser is
free. When an upstream stops by itself, the broker forgets the sessions of its group, and the agents
start new ones. An upstream answer 404 for a session also ends it in the broker. Teardown stops the broker after the agent service (`TEARDOWN_ORDER.browserBroker`).

`openbot-playwright-broker-v1.json` in `userData` holds the port and the bearer (`BrokerIdentityFile`,
`playwright-broker-runtime.ts`). The file has mode 0600. The bearer stays the same across restarts;
the port stays the same when it is free. A missing or damaged file gives a new pair. Codex keeps the
MCP configuration of a resumed session, so `McpGateway.proxyFingerprint` includes the broker URL
while the broker row is enabled. A new address then replaces the old configuration.

`applyBrowserAccess` (`playwright-browser-access.ts`) hands the providers one http row in place of
the Playwright row: id `builders-bot-browser-broker`, name `playwright`, the broker URL, no headers.
The upstream gets the token that the first approval in Chrome gave the Playwright extension, so that
Chrome does not ask again. The app's own `PLAYWRIGHT_MCP_EXTENSION_TOKEN` wins; without it,
`extensionTokenEnvironment` reads `mcp.playwright.environment` of `~/.config/opencode/opencode.json`
(read only, checked against `[A-Za-z0-9_-]{8,200}`, never logged) and gives it to the Playwright
process alone. The server prints a connect URL with `token=` when the extension does not answer, so
`maskSecrets` clears it from each start error that an agent can read.

`McpGateway.endpoint` adds the bearer at each hand-off and records it as a secret for redaction. The
bearer is never written to the saved row.

While the server's network egress proxy is on, the person's Chrome cannot use that proxy, so
`playwrightUpstream` replaces `--extension` with `--user-data-dir` (a profile of the server's own)
and `--config` (a file with `browser.launchOptions.proxy` set to the loopback egress gateway). A
change of the switch calls `PlaywrightBroker.resetUpstream`. See [egress-proxy.md](egress-proxy.md).

`playwrightUpstream` reads the row that the person saved as it is, at each upstream start. It does
not change the stored row. A package row (`npx`, `bunx`) keeps its command and package argument. A
row with the gated launcher `playwright-mcp-gated.mjs` loses the launcher: the broker runs the
`playwright-mcp` program from `PATH` or `COMMON_PROGRAM_DIRECTORIES`, else the pinned package
`@playwright/mcp@0.0.83` through `npx -y`. The flags `--port`, `--host`, `--mode`, `--cdp-endpoint`,
`--user-data-dir`, `--allowed-hosts` (with their values), `--extension`, `--isolated`, `--headless`
and `--shared-browser-context` are removed from the row, and the broker sets its own. The child
environment is an allowlist (`brokerEnvironment`): the names in `BASE_PASSTHROUGH` and in the row's
`envPassthrough`, copied from the app environment, then the row's own `env`. No provider key gets to
the child unless the row names it.

Two more rules keep the memory low:

- The broker reads the memory level of the computer (`memoryLevel`, from `MacMemory`; see
  [Memory of the computer](providers.md#memory-of-the-computer)). Without `MacMemory` the level is
  `ok`. While the level is `low`, `browser_tabs` action `new` gets a tool result with
  `isError: true`. While it is `critical`, a new `initialize` also gets a JSON-RPC error. Tools that
  list or close tabs always work, so an agent can give memory back.
- OpenCode starts each MCP server of the person's own `opencode.json` for each agent, so its
  Playwright started one server and one Chrome for each agent. Each OpenCode and Cultura Builder
  spawn now gets a complete `mcp.playwright` entry that is off, `{ type: "local", command: ["true"],
  enabled: false }`, on `OPENCODE_CONFIG_CONTENT` (`OWN_PLAYWRIGHT_OFF` in
  `src/backend/opencode-config.ts`). Only the name `playwright` is overridden: the other servers of
  the person still run, and the file does not change. The shared broker reaches the agent through
  ACP `mcpServers`. Keep `type` and `command` in the entry: OpenCode 2 drops an entry that has only
  `enabled` ("omitted enabled-only legacy MCP entry"), and with OpenCode 2.2.5 the old
  `{ enabled: false }` layer let the gated Playwright of the file start in each app `opencode serve`.
  OpenCode 2 keeps the entry of the last config document for each server name, and
  `OPENCODE_CONFIG_CONTENT` comes after the global and project files, so a later layer replaces a
  server of the same name. `opencode-config.test.ts` checks the JSON that Builders Bot sends, and
  `bun run test:opencode-own-playwright` checks the result with the real OpenCode binary: a server of
  the global file named `playwright` must not start, and another one must start.

### Rules that are easy to break

- The Playwright server answers only the `Host` that it prints, `localhost:PORT`. `localhost` can
  resolve to `::1`, so the broker connects to `127.0.0.1` and sends that `Host`
  (`UpstreamProcess.hostHeader`). A test with a fake upstream that accepted all hosts hid this one
  time. The fake in `playwright-broker.test.ts` now answers only its own host.
- The upstream has no sign-in of its own, and its browser holds the person's signed-in sites. Its
  guard and the loopback port are what stop another program. Keep both: a program of the same user can
  still read the token from the environment of the process, which this does not prevent.
- An unknown session id must get 404. Never add it to the ledger. The ledger records a session only
  from the `mcp-session-id` that the upstream sends for `initialize`.
- `createApplicationServices` must start the broker (`await browserBroker.start()`) before the first
  agent turn. Before `start`, `endpoint()` is null, and an agent gets the old row: one Playwright
  process for each agent.
- The counts are of tabs that agents opened through the broker, not of the person's own tabs. A tab
  that a page opens by itself is not counted; the session end limits it.

### Not verified

- The real extension path. The person must approve the connection one time in Chrome.
- The broker and its guard were checked by hand with a real `@playwright/mcp` 0.0.82 in isolated
  headless mode, not with the extension: two sessions, the tab count from real answers, the session
  limit, a request to the upstream port with no token or a wrong one (401), and no process left after
  `stop`. The tests in `src/main/playwright-broker*.test.ts` use a fake upstream, and
  `playwright-broker-guard.test.ts` runs the real guard in a Node process.

## The person's Chrome through the Builders Bot extension

The Builders Bot extension will replace the Playwright extension and the broker: the agents drive
tabs of the person's own Chrome, in one tab group for each project, through `chrome.debugger`, with
no TCP port and no token. The channel is Native Messaging to a small signed host in the app bundle,
then a private Unix socket to the app, encrypted with keys that the two sides pin when they pair.
Phase 1 adds the contracts and the seams, and no behavior of the Builders Bot browser or of the
broker changes, except the refusal below. Phase 2 adds the native host and the channel (below), and
the extension itself ([chrome-extension.md](chrome-extension.md)). Phase 3 gives the agents the tabs
([Agents in the person's Chrome](#agents-in-the-persons-chrome)).

| Part | Where | What it does |
| --- | --- | --- |
| Web access mode | `WEB_ACCESS_MODES`, `webAccessFromSwitch` (`ipc-app-behavior.ts`); `AppBehaviorService` | `webAccess` is `app`, `chrome` or `playwright-legacy`. The released `browserInApp` switch stays, and the app writes it as `webAccess === "app"`, so an older app reads the choice after a downgrade. A file or a payload with no `webAccess`, or with a mode that this app does not know, reads from the switch. `chrome` gives the agents `openbot_chrome` and no Playwright. Settings > General offers it as a switch that is off by default, so the legacy path stays the default. |
| Engine seam | `CdpTarget`, `ElectronCdpTarget` (`browser-cdp-target.ts`) | `BrowserCdpEngine` drives a `CdpTarget`, not a `WebContents`. `attach` is an Effect, so an attach over a channel can be asynchronous; `isAttached` reads no I/O. `release` is what the engine calls when nothing needs the debugger: an Electron tab (`retention: "operation"`) detaches at once, as before; a Chrome tab (`"lease"`) will keep the real debugger until the agent's lease ends, so Chrome's debugging bar does not flash on each call. Electron's own dialog box is `dialogBox`; a Chrome target has none. |
| Tab ownership | `canUseBrowserTab` (`browser-tab-ownership.ts`) | One rule for the Builders Bot browser and for Chrome tabs: a tab belongs to its thread, and to its agent when an agent opened it. A tab that the caller cannot use reads as unknown. |
| Wire protocol | `packages/contracts/src/chrome-bridge/protocol.ts`, `decode.ts` | Closed decoders with no Node, Electron or Effect, so the extension runs them too. Every object is closed: an unknown field, operation, event or error code breaks the protocol and closes the connection. Each operation and event has a feature, and a side sends only what the other announced. Identifiers are 128-bit opaque values; an agent never sees a Chrome tab id. There is no reflective `chrome.*` call, no consent grant and no operation that lowers the floor. |
| CDP allowlist | `cdp-allowlist.ts` | The methods that the engine sends, each with a closed list of parameters and rules (`checkCdpCommand`). Cookies, storage, `Fetch`, `Target.attachToTarget`, `DOM.setFileInputFiles`, the tab's history (`Page.getNavigationHistory`), a `paste` command, copy, cut and paste keys in any spelling (`isClipboardKey`) and drag files are denied. Page code runs only as an engine function (condition `scripts`): `Runtime.callFunctionOn` with a declaration whose SHA-256 is in the engine table, or the agent's own code when the person turned scripts on for the project, which this release never does; `Runtime.evaluate` is agent code only. A command makes only the engine's isolated world (`ENGINE_WORLD_NAME`), and names only contexts and objects (`objectIdContext`) of its session that the extension may hand out. Reads of page values (`Runtime.*`, `DOM.getDocument`, `DOM.describeNode`) run the strict secret check; a screenshot and the accessibility tree run the masked one. `Network.enable` only inside a navigation, with no buffer. Events and results leave the extension reduced to listed fields (`projectCdpEvent`, `projectCdpResult`): no URL fragment, no frame of the floor, no `Network.*` event, because those carry `HttpOnly` cookie values. |
| Engine table | `cdp-functions.ts`, made by `scripts/chrome-bridge-cdp-functions.ts` | The SHA-256 of each function that the engine runs through `Runtime.callFunctionOn` (48 today), and of the ones with `userGesture: true` (26, `#callOnNode`). The engine never builds code from values: values go in `arguments` (`callInContext`). In Chrome, only these functions run, and only the gesture ones get a gesture. `--check` fails when the table is stale, when a declaration is not a constant that it can read, when the engine sends `Runtime.evaluate` outside `BrowserCdp.evaluate` (the agent's own code), or when a gesture appears outside `#callOnNode` and `evaluate`. |
| Site floor | `site-floor.ts` | Banks, exchanges, password vaults, Google and Apple accounts, `*.gov.br` and browser pages: no agent opens, reads or acts on them. Only http, https and `about:blank` (and `about:srcdoc` in a frame) pass. The app can add blocks; only a choice in the extension popup opens one origin for one project. |
| Group title and color | `groups.ts` | The project name only, in NFC, with no control or direction characters, at most 40 characters. Grey is kept for "paused". |

The legacy broker refuses `browser_run_code_unsafe` before the Guard sees it and leaves it out of
`tools/list` (`REFUSED_BROWSER_TOOLS`, `playwright-broker-policy.ts`): it runs Playwright code with
the reach of the whole browser context, every tab of the group and the cookies of the person's
sites. `scripts/browser-tab-reuse-e2e.ts` checks that a call of it gets an error and never reaches
the server.

`bun scripts/chrome-bridge-contracts-smoke.ts` runs the real decoders, the allowlist, the event and
result projections, the floor, the group rules and `AppBehaviorService` on a real preference file, and
compares each CDP method that `src/backend/browser-*.ts` and `chrome-*.ts` send with the allowlist. It writes
`.buildersbot-build/chrome-bridge-contracts-smoke/report.json`.

### Native host, channel and pairing

Phase 2 adds the path between the extension and the app. The app does not start it yet: the pairing
card, Settings and `application-services.ts` come with Phase 3.

| Part | Where | What it does |
| --- | --- | --- |
| Native host | `native/chrome-host/main.swift`, `scripts/build-chrome-host.ts` | Swift, CoreFoundation and Security only (about 110 KB). Chrome starts it; it copies whole frames between Chrome (stdin and stdout) and the app's socket and reads no message. Each build compiles its channel in: the one extension origin it accepts (`argv[1]`, else exit 2), its socket, and the code requirement of the app. A store build checks the app on the socket (`LOCAL_PEERTOKEN`, team `ZTRDTUL87R`, `app.buildersbot.desktop`) before it passes a byte. It holds at most one frame for each direction and reads one side only when the other side took the last frame. |
| Host frames | `HostFrameGate` (`channel.ts`) | The host sends `hello` once, first, then `status: online` or `offline` when the app connection changes. A frame from the app must start as `{"k":"` or `{"v":1,`, so the app side of the socket cannot write a host frame. |
| Socket | `bridgeSocket`, `preparePrivateFolder` (`bridge-paths.ts`) | `~/Library/Application Support/Builders Bot/cb/b.sock` (`b-dev.sock` for dev), in a folder of mode 0700; E2E uses `<per-user temporary folder>/bb-e2e/b-e2e.sock`. Both sides compute the path, never from the environment. The host does not connect through a folder that others can open. |
| Peer check in the app | `native/chrome-peer/peer.c`, `bridge-peer.ts` | A Node-API addon with one function: the audit token of the peer and `SecCodeCheckValidity` against the host requirement, and the code of the process that started the peer against the Chrome requirement: Google's Developer ID `EQHXZ8M8AV` and a `com.google.Chrome` channel identifier in a store build; in E2E, Chrome for Testing pinned by its code hash, because it is signed ad hoc, with no team; none in development. The check is bound to values that the kernel never gives twice, not to a pid: the peer's records must carry the pid version of its audit token, and the process at the parent pid must have the unique id and the pid version that the peer recorded at fork (`proc_pidinfo` flavor 17, `p_orig_ppidversion`), before and after the code check. So a copy of the signed host that another program starts is refused, and so is one whose starter then runs `exec` into Chrome (protocol smoke B9, B10). It proves only that a process that runs Chrome's code started the host, not which extension asked Chrome: a Chrome that someone starts with a profile and an extension of their own passes it. The pairing (the extension's static key, pinned after the person picks the words) stays the main defense. The server accepts with `pauseOnConnect`, so a process that fails is closed before the app reads a byte. |
| Channel | `packages/contracts/src/chrome-bridge/channel.ts` | One WebCrypto implementation for both sides: the handshake with a commitment, three ECDH values, HKDF, key confirmation, the comparison words (BIP-39 Portuguese list, `pairing-words.ts`), and sealed frames with parts. The transcript is the canonical JSON of the decoded messages, because Chrome writes the extension's messages with sorted keys. |
| App service | `ChromeBridgeService` (`chrome-bridge-service.ts`), `HostConnection` (`host-connection.ts`) | One connection for each Chrome profile, up to 8. The handshake has a 5 s deadline from the accept, and a connection told `busy` closes after 60 s, so idle connections do not keep the places. The pairing rules of DESIGN §3: a window of 2 minutes that the person opens, used once, cancelled by a second candidate; outside it, at most 3 cards an hour and never two at once, else `reject{busy}`; a key that the person just refused gets `busy` for 10 minutes. A connection told `busy` waits idle; opening a window closes it, so its host reconnects and the extension tries again. Requests: at most 64 in flight and 16 for one key (a tab), up to 1024 waiting in order, a deadline from the moment the frames go to the socket. |
| Sealed state | `BridgeStateStore` (`bridge-state.ts`) | `app-key.bin` (the app key and a state key, sealed by the key store) and `bridge-state-v1.bin` (pins, revocations, refusals; AES-256-GCM). A file that does not open reads as no pairing. |
| Manifest | `native-host-manifests.ts`, `ChromeBridgeService.connectChrome` | Only the person's "Connect Chrome" writes it, and opens the pairing window; a change to it during the window cancels the window, and a changed manifest is written back at each start. Written whole, mode 0600, never through a link and never with a translocated path. A build that is not packaged never writes into a real browser's folder unless the owner sets `OPENBOT_CHROME_BRIDGE_REAL_CHROME=1`; tests write only into `<test profile>/NativeMessagingHosts`. |

Pairing takes two taps and nothing typed: the person taps, in the app, the words that Chrome shows,
and, on the extension's welcome page, the words that the app shows. Each side shows three options
with the right one at a random place. The app pins the extension key only after its own right
choice and the extension's `pair.chrome-ok`; the extension makes its pin final at `pair.done`.

Rules that are easy to break:

- Hash the canonical form of decoded handshake messages, never the bytes received.
- Build `hello` before reading `welcome`: the commitment is what makes a person in the middle unable
  to choose values that match the words.
- The host never parses JSON. Do not add a field to its own frames: the extension's decoder is closed.
- A connection told `busy` must stay open and idle. Closing it at once makes the host reconnect and
  the extension try again in a loop.

`bun scripts/chrome-host-framing-fuzz.ts` drives the real host binary with a stand-in app and
writes `.buildersbot-build/chrome-extension/host-framing-fuzz.json`. `bun scripts/chrome-bridge-protocol-smoke.ts`
runs the channel vectors, the real host between the app service and a stand-in Chrome, and then
Chrome for Testing with a stub extension and a temporary profile (`--skip-chrome` leaves it out). It
writes `.buildersbot-build/chrome-extension/protocol-smoke.json`.

Not verified yet: a host signed with the team's Developer ID (`--sign-identity`) and the app's
packaging of the host and the addon (`electron-builder.yml`); `safeStorage` as the key store (the
smoke uses a stand-in in its own process); the pairing card in the app.

### The extension

`apps/chrome-extension` is the Manifest V3 extension: one Native Messaging connection for all agents,
a tab group named after each project, leases that keep the same tab across turns, the closed gate of
DESIGN §6.5, the site floor with a `declarativeNetRequest` rule, Stop all, the welcome page of the
pairing and the popup. [chrome-extension.md](chrome-extension.md) describes it, and
`bun run chrome-extension:e2e` tests it in Chrome for Testing.

## Agents in the person's Chrome

With Settings > General > "Let agents use my Chrome (beta)" on (`webAccess: "chrome"`, off by
default), agents get the namespace `openbot_chrome`: the tools of `openbot_browser` on tabs of the
person's own Chrome. `openbot_browser` stays for the Vault, the secret handoff, takeover from the
phone and tabs that outlive a restart. The switch and the Builders Bot browser switch are one choice
of three; turning one on turns the other off, and the Playwright row leaves the providers in both
(`applyBrowserAccess`). A change refreshes every agent (`AgentService.notifyWebAccessChanged`).
Turning Chrome mode off closes the bridge socket; the tabs stay in Chrome, and the pairing stays.

| Part | Where | What it does |
| --- | --- | --- |
| Tools | `CHROME_DYNAMIC_TOOLS`, `parseChromeToolCall` (`chrome-tools.ts`) | The same schemas as `openbot_browser`, with Chrome descriptions: `open`, `list_tabs`, `status`, `snapshot`, `navigate`, `click`, `type`, `fill_fields`, `press`, `hover`, `scroll`, `select_option`, `set_checked`, `drag`, `wait_for`, `screenshot`, `handle_dialog`, `close_tab`. The namespace is gated (`GATED_TOOL_NAMESPACES`): a search, a describe and `tool_call` see it only while the router grants it. |
| Host | `ChromeTabsHost` (`chrome-tabs-host.ts`) | Projects, leases, tab ownership, limits and the gates. It answers each tool with the same tab queue, engine actions and result text as `BrowserHost` (`browser-tab-operations.ts`, `browser-tool-results.ts`), so an agent reads one format in either browser. |
| Engine target | `ChromeCdpTarget` (`chrome-cdp-target.ts`) | `CdpTarget` over the bridge, with `retention: "lease"`. The page state comes from the extension's `tab.updated` events; commands that the engine sends in one turn of the event loop leave in one `cdp.batch`. |
| Router | `BuildersBotToolRouter#chromeTool`, `#chromeOrigin` | The gates before any message to Chrome, the Guard before and after, and the send card. |
| App runtime | `createChromeAgents` (`chrome-agents-runtime.ts`), `askChromePairing` | Starts `ChromeBridgeService` only in Chrome mode, with `safeStorage` as the key store, the `chrome-peer` addon and a native pairing dialog. Turning the switch on is the "Connect Chrome" click. |
| Project | `AgentService.chromeProject` | The channel of the thread, else the sidebar section that the person made (and its color), else the agent's one added folder, else the agent. The app decides it at each call. |

How a call runs:

1. The router grants `openbot_chrome` only in Chrome mode and when the turn's origin is the owner or
   an agent of the owner (`CHROME_TURN_ORIGINS`, `chromeTurnOrigin` in `chrome-turn-origin.ts`). The
   origin comes from the stored messages of the turn, as for the Hub connections, except that a
   channel thread is open while no team member can write in the channels
   (`HostService.channelsHaveRemotePeople`). A message that a team member wrote or edited, a channel
   while the server has a team member, a chat app thread, a routine or an origin that the app cannot
   prove closes it. An agent turn that a routine started, at any distance, is `routine_agent` and
   closed too: a message that a routine's turn sends, a run of a routine that an agent or a routine
   saved (a webhook routine too), and what such a turn sends on ([hub-connections.md](hub-connections.md)).
   The host checks the origin again.
2. The Guard checks what the call sends out (`GUARD_TOOL_EGRESS` has an entry for each
   `openbot_chrome` tool) and, after the call, reads the page content before the agent does
   (`GUARD_INBOUND_PATHS["chrome-extension"]`).
3. `evaluate` and `run_script` are not in the namespace, and a call of them gets `scripts_disabled`:
   an agent's script in a signed-in page can send the page's data out past the Guard (DESIGN §7,
   item 19).
4. A send on a mail, chat, social, forum or code review site, or in a frame of one
   (`chrome-message-send.ts`), waits for a card with the text and the recipients, read from the
   agent's last snapshot of the tab (`AttentionRegistry.awaitToolApproval` with `alwaysAsk` and
   `ownerOnly`): Full access and "Always" never skip it. A send is a click on a ref whose element has
   a send name or no name (a name of symbols only is no name); a click on a role or a text target
   that is not exact (the engine finds it in the live page, which can have changed since the
   snapshot), or an exact one whose name, or a snapshot element it matches, is a send or no name; a
   click by selector, point or stale ref; Enter, NumpadEnter, Return or Space, and any key with Ctrl,
   Cmd or Alt that is not an edit key (Alt+S sends in some mail sites), read with the engine's own
   `parseShortcut`; a `type` with submit or with a new line or any control or separator character,
   read with the engine's own `typedCharacters`; and a `type` with no target that has a space of any
   kind, unless a snapshot that no action followed shows the focus on a text field. While the page
   holds a composer with text, the list turns over: a click on a button, link, menu item, tab or option
   asks unless its name is on a short list of actions that do not send (`NOT_SEND_NAME`: cancel, close,
   attach, emoji, format and the like, in English, Portuguese and Spanish). Send words are in seven
   languages, and send parts in Japanese, Chinese, Korean, Russian and Arabic. A click that asks no card
   passes `clickTargetCheck` too: just before the click, the engine reads the element that the target
   resolved to (its accessible name and its visible text) and stops when either is a send. The click
   then lands only on a point where the element hit is the target itself, or an inner part of its own
   shadow trees when each part up to the target is inert: no control, no send name, and no click
   listener in the page's world (`#ownPointEffect`, `OWN_HIT_FUNCTION`, `DOMDebugger.getEventListeners`,
   whose result leaves with the kind of each listener only). It never lands on a child of the target
   or on what a slot shows in it: a child can act on its own through a listener that no check sees (a
   framework that listens at the root). A target that no such point shows is refused. Recipients
   come from recipient fields and from chips with an e-mail address. The card needs a snapshot that no action of the tab followed (the host counts
   the actions in the tab's queue); an action during the person's answer voids the card. Where nobody
   answers a card, the call gets `message_send_requires_approval`.
5. A sensitive site (`sensitiveSiteKind` in `site-floor.ts`: mail, chat, cloud and code consoles,
   social networks, payment pages, and the person's own network: loopback, private ranges,
   `localhost`, `.local`) waits for the person's consent card for the project and the origin, before a
   call reads or acts on it, and again after an action or a navigation that lands on it. The answer
   holds for the project until the app restarts. Where nobody answers, the call gets
   `consent_required`. Until the person allows it, `list_tabs` shows only the origin of such a page,
   with no path and no title.
6. The project key and the lease id are HMACs of a secret of this install, sealed by `safeStorage`
   (`userData/chrome-bridge/project-secret.sealed`), so the extension never sees an app id, and the
   same agent in the same thread gets the same lease, and so the same tabs, in each turn and after a
   restart. `session.configure` names the projects; `lease.open` is sent again only on a new
   connection or a little before the extension would end the lease for idleness.
7. `open` uses a blank tab of the agent before it makes a new one. A new tab is made by the
   extension at `about:blank`, in the background, in the project's group, then navigated.

Limits: 4 tabs for an agent, 12 for a project and 12 in all (`DEFAULT_TAB_LIMITS`), counted by the
extension from its own records. The host refuses a fifth tab of an agent with no message. Under
memory pressure, `low` opens no new tab and `critical` no tab at all; listing and closing always work.

Rules that are easy to break:

- `chrome.debugger` drops a `null` value from command parameters. An engine function that takes a
  `null` argument through `Runtime.callFunctionOn` gets `undefined` in Chrome: read both as null
  (`FILL_FIELD_STATE_FUNCTION` uses `== null`).
- Chrome reports a new context only to a session with `Runtime` on, and the engine does not turn it
  on. The extension records the context that a checked `Page.createIsolatedWorld` returns, so the
  engine's isolated world passes the context check of the allowlist.
- A tab's load events can reach the app before the answer to `tab.create` gives its handle: the host
  keeps them and gives them to the tab when it registers. `open` waits for the first page that is not
  `about:blank`; `navigate` waits for a load that began after its own mark (`statusMark`).
- Chrome reports no title change for a page that the back-forward cache gives back: after back and
  forward, the host reads the title once from `Target.getTargetInfo`. The tab's history is not a
  command in the person's Chrome.
- The commands of a tab (`cdp.send`, `cdp.batch`, `script.run`, `secret.fill`) name the lease that
  sends them, and the extension refuses a tab of another lease (`tab_not_owned`).
- Page code in Chrome is an engine function with JSON arguments (`callInContext`), never code built
  from a value: the extension refuses a declaration that is not in the engine table. After a change
  to such a function, run `bun scripts/chrome-bridge-cdp-functions.ts`.
- A connection keeps going when an answer comes after the app's deadline: the app keeps the ids of
  requests that timed out for 5 minutes (at most 1024) and drops their answers. The extension's own
  deadline starts later than the app's, so a late answer is normal for a stuck page.
- When the keys of a connection are due for renewal (24 h), no new request starts; the connection
  closes when the requests in flight end, and `ChromeBridgeService` sends the held requests on the next
  connection of the profile (10 s at most).
- A `ready` with a tab that is not in `attached` (the worker restarted) makes the engine set up the
  next debugger session of that tab again (`receiveDetached`).
- A lease follows the Chrome profile that agents use now: a new install id gives a new lease record.
- The app watches the Native Messaging manifest for the life of the bridge and writes it back when
  another process changes it; turning "My Chrome" off removes it (packaged builds, or the owner's
  opt-in).
- The extension sends `ready` right after its person chose the words, before the app pins its key.
  `HostConnection` keeps that report and gives it on after `pair.done`.
- `Network.*` leaves the extension only inside a navigation batch; the Chrome host navigates with
  `Page.navigate` alone and never disables the person's cache.

`bun scripts/chrome-agents-e2e.ts` runs stand-in agents against the real host, engine, bridge service,
signed native host and extension, in Chrome for Testing with a temporary profile: pairing, the group
named after the project, two projects in two groups, the same tab in the next turn, the result format
of each tool, the limits, the site floor (open, navigate, redirect), the gates and the send card. It
writes `.buildersbot-build/chrome-agents-e2e/report.json`, with the bridge requests by operation.

Not in this release: `upload_files` (upload by content), `submit_secret` and `fill_card` in Chrome
(`secret.fill`), `request_takeover`, `set_environment`, recording, a name that the person sets for a
project's group, the per-project switch for scripts, Settings > Connected browsers, the pause of
Computer Use while the pairing dialog is open, and the app package of the host and the addon.

## Secure browser authentication

`openbot_browser.submit_secret` uses the existing attention/takeover lifecycle with optional public
secret-request metadata. The attention registry creates a fresh request ID and owns the pending
response. The secret travels through a dedicated typed IPC endpoint or the optional
`browser-secret-handoff` Team API capability, never a prompt answer or provider tool argument.
Frozen protocol projections continue to show ordinary takeover to older clients. Current codecs
carry validated metadata beside those projections. There is no database schema change.

A password can also go to the Vault of the server that runs the agent. The local app sends
`saveToVault` over IPC. A remote client sends the same submit on `browser-secret-vault-v1`, which
only an owner or admin can use; the released route keeps its fields. The card shows the save box on
every password request, and for a member or an older host it shows the box off with the reason.

The browser host owns the protection state and serializes entry behind existing browser work. CDP
resolves fields before consent and checks the document and origin again before entry. The host
stops recording, suppresses page diagnostics, blocks inspection and capture, rejects remote input,
and invalidates existing live-view streams. Capture protection remains after same-document navigation
or an uncertain submission. After a completed submit action without document replacement, the host
waits up to five seconds, then empties the filled fields. When every field is empty and an automation-world scan finds the
value in no title, URL, text node, value, or attribute, including open shadow roots, it keeps the
document so a single-page sign-in can show its next step, and blocks evaluation and recording in the
opener group until a main-frame navigation, which also clears history. Otherwise it loads the current
URL with GET to replace the document without replaying a form POST. Failure retains protection and falls back to takeover. A new document releases it and
clears navigation history; manual takeover
completion alone cannot release it. Secrets are not retried. Authentication inside unsupported frames,
unclear OAuth account selection, CAPTCHA, passkeys, and payment confirmation use takeover.
