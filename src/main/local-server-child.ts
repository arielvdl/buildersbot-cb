/**
 * A local server: a second Builders Bot server on this computer, which the desktop app starts as a
 * headless child process of itself (`local-servers/local-servers.ts`). It has its own user data
 * directory and its own agent root, so its database, agents, chats and files stay apart from the
 * app's own server. It shows no window and listens only on the loopback Team API.
 *
 * The parent passes the server name and the owner password in the environment. The password is
 * removed from the environment here, before any agent or provider process starts, so that no child
 * of this process can read it.
 */

import { isAbsolute } from "node:path";
import { Effect } from "effect";
import type { HostService } from "./host-service";
import { RemoteWorkflowError } from "./remote-service-effects";
import type { TeamStore } from "./team-store";

/** The username of the one member of a local server. The desktop app logs in as it. */
export const LOCAL_SERVER_OWNER_USERNAME = "owner";
/** The prefix of the one stdout line that tells the parent where the Team API listens. */
export const LOCAL_SERVER_READY_PREFIX = "OPENBOT_LOCAL_SERVER_READY ";
/**
 * The stdout line that asks the parent to quit Builders Bot. A local server runs from the bundle of
 * the app, so macOS knows it by the bundle identifier of the app: a quit Apple Event that names
 * Builders Bot, such as `tell application "Builders Bot" to quit`, can reach a local server and not the
 * app. The server then keeps running and passes the request on, and the app stops it as it quits.
 */
export const LOCAL_SERVER_QUIT_REQUEST = "OPENBOT_LOCAL_SERVER_QUIT_REQUEST";

export const LOCAL_SERVER_ENVIRONMENT = {
  child: "OPENBOT_LOCAL_SERVER_CHILD",
  agentRoot: "OPENBOT_LOCAL_SERVER_ROOT",
  name: "OPENBOT_LOCAL_SERVER_NAME",
  secret: "OPENBOT_LOCAL_SERVER_SECRET",
  runtimeRoot: "OPENBOT_LOCAL_SERVER_RUNTIMES",
} as const;

/**
 * Keeps a local server out of the apps that macOS lists. The child runs from the app bundle, so
 * LaunchServices registers it as one more "Builders Bot". `app.dock.hide()` made it a UI element: no
 * Dock tile, but the low-memory panel of macOS ("Your system has run out of application memory") still
 * listed it as a second Builders Bot, with the footprint of the whole app, because the child shares the
 * app's coalition. The `prohibited` policy registers it as a background-only process, as
 * `LSBackgroundOnly` does. Its hidden window and the agent browser views in it still load and paint.
 */
export function hideLocalServerFromMacOS(
  platform: NodeJS.Platform,
  setActivationPolicy: (policy: "prohibited") => void,
): void {
  if (platform === "darwin") setActivationPolicy("prohibited");
}

export interface LocalServerChildEnvironment {
  /** The folder that holds the agents of this server, in place of `~/Builders Bot`. */
  agentRoot: string;
  /** The name of the server when it is made. A rename later goes through the Team API. */
  serverName: string;
  ownerSecret: string;
  /** The provider CLI store of the desktop app. The servers of one computer share one copy of each CLI. */
  runtimeRoot: string | null;
}

export interface LocalServerReady {
  serverId: string;
  serverName: string;
  apiUrl: string;
  fingerprint: string;
  publicKey: string;
}

/**
 * Returns null unless the desktop app started this process as a local server. An explicit
 * `--user-data-dir` is required, so that a stray variable cannot make the normal app open its own
 * profile without a window.
 */
export function takeLocalServerChildEnvironment(
  environment: NodeJS.ProcessEnv,
  userDataDirectory: string,
): LocalServerChildEnvironment | null {
  const flag = environment[LOCAL_SERVER_ENVIRONMENT.child];
  const agentRoot = environment[LOCAL_SERVER_ENVIRONMENT.agentRoot]?.trim() ?? "";
  const serverName = environment[LOCAL_SERVER_ENVIRONMENT.name]?.trim() ?? "";
  const ownerSecret = environment[LOCAL_SERVER_ENVIRONMENT.secret] ?? "";
  const runtimeRoot = environment[LOCAL_SERVER_ENVIRONMENT.runtimeRoot]?.trim() ?? "";
  for (const name of Object.values(LOCAL_SERVER_ENVIRONMENT)) delete environment[name];
  if (flag !== "1" || !userDataDirectory || !isAbsolute(agentRoot) || !serverName || !ownerSecret) return null;
  return { agentRoot, serverName, ownerSecret, runtimeRoot: isAbsolute(runtimeRoot) ? runtimeRoot : null };
}

/** The ready line holds no secret: the parent knows the password, and the session is made later. */
export function formatLocalServerReady(ready: LocalServerReady): string {
  return `${LOCAL_SERVER_READY_PREFIX}${JSON.stringify(ready)}\n`;
}

export interface StartLocalServerChildOptions {
  environment: LocalServerChildEnvironment;
  teamStore: Pick<TeamStore, "configured" | "configure" | "getIdentity">;
  host: Pick<HostService, "startLoopbackOnly">;
  writeReady: (line: string) => void;
}

/**
 * Makes the owner at the first start, then starts the Team API on loopback only. The store keeps a
 * host with no account owner bound at the next start, so the identity keys stay the same.
 */
export const startLocalServerChild = Effect.fn("LocalServerChild.start")(function* ({
  environment,
  teamStore,
  host,
  writeReady,
}: StartLocalServerChildOptions) {
  if (!teamStore.configured)
    yield* teamStore.configure(environment.serverName, LOCAL_SERVER_OWNER_USERNAME, environment.ownerSecret);
  const status = yield* host.startLoopbackOnly();
  const identity = teamStore.getIdentity();
  // The parent waits for the ready line. An error ends this process now, so the parent does not wait
  // for its time limit.
  if (!identity || !status.apiUrl)
    return yield* new RemoteWorkflowError({ cause: new Error("The local server has no identity or API address.") });
  writeReady(
    formatLocalServerReady({
      serverId: identity.serverId,
      serverName: identity.serverName,
      apiUrl: status.apiUrl,
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey,
    }),
  );
});
