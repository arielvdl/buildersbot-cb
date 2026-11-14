# Builders Bot extension for Chrome

`apps/chrome-extension` is the Manifest V3 extension that lets agents drive tabs of the person's own
Chrome, in one tab group for each project. It replaces the Playwright extension of the legacy broker
([browser.md](browser.md#one-playwright-server-for-all-agents)). The wire protocol, the CDP allowlist,
the site floor and the encrypted channel are in `packages/contracts/src/chrome-bridge`
([browser.md](browser.md#the-persons-chrome-through-the-builders-bot-extension)). The native host
(`native/chrome-host`) and the app side of the bridge are separate parts. The app does not use the
extension yet: `webAccess: "chrome"` still browses as `playwright-legacy`.

## Build

`bun run chrome-extension:build -- --channel store|local|dev|e2e` writes an unpacked extension to
`.buildersbot-build/chrome-extension/<channel>/`. Bun bundles the code without minifying it, so a store
reviewer can read it, and the extension has no runtime dependency. The `_locales` folders come from the
`chromeExtension.*` keys of `@openbot/i18n` (`en`, and `pt` as Chrome's `pt_BR`); a `{name}`
placeholder becomes Chrome's `$name$`. The local, dev and E2E builds carry the public `key` of
`EXTENSION_PUBLIC_KEYS` (`extension-ids.ts`), so they have fixed IDs. The store build has no `key`. The
local build is for an app that its owner signed on their Mac (`bun run package:signed`), and it keeps
the product name; the dev and E2E builds have "(Dev)" and "(E2E)" in their names.

`bun run chrome-extension:kit` builds, for a manual test in the owner's own Chrome, the dev and local
extensions into `.buildersbot-build/chrome-extension/dist/` of the main checkout (`extension` and
`extension-local`, the folders to load with "Load unpacked"), the dev host and the `chrome-peer` addon
where `bun run dev` reads them, and writes the steps in Portuguese next to that folder
(`COMO-TESTAR.md`). It checks that each ID from a manifest key is the one that its host accepts. It
writes nothing into a Chrome folder.

Permissions: `debugger`, `tabs`, `tabGroups`, `nativeMessaging`, `storage`, `alarms`,
`declarativeNetRequest`. No host permission, no content script, no web-accessible resource, and
`externally_connectable` names no extension and no page. The page CSP allows `connect-src 'self'` only:
the extension makes no network connection.

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| Connection | `link.ts` | One Native Messaging port for all agents, projects and windows. Requests carry an id; the extension answers each one when its work ends, in any order. The host speaks first (`hello`), then `status: online`; then the handshake of `channel.ts` runs, and every later frame is sealed. The open port keeps the worker alive, and so does an attached debugger. There is no keepalive message and no polling. |
| Reconnection | `link.ts`, `service-worker.ts` | A closed port is tried again after 1 s, then by `chrome.alarms` (30 s, 1, 2, 5, 15, 30 min). A one-minute watchdog alarm starts a worker that Chrome stopped; a worker that starts for an alarm or any event other than `onStartup` and `onInstalled` connects only when the wait of its retry step has passed (the step is kept in `storage.session`), so with no host it does not try at each wake. The worker also connects at `onStartup`, `onInstalled`, a window focus change (at most every 5 s) and a click on the icon. 60 s with no app, the debugger leaves every tab; tabs and groups stay. |
| Pairing | `link.ts`, `keys.ts`, `welcome.ts` | A new app key opens the welcome page by itself only when the app's `welcome` says that the person opened a pairing window there, and at most 3 times an hour (`storage.local`); otherwise the icon shows "!" and **Connect** in the popup opens it. The page shows the words of Chrome's code, offers three options for the app's code, and says to tap "Not now" when Builders Bot shows no card. The right choice is the consent and the check on the Chrome side; the extension then pins the app key as provisional and sends `pair.chrome-ok`. `pair.done` from the app makes the pin final, and only for that key after that choice. Until the choice, only `ping` is answered (`consent_required`). A wrong choice or "Not now" closes the port, and only a gesture connects again. The static key is a non-extractable `CryptoKey` in IndexedDB. |
| Groups | `groups.ts` | One group for each project, titled with the project name only (cleaned again with `projectGroupTitle`; a repeated name gets " (2)"), in the project color, or the next free color in its window. A group is ours only by the id in the extension's registry (`storage.local`, cleared at `onStartup`), never by its title. Grey means paused. A rename by the person stops the extension from writing the title. A group dragged to another window is followed. Closing or ungrouping the whole group pauses the project; closing its only tab does not. A shared group pauses the project. Concurrent tabs of a new project join one group. |
| Tabs and leases | `tabs.ts` | A lease is one agent in one thread; its id stays across turns, so `lease.close` and the next `lease.open` keep the same tabs. A handle is a 128-bit opaque value. A new tab opens at `about:blank`, inactive, at the end of the group, enters the floor rule, gets the debugger, and only then navigates. Limits (4 per lease, 12 per project, 12 in all by default, up to 25, 32 and 40) are counted from the extension's own records, with a reservation when the limit is checked, so concurrent calls cannot pass it; past a limit the call is refused at once with `limit`. Before a limit of a project or of all agents refuses, the oldest tab that an agent made and nobody looked at, of a lease that is not open, closes (`tab.removed {by: "extension"}`). A `tab.create` that fails after it made its tab closes that tab, so no tab counts that the app does not know. Popups of an agent tab join its group, or become satellites in a popup window (the slot is reserved before the wait). A tab that the person closes is reported; a tab that the person drags out of the group and keeps out for 1.5 s leaves the lease and the limits (`tab.removed {by: "person"}`), and `tab.close`, `tab.history`, `tab.zoom` and `tab.discard` check the group first. A blank tab of a closed lease closes after 10 min; a tab with content is discarded after 5 min unless the person looked at it, and it loads again at its next command. Deadlines (lease idle, blank close, discard, collapse) set one timer to the nearest one that still has work: a tab already discarded, a lease that is open and a group that the person keeps open do not count, so nothing wakes the worker in a loop. Leases closed for an hour with no tab, and projects with nothing left, leave the records. |
| Debugger | `debugger.ts` | Attach at the first command of a lease, detach at its end, so Chrome's bar does not flash at each call. Frames of another origin attach as child sessions, and each one is checked against the floor when it attaches and when its URL changes. Commands share bounded slots (16 per tab, 64 in all); the order of one tab holds at most 64 commands, and past that a command gets `limit`. `Page.handleJavaScriptDialog` does not wait in the tab's order or for a slot: the commands before it may be the ones that the dialog holds. A detach (stop, pause, end of the lease) during an attach wins: the new session leaves at once and the command fails. A crash is reported as `tab.updated {status: "unloaded"}` and `tab.detached`. "Cancel" on Chrome's bar is a stop of all. Console events are capped at 20 per second per tab. |
| Gate | `commands.ts` | Each command, in order: no stop or pause; the handle, the lease that sends the command holds it (`tab_not_owned` otherwise), and that lease is open; the tab is in the registered group now (`tabs.get`); a tab that Chrome discarded loads again first; the main frame and the child session are not on the floor; after the attach, the stop, the pause and the lease are checked again; `checkCdpCommand` (closed methods and parameters; page code only as an engine function of `cdp-functions.ts`, by SHA-256, because this build has no switch for the agent's own scripts; copy, cut and paste keys refused); a click over a frame on the floor is refused; a secret check before reads that can show a secret. The commands of one tab reach Chrome in arrival order, without waiting for each other's result. Reads, and engine functions with no gesture, that change origin while they run are dropped. Results leave with the closed fields of `projectCdpResult`: no URL fragment, frames of the floor with no URL. The tab's history is not a command. `Network.enable` passes only in a `cdp.batch` that navigates. The file chooser is caught for 30 s at most. |
| Contexts | `debugger.ts` | The contexts that a command may name are kept for each session (context ids are counted per renderer process): the page's own worlds, from `Runtime.executionContextCreated`, and the engine's world, from the answer to a checked `Page.createIsolatedWorld`, which may name only that world. The worlds of the secret check and of an agent script are reserved and never listed; the content-script worlds of other extensions (a password manager) are not listed either. A new document in a session's top frame clears its contexts. An object id names its context (`<isolate>.<context>.<object>`), and is checked the same way. |
| Secrets | `secrets.ts` | The secret check runs in an isolated world of the extension's own, in every frame of the tab: the frames of the main session and of each child session (the card fields of a payment provider are a frame of another site), and inside shadow roots: the open ones from the guard world, the closed ones from a DOM snapshot of each session (`DOMSnapshot.captureSnapshot`, which reads them as a screenshot and the accessibility tree do). A password, one-time code or card field with a value gives `secret_present`. The check fails closed: a page past 100,000 elements, or a snapshot that fails, counts as holding a secret, so such a page refuses reads (measured: 25 to 45 ms to refuse a page of 120,000 elements). A field that `secret.fill` typed does not count only for a screenshot and the accessibility tree (they show a password as dots), and only while it is still the password field that it was: a field whose type or autocomplete changed counts. Reads of page values (engine functions, the DOM) are strict: every secret counts. The world is made again for each check, never taken from a cache, because a context id names another document after a navigation. A frame that the check cannot reach counts as a secret. A clean result holds for 1 s, until the next command that is not a read. `secret.fill` is atomic: the tab's commands in Chrome end first, then origin, focus, the focused node in the isolated world, which must be a password, code or card field of the page, then `Input.insertText`. The text never comes back. |
| Floor | `floor.ts` | `siteFloorDecision` on each URL, and a `declarativeNetRequest` session rule that blocks main frames and frames of the floor and of `policyAdd`, only in agent tabs, before the request leaves. A tab whose main frame lands on the floor is quarantined at its first `Page.frameNavigated`, before `tabs.onUpdated`, and nothing of that page leaves: no debugger, only history and close, until it leaves. `tab.history` checks the entry that back or forward reaches first, because the back-forward cache shows a page with no request. An origin that the person allows for a project in the popup gets an `allow` rule of higher priority for that project's tabs only, anchored to its scheme, host and port (`urlFilter: "\|https://host:port/"`), so no subdomain, scheme or port of the same site opens with it. |
| Updates | `state.ts`, `service-worker.ts` | `storage.local` keeps a copy of the projects, leases, tabs, stops and limits (the carry). An update or a reload of the extension empties `storage.session`; the next worker then takes the tabs of the carry back with the same handles, each one only while Chrome shows it in the registered group of its project, and the app finds its tabs in the next `ready`. A browser start never takes the carry (`runtime.onStartup` marks the worker first). Before the reload of an update, the debugger leaves each tab and `ext.updating` is on the port. |
| Scripts | `link.ts`, `commands.ts` | The extension does not announce `agent-scripts`, and `scriptsOn` is false: an agent's own scripts wait for a switch for each project in the popup, so the app alone cannot turn them on. Until then, `Runtime.evaluate` and any function outside the engine table get `scripts_disabled`. |
| Stop and badge | `stop.ts` | Stop all from the popup, `Alt+Shift+K`, or Chrome's bar ends only with Resume in the popup; the app ends only what the app started. Each agent tab shows the agent's initials in the project color, and a tooltip "Controlled by <agent> · <project>". |
| Popup | `popup.ts`, `pages.ts` | The link state, Stop all and Resume, each project with its agents, tab count and pause, and the floor sites it hit. Allowing one of them for one project needs a choice among three sites at random places. Pages talk to the worker only through `runtime.sendMessage`, checked against the extension's own id and URL. |

## Test

`bun run chrome-extension:e2e` (under the heavy-command mutex) downloads a pinned Chrome for Testing
(version and SHA-256 in the script), builds the E2E extension, and runs it in a new profile under
`$TMPDIR` that the script deletes. The Native Messaging manifest goes to
`<profile>/NativeMessagingHosts`, never to the person's Chrome folder. The script plays the app with
the real `AppHandshake` and checks each message with `decodeToApp`; a stand-in host
(`scripts/chrome-extension-e2e-relay.ts`) copies frames between Chrome and the app socket. Chrome is
driven through `--remote-debugging-pipe` with a small CDP client: Playwright attaches to every service
worker, and an attached debugger keeps a worker from stopping. Floor hosts resolve to the local test
server inside the test Chrome only (`--host-resolver-rules`), with a control host that must be reached.
The report is `.buildersbot-build/chrome-extension-e2e/report.json`.

### Measured (02/11/2026, Chrome for Testing 156.0.8078.80, headless, MacBook with 24 GB)

All agents share the one connection; each agent has one tab of 200 buttons and sends, for 8 s, one
command after another, with a `cdp.batch` of 8 commands every fourth call. Up to the security review of
02/11 the command was `Runtime.evaluate`; since then it is an engine function (`Runtime.callFunctionOn`
in the engine's world), so the numbers below are of the earlier command. Other agents
were running on the computer (load average 26 to 42, swap about 8 GB), so the numbers are a floor,
not a best case.

| Agents | Tabs per renderer | Served | Requests/s | CDP commands/s | `cdp.send` p50 / p95 / p99 | Worker heap used | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | one each | 10 | 1,200 | 3,301 | 6.1 / 16.3 / 53.8 ms | 14.2 MB | 0 |
| 25 | one each | 25 | 567 | 1,560 | 12.4 / 120.8 / 1,333 ms | 4.4 MB | 0 |
| 10 | shared (`--process-per-site`) | 10 | 2,264 | 6,225 | 3.5 / 7.9 / 14.3 ms | 4.7 MB | 0 |
| 25 | shared | 25 | 3,389 | 9,317 | 6.7 / 11.3 / 21.6 ms | 15.8 MB | 0 |
| 50 | shared | 40, and 10 refused with `limit` | 2,782 | 7,650 | 11.2 / 20.9 / 61.7 ms | 4.2 MB | 0 |

After the security review of 02/11 (engine functions, strict secret check on reads, closed results),
10 agents with one renderer each: 3,807 requests/s, 10,469 CDP commands/s, `cdp.send` p50 / p95 / p99
1.5 / 2.4 / 5.8 ms, worker heap 21.5 MB, 0 errors (swap 3.4 GB, load average 15).

The 50-agent load ran with shared renderers because swap was above 6 GB: 25 tabs with one renderer
each took 4.4 GB of Chrome memory. The extension process (worker and its open pages) stayed at 295 to
347 MB. Other numbers of the same runs: a new turn's first command 6 ms; a warm command 3.5 ms; the
worker back 216 ms after a new tab once Chrome stopped it; no worker stop in 35 s idle, with the
debugger attached and with only the port open.

## Rules that are easy to break

- A handler that throws at once must answer with an error. Only a message that fails its decode may
  close the connection.
- Check a limit and take its slot in the same task. Many `tab.create` calls run at once, and each one
  waits for Chrome.
- Never read another tab's URL to find the extension's own page: use `runtime.getContexts`.
- Register every listener at the top level of `service-worker.ts`, at once. Chrome starts a stopped
  worker for an event only when the first run of the file added a listener for it.
- After a restart of the worker, drop the debugger sessions of the last worker: its frame and context
  records are gone, and a clean attach at the next command is the safe way. `ready.attached` is then
  empty, and the app enables its domains again.

## Not verified

- With the signed host (`native/chrome-host`) and the app's bridge service: the E2E uses a stand-in.
- The infobar, focus and rendering of background tabs in a visible window (DESIGN V15, V24): the E2E
  runs headless by default (`--headed` shows the window).
- Handed tabs (`tab-handoff`: `tab.claim`, `tab.release`, candidates) are not in this build; the
  extension does not announce that feature.
- The password manager case of the secret check (DESIGN V16) and the drag of a tab or a group by a
  person (V18, V26) need a person. Document identity is checked again during secret filling;
  this does not bind a node to the earlier snapshot or remove the final navigation race.
- What starts the worker again after Chrome stops it with no browser event: in the runs, Chrome
  started it by itself in 0.4 to 2 s, before the one-minute watchdog alarm. The alarm bounds the wait
  when Chrome does not.
- After a page sends the tab to a floor site by itself, Chrome often has no history entry to go back
  to (its history intervention skips an entry left without a user gesture). The agent then closes the
  tab and opens a new one.
