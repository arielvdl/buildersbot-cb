# Main-process design notes

[The main-process instructions](../src/main/AGENTS.md) contain the active rules and file ownership
map. This document explains the decisions and the failures that led to them.

## IPC coverage and privileged imports

The main process runs with the user's full privileges. Agents already use `danger-full-access`;
Electron sandboxing, context isolation, navigation policy and sender validation protect the process
boundary that remains. A renderer feature must be assessed as a capability available to a
compromised renderer.

IPC domain modules return typed handler groups. Missing endpoints produce `TS2741`; extra endpoint
names produce `TS2353`. Missing groups in `registerIpcGroups` also produce `TS2741`. This replaced a
source scan that found modules which the dispatcher did not call. Removing both a registrar import
and its spread now fails compilation.

The payload binding types make `(input: unknown) => Result` incompatible with the no-payload
`() => Result` form. This requires an explicit decoder. Decoding follows sender validation so an
untrusted frame cannot reach a parser.

`ipc-channel-coverage.test.ts` restricts the name `ipcMain` to `trusted-ipc.ts`, which holds the
sender check. An aliased import elsewhere could otherwise register a handler without a sender check.
The test restricts the trusted wrapper names to `ipc/define-ipc-group.ts`: the wrappers accept string
channels, so direct use could create an endpoint outside the declared groups. Direct `IPC_ENDPOINTS.group.name` references keep
renderer sends visible to the same coverage checks.

`index.ts` calls `app.setPath`, `app.enableSandbox` and
`protocol.registerSchemesAsPrivileged` at module scope. Tests that import it need an Electron mock.
Source coverage tests read the file instead.

## Construction and shutdown

Service construction, windows, saved bounds, shutdown, development remote setup, session
configuration, renderer event forwarding and IPC handlers moved out of `index.ts`. The file keeps
lifecycle and dispatch work.

`createApplicationServices` remains one function because control-flow narrowing makes construction
order explicit: a service assigned to a `const` can satisfy later non-null constructor parameters.
Splitting it into stages would pass a roughly 15-field object between stages and restore ordering
hazards. It only constructs. Adding event wiring would require more inputs than outputs and invert
the dependency direction. A self-contained block with a few inputs, such as `createMessagingServices`,
can move to a helper in the same file that the function awaits at the same position; the helper keeps
its teardown ordinals.

Shutdown is largely in construction order, rather than reverse order. The browser host closes
before its picture-in-picture window. Provider runtimes stop before the agent service that owns
them. Teardown ordinals state this order beside construction instead of repeating it elsewhere.

### Quit time limits

The quit has these limits, from the inside out:

| Limit | Value | What it does |
| --- | --- | --- |
| Step limit (`TeardownRegistry`) | 10 s | The drain stops waiting for one step. The step continues. |
| Budget (`TeardownRegistry`) | 15 s together | The steps that hold no data share it, such as the local host and the team WebRTC bridge. The time that the drain waits for them counts. |
| Steps outside the budget | 10 s each | The steps that write user data or own child processes: the browser, the provider runtimes, the servers on this computer, messaging, the routine flows, the workflows, automation and the agent service. The budget does not make their limit shorter. |
| Last step time (`lastStepByMs`) | 24 s after the drain starts | No step gets more time after it, and no step inside the budget after the budget. Each step that is left gets 100 ms, and all of them 1 s together. |
| Database step | A wait, then its own 10 s | It waits for an abandoned step outside the budget until the last step time, and for any other abandoned step 5 s at most. So an abandoned agent stop still records its interrupted turns. Then it closes and checkpoints the WAL. |
| `SHUTDOWN_DEADLINE_MS` in `index.ts` | 30 s | `app.exit(0)`, logged. A server on this computer that is still there is killed at the exit. Then the exit watchdog sends `SIGKILL` after 10 s more. |

The agent stop took more than 10 s on six quits of 30 Oct to 1 Nov 2026 (`It did not stop within
10000 ms.`), once with no turn running. `AgentService.stop` logs each of its phases that takes 1 s or
more, so the next slow quit names the phase. A local server gets `SIGKILL` 6 s after its stop starts, so its step must not be abandoned
before then.

**Worst case.** The database step starts 25 s after the drain starts at the latest: the last step time,
then 1 s for the steps that are left. The close has the 5 s that are left before the deadline, less
the lag of the main loop (1.8 s at most on 1 Nov 2026). The agent stop ends before the close when it
ends by the last step time: a stop of 13 s after one step that did not stop (10 s) ends at 23 s. A
longer one, or one after more steps that did not stop, can end after it, and the database then
closes first, as at the deadline before.

Before the budget, the step limits added up. One quit on 31 Oct 2026 waited 10 s for the local
host (`The Team WebRTC disconnect command timed out.`) and 10 s for the team WebRTC bridge, whose
stop sends its next command to the same bridge window. A third step that did not stop would have
taken the quit to the 30 s deadline before the database step. The registry logs each step that
takes 1 s or more (`Shutting down … took … ms.`), also a step that it abandoned, so the main log
names the step that holds a slow quit.

`before-quit` holds every quit until the teardown has ended (`shutdownFinished`). Before, a second
request while the teardown ran (Cmd+Q again, `SIGTERM`, the quit of an update) went through:
Electron closed the windows and ended the process before the database step.

Every quit that the app asks for itself goes through `quitApplication()`. A local server child on
macOS uses this to find a quit that macOS delivered to it: see
[servers on this computer](architecture/servers.md). On 31 Oct and 1 Nov 2026 the install script's
`tell application "Builders Bot" to quit` reached the child, not the app. The child quit and was
started again 5 s later, and the app quit only at the script's `SIGTERM`, 62 s and 76 s later.

Dependencies wired before `app.whenReady()` need getters because the services do not yet exist.
Capturing `null` there never recovers. The renderer forwarders and window module now read one
service handle each instead of eleven separate handles. Code wired during construction can receive
values directly. Both a getter and a nullable value can type-check, so the compiler cannot select
the correct lifetime.

A similar lifetime issue applies to windows: a constructor needs the current window, but a callback
that runs later must obtain it again. macOS can close and rebuild the main window without ending
the application.

## MCP sign-in redirect address

An MCP server that asks its users to sign in sends the grant back to a redirect address. OpenBot
registers that address with the authorization server (RFC 7591) and sends it again at `/authorize`
and at `/token`. The three must agree, or the authorization server stops the sign-in on its own
page, where OpenBot can see nothing and can explain nothing. Canva does this: it accepts
`openbot://mcp-auth` at registration and then answers `Invalid redirect URI.` at `/authorize`.

So `src/main/mcp-oauth-redirect-server.ts` listens on `127.0.0.1` and the address it listens on is
the redirect address. This is the loopback redirect of RFC 8252, and it is the form every signed-in
listing in the catalog accepts. `openbot://mcp-auth` stays as the fallback for a machine where no
port can be bound, and `src/main/deep-link-router.ts` keeps that kind of link.

There is no configuration for a developer or for a packaged build:

- The port is the one the operating system gives, and it changes on each start. An authorization
  server must ignore the port of a loopback redirect, and the registration is dynamic, so no port
  is registered anywhere by hand.
- A stored registration that names a different address is replaced, but only for the attempt that
  needs the browser. `clientInformation()` in `src/backend/mcp-oauth-provider.ts` answers
  `undefined` when the stored `redirect_uris` do not hold this run's address, which makes the SDK
  register again. A record that still has a refresh token keeps its client for one pass first: a
  refresh uses no redirect address, and a refresh token spent against a new `client_id` is refused
  and costs the user a sign-in. Two attempts never replace the registration: a silent refresh, and
  the exchange of a grant already in hand, which must use the `client_id` that grant was issued
  to.
- `describeUnusableRedirectUrl` refuses an address that cannot receive a grant: an `https` address,
  or a plain-text address that is not on this machine.

## Remote services and released protocols

`remote-server-manager.ts` was 2,828 lines before its concerns moved to the flat `remote-server-*`
and `remote-*-decoding` family. The manager connects those modules through callbacks. The request
path does not need to know about the event stream, and the event stream does not need to know about
the error path. The callback connection preserves those dependency boundaries.

Team API routes use the same narrow dependency style as IPC handlers. Four behavior rules explain
the dispatch order:

- Compatibility runs first so an old client can read how to update instead of receiving 426 on
  every request.
- Remote-screen delegation precedes the protocol gate because a browser that loads the viewer
  sends no protocol header or token.
- Authentication precedes route selection so an unknown path without a token returns 401.
- The dispatcher handles unmatched paths and methods. Released clients receive 404 for a wrong
  method on a known path.

One dispatcher catch keeps unexpected errors visible to the logger and returns 500. A local catch
could incorrectly convert them to 400. There is one `HttpError` class because `instanceof` would
not recognize a second definition and would turn an intended 400 into 500.

The explicit `Promise<RouteOutcome>` return annotation produces `TS2366` when a route falls off the
end. This project has no `noImplicitReturns` guard. Without the annotation, inference can accept
`undefined`, which becomes a silent 404.

Host and preload decoders remain separate because they validate different trust boundaries. HTTPS
V1/V3 and WebRTC V2 remain separate because their encodings are released contracts. Control-plane
methods remain on `RemoteTeamDirectory` because they contact a different server from the host.

`ipc-channel-coverage.test.ts` checks a name bijection between `decode*FromHost` under `src/main`
and `decode*FromMain` in the preload. This prevents deleting one side and redirecting its callers
to the other, which could apply trusted-main validation to a remote server. A second test rejects a
decoder that is a bare alias of its twin. Review must still detect a wrapper that calls the other
decoder.
