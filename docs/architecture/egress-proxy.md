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
| User, password | The password is write-only. The host never sends it back; the view says only "saved". |
| Bypass list | Hosts that do not go through the proxy. Defaults below. |
| Expected country | Two letters, `BR` by default. |
| Block on another country | On by default. The check below blocks the traffic when the country is not the expected one. |

The paste field takes one line in the two forms that providers give: `host:port:user:password`
and `http://user:password@host:port`. It fills the fields; it saves nothing by itself. The
password can hold `:` only in the URL form (percent-encoded).

The default bypass list keeps local and control-plane traffic direct: `localhost`, `127.0.0.0/8`,
`::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`,
`*.local`, `culturabuilder.com` and `*.culturabuilder.com`, `openbot.run` and `*.openbot.run`. Sign-in,
the account service and Signal never go through the proxy.

`src/main/egress-proxy-store.ts` keeps the setting in `openbot-egress-proxy-v1.json` in the user
data of the server. The password is encrypted with `safeStorage`, as `ProviderCredentialStore`
does. A file that cannot be read or a password that cannot be decrypted makes the state
`error` with the reason `secret`; the file stays until an admin saves again.

## What goes through the proxy

| Traffic | How | Owner |
| --- | --- | --- |
| Embedded browser: the shared session, agent and profile sessions, private sign-in sessions | `session.setProxy` with `proxyRules` set to the proxy and `proxyBypassRules` from the list. The `login` event answers a proxy challenge (`authInfo.isProxy`) with the stored user and password, and never shows a prompt. WebRTC gets `disable_non_proxied_udp`. | `BrowserHost.#configureSession` calls `EgressProxyService.attachSession` |
| Processes that agents start: provider CLIs, their tools, shells and MCP servers | `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, the lowercase forms, and `NODE_USE_ENV_PROXY=1` | `agentEnvironment` in `application-services.ts`, read at each spawn |
| The browser of the shared Playwright server | The broker starts `@playwright/mcp` with its own persistent profile and `launchOptions.proxy` (server, username, password, bypass) in place of `--extension` | `playwrightUpstream`, `PlaywrightBroker.resetUpstream` |

The agent processes and Playwright do not get the proxy password. They get the loopback **egress
gateway** (`src/main/egress-gateway.ts`): an HTTP proxy on `127.0.0.1` with a random port and a
random token for each start of the server process. The gateway refuses a request without the token
(407), and sends each `CONNECT` and each absolute-form HTTP request on to the upstream proxy with the
stored credentials. It never opens a direct connection. So an agent that prints its environment,
or a tool error that prints the proxy address, shows only a loopback token. A new password applies
at the next connection, with no restart of an agent.

The embedded browser goes to the upstream proxy directly, because the gateway runs on the main
thread and the browser makes many requests. Its credentials stay in the main process.

### Not covered

- WebRTC and UDP of Builders Bot itself: the Team connection to Signal and TURN stays direct. So do
  the main process calls to the account service, Signal, the update feed and telemetry.
- A program that does not read the proxy variables, or that opens raw sockets or UDP. The variables
  are a convention; Builders Bot cannot force a program to use them.
- DNS: a request through the proxy sends the host name to the proxy, but Chromium can still resolve
  some names locally (link prefetch).
- A process that started before the switch changed keeps its environment until it stops. Restart the
  server to apply the change to every running agent. A server that inherits the default (below) has
  the setting before its first agent starts.
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
last check.

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
| `POST /v1/admin/host/egress-proxy/update` | the setting, with `password` absent to keep the saved one | the view |
| `POST /v1/admin/host/egress-proxy/test` | `{}` | the view after a new check |

The view has the fields above with `passwordSaved: boolean` in place of the password, and the state,
its reason and the last check. A server on this computer is a child process that the desktop reaches
over loopback, so the desktop reaches its setting through the same routes.

## Default for new servers

Settings of the desktop app keep one default (`EgressDefaultStore`,
`openbot-egress-default-v1.json`, password encrypted with `safeStorage`). An admin sets it in the
Network egress section with **Use as default for new servers**, or removes it there.

| How the server is made | What happens |
| --- | --- |
| A server on this computer (`LocalServers.create`) | The desktop gives the default to the child in `OPENBOT_LOCAL_SERVER_EGRESS` at its first start. The child removes the variable at once, before any agent starts, and saves it as its own setting when it has none. |
| A hosted server | The desktop keeps the new server id as pending. When the server is online, supports `egress-proxy-v1` and the user is its owner or admin, the desktop sends the default with the update route and removes the id. |
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

## Not verified

- The `@playwright/mcp` configuration file shape (`browser.launchOptions.proxy`,
  `browser.userDataDir`) was read from its documentation, not run here: no network was used.
- A real residential proxy. The tests use a fake proxy and a fake location service on loopback.
