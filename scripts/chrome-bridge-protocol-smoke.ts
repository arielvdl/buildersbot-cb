/**
 * The protocol smoke of the Chrome bridge (DESIGN §13.2): the closed protocol of
 * `packages/contracts/src/chrome-bridge`, end to end.
 *
 *   bun scripts/chrome-bridge-protocol-smoke.ts [--skip-chrome] [--headed]
 *
 * A. The channel in one process: canonical JSON, the handshake of both roles, the comparison words
 *    (checked against an independent BigInt reading), the wire layout of a sealed frame (decrypted with
 *    node:crypto from the documented nonce and AAD), parts from 0.9 MB to 16 MB (also payloads of only
 *    `"` and only `\u0001`), counters, replays, a tampered tag, a swapped nonce in the middle, a hello
 *    changed after its commit, the deadline, the host's own frames out of time, the sealed state with a
 *    bad tag, and the manifest rules.
 * B. The real E2E host binary between this process (the app: `ChromeBridgeService` with the
 *    `chrome-peer` addon) and a stand-in Chrome on the host's stdin and stdout: pairing with the two
 *    choices, a wrong choice, the card limit outside a window (`busy`), revocation, 9 MB and 1.5 MB
 *    messages, 600 requests at once (in-flight caps and order by tab), features that one side did not
 *    announce, the app restarting (reconnection time), and a process that is not the host on the app's
 *    socket.
 * C. Chrome for Testing (pinned, isolated temporary profile) with the stub extension
 *    (`scripts/chrome-bridge-stub-extension`), the Native Messaging manifest written only inside that
 *    profile, a real click on the welcome page and a choice in the app, then messages, load and a restart.
 *    Skipped with a reason when the swap is above 6 GB or the disk is below 3 GB.
 *
 * Report: `.buildersbot-build/chrome-extension/protocol-smoke.json`. Never the person's Chrome, its
 * profile or its folders; the host socket is in the per-user temporary folder (`bb-e2e`).
 */

import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import type { BrowserContext, Page } from "playwright-core";
import {
  AppHandshake,
  ChannelError,
  canonicalJson,
  ExtensionHandshake,
  fromBase64Url,
  generateChannelKey,
  HostFrameGate,
  type PairingCode,
  pairingCodes,
  randomBase64Url,
  SealedChannel,
  toBase64Url,
} from "../packages/contracts/src/chrome-bridge/channel";
import { EXTENSION_IDS, EXTENSION_PUBLIC_KEYS } from "../packages/contracts/src/chrome-bridge/extension-ids";
import { PAIRING_WORDS } from "../packages/contracts/src/chrome-bridge/pairing-words";
import {
  BRIDGE_LIMITS,
  CHROME_BRIDGE_FEATURES,
  type HandshakeMessage,
  NATIVE_HOST_NAMES,
} from "../packages/contracts/src/chrome-bridge/protocol";
import { bridgeSocket } from "../src/main/chrome-bridge/bridge-paths";
import { loadPeerChecker } from "../src/main/chrome-bridge/bridge-peer";
import { BridgeStateStore, type KeySealer } from "../src/main/chrome-bridge/bridge-state";
import {
  type ChromeBridgeOptions,
  ChromeBridgeService,
  type ChromeBridgeShape,
} from "../src/main/chrome-bridge/chrome-bridge-service";
import type { PairingPrompt, PairingRequest } from "../src/main/chrome-bridge/host-connection";
import {
  checkNativeHostManifest,
  nativeHostManifest,
  removeNativeHostManifest,
  writeNativeHostManifest,
} from "../src/main/chrome-bridge/native-host-manifests";
import { buildChromeHost, codeHash } from "./build-chrome-host";
import { buildChromePeer } from "./build-chrome-peer";
import { type ExtensionFrame, StubExtension } from "./chrome-bridge-stub-extension/stub-core";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".buildersbot-build/chrome-extension");
const REPORT = join(OUT, "protocol-smoke.json");
const skipChrome = process.argv.includes("--skip-chrome");
const onlyChrome = process.argv.includes("--only-chrome");
const headed = process.argv.includes("--headed");

/** Chrome for Testing, pinned by version and archive hash (the same folder and pin as `chrome-extension-e2e.ts`). */
const CFT_PIN: { version: string; sha256: Partial<Record<"mac-arm64" | "mac-x64", string>> } = {
  version: "156.0.8078.80",
  sha256: { "mac-arm64": "8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1" },
};

const results: { section: string; name: string; ok: boolean; detail?: unknown }[] = [];
/** A measured value for the report. */
type Measure = string | number | boolean | null | undefined | readonly Measure[] | { readonly [key: string]: Measure };
const measures: { [key: string]: Measure } = {};
let section = "A";
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ section, name, ok, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"} [${section}] ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`,
  );
};
const throwsCode = async (run: () => Promise<unknown>, code: ChannelError["code"]) => {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof ChannelError && error.code === code;
  }
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(test: () => boolean, ms: number, what: string): Promise<void> {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A stand-in for `safeStorage`: AES-256-GCM with a key that lives only in this process. */
function testSealer(): KeySealer {
  const key = randomBytes(32);
  return {
    seal: (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, body, cipher.getAuthTag()]);
    },
    open: (sealed) => {
      const data = Buffer.from(sealed);
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]);
    },
  };
}

const browser = { brand: "chrome-for-testing", version: "146.0.0.0" } as const;

/** Runs the handshake of both roles in memory; `tamper` may change a message on its way. */
async function pairInMemory(tamper?: {
  welcome?: (value: HandshakeMessage<"welcome">) => HandshakeMessage<"welcome">;
}) {
  const extKey = await generateChannelKey(false);
  const appKey = await generateChannelKey(false);
  const { handshake, commit } = await ExtensionHandshake.start({
    staticKey: extKey,
    extVersion: "1.0.0",
    installId: randomBase64Url(16),
    features: CHROME_BRIDGE_FEATURES,
    browser,
  });
  const app = await AppHandshake.create({
    staticKey: appKey,
    appVersion: "0.56.0",
    appInstanceId: randomBase64Url(16),
    features: CHROME_BRIDGE_FEATURES,
    pairing: "new",
  });
  const sent = structuredClone(app.onCommit(structuredClone(commit)));
  const welcome = tamper?.welcome ? tamper.welcome(sent) : sent;
  const answer = await handshake.onWelcome(welcome);
  if ("rejected" in answer) throw new Error("rejected");
  const [hello, extConfirm] = answer.frames;
  const appAnswer = await app.onHello(structuredClone(hello), () => "unknown");
  if ("reject" in appAnswer) throw new Error("app rejected");
  const extEnd = await handshake.onConfirm(structuredClone(appAnswer.confirm));
  const appEnd = await app.onConfirm(structuredClone(extConfirm));
  if ("rejected" in extEnd) throw new Error("ext rejected");
  return { ext: extEnd, app: appEnd, extKey, appKey };
}

// -------------------------------------------------------------------------------------------------
// A. The channel in one process

async function sectionA() {
  section = "A";
  check(
    "canonical JSON sorts keys at every depth",
    canonicalJson({ b: [{ z: 1, a: "x" }], a: 2 }) === '{"a":2,"b":[{"a":"x","z":1}]}',
  );
  check(
    "canonical JSON is the same for both key orders",
    canonicalJson({ k: "commit", digest: "d" }) === canonicalJson({ digest: "d", k: "commit" }),
  );
  const sample = randomBytes(1000);
  check(
    "base64url matches Node's",
    toBase64Url(sample) === sample.toString("base64url") &&
      Buffer.from(fromBase64Url(sample.toString("base64url"))).equals(sample),
  );
  check(
    "base64url refuses stray bits and other characters",
    (await throwsCode(async () => fromBase64Url("AB"), "decode")) &&
      (await throwsCode(async () => fromBase64Url("A+=="), "decode")),
  );

  const { ext, app } = await pairInMemory();
  check("both roles derive the same words", JSON.stringify(ext.codes) === JSON.stringify(app.codes), ext.codes);
  check(
    "the two codes are distinct words from the list",
    ext.codes.chrome.every((word) => PAIRING_WORDS.includes(word)) && ext.codes.chrome.join() !== ext.codes.app.join(),
  );

  // The word bits, read again with BigInt from SHA-256(transcript ‖ "sas"), on a fixed transcript.
  const transcript = new TextEncoder().encode("fixed transcript");
  const codes = await pairingCodes(transcript);
  const digest = createHash("sha256")
    .update(Buffer.concat([Buffer.from(transcript), Buffer.from("sas")]))
    .digest();
  const bits = BigInt(`0x${digest.toString("hex")}`);
  const wordAt = (start: number) => PAIRING_WORDS[Number((bits >> BigInt(256 - start - 11)) & 2047n)];
  check(
    "the words are bits 0-32 (Chrome) and 33-65 (app) of SHA-256(transcript ‖ sas)",
    JSON.stringify(codes) ===
      JSON.stringify({ chrome: [wordAt(0), wordAt(11), wordAt(22)], app: [wordAt(33), wordAt(44), wordAt(55)] }),
  );

  // The wire layout, decrypted with node:crypto from a known key.
  const raw = randomBytes(32);
  const sendKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const sender = new SealedChannel("app", sendKey, sendKey);
  await sender.seal({ skip: 1 });
  const [frame] = await sender.seal({ t: "evt", hello: "é" });
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(1n);
  const sealedBytes = Buffer.from(frame?.d ?? "", "base64url");
  const decipher = createDecipheriv("aes-256-gcm", raw, Buffer.concat([Buffer.from([2]), counter, Buffer.alloc(3)]));
  decipher.setAAD(Buffer.concat([Buffer.from("bb-chrome-v1"), counter]));
  decipher.setAuthTag(sealedBytes.subarray(sealedBytes.length - 16));
  const plain = Buffer.concat([
    decipher.update(sealedBytes.subarray(0, sealedBytes.length - 16)),
    decipher.final(),
  ]).toString("utf8");
  check(
    "a sealed frame is AES-256-GCM with nonce = direction ‖ counter ‖ 0 and AAD = label ‖ counter",
    plain === '{"t":"evt","hello":"é"}' && frame?.c === 1,
  );

  // Parts: sizes and payloads that JSON makes larger.
  const sizes: { [name: string]: Measure } = {};
  const cases: [string, unknown][] = [
    ["0.9 MB", { d: "x".repeat(900_000) }],
    ["1 MB of quotes", { d: '"'.repeat(500_000) }],
    ["control characters", { d: "\u0001".repeat(170_000) }],
    ["4 MB", { d: "y".repeat(4_000_000) }],
    ["16 MiB less a little", { d: "z".repeat(BRIDGE_LIMITS.maxMessageBytes - 64) }],
  ];
  for (const [name, message] of cases) {
    const started = performance.now();
    const frames = await ext.channel.seal(message);
    const largest = Math.max(...frames.map((part) => JSON.stringify(part).length));
    let opened: { message: unknown } | null = null;
    for (const part of frames) opened = await app.channel.open(JSON.parse(JSON.stringify(part)));
    sizes[name] = { frames: frames.length, largestFrameBytes: largest, ms: Math.round(performance.now() - started) };
    check(
      `${name}: every frame below 1 MB and the message comes back whole`,
      largest < BRIDGE_LIMITS.maxFrameToChromeBytes && JSON.stringify(opened?.message) === JSON.stringify(message),
      sizes[name],
    );
  }
  measures.parts = sizes;
  check(
    "a message above 16 MiB is refused before it is sent",
    await throwsCode(() => ext.channel.seal({ d: "\u0001".repeat(3_000_000) }), "size"),
  );

  // Order, replay, tag.
  const [a] = await ext.channel.seal({ n: 1 });
  await app.channel.open(a);
  check("a replayed frame breaks the channel", await throwsCode(() => app.channel.open(a), "order"));
  const fresh = await pairInMemory();
  await fresh.ext.channel.seal({ n: 1 });
  const [f2] = await fresh.ext.channel.seal({ n: 2 });
  check("a skipped counter breaks the channel", await throwsCode(() => fresh.app.channel.open(f2), "order"));
  const tamperedPair = await pairInMemory();
  const [t1] = await tamperedPair.ext.channel.seal({ n: 1 });
  const flipped = Buffer.from(t1?.d ?? "", "base64url");
  flipped[3] = (flipped[3] ?? 0) ^ 1;
  check(
    "a changed byte fails the tag",
    await throwsCode(() => tamperedPair.app.channel.open({ ...t1, d: flipped.toString("base64url") }), "tag"),
  );
  const split = await pairInMemory();
  const parts = await split.ext.channel.seal({ d: "w".repeat(1_200_000) });
  check("a part out of order breaks the channel", await throwsCode(() => split.app.channel.open(parts[1]), "order"));

  // The person in the middle. It passes the extension's commit to the app, sees the app's welcome, and
  // then sends a hello of its own (its own keys and nonce, chosen after the welcome) under that commit.
  let commitmentBroken = false;
  {
    const extKey = await generateChannelKey(false);
    const { commit } = await ExtensionHandshake.start({
      staticKey: extKey,
      extVersion: "1.0.0",
      installId: randomBase64Url(16),
      features: ["core"],
      browser,
    });
    const appSide = await AppHandshake.create({
      staticKey: await generateChannelKey(false),
      appVersion: "0.56.0",
      appInstanceId: randomBase64Url(16),
      features: ["core"],
      pairing: "new",
    });
    const welcome = appSide.onCommit(structuredClone(commit));
    const { handshake: middle } = await ExtensionHandshake.start({
      staticKey: await generateChannelKey(false),
      extVersion: "1.0.0",
      installId: randomBase64Url(16),
      features: ["core"],
      browser,
    });
    const chosen = await middle.onWelcome(structuredClone(welcome));
    if (!("rejected" in chosen))
      commitmentBroken = await throwsCode(() => appSide.onHello(chosen.frames[0], () => "unknown"), "commitment");
  }
  check("a hello chosen after the welcome does not match its commit, so the words cannot be ground", commitmentBroken);
  let swapped = false;
  try {
    await pairInMemory({ welcome: (value) => ({ ...value, nonce: randomBase64Url(32) }) });
  } catch (error) {
    swapped = error instanceof ChannelError && error.code === "confirm";
  }
  check("a welcome nonce swapped in the middle fails the key confirmation before any word shows", swapped);

  // Deadline.
  const late = await (async () => {
    const extKey = await generateChannelKey(false);
    const { handshake, commit } = await ExtensionHandshake.start({
      staticKey: extKey,
      extVersion: "1.0.0",
      installId: randomBase64Url(16),
      features: ["core"],
      browser,
      now: 0,
    });
    const appSide = await AppHandshake.create({
      staticKey: await generateChannelKey(false),
      appVersion: "0.56.0",
      appInstanceId: randomBase64Url(16),
      features: ["core"],
      pairing: "known",
    });
    const answer = await handshake.onWelcome(appSide.onCommit(commit, 0));
    if ("rejected" in answer) return false;
    const confirm = await appSide.onHello(answer.frames[0], () => "known");
    if ("reject" in confirm) return false;
    return throwsCode(() => appSide.onConfirm(answer.frames[1], BRIDGE_LIMITS.handshakeTimeoutMs + 1), "timeout");
  })();
  check("a handshake past 5 s fails", late);

  // Versions.
  const oldExt = await (async () => {
    const { commit, handshake } = await ExtensionHandshake.start({
      staticKey: await generateChannelKey(false),
      extVersion: "0.9.0",
      installId: randomBase64Url(16),
      features: ["core"],
      browser,
    });
    const appSide = await AppHandshake.create({
      staticKey: await generateChannelKey(false),
      appVersion: "0.56.0",
      appInstanceId: randomBase64Url(16),
      features: ["core"],
      pairing: "known",
    });
    const answer = await handshake.onWelcome(appSide.onCommit(commit));
    if ("rejected" in answer) return null;
    const reply = await appSide.onHello(answer.frames[0], () => "known");
    return "reject" in reply ? reply.reject.code : null;
  })();
  check("an extension below MIN_EXTENSION_VERSION gets reject{update_extension}", oldExt === "update_extension");
  const { ext: e2, app: a2 } = await (async () => {
    const extKey = await generateChannelKey(false);
    const { handshake, commit } = await ExtensionHandshake.start({
      staticKey: extKey,
      extVersion: "1.0.0",
      installId: randomBase64Url(16),
      features: ["core", "cdp-batch", "future-thing"],
      browser,
    });
    const appSide = await AppHandshake.create({
      staticKey: await generateChannelKey(false),
      appVersion: "0.56.0",
      appInstanceId: randomBase64Url(16),
      features: ["core", "tab-zoom"],
      pairing: "known",
    });
    const answer = await handshake.onWelcome(appSide.onCommit(commit));
    if ("rejected" in answer) throw new Error("rejected");
    const reply = await appSide.onHello(answer.frames[0], () => "known");
    if ("reject" in reply) throw new Error("rejected");
    const extEnd = await handshake.onConfirm(reply.confirm);
    if ("rejected" in extEnd) throw new Error("rejected");
    return { ext: extEnd, app: await appSide.onConfirm(answer.frames[1]) };
  })();
  check(
    "each side keeps only the features both announced; an unknown feature name is ignored",
    e2.features.join() === "core" && a2.features.join() === "core",
  );

  // Host frames out of time.
  const gate = new HostFrameGate();
  check(
    "a host status before its hello breaks",
    await throwsCode(async () => gate.accept({ h: "status", app: "online" }), "protocol"),
  );
  const gate2 = new HostFrameGate();
  gate2.accept({ h: "hello", hostVersion: "0.56.0", pid: 10, parent: "other" });
  const startNow = gate2.accept({ h: "status", app: "online" });
  gate2.sessionStarted();
  check(
    "a host hello twice, or a status online during a session, breaks; offline ends the session",
    startNow === "start-handshake" &&
      (await throwsCode(async () => gate2.accept({ h: "status", app: "online" }), "protocol")) &&
      gate2.accept({ h: "status", app: "offline" }) === "app-offline" &&
      (await throwsCode(
        async () => gate2.accept({ h: "hello", hostVersion: "0.56.0", pid: 10, parent: "other" }),
        "protocol",
      )),
  );
  check(
    "a host frame with a field the list does not name breaks",
    await throwsCode(
      async () =>
        new HostFrameGate().accept({ h: "hello", hostVersion: "0.56.0", pid: 10, parent: "other", token: "x" }),
      "protocol",
    ),
  );

  // Sealed state.
  const folder = mkdtempSync(join(tmpdir(), "bb-bridge-state-"));
  try {
    const sealer = testSealer();
    const first = await BridgeStateStore.open(folder, sealer);
    await first.pin({
      installId: "AAAAAAAAAAAAAAAAAAAAAA",
      extensionKey: "K",
      browser,
      profileLabel: null,
      extVersion: "1.0.0",
    });
    const second = await BridgeStateStore.open(folder, sealer);
    check(
      "a pin survives a restart, with the same app key",
      second.start === "loaded" &&
        second.keyStatus("AAAAAAAAAAAAAAAAAAAAAA", "K") === "known" &&
        second.appKey.publicKey === first.appKey.publicKey,
    );
    const statePath = join(folder, "bridge-state-v1.bin");
    const bytes = readFileSync(statePath);
    bytes[20] = (bytes[20] ?? 0) ^ 1;
    writeFileSync(statePath, bytes);
    const third = await BridgeStateStore.open(folder, sealer);
    check(
      "an edited state file reads as no pairing at all",
      third.start === "reset" && third.data.browsers.length === 0,
    );
    const otherSealer = await BridgeStateStore.open(folder, testSealer());
    check(
      "a key file that the key store does not open gives a new app key and no pairing",
      otherSealer.start === "reset" &&
        otherSealer.appKey.publicKey !== first.appKey.publicKey &&
        otherSealer.data.browsers.length === 0,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  // Manifest rules.
  const profile = mkdtempSync(join(tmpdir(), "bb-manifest-"));
  try {
    const manifest = nativeHostManifest({
      name: NATIVE_HOST_NAMES.e2e,
      hostPath: "/Applications/Builders Bot.app/Contents/Resources/chrome-host/darwin/arm64/buildersbot-chrome-host",
      extensionId: EXTENSION_IDS.e2e ?? "",
    });
    let refused = false;
    try {
      // `home` points at the temporary folder, so even a wrong answer could not reach the person's Chrome.
      await writeNativeHostManifest({
        folder: join(profile, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
        manifest,
        packaged: false,
        allowRealBrowser: false,
        home: profile,
      });
    } catch {
      refused = true;
    }
    check(
      "a development build refuses to write into a browser's own folder",
      refused && !existsSync(join(profile, "Library")),
    );
    let translocated = false;
    try {
      nativeHostManifest({
        name: NATIVE_HOST_NAMES.e2e,
        hostPath: "/private/var/folders/x/AppTranslocation/ABC/d/Builders Bot.app/host",
        extensionId: EXTENSION_IDS.e2e ?? "",
      });
    } catch {
      translocated = true;
    }
    check("a translocated host path is refused", translocated);
    const testFolder = join(profile, "NativeMessagingHosts");
    await writeNativeHostManifest({
      folder: testFolder,
      manifest,
      packaged: false,
      allowRealBrowser: false,
      home: profile,
    });
    const ok = await checkNativeHostManifest(testFolder, manifest);
    writeFileSync(
      join(testFolder, `${NATIVE_HOST_NAMES.e2e}.json`),
      JSON.stringify({ ...manifest, path: "/tmp/evil" }),
    );
    const changed = await checkNativeHostManifest(testFolder, manifest);
    await removeNativeHostManifest(testFolder, NATIVE_HOST_NAMES.e2e);
    check(
      "the manifest reads ok, then changed after an edit, then missing",
      ok === "ok" && changed === "changed" && (await checkNativeHostManifest(testFolder, manifest)) === "missing",
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------------
// B and C: the app service

interface Prompted {
  request: PairingRequest;
  resolve: (choice: number | null) => void;
  signal: AbortSignal;
}

class TestPrompt implements PairingPrompt {
  readonly asked: Prompted[] = [];
  ask(request: PairingRequest, signal: AbortSignal): Promise<number | null> {
    return new Promise((resolve) => {
      this.asked.push({ request, resolve, signal });
      signal.addEventListener("abort", () => resolve(null));
    });
  }
  #taken = 0;
  /** The oldest card not taken yet: a card can show before the test asks for it. */
  async next(ms = 8000): Promise<Prompted> {
    await until(() => this.asked.length > this.#taken, ms, "the pairing card");
    const prompted = this.asked[this.#taken];
    this.#taken += 1;
    if (!prompted) throw new Error("no card");
    return prompted;
  }
}

const indexOf = (options: readonly PairingCode[], code: PairingCode | null) =>
  options.findIndex((option) => code !== null && option.join() === code.join());

class App {
  runtime: ManagedRuntime.ManagedRuntime<ChromeBridgeService, unknown> | null = null;
  bridge: ChromeBridgeShape | null = null;
  readonly prompt = new TestPrompt();
  readonly ready: string[] = [];
  constructor(readonly options: Omit<ChromeBridgeOptions, "prompt" | "onReady">) {}
  async start(): Promise<number> {
    this.runtime = ManagedRuntime.make(
      ChromeBridgeService.layer({
        ...this.options,
        prompt: this.prompt,
        onReady: (browser) => this.ready.push(browser.installId),
      }),
    );
    this.bridge = await this.runtime.runPromise(
      Effect.gen(function* () {
        return yield* ChromeBridgeService;
      }),
    );
    return performance.now();
  }
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    if (!this.runtime) throw new Error("the app is not running");
    return this.runtime.runPromise(effect);
  }
  get api(): ChromeBridgeShape {
    if (!this.bridge) throw new Error("the app is not running");
    return this.bridge;
  }
  async stop() {
    await this.runtime?.dispose();
    this.runtime = null;
    this.bridge = null;
  }
}

/** Plays Chrome on the host's stdin and stdout, with the stub extension. */
function chromeOnHost(
  binary: string,
  origin: string,
  stub: (send: (frame: ExtensionFrame) => void, disconnect: () => void) => StubExtension,
) {
  const child = spawn(binary, [origin], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = Buffer.alloc(0);
  const send = (frame: ExtensionFrame) => {
    const body = Buffer.from(JSON.stringify(frame));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    if (!child.stdin.destroyed) child.stdin.write(Buffer.concat([head, body]));
  };
  child.stdin.on("error", () => undefined);
  const extension = stub(send, () => child.stdin.end());
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      void extension.receive(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
      buffer = buffer.subarray(4 + length);
    }
  });
  const exit = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  return { child, extension, exit, close: () => child.stdin.end() };
}

const rssKb = (pid: number | undefined) =>
  pid ? Number(spawnSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) || 0 : 0;

async function sectionB(host: ReturnType<typeof buildChromeHost>, peerAddon: string) {
  section = "B";
  const stateFolder = mkdtempSync(join(tmpdir(), "bb-bridge-app-"));
  const sealer = testSealer();
  const peerChecker = loadPeerChecker(peerAddon, `cdhash H"${host.cdhash}"`);
  const base = { channel: "e2e" as const, stateFolder, sealer, peerChecker, appVersion: host.version };
  const app = new App(base);
  const hosts: ReturnType<typeof chromeOnHost>[] = [];
  const newStub = async (
    extra: {
      pinnedAppKey?: string | null;
      features?: readonly string[];
      key?: Awaited<ReturnType<typeof generateChannelKey>>;
      installId?: string;
    } = {},
  ) => {
    const staticKey = extra.key ?? (await generateChannelKey(false));
    const installId = extra.installId ?? randomBase64Url(16);
    const run = chromeOnHost(
      host.binary,
      host.origin,
      (send, disconnect) =>
        new StubExtension({
          send,
          disconnect,
          staticKey,
          installId,
          browser,
          pinnedAppKey: extra.pinnedAppKey ?? null,
          features: extra.features,
          evaluateDelayMs: 5,
        }),
    );
    hosts.push(run);
    return { ...run, staticKey, installId };
  };
  try {
    await app.start();
    await app.run(app.api.openPairingWindow);
    // B1: pairing, path A.
    const s1 = await newStub();
    const card = await app.prompt.next();
    await until(() => s1.extension.view.phase === "pairing", 5000, "the welcome words");
    const appIndex = indexOf(card.request.options, s1.extension.view.chromeCode);
    const chromeIndex = indexOf(s1.extension.view.options, card.request.appCode);
    check(
      "each side offers the other side's words among three options",
      appIndex >= 0 && chromeIndex >= 0 && card.request.options.length === 3 && s1.extension.view.options.length === 3,
    );
    check(
      "the card says what the extension reported, and the window reason",
      card.request.reason === "window" &&
        card.request.browser.brand === "chrome-for-testing" &&
        card.request.profileLabel === "Test profile",
    );
    await s1.extension.choose(chromeIndex);
    card.resolve(appIndex);
    await until(
      () => s1.extension.view.phase === "ready" && app.ready.includes(s1.installId),
      5000,
      "the pin on both sides",
    );
    const paired = await app.run(app.api.paired);
    check(
      "two taps and no typed field pair the profile; the app sealed the pin",
      paired.some((entry) => entry.installId === s1.installId && entry.extensionKey === s1.staticKey.publicKey) &&
        s1.extension.view.pinnedAppKey !== null,
      { choices: 2, typed: 0 },
    );
    check(
      "the host told the extension its parent kind and pid",
      s1.extension.view.hostHello?.pid === s1.child.pid && s1.extension.view.hostHello?.parent === "other",
    );

    // B2: messages through the real host.
    let started = performance.now();
    await app.run(app.api.request(s1.installId, "ping", {}));
    measures.pingMs = Math.round(performance.now() - started);
    const handle = randomBase64Url(16);
    started = performance.now();
    const shot = await app.run(
      app.api.request(
        s1.installId,
        "cdp.send",
        { handle, method: "Page.captureScreenshot", params: { stubBytes: 9_000_000 } },
        { timeoutMs: 30_000 },
      ),
    );
    const shotMs = Math.round(performance.now() - started);
    const shotData =
      typeof shot.result === "object" && shot.result !== null && "data" in shot.result ? String(shot.result.data) : "";
    check("a 9 MB answer from the extension comes through the host in parts", shotData.length === 9_000_000, {
      ms: shotMs,
    });
    started = performance.now();
    await app.run(
      app.api.request(s1.installId, "cdp.send", {
        handle,
        method: "Runtime.evaluate",
        params: { order: 1, blob: "q".repeat(1_500_000) },
      }),
    );
    check(
      "a 1.5 MB request reaches the extension in parts below Chrome's 1 MB limit",
      s1.extension.view.largestParamsBytes >= 1_500_000,
      { ms: Math.round(performance.now() - started) },
    );
    measures.hostB = { screenshot9MbMs: shotMs };

    // B3: load. 600 requests, 12 tabs, 50 in order on each.
    const handles = Array.from({ length: 12 }, () => randomBase64Url(16));
    started = performance.now();
    let sawWaiting = 0;
    const all = handles.flatMap((tab) =>
      Array.from({ length: 50 }, (_, order) =>
        app.run(
          app.api.request(
            s1.installId,
            "cdp.send",
            { handle: tab, method: "Runtime.evaluate", params: { order: order + 10 } },
            { key: tab },
          ),
        ),
      ),
    );
    const loads = await app.run(app.api.load);
    sawWaiting = Math.max(...loads.map((load) => load.waiting));
    await Promise.all(all);
    measures.load600 = {
      ms: Math.round(performance.now() - started),
      maxInFlight: s1.extension.view.maxInFlight,
      maxInFlightPerTab: s1.extension.view.maxInFlightPerHandle,
      waitingSeen: sawWaiting,
    };
    check(
      "600 requests at once: at most 64 in flight, at most 16 for one tab, order kept for each tab",
      s1.extension.view.maxInFlight <= 64 &&
        s1.extension.view.maxInFlightPerHandle <= 16 &&
        !s1.extension.view.orderBroken &&
        sawWaiting > 0,
      measures.load600,
    );
    measures.hostRssAfterLoadKb = rssKb(s1.child.pid);

    // B3b: an answer after the app's deadline is dropped; the connection and the other agents go on.
    const slowHandle = randomBase64Url(16);
    const otherHandle = randomBase64Url(16);
    let lateError = "";
    try {
      await app.run(
        app.api.request(
          s1.installId,
          "cdp.send",
          { handle: slowHandle, method: "Runtime.evaluate", params: { order: 1, stubDelayMs: 1500 } },
          { key: slowHandle, timeoutMs: 300 },
        ),
      );
    } catch (error) {
      lateError = error instanceof Error && "code" in error ? String(error.code) : String(error);
    }
    // The late answer reaches the app now.
    await new Promise((done) => setTimeout(done, 1600));
    const afterLate = await app
      .run(
        app.api.request(
          s1.installId,
          "cdp.send",
          { handle: otherHandle, method: "Runtime.evaluate", params: { order: 1 } },
          { key: otherHandle },
        ),
      )
      .then(
        () => "ok",
        (error: unknown) => (error instanceof Error && "code" in error ? String(error.code) : String(error)),
      );
    check(
      "a late answer after the app's deadline is dropped: the connection stays, another agent's request passes",
      lateError === "timeout" && afterLate === "ok" && app.ready.filter((id) => id === s1.installId).length === 1,
      { lateError, afterLate, readyCount: app.ready.filter((id) => id === s1.installId).length },
    );

    // B4: the app restarts with one feature less; reconnection time.
    await app.stop();
    await until(() => !s1.extension.view.appOnline, 5000, "the host to report the app away");
    const lessFeatures = new App({
      ...base,
      features: CHROME_BRIDGE_FEATURES.filter((feature) => feature !== "tab-history"),
    });
    const listening = await lessFeatures.start();
    await until(() => lessFeatures.ready.includes(s1.installId), 5000, "the reconnection");
    const reconnectMs = Math.round(performance.now() - listening);
    measures.reconnectAfterAppStartMs = reconnectMs;
    check(
      "after the app restarts, the paired profile is back below 1 s, with no card",
      reconnectMs < 1000 && lessFeatures.prompt.asked.length === 0,
      { reconnectMs },
    );
    let denied = "";
    try {
      await lessFeatures.run(lessFeatures.api.request(s1.installId, "tab.history", { handle, action: "reload" }));
    } catch (error) {
      denied =
        error instanceof Error
          ? `${error.name} ${"code" in error ? String(error.code) : error.message}`
          : String(error);
    }
    check(
      "an operation of a feature that one side did not announce is never sent",
      denied.includes("method_denied"),
      denied,
    );
    await lessFeatures.stop();
    await app.start();
    await until(
      () => app.ready.includes(s1.installId) && app.ready.filter((id) => id === s1.installId).length >= 2,
      5000,
      "the second reconnection",
    );

    // B5: a wrong choice in the app.
    await app.run(app.api.openPairingWindow);
    const s2 = await newStub();
    const card2 = await app.prompt.next();
    await until(() => s2.extension.view.phase === "pairing", 5000, "the welcome words");
    const wrong =
      [0, 1, 2].find((index) => index !== indexOf(card2.request.options, s2.extension.view.chromeCode)) ?? 0;
    card2.resolve(wrong);
    await until(() => !s2.extension.view.appOnline || s2.extension.view.phase === "waiting", 5000, "the refusal");
    const paired2 = await app.run(app.api.paired);
    check(
      "a wrong choice in the app pins nothing and ends the connection",
      !paired2.some((entry) => entry.installId === s2.installId),
    );
    // The refused key gets `busy` when it comes back at once: no card for it again.
    await until(() => s2.extension.view.rejected === "busy", 5000, "the quiet refusal");
    check("the refused key comes back to `busy`, not to a new card", app.prompt.asked.length === 2);
    s2.close();

    // B6: outside a window, at most 3 cards an hour, then `busy`.
    const reasons: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const stub = await newStub();
      const card3 = await app.prompt.next();
      reasons.push(card3.request.reason);
      card3.resolve(null);
      await until(
        () => stub.extension.view.phase !== "handshake" && stub.extension.view.phase !== "pairing",
        5000,
        "the cancel",
      );
      stub.close();
    }
    const s6 = await newStub();
    await until(() => s6.extension.view.rejected !== null, 5000, "the busy answer");
    check(
      "outside a window, three cards an hour, then `busy` with no card",
      reasons.every((reason) => reason === "unexpected") &&
        s6.extension.view.rejected === "busy" &&
        app.prompt.asked.length === 5,
      { reasons, rejected: s6.extension.view.rejected },
    );
    // A window opening lets the refused profile try again at once.
    await app.run(app.api.openPairingWindow);
    const card6 = await app.prompt.next(5000);
    check(
      "a pairing window closes the `busy` connection and the profile retries inside it",
      card6.request.reason === "window",
    );
    card6.resolve(null);
    await app.run(app.api.closePairingWindow);

    // B7: revocation.
    await app.run(app.api.revoke(s1.installId));
    await until(() => s1.extension.view.rejected === "revoked", 5000, "reject{revoked}");
    check("a revoked profile gets reject{revoked}", s1.extension.view.rejected === "revoked");

    // B8: a process that is not the host on the app's socket.
    const socket = bridgeSocket("e2e");
    const connectionsBefore = (await app.run(app.api.load)).length;
    // Asynchronous: the app runs in this process and must answer while perl waits.
    const perl = await new Promise<{ stdout: string }>((done) => {
      const child = spawn("/usr/bin/perl", [
        "-MIO::Socket::UNIX",
        "-e",
        '$SIG{PIPE} = "IGNORE"; my $c = IO::Socket::UNIX->new(Type => SOCK_STREAM(), Peer => $ARGV[0]) or die "no"; syswrite($c, pack("V", 31) . q({"k":"commit","digest":"xxxxxxxx"})); my $n = sysread($c, my $b, 65536); print defined $n ? $n : -1;',
        socket.path,
      ]);
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      const timer = setTimeout(() => child.kill(), 5000);
      child.on("exit", () => {
        clearTimeout(timer);
        done({ stdout });
      });
    });
    const nodePeer = await new Promise<number>((done) => {
      let received = 0;
      const client = connect(socket.path, () => client.write(Buffer.from([31, 0, 0, 0])));
      client.on("data", (chunk) => (received += chunk.length));
      client.on("close", () => done(received));
      client.on("error", () => done(received));
      setTimeout(() => client.destroy(), 3000);
    });
    check(
      "a process that is not the signed host is closed before the app reads or writes a byte",
      ["0", "-1"].includes(perl.stdout.trim()) &&
        nodePeer === 0 &&
        (await app.run(app.api.load)).length === connectionsBefore,
      { perlRead: perl.stdout.trim(), bunRead: nodePeer },
    );
    measures.hostRssIdleKb = rssKb(s1.child.pid);
  } finally {
    for (const run of hosts) run.child.kill();
    await app.stop();
    rmSync(stateFolder, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------------
// C. Chrome for Testing with the stub extension

/** What the stub's service worker reports to its own page. Extra fields are ignored. */
const StubState = Schema.Struct({
  view: Schema.NullOr(
    Schema.Struct({
      phase: Schema.String,
      maxInFlight: Schema.Number,
      maxInFlightPerHandle: Schema.Number,
      orderBroken: Schema.Boolean,
      hostHello: Schema.NullOr(Schema.Struct({ pid: Schema.Number, parent: Schema.String })),
    }),
  ),
});

async function stubState(page: Page) {
  return Schema.decodeUnknownSync(StubState)(await page.evaluate("chrome.runtime.sendMessage({ type: 'state' })"));
}

async function ensureCft(): Promise<{ version: string; binary: string; sha256: string }> {
  const platform = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  let version = CFT_PIN.version;
  let url: string;
  if (!version) {
    const known = await (
      await fetch("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json")
    ).json();
    version = known.channels.Stable.version;
    url = known.channels.Stable.downloads.chrome.find((entry: { platform: string }) => entry.platform === platform).url;
  } else {
    url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`;
  }
  const folder = join(OUT, "cft", version);
  const binary = join(
    folder,
    `chrome-${platform}`,
    "Google Chrome for Testing.app",
    "Contents/MacOS/Google Chrome for Testing",
  );
  const shaFile = join(folder, "sha256.txt");
  if (!existsSync(binary)) {
    mkdirSync(folder, { recursive: true });
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pinned = CFT_PIN.sha256[platform];
    if (pinned && pinned !== sha256) throw new Error(`Chrome for Testing archive hash changed: ${sha256}`);
    const zip = join(folder, "chrome.zip");
    writeFileSync(zip, bytes);
    const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", zip, folder]);
    rmSync(zip);
    if (unzip.status !== 0) throw new Error("Could not unpack Chrome for Testing.");
    writeFileSync(shaFile, `${sha256}  chrome.zip\n`);
  }
  const sha256 = existsSync(shaFile) ? (readFileSync(shaFile, "utf8").split(/\s+/u)[0] ?? "") : "";
  const pinned = CFT_PIN.sha256[platform];
  if (pinned && sha256 !== pinned) throw new Error(`Chrome for Testing at ${folder} is not the pinned archive.`);
  return { version, binary, sha256 };
}

function swapUsedMb(): number {
  const text = spawnSync("/usr/sbin/sysctl", ["vm.swapusage"], { encoding: "utf8" }).stdout;
  return Number(/used = ([\d.]+)M/u.exec(text)?.[1] ?? Number.POSITIVE_INFINITY);
}

async function sectionC(host: ReturnType<typeof buildChromeHost>, peerAddon: string) {
  section = "C";
  const swap = swapUsedMb();
  const stats = statfsSync(ROOT);
  const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
  if (swap > 6144 || freeGb < 3) {
    check("Chrome for Testing section skipped: swap above 6 GB or disk below 3 GB", true, { swapMb: swap, freeGb });
    measures.chromeSkipped = { swapMb: swap, freeGb };
    return;
  }
  const cft = await ensureCft();
  measures.cft = cft;
  const work = mkdtempSync(join(tmpdir(), "bb-chrome-bridge-smoke-"));
  const profile = join(work, "profile");
  const extension = join(work, "extension");
  if (profile.startsWith(join(homedir(), "Library/Application Support")))
    throw new Error("The test profile must be a temporary folder.");
  const stateFolder = join(work, "app-state");
  mkdirSync(profile, { recursive: true });
  mkdirSync(stateFolder, { recursive: true });
  const app = new App({
    channel: "e2e",
    stateFolder,
    sealer: testSealer(),
    peerChecker: loadPeerChecker(peerAddon, `cdhash H"${host.cdhash}"`),
    appVersion: host.version,
    // The manifest goes into the test profile only: Chrome reads `<user-data-dir>/NativeMessagingHosts`.
    nativeHost: {
      folder: join(profile, "NativeMessagingHosts"),
      hostPath: host.binary,
      extensionId: EXTENSION_IDS.e2e ?? "",
      packaged: false,
      allowRealBrowser: false,
      inApplications: () => true,
    },
  });
  let context: BrowserContext | null = null;
  try {
    // The stub extension, with the E2E key so its ID is the one the host accepts.
    const built = await Bun.build({
      entrypoints: [
        join(ROOT, "scripts/chrome-bridge-stub-extension/background.js"),
        join(ROOT, "scripts/chrome-bridge-stub-extension/welcome.js"),
      ],
      outdir: extension,
      target: "browser",
      format: "esm",
      minify: false,
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    writeFileSync(
      join(extension, "welcome.html"),
      readFileSync(join(ROOT, "scripts/chrome-bridge-stub-extension/welcome.html")),
    );
    writeFileSync(
      join(extension, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Builders Bot (E2E stub)",
        version: "1.0.0",
        key: EXTENSION_PUBLIC_KEYS.e2e,
        minimum_chrome_version: "137",
        incognito: "not_allowed",
        background: { service_worker: "background.js", type: "module" },
        permissions: ["nativeMessaging"],
        externally_connectable: { ids: [], matches: [] },
        content_security_policy: {
          extension_pages:
            "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      }),
    );
    // "Connect Chrome": the only path that writes the manifest, and it opens the pairing window.
    await app.start();
    const connected = await app.run(app.api.connectChrome);
    check(
      "Connect Chrome writes the Native Messaging manifest inside the temporary profile only",
      connected.manifest.startsWith(profile) &&
        !existsSync(
          join(
            homedir(),
            "Library/Application Support/Google/Chrome/NativeMessagingHosts",
            `${NATIVE_HOST_NAMES.e2e}.json`,
          ),
        ),
    );
    const { chromium } = await import("playwright-core");
    const launched = await chromium.launchPersistentContext(profile, {
      executablePath: cft.binary,
      headless: !headed,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    context = launched;
    const page = await launched.newPage();
    await page.goto(`chrome-extension://${EXTENSION_IDS.e2e}/welcome.html`);
    let card: Prompted;
    try {
      // The first start of a freshly unpacked Chrome for Testing can take a while (macOS checks it).
      card = await app.prompt.next(45_000);
    } catch (error) {
      // What the extension and the host saw, for the report.
      const seen = await page.evaluate("chrome.runtime.sendMessage({ type: 'state' })").catch(String);
      const log = join(bridgeSocket("e2e").folder, "host-diagnostics.log");
      check("the extension in Chrome for Testing reaches the app", false, {
        error: String(error),
        extension: seen,
        workers: launched.serviceWorkers().map((worker) => worker.url()),
        host: existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-20) : "no host log",
      });
      return;
    }
    await page.locator("#options button").first().waitFor({ timeout: 10_000 });
    const chromeWords = (await page.locator("#chrome-code").textContent())?.trim() ?? "";
    const appIndex = card.request.options.findIndex((option) => option.join(" · ") === chromeWords);
    const startedPair = performance.now();
    // A real click on the welcome page (a person's gesture), and the person's choice in the app.
    await page.locator("#options button", { hasText: card.request.appCode.join(" · ") }).click();
    card.resolve(appIndex);
    await until(() => app.ready.length > 0, 10_000, "the pin in Chrome for Testing");
    measures.chromePairMs = Math.round(performance.now() - startedPair);
    const installId = app.ready[0] ?? "";
    const state = await stubState(page);
    check(
      "Chrome for Testing pairs with one click on the welcome page and one choice in the app",
      appIndex >= 0 && state.view?.phase === "ready",
      { appIndex, phase: state.view?.phase ?? null },
    );
    measures.v20Parent = state.view?.hostHello?.parent ?? null;
    const hostPid = state.view?.hostHello?.pid;

    let started = performance.now();
    await app.run(app.api.request(installId, "ping", {}));
    measures.chromePingMs = Math.round(performance.now() - started);
    const handle = randomBase64Url(16);
    started = performance.now();
    const shot = await app.run(
      app.api.request(installId, "cdp.send", {
        handle,
        method: "Page.captureScreenshot",
        params: { stubBytes: 9_000_000 },
      }),
    );
    const size =
      typeof shot.result === "object" && shot.result !== null && "data" in shot.result
        ? String(shot.result.data).length
        : 0;
    measures.chromeScreenshot9MbMs = Math.round(performance.now() - started);
    started = performance.now();
    await app.run(
      app.api.request(installId, "cdp.send", {
        handle,
        method: "Runtime.evaluate",
        params: { order: 1, blob: "q".repeat(1_500_000) },
      }),
    );
    measures.chrome1500KbRequestMs = Math.round(performance.now() - started);
    check("9 MB from the extension and 1.5 MB to it pass Chrome's Native Messaging in parts", size === 9_000_000);

    const tabs = Array.from({ length: 6 }, () => randomBase64Url(16));
    started = performance.now();
    await Promise.all(
      tabs.flatMap((tab) =>
        Array.from({ length: 50 }, (_, order) =>
          app.run(
            app.api.request(
              installId,
              "cdp.send",
              { handle: tab, method: "Runtime.evaluate", params: { order: order + 10 } },
              { key: tab },
            ),
          ),
        ),
      ),
    );
    const after = (await stubState(page)).view;
    measures.chromeLoad300 = {
      ms: Math.round(performance.now() - started),
      maxInFlight: after?.maxInFlight ?? null,
      maxInFlightPerTab: after?.maxInFlightPerHandle ?? null,
    };
    check(
      "300 requests through Chrome: caps and order hold",
      after !== null && after.maxInFlight <= 64 && after.maxInFlightPerHandle <= 16 && !after.orderBroken,
      measures.chromeLoad300,
    );

    await app.stop();
    const listening = await app.start();
    await until(() => app.ready.filter((id) => id === installId).length >= 2, 10_000, "the reconnection in Chrome");
    const chromeReconnectMs = Math.round(performance.now() - listening);
    measures.chromeReconnectMs = chromeReconnectMs;
    check("Chrome reconnects below 1 s after the app listens again, with no card", chromeReconnectMs < 1000, {
      ms: chromeReconnectMs,
    });
    measures.chromeHostRssKb = rssKb(hostPid);
    const diagnostics = join(bridgeSocket("e2e").folder, "host-diagnostics.log");
    measures.hostDiagnostics = existsSync(diagnostics)
      ? readFileSync(diagnostics, "utf8")
          .split("\n")
          .filter((line) => line.includes("parent"))
          .slice(-2)
      : [];
  } finally {
    await context?.close().catch(() => undefined);
    await app.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  const socket = bridgeSocket("e2e");
  rmSync(socket.folder, { recursive: true, force: true });
  await sectionA();
  const host = buildChromeHost({ channel: "e2e", appRequirement: `cdhash H"${codeHash(process.execPath)}"` });
  const peer = buildChromePeer();
  measures.host = { cdhash: host.cdhash, version: host.version, binaryBytes: statSync(host.binary).size };
  try {
    if (!onlyChrome) await sectionB(host, peer.addon);
    if (!skipChrome) await sectionC(host, peer.addon);
  } finally {
    rmSync(socket.folder, { recursive: true, force: true });
  }
  const passed = results.every((result) => result.ok);
  writeFileSync(REPORT, `${JSON.stringify({ passed, at: new Date().toISOString(), measures, results }, null, 2)}\n`);
  process.stdout.write(
    `${passed ? "PASSED" : "FAILED"} ${results.filter((r) => r.ok).length}/${results.length} → ${REPORT}\n`,
  );
  process.exit(passed ? 0 : 1);
}

await main();
