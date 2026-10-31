# Network egress through a proxy

Server settings › Network egress sends the internet traffic of one server's agents through one HTTP
proxy, such as a residential proxy in Brazil. The setting belongs to the server: each server process
keeps it, applies it, and checks it. An app default gives the same proxy to each server that this
app makes later.

## The setting

Only an owner or admin of the server can read or change it. The host checks the role
(`requireAdmin`); the renderer hides the section from a member.

| Field | Rule |
| --- | --- |
| On/off switch | Off is the default. With the switch off, nothing changes for the server. |
| Host, port | A host name or an IP address, and a port from 1 to 65535. |
| User, password | The password is write-only. The host never sends it back; the view says only "saved". It stays only for the same host, port and user (below). |
| Bypass list | Hosts that do not go through the proxy. Defaults below. |
| Expected country | Two letters, `BR` by default. |
| Block on another country | On by default. The check below blocks the traffic when the country is not the expected one. |

The paste field takes one line in the two forms that providers give: `host:port:user:password`
and `http://user:password@host:port`. It fills the fields; it saves nothing by itself. The
password can hold `:` only in the URL form (percent-encoded).

The paste field is cleared when its line fills the fields, so the line with the password does not
stay on the screen.

A save with the password field empty keeps the saved password only when the host, the port and the
user stay the same (`egressUpstreamChanged`). For another upstream the saved password is not used:
with a user and the switch on, the save is refused (`error.host.egressIncomplete`) and the admin
types the password again; with the switch off, the save removes the saved password. So an admin
cannot send the saved password to a host of their choice, and a typo in the host does not send it
there either. `EgressProxyStore.save` applies the same rule, so the app default follows it too. The
section hides "A password is saved" while the host, the port or the user differ from the saved ones.

The default bypass list keeps local and control-plane traffic direct: `localhost`, `127.0.0.0/8`,
`::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`,
`*.local`, the Tailscale network (`100.64.0.0/10`, `fd7a:115c:a1e0::/48` and `*.ts.net`),
`culturabuilder.com` and `*.culturabuilder.com`, `openbot.run` and `*.openbot.run`. Sign-in, the
account service and Signal never go through the proxy, and a proxy in another country cannot reach
the machines of the tailnet. Loopback is always direct, also when an admin removes it from the list:
the gateway and the agents' own local servers are there.

`src/main/egress-proxy-store.ts` keeps the setting in `openbot-egress-proxy-v1.json` in the user
data of the server. The password is encrypted with `safeStorage`, as `ProviderCredentialStore`
does. A file that cannot be read or a password that cannot be decrypted makes the state
`error` with the reason `secret`; the file stays until an admin saves again.

## What goes through the proxy

| Traffic | How | Owner |
| --- | --- | --- |
| Embedded browser: the shared session, agent and profile sessions, private sign-in sessions | `session.setProxy` with `proxyRules` set to the proxy and `proxyBypassRules` from the list. The `login` event answers a proxy challenge (`authInfo.isProxy`) with the stored user and password, and never shows a prompt. WebRTC gets `disable_non_proxied_udp`. | `BrowserHost.#configureSession` calls `EgressProxyService.attachSession` |
| Processes that agents start: provider CLIs, their tools and shells | `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, the lowercase forms, and `NODE_USE_ENV_PROXY=1` | `agentEnvironment` in `application-services.ts`, read at each spawn |
| The Codex app-server: its model calls, its MCP clients and the stdio servers it starts | The same variables in the spawn environment of the one app-server process. Codex gives a thread's shell commands only `shell_environment_policy`, so the app-server needs them too | `egressEnvironment` of `ProviderClientContext`, read in the Codex `createClient` |
| Each stdio MCP server, for every provider and for the MCP test | The same variables last in the server's launch environment, after the pairs of its row. Codex starts a stdio server with only the variables of its entry, so no server depends on what a provider passes down | `McpToolRuntimes.launchEnvironment`, read by `mcpLaunchEnvironment` |
| The requests that Builders Bot sends for the agents: tool calls through the MCP OAuth proxy, GitHub tools through the GitHub MCP proxy, and the MCP test of an http server | A `fetch` that sends each request that is not to a bypass host to the gateway (`undici` `ProxyAgent` with the gateway token). With the gateway down, it refuses | `EgressProxyService.fetch` (`src/main/egress-fetch.ts`); `McpOAuthProxyOptions.fetch`, `GitHubMcpProxyOptions.fetch`, `McpToolRuntimes.fetch` |
| The browser of the shared Playwright server | The broker starts `@playwright/mcp` with its own persistent profile and `launchOptions.proxy` (server, username, password, bypass) in place of `--extension`. `launchOptions.args` has `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, so a page cannot read the real address from WebRTC | `playwrightUpstream`, `playwrightEgressConfig`, `PlaywrightBroker.resetUpstream` |

The agent processes and Playwright do not get the proxy password. They get the loopback **egress
gateway** (`src/main/egress-gateway.ts`): an HTTP proxy on `127.0.0.1` with a random port and a
random token for each start of the server process. The gateway refuses a request without the token
(407), and sends each `CONNECT` and each absolute-form HTTP request on to the upstream proxy with the
stored credentials. It never opens a direct connection. So an agent that prints its environment,
or a tool error that prints the proxy address, shows only a loopback token. A new password applies
at the next connection, with no restart of an agent.

The embedded browser goes to the upstream proxy directly, because the gateway runs on the main
thread and the browser makes many requests. Its credentials stay in the main process.

### A change of the switch

When the switch turns on or off, or the bypass list changes, the variables change. The host then
hands the MCP set over again and starts again each provider process that read them at spawn: grok,
opencode, antigravity, cursor, cline, acp and the Codex app-server
(`AgentService.notifyEgressProxyChanged`, `reloadAgentEnvironment` with `appServer`). A process with a
turn in progress starts again after the turn, as for the GitHub connection. A Codex session is
replaced at its next turn, because the variables are part of its fingerprint. Proxy and blocked give
the same variables: the gateway applies that change for each new connection, with no restart.

### Not covered

- WebRTC and UDP of Builders Bot itself: the Team connection to Signal and TURN stays direct. So do
  the main process calls to the account service, Signal, the update feed, telemetry and the
  messaging connectors (Discord, Slack, Telegram).
- Sign-ins and account reads that the main process makes: the OAuth sign-in and token refresh of an
  MCP server (`McpOAuth`), the GitHub sign-in and its installation tokens, the provider sign-in
  commands, and the usage reads of the providers. They go direct.
- A program that does not read the proxy variables, or that opens raw sockets or UDP. The variables
  are a convention; Builders Bot cannot force a program to use them.
- DNS: a request through the proxy sends the host name to the proxy, but Chromium can still resolve
  some names locally (link prefetch).
- A proxy challenge from a service worker of the embedded browser (the `login` event of the app, with
  no tab) gets no answer, so such a request fails.
- The person's own Chrome (the Playwright extension). While the setting is on, the broker does not
  attach to it.
- The web client and the mobile app do not show the section yet.

## Fail closed

With the switch on, the browser and the tools never fall back to a direct connection. The bypass
hosts keep working.

| Failure | Embedded browser | Agent processes and Playwright |
| --- | --- | --- |
| Proxy not reachable | Chromium has no `DIRECT` in the rules, so the load fails (`ERR_PROXY_CONNECTION_FAILED`) | The gateway answers 502 with a message that names the setting |
| Authentication refused | The `login` event answers once for each proxy challenge, then cancels: 407 | The gateway answers 502 and the state becomes `error` (`auth`) |
| Country is not the expected one (block on) | A request gate cancels every request that is not to a bypass host | The gateway answers 502 to everything |
| Password cannot be decrypted, or the setting is not complete | The request gate cancels | The gateway answers 502 to everything |
| Proxy change in progress | The request gate holds each request until `setProxy` resolves, then `closeAllConnections` drops old sockets | The gateway reads the new upstream for each new connection |

The gate (`webRequest.onBeforeRequest`) exists only while a change is in progress or the state
blocks. With the switch off or the proxy active, the session has no gate, so a page load costs no
extra round trip to the main process.

When a page does not load because of the proxy, the browser host changes the agent's navigation
error to a sentence that names the cause and Server settings › Network egress. The section shows the
state (`active` or `error` with its reason), a **Test proxy** button that is also the retry, and the
last check. The tab itself shows the error page of Chromium, with no retry button and no link to the
section.

## The check

`checkEgressProxy` (`src/main/egress-proxy-check.ts`) opens a `CONNECT` tunnel through the upstream
to `ipinfo.io:443`, sends `GET /json` over TLS, and reads the IP address, the city and the country.
The host runs it when an admin saves with the switch on, when an admin presses **Test proxy**, and at
the start of the server process. A country that is not the expected one shows a warning, and with
block on it sets the state `error` (`country`). The traffic stays on the proxy, never direct, while a
check runs. This is outbound data: see `PRIVACY.md`.

## Team API

`egress-proxy-v1` (protocol 9 only) adds three admin routes. `requireAdmin` is the only gate.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /v1/admin/host/egress-proxy` | `{}` | the view |
| `POST /v1/admin/host/egress-proxy/update` | the setting, with `password` absent to keep the saved one for the same host, port and user | the view; 409 `egressIncomplete` when the switch is on and the upstream has no password |
| `POST /v1/admin/host/egress-proxy/test` | `{}` | the view after a new check |

The view has the fields above with `passwordSaved: boolean` in place of the password, and the state,
its reason and the last check. A server on this computer is a child process that the desktop reaches
over loopback, so the desktop reaches its setting through the same routes. The update and test routes
wait for a check through the proxy, so the desktop gives them 45 seconds
(`EGRESS_PROXY_REMOTE_TIMEOUT_MS`) in place of the default time limit of a request.

## Default for new servers

The desktop app keeps one default (`EgressProxyDefault` in `src/main/egress-proxy-default.ts`, file
`openbot-egress-default-v1.json`, password encrypted with `safeStorage`). An admin sets it in the
Network egress section with **Use as default for new servers**, or removes it there.

| How the server is made | What happens |
| --- | --- |
| A server on this computer (`LocalServers.create`) | Before the first start, the desktop writes the default as `openbot-egress-proxy-v1.json` in the user data folder of the new server (`EgressProxyDefault.writeToNewServer`), with the password encrypted by `safeStorage`. The server is the same app with another folder, so it reads the same keychain item. The server reads the file at its start, before any agent. The password never goes into the environment of the server: another process of the same user can read the environment of a process. When the file cannot be written, the creation stops and the server is removed. |
| A hosted server | The desktop keeps the new server id as pending. When the server is online, supports `egress-proxy-v1` and the user is its owner or admin, the desktop reads the server's setting. When it is off and has no host, the desktop sends the default with the update route. Either way it removes the id: a setting that the owner made stays. An id waits until a send succeeds or the default is removed (at most 64 ids). |
| A server that the user joins | Nothing: the user did not make it, and its admin decides. |
| This computer's own server | Nothing: it exists before the default. Set it in its own section. |

A server that exists keeps its setting when the default changes.

## Secrets

- The password and the full pasted line are registered with `registerSecretValue` when the host
  loads or saves them, so every log, export and error masks them. `packages/logging` also masks the
  user and password of a URL (`scheme://user:password@host`) and the last two fields of a
  `host:port:user:password` line.
- IPC and the Team API answer only the view. The update payload is decoded at the boundary
  (`parseEgressProxyUpdate`), after the sender check.
- The gateway token is registered as a secret too. It is valid only on loopback and only for the
  life of the server process.

## Rotate the password

1. Paste the new line, or type the new password, in Server settings › Network egress.
2. Save. The host encrypts and stores it, gives the new credentials to the browser sessions, closes
   their open connections, and the gateway uses it for the next connection.
3. Press **Test proxy** and check the IP address, the city and the country.

The agents keep their loopback address, so no agent restarts.

## Tests

- `scripts/egress-proxy-e2e.ts` (`bun run test:egress-proxy`, in CI; it runs on Node with `tsx`,
  because the main process runs on Node and Bun replaces `undici`; needs `curl` and `/bin/sh`) runs
  the real store, gateway, check and service against a fake upstream proxy, a fake location service
  and a fake host on loopback, with `curl` as the agent tool. It checks the parser, the bypass rules
  (Tailscale too), the option builders and the Playwright file with its WebRTC flag, plain HTTP and
  `CONNECT` through the gateway, the `fetch` of the main process, the spawn environment of a fake
  Codex app-server, the stdio MCP entries of Codex, Claude and ACP, a bypass host that goes direct,
  the fail-closed cases, that a second proxy gets no `Proxy-Authorization` when only the host
  changes, a password rotation, the store, the redaction, the default of a new local server (a file
  before the first start, no password in the environment of the child, a failed write that stops the
  creation) and of a new hosted server. It writes `.openbot-build/egress-proxy-e2e/report.json`.
- `scripts/team-api-routes-e2e.ts` checks the three routes: a member gets 403 `adminRequired` and
  nothing is saved, an admin saves, reads and tests with no password in an answer, and a save that
  moves the proxy to another host without the password gets 409.
- `src/main/ipc/host-admin-egress.test.ts` checks the trust boundary: the sender check, the decoding
  of malformed settings, and that no view carries the password.
- `packages/logging/src/redaction.test.ts` checks the proxy URL and line shapes.

## Not verified

- The `@playwright/mcp` configuration file shape (`browser.launchOptions.proxy`,
  `browser.userDataDir`) was read from its documentation, not run here: no network was used.
- A real residential proxy. The tests use a fake proxy and a fake location service on loopback.
- The Electron parts in a running app: `session.setProxy`, the request gate, the `login` event and
  the WebRTC policy. The service drives them through `BrowserEgressSession`, which the end-to-end
  check replaces with a fake.
- The real Codex CLI and the other provider CLIs with the variables: the end-to-end check reads the
  spawn environment of a fake app-server. That a CLI or a stdio server reads the variables is the
  convention above.
- The restart of the provider processes after a change of the switch in a running app.
- A new server on this computer on Windows. There, `safeStorage` can use a key of each user data
  folder. When the new server cannot decrypt the file, its state is `error` (`secret`) and it blocks
  until an admin types the password again: it never goes direct.
- The TLS step of the check (`ipinfo.io` over HTTPS). The end-to-end check uses plain HTTP to a fake
  service through the same tunnel code.
