/**
 * The person's Chrome for the agents, in the app (DESIGN §10.1): the `ChromeBridgeService` (socket,
 * peer check, pairing, sealed state) and the `ChromeTabsHost` that answers `openbot_chrome`.
 *
 * - Nothing starts while web access is not "chrome": no socket, no file, no addon load. The legacy
 *   Playwright path stays the default.
 * - The keys and the bridge state are sealed by `safeStorage` (the macOS Keychain). Without it the
 *   bridge does not start.
 * - "Connect Chrome" (the Settings switch turned on) is the only path that writes the Native Messaging
 *   manifest, and a build that is not packaged never writes into a real browser's folder unless the
 *   owner sets `OPENBOT_CHROME_BRIDGE_REAL_CHROME=1` (`native-host-manifests.ts`).
 * - The pairing card is a native dialog of the app: the words that Chrome must show, and three
 *   options, with the right one at a random place. Nothing is typed.
 * - An installed app takes its channel from its own signature (`packagedSigning`): the team's Developer
 *   ID is `store`; the owner's own certificate (`scripts/sign-local-macos.sh`) is `local`, with a host
 *   signed by the same certificate. An app with an ad-hoc signature has no host it can check, and the
 *   bridge stays off. A development run is `dev`.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChromeBridgeChannel, EXTENSION_IDS } from "@openbot/contracts/chrome-bridge/extension-ids";
import { Effect, ManagedRuntime } from "effect";
import {
  ChromeBridgeCallError,
  type ChromeBridgePort,
  type ChromeProject,
  ChromeTabsHost,
} from "../../backend/chrome-tabs-host";
import {
  chromeRequirement,
  designatedRequirement,
  hostRequirement,
  loadPeerChecker,
  packagedSigning,
} from "./bridge-peer";
import { type KeySealer, writePrivate } from "./bridge-state";
import { ChromeBridgeService, type ChromeBridgeShape } from "./chrome-bridge-service";
import type { PairingPrompt, PairingRequest } from "./host-connection";

export interface ChromeAgentsOptions {
  readonly userData: string;
  readonly home: string;
  /** `app.getAppPath()`: the build folders of a development run are under it. */
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly packaged: boolean;
  readonly appVersion: string;
  readonly allowRealBrowser: boolean;
  readonly inApplications: () => boolean;
  readonly sealer: KeySealer | null;
  readonly projectOf: (agentId: string, threadId: string) => ChromeProject | null;
  readonly agentName: (agentId: string) => string | null;
  readonly memoryLevel: () => "ok" | "low" | "critical";
  /** Shows the pairing dialog and gives the index of the tapped button. */
  readonly askPairing: (request: PairingRequest, signal: AbortSignal) => Promise<number | null>;
  readonly log: (level: "info" | "warn", line: string) => void;
}

export interface ChromeAgents {
  readonly host: ChromeTabsHost;
  /** Starts the bridge, if it does not run. Failures are logged; the tools then answer "not connected". */
  start(): Promise<void>;
  /** The person turned Chrome on: start, write the manifest and open the pairing window. */
  connect(): Promise<void>;
  /** `turnedOff`: the person turned "My Chrome" off, so the Native Messaging manifest goes too. */
  stop(options?: { readonly turnedOff?: boolean }): Promise<void>;
}

/**
 * The secret behind the opaque project keys and lease ids: the same after a restart, so tabs stay. It
 * is sealed by the key store, as the bridge state is. A file that does not open (edited, or sealed by
 * another Keychain) gets a new secret: the agents then get new leases, and the extension keeps the old
 * tabs until it closes them.
 */
async function projectSecret(folder: string, sealer: KeySealer): Promise<Uint8Array> {
  const path = join(folder, "project-secret.sealed");
  const sealed = await readFile(path).catch(() => null);
  if (sealed) {
    try {
      const opened = sealer.open(sealed);
      if (opened.length === 32) return opened;
    } catch {
      // A new secret below.
    }
  }
  const secret = randomBytes(32);
  await writePrivate(path, sealer.seal(secret));
  return secret;
}

/** The channel of this app and the certificate that pins its host, or null when the bridge cannot start. */
async function bridgeChannel(
  options: Pick<ChromeAgentsOptions, "packaged" | "resourcesPath">,
): Promise<{ readonly channel: ChromeBridgeChannel; readonly certificate?: string } | null> {
  if (!options.packaged) return { channel: "dev" };
  // `<bundle>/Contents/Resources`: the signature of the bundle is the signature of this app.
  return packagedSigning(await designatedRequirement(join(options.resourcesPath, "..", "..")));
}

export function createChromeAgents(options: ChromeAgentsOptions): ChromeAgents {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const stateFolder = join(options.userData, "chrome-bridge");
  const addon = options.packaged
    ? join(options.resourcesPath, "chrome-peer", "chrome-peer.node")
    : join(options.appPath, ".buildersbot-build", "chrome-peer", arch, "chrome-peer.node");
  const hostBinary = options.packaged
    ? join(options.resourcesPath, "chrome-host", "darwin", arch, "buildersbot-chrome-host")
    : join(options.appPath, ".buildersbot-build", "chrome-host", "dev", arch, "buildersbot-chrome-host");
  let runtime: ManagedRuntime.ManagedRuntime<ChromeBridgeService, unknown> | null = null;
  let bridge: ChromeBridgeShape | null = null;
  let starting: Promise<ChromeBridgeShape | null> | null = null;
  /** Each `stop` starts a new generation: a launch of an older one closes what it made. */
  let generation = 0;
  let secret: Uint8Array = randomBytes(32);

  const port: ChromeBridgePort = {
    connected: () => (bridge ? Effect.runSync(bridge.connected) : []),
    request: (installId, op, body, requestOptions) =>
      bridge
        ? bridge
            .request(installId, op, body, requestOptions)
            .pipe(
              Effect.mapError((failure) => new ChromeBridgeCallError({ code: failure.code, message: failure.message })),
            )
        : Effect.fail(new ChromeBridgeCallError({ code: "chrome_not_connected", message: "The bridge is off." })),
  };
  let host = new ChromeTabsHost({
    bridge: port,
    projectOf: options.projectOf,
    agentName: options.agentName,
    secret,
    memoryLevel: options.memoryLevel,
  });
  const prompt: PairingPrompt = { ask: (request, signal) => options.askPairing(request, signal) };

  const launch = async (): Promise<ChromeBridgeShape | null> => {
    const sealer = options.sealer;
    if (process.platform !== "darwin") return null;
    if (!sealer) {
      options.log("warn", "chrome bridge: no key store, so the bridge is off");
      return null;
    }
    if (!existsSync(addon)) {
      options.log("warn", "chrome bridge: the chrome-peer addon is missing, so the bridge is off");
      return null;
    }
    const launched = generation;
    const signing = await bridgeChannel(options);
    if (!signing) {
      options.log(
        "warn",
        "chrome bridge: this app has no signature that its Chrome host can check, so the bridge is off. Sign it with scripts/sign-local-macos.sh.",
      );
      return null;
    }
    const { channel } = signing;
    if (!existsSync(hostBinary)) {
      options.log("warn", "chrome bridge: the Chrome host is missing from this app, so the bridge is off");
      return null;
    }
    await mkdir(stateFolder, { recursive: true, mode: 0o700 });
    secret = await projectSecret(stateFolder, sealer);
    // The host's project keys come from the saved secret, so a restart keeps the same groups and leases.
    host = new ChromeTabsHost({
      bridge: port,
      projectOf: options.projectOf,
      agentName: options.agentName,
      secret,
      memoryLevel: options.memoryLevel,
    });
    const extensionId = EXTENSION_IDS[channel];
    const made = ManagedRuntime.make(
      ChromeBridgeService.layer({
        channel,
        stateFolder,
        sealer,
        peerChecker: loadPeerChecker(addon, hostRequirement(channel, signing.certificate), chromeRequirement(channel)),
        prompt,
        appVersion: options.appVersion,
        ...(extensionId
          ? {
              nativeHost: {
                folder: join(
                  options.home,
                  "Library",
                  "Application Support",
                  "Google",
                  "Chrome",
                  "NativeMessagingHosts",
                ),
                hostPath: hostBinary,
                extensionId,
                packaged: options.packaged,
                allowRealBrowser: options.allowRealBrowser,
                inApplications: options.inApplications,
              },
            }
          : {}),
        onEvent: (installId, event, body) => host.receiveEvent(installId, event, body),
        log: (line) => options.log("info", line),
      }),
    );
    const service = await made
      .runPromise(
        Effect.gen(function* () {
          return yield* ChromeBridgeService;
        }),
      )
      .catch(async (error: unknown) => {
        await made.dispose();
        throw error;
      });
    if (launched !== generation) {
      // Chrome mode was turned off while the bridge started.
      await made.dispose();
      return null;
    }
    runtime = made;
    bridge = service;
    return service;
  };

  const start = (): Promise<ChromeBridgeShape | null> => {
    if (bridge) return Promise.resolve(bridge);
    starting ??= launch()
      .catch((error: unknown) => {
        options.log("warn", `chrome bridge: did not start: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  };

  return {
    get host() {
      return host;
    },
    start: async () => {
      await start();
    },
    connect: async () => {
      const service = await start();
      if (!service || !runtime) return;
      await runtime.runPromise(service.connectChrome).then(
        () => options.log("info", "chrome bridge: the pairing window is open"),
        (error: unknown) =>
          options.log(
            "warn",
            `chrome bridge: could not connect Chrome: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
    },
    stop: async (stopOptions = {}) => {
      generation += 1;
      host.dispose();
      const current = runtime;
      const service = bridge;
      runtime = null;
      bridge = null;
      if (stopOptions.turnedOff && current && service)
        await current
          .runPromise(service.disconnectChrome)
          .catch((error: unknown) =>
            options.log(
              "warn",
              `chrome bridge: could not remove the manifest: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      await current?.dispose();
    },
  };
}
