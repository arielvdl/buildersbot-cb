/**
 * The app's end of the Chrome bridge (DESIGN §6): a private Unix socket for the Chrome hosts, one
 * connection for each Chrome profile with the Builders Bot extension, the pairing rules, and the
 * requests to the extension.
 *
 * - The socket is in a folder of this user only (0700); the socket file is 0600. No TCP port.
 * - Each connection is held paused until the peer check: the process on the other side must meet the
 *   host requirement of this channel (`chrome-peer` addon, LOCAL_PEERTOKEN). A peer that fails is
 *   closed before one byte of it is read.
 * - At most `MAX_CONNECTIONS` profiles at once.
 * - Pairing (DESIGN §3.1, §3.2): an unknown extension key opens the pairing card only inside a pairing
 *   window that the person opened in the app (2 minutes, used once; a second candidate cancels it), or,
 *   outside one, as the "a Chrome on this computer wants to connect" card, at most 3 times an hour and
 *   never while another card is open. Otherwise the extension gets `reject{busy}` and the attempt is
 *   recorded. A key that the person just refused stays quiet for `REFUSED_KEY_QUIET_MS`. The card
 *   never accepts by itself: the person taps the words that Chrome shows, and Chrome must report that
 *   its person tapped the app's words (`pair.chrome-ok`). Only then the app pins the key.
 */

import { randomBytes } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { ChromeBridgeChannel } from "@openbot/contracts/chrome-bridge/extension-ids";
import {
  BRIDGE_LIMITS,
  CHROME_BRIDGE_FEATURES,
  type ChromeBridgeEvent,
  type ChromeBridgeOperation,
  type EventBodies,
  NATIVE_HOST_NAMES,
  type OperationBodies,
  type ResultBodies,
} from "@openbot/contracts/chrome-bridge/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import { type BridgeSocket, bridgeSocket, preparePrivateFolder } from "./bridge-paths";
import type { PeerChecker } from "./bridge-peer";
import { BridgeStateStore, type KeySealer, type PairedBrowser } from "./bridge-state";
import { BridgeRequestError, type ConnectionHost, HostConnection, type PairingPrompt } from "./host-connection";
import {
  checkNativeHostManifest,
  nativeHostManifest,
  watchNativeHostManifest,
  writeNativeHostManifest,
} from "./native-host-manifests";

export const MAX_CONNECTIONS = 8;
/** The "a Chrome wants to connect" card, outside a pairing window. */
export const UNEXPECTED_CARDS_PER_HOUR = 3;
/**
 * After the person says "Not now" or taps the wrong words, the same extension key gets `busy` for this
 * long, unless the person opens a pairing window. Without it, the host reconnects, the extension tries
 * again, and the card the person just closed comes back.
 */
export const REFUSED_KEY_QUIET_MS = 10 * 60 * 1000;

export class ChromeBridgeFailure extends Schema.TaggedError<ChromeBridgeFailure>()("ChromeBridgeFailure", {
  cause: Schema.Defect(),
}) {}

export class ChromeBridgeRequestFailure extends Schema.TaggedError<ChromeBridgeRequestFailure>()(
  "ChromeBridgeRequestFailure",
  { code: Schema.String, message: Schema.String },
) {}

export interface ChromeBridgeOptions {
  readonly channel: ChromeBridgeChannel;
  /** `userData/chrome-bridge` in the app: the sealed key and state. */
  readonly stateFolder: string;
  readonly sealer: KeySealer;
  readonly peerChecker: PeerChecker;
  readonly prompt: PairingPrompt;
  readonly appVersion: string;
  readonly socket?: BridgeSocket;
  readonly features?: readonly string[];
  readonly onEvent?: <E extends ChromeBridgeEvent>(installId: string, event: E, body: EventBodies[E]) => void;
  readonly onReady?: (browser: ConnectedBrowser) => void;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** Where and how the app writes the Native Messaging manifest; without it, `connectChrome` fails. */
  readonly nativeHost?: NativeHostInstall;
}

export interface NativeHostInstall {
  /** The user-level manifest folder: the person's Chrome in a packaged app, a test profile in E2E. */
  readonly folder: string;
  readonly hostPath: string;
  readonly extensionId: string;
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /** The owner's `OPENBOT_CHROME_BRIDGE_REAL_CHROME=1`. */
  readonly allowRealBrowser: boolean;
  /** `app.isInApplicationsFolder()`; a translocated copy must move first. */
  readonly inApplications: () => boolean;
}

export interface ConnectedBrowser {
  readonly installId: string;
  readonly browser: { readonly brand: string; readonly version: string };
  readonly profileLabel: string | null;
  readonly extVersion: string;
  readonly features: readonly string[];
  readonly hostPid: number;
}

export interface ChromeBridgeShape {
  readonly socketPath: string;
  readonly stateStart: BridgeStateStore["start"];
  /** The person clicked "Connect Chrome": the next unknown key shows the card at once, for 2 minutes. */
  readonly openPairingWindow: Effect.Effect<{ readonly expiresAt: number }>;
  readonly closePairingWindow: Effect.Effect<void>;
  /**
   * The person clicked "Connect Chrome": the only way the manifest is written. It checks where the app
   * runs, writes the manifest, opens the pairing window, and watches the manifest while the window is
   * open; a change cancels the window.
   */
  readonly connectChrome: Effect.Effect<{ readonly expiresAt: number; readonly manifest: string }, ChromeBridgeFailure>;
  readonly connected: Effect.Effect<readonly ConnectedBrowser[]>;
  readonly paired: Effect.Effect<readonly PairedBrowser[]>;
  readonly request: <O extends ChromeBridgeOperation>(
    installId: string,
    op: O,
    body: OperationBodies[O],
    options?: { readonly key?: string; readonly timeoutMs?: number },
  ) => Effect.Effect<ResultBodies[O], ChromeBridgeRequestFailure>;
  /** Settings › Connected browsers › Disconnect. */
  readonly revoke: (installId: string) => Effect.Effect<void, ChromeBridgeFailure>;
  /** Settings › Reconnect: the pin is forgotten, and the next connection pairs again with the words. */
  readonly forget: (installId: string) => Effect.Effect<void, ChromeBridgeFailure>;
  /** For diagnostics and tests: requests in flight and waiting, by install. */
  readonly load: Effect.Effect<readonly { installId: string | null; inFlight: number; waiting: number }[]>;
}

export class ChromeBridgeService extends Context.Service<ChromeBridgeService, ChromeBridgeShape>()(
  "openbot/main/ChromeBridgeService",
) {
  static layer(options: ChromeBridgeOptions) {
    return Layer.effect(ChromeBridgeService, makeChromeBridge(options));
  }
}

const bridgeIO = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ChromeBridgeFailure({ cause }) });

/** Removes a stale socket file of this user. Anything else at the path stops the start. */
async function clearStaleSocket(path: string) {
  const stats = await lstat(path).catch(() => null);
  if (!stats) return;
  if (!stats.isSocket()) throw new Error("Something other than a socket is at the Chrome bridge path.");
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error("The Chrome bridge socket belongs to another user.");
  await rm(path);
}

export const makeChromeBridge = Effect.fn("ChromeBridge.make")(function* (options: ChromeBridgeOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const socket = options.socket ?? bridgeSocket(options.channel);
  const state = yield* bridgeIO(() => BridgeStateStore.open(options.stateFolder, options.sealer));
  const appInstanceId = randomBytes(16).toString("base64url");
  const connections = new Set<HostConnection>();
  const ready = new Map<string, HostConnection>();
  let pairingWindow: { expiresAt: number; claimedBy: HostConnection | null } | null = null;
  let cardOpen: HostConnection | null = null;
  const cardsShown: number[] = [];
  const quietKeys = new Map<string, number>();

  const windowOpen = () => pairingWindow !== null && pairingWindow.expiresAt > now();

  const host: ConnectionHost = {
    appKey: state.appKey,
    appVersion: options.appVersion,
    appInstanceId,
    features: options.features ?? CHROME_BRIDGE_FEATURES,
    prompt: options.prompt,
    pairingHint: () => (windowOpen() ? "new" : "known"),
    keyStatus: (installId, publicKey) => {
      const status = state.keyStatus(installId, publicKey);
      // Inside a window that the person opened, a revoked install pairs again with the words.
      return status === "revoked" && windowOpen() ? "unknown" : status;
    },
    admitPairing: (connection) => {
      const key = connection.hello?.sPub;
      const quietUntil = key ? (quietKeys.get(key) ?? 0) : 0;
      if (windowOpen() && pairingWindow) {
        if (pairingWindow.claimedBy === null) {
          pairingWindow.claimedBy = connection;
          cardOpen = connection;
          return "window";
        }
        // A second candidate in one window: someone else is trying too. Cancel both.
        pairingWindow.claimedBy.close("a second candidate cancelled the pairing window");
        pairingWindow = null;
        return null;
      }
      if (quietUntil > now()) return null;
      const hourAgo = now() - 60 * 60 * 1000;
      while (cardsShown.length > 0 && (cardsShown[0] ?? 0) < hourAgo) cardsShown.shift();
      if (cardOpen !== null || cardsShown.length >= UNEXPECTED_CARDS_PER_HOUR) return null;
      cardsShown.push(now());
      cardOpen = connection;
      return "unexpected";
    },
    pinned: async (connection, hello) => {
      await state.pin(
        {
          installId: hello.installId,
          extensionKey: hello.sPub,
          browser: hello.browser,
          profileLabel: hello.consent ? (hello.profileLabel ?? null) : null,
          extVersion: hello.extVersion,
        },
        now(),
      );
      if (pairingWindow?.claimedBy === connection) pairingWindow = null;
      if (cardOpen === connection) cardOpen = null;
      log("chrome bridge: a Chrome profile paired");
    },
    unpinned: (_connection, hello) => state.forget(hello.installId),
    refused: (connection) => {
      const key = connection.hello?.sPub;
      if (key) quietKeys.set(key, now() + REFUSED_KEY_QUIET_MS);
      for (const [quiet, until] of quietKeys) if (until <= now()) quietKeys.delete(quiet);
      if (cardOpen === connection) cardOpen = null;
      if (pairingWindow?.claimedBy === connection) pairingWindow = null;
      void state.recordRefusal(now()).catch(() => log("chrome bridge: could not record a refusal"));
    },
    ready: (connection) => {
      const installId = connection.installId;
      const hello = connection.hello;
      if (!installId || !hello) return;
      ready.get(installId)?.close("the same profile connected again");
      ready.set(installId, connection);
      void state.touch(installId, now()).catch(() => undefined);
      options.onReady?.(describe(connection));
    },
    event: (connection, event, body) => {
      const installId = connection.installId;
      if (installId) options.onEvent?.(installId, event, body);
    },
    closed: (connection) => {
      connections.delete(connection);
      const installId = connection.installId;
      if (installId && ready.get(installId) === connection) ready.delete(installId);
      if (cardOpen === connection) cardOpen = null;
    },
  };

  const describe = (connection: HostConnection): ConnectedBrowser => ({
    installId: connection.installId ?? "",
    browser: connection.hello?.browser ?? { brand: "other", version: "0" },
    profileLabel: connection.hello?.consent ? (connection.hello.profileLabel ?? null) : null,
    extVersion: connection.hello?.extVersion ?? "0.0.0",
    features: connection.features,
    hostPid: connection.peerPid,
  });

  const accept = (peer: Socket) => {
    if (connections.size >= MAX_CONNECTIONS) {
      peer.destroy();
      log("chrome bridge: too many Chrome connections");
      return;
    }
    let identity: ReturnType<PeerChecker["check"]>;
    try {
      identity = options.peerChecker.check(peer);
    } catch {
      peer.destroy();
      log("chrome bridge: a peer without a readable identity was refused");
      return;
    }
    const uid = process.getuid?.();
    if (identity.valid === false || (uid !== undefined && identity.uid !== uid)) {
      peer.destroy();
      log(`chrome bridge: refused a process that is not the Chrome host (pid ${identity.pid})`);
      return;
    }
    connections.add(new HostConnection(peer, host, { peerPid: identity.pid, log }));
  };

  yield* bridgeIO(() => preparePrivateFolder(socket.folder));
  yield* bridgeIO(() => clearStaleSocket(socket.path));
  const server = yield* Effect.acquireRelease(
    bridgeIO(
      () =>
        new Promise<Server>((resolve, reject) => {
          // Paused until the peer check: nothing from an unchecked process is read.
          const created = createServer({ pauseOnConnect: true }, accept);
          created.once("error", reject);
          created.listen(socket.path, () => {
            created.off("error", reject);
            resolve(created);
          });
        }),
    ),
    (created) =>
      Effect.promise(async () => {
        for (const connection of connections) connection.close("the app is closing");
        await new Promise<void>((resolve) => created.close(() => resolve()));
        await rm(socket.path, { force: true });
      }),
  );
  yield* bridgeIO(() => chmod(socket.path, 0o600));
  server.on("error", () => log("chrome bridge: the socket server failed"));
  log("chrome bridge: listening");

  const nativeHost = options.nativeHost;
  const manifest = nativeHost
    ? nativeHostManifest({
        name: NATIVE_HOST_NAMES[options.channel],
        hostPath: nativeHost.hostPath,
        extensionId: nativeHost.extensionId,
      })
    : null;
  // A manifest that someone changed is written back at each start; a missing one stays missing, because
  // only the person's click writes it (DESIGN §3.4).
  if (
    nativeHost &&
    manifest &&
    (yield* bridgeIO(() => checkNativeHostManifest(nativeHost.folder, manifest))) === "changed"
  ) {
    yield* bridgeIO(() =>
      writeNativeHostManifest({
        folder: nativeHost.folder,
        manifest,
        packaged: nativeHost.packaged,
        allowRealBrowser: nativeHost.allowRealBrowser,
      }),
    );
    log("chrome bridge: the Native Messaging manifest was changed and is repaired");
  }
  let stopWatch: (() => void) | null = null;
  const openWindow = () => {
    pairingWindow = { expiresAt: now() + BRIDGE_LIMITS.pairingWindowMs, claimedBy: null };
    // Profiles that were told `busy` wait idle; closing them makes their host reconnect, and the
    // extension tries again inside the window.
    for (const connection of connections) if (connection.rejected) connection.close("a pairing window opened");
    return pairingWindow.expiresAt;
  };
  const closeWindow = () => {
    stopWatch?.();
    stopWatch = null;
    pairingWindow?.claimedBy?.close("the pairing window closed");
    pairingWindow = null;
  };

  const shape: ChromeBridgeShape = {
    socketPath: socket.path,
    stateStart: state.start,
    openPairingWindow: Effect.sync(() => ({ expiresAt: openWindow() })),
    closePairingWindow: Effect.sync(closeWindow),
    connectChrome: bridgeIO(async () => {
      if (!nativeHost || !manifest) throw new Error("This build has no Native Messaging host to install.");
      if (nativeHost.packaged && !nativeHost.inApplications())
        throw new Error("Move Builders Bot to Applications before you connect Chrome.");
      const written = await writeNativeHostManifest({
        folder: nativeHost.folder,
        manifest,
        packaged: nativeHost.packaged,
        allowRealBrowser: nativeHost.allowRealBrowser,
      });
      const expiresAt = openWindow();
      stopWatch?.();
      const unwatch = watchNativeHostManifest(nativeHost.folder, manifest.name, () => {
        void checkNativeHostManifest(nativeHost.folder, manifest).then((status) => {
          if (status === "ok" || pairingWindow?.expiresAt !== expiresAt) return;
          log("chrome bridge: the manifest changed during pairing; the window is cancelled");
          closeWindow();
        });
      });
      const timer = setTimeout(unwatch, BRIDGE_LIMITS.pairingWindowMs);
      stopWatch = () => {
        clearTimeout(timer);
        unwatch();
      };
      return { expiresAt, manifest: written };
    }),
    connected: Effect.sync(() => [...ready.values()].map(describe)),
    paired: Effect.sync(() => state.data.browsers),
    request: (installId, op, body, requestOptions) =>
      Effect.tryPromise({
        try: () => {
          const connection = ready.get(installId);
          if (!connection) throw new BridgeRequestError("chrome_not_connected", "This Chrome is not connected.");
          return connection.request(op, body, requestOptions);
        },
        catch: (cause) =>
          cause instanceof BridgeRequestError
            ? new ChromeBridgeRequestFailure({ code: cause.code, message: cause.message })
            : new ChromeBridgeRequestFailure({ code: "chrome_not_connected", message: "The Chrome request failed." }),
      }),
    revoke: (installId) =>
      bridgeIO(async () => {
        await state.revoke(installId);
        ready.get(installId)?.close("revoked in the app");
      }),
    forget: (installId) =>
      bridgeIO(async () => {
        await state.forget(installId);
        ready.get(installId)?.close("forgotten in the app");
      }),
    load: Effect.sync(() =>
      [...connections].map((connection) => ({ installId: connection.installId, ...connection.load })),
    ),
  };
  return ChromeBridgeService.of(shape);
});
