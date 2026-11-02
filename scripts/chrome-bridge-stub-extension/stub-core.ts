/**
 * The extension's side of the Chrome bridge, for the protocol smoke only: the host's own frames, the
 * handshake, the pairing choice, and a few operations. The real extension (`apps/chrome-extension`)
 * replaces it; this stub has no tabs, no CDP, no allowlist and no site floor. It runs in two places:
 * inside a real extension service worker in Chrome for Testing (`background.ts`), and in the smoke
 * process, where it plays Chrome on the host's stdin and stdout.
 */

import {
  ChannelError,
  type ChannelKeyPair,
  type Established,
  ExtensionHandshake,
  HostFrameGate,
  type PairingCode,
  pairingOptions,
  type SealedFrame,
  samePairingCode,
} from "../../packages/contracts/src/chrome-bridge/channel";
import {
  CHROME_BRIDGE_FEATURES,
  type ChromeBridgeEvent,
  decodeToExtension,
  type EventBodies,
  type HandshakeMessage,
  type OperationHandlers,
} from "../../packages/contracts/src/chrome-bridge/protocol";

/** What the extension writes to the host: its handshake messages in clear, then sealed frames. */
export type ExtensionFrame =
  | HandshakeMessage<"commit">
  | HandshakeMessage<"hello">
  | HandshakeMessage<"confirm">
  | SealedFrame;

export interface StubOptions {
  readonly send: (frame: ExtensionFrame) => void;
  readonly disconnect: (reason: string) => void;
  readonly staticKey: ChannelKeyPair;
  readonly installId: string;
  readonly extVersion?: string;
  readonly browser: { brand: "google-chrome" | "chrome-for-testing" | "chromium" | "other"; version: string };
  readonly features?: readonly string[];
  /** The app key pinned before (a second connection), or null. */
  readonly pinnedAppKey?: string | null;
  readonly onChange?: () => void;
  /** How long `cdp.send` with `Runtime.evaluate` waits before it answers, to measure concurrency. */
  readonly evaluateDelayMs?: number;
}

export interface StubView {
  phase: "waiting" | "handshake" | "pairing" | "ready" | "closed" | "rejected";
  hostHello: HostFrameGate["hostHello"];
  appOnline: boolean;
  chromeCode: PairingCode | null;
  options: PairingCode[];
  chose: "none" | "right" | "wrong";
  pinnedAppKey: string | null;
  rejected: string | null;
  error: string | null;
  sessions: number;
  inFlight: number;
  maxInFlight: number;
  maxInFlightPerHandle: number;
  orderBroken: boolean;
  largestParamsBytes: number;
  pings: number;
}

export class StubExtension {
  readonly #options: StubOptions;
  readonly #gate = new HostFrameGate();
  #handshake: ExtensionHandshake | null = null;
  #established: Established | null = null;
  #correctIndex = -1;
  #provisional: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #seq = 1;
  readonly #inFlightByHandle = new Map<string, number>();
  readonly #lastByHandle = new Map<string, number>();
  readonly view: StubView;

  constructor(options: StubOptions) {
    this.#options = options;
    this.view = {
      phase: "waiting",
      hostHello: null,
      appOnline: false,
      chromeCode: null,
      options: [],
      chose: "none",
      pinnedAppKey: options.pinnedAppKey ?? null,
      rejected: null,
      error: null,
      sessions: 0,
      inFlight: 0,
      maxInFlight: 0,
      maxInFlightPerHandle: 0,
      orderBroken: false,
      largestParamsBytes: 0,
      pings: 0,
    };
  }

  /** One frame from the host. Frames are handled one at a time, in order. */
  receive(frame: unknown): Promise<void> {
    const run = this.#queue.then(() => this.#receive(frame));
    this.#queue = run.catch((error: unknown) => this.#fail(error));
    return this.#queue;
  }

  #fail(error: unknown) {
    this.view.error = error instanceof ChannelError ? `${error.code}: ${error.message}` : String(error);
    this.view.phase = "closed";
    this.#options.disconnect(this.view.error);
    this.#options.onChange?.();
  }

  async #receive(frame: unknown) {
    if (this.view.phase === "closed") return;
    if (HostFrameGate.isHostFrame(frame)) {
      const action = this.#gate.accept(frame);
      this.view.hostHello = this.#gate.hostHello;
      if (action === "start-handshake") {
        this.view.appOnline = true;
        await this.#start();
      } else if (action === "app-offline") {
        this.view.appOnline = false;
        this.#established = null;
        this.#handshake = null;
        this.view.phase = "waiting";
      }
      this.#options.onChange?.();
      return;
    }
    if (this.view.phase === "handshake" && this.#handshake) {
      await this.#handshakeStep(frame);
      return;
    }
    const channel = this.#established?.channel;
    if (!channel) throw new ChannelError("protocol", "a frame came with no session");
    const opened = await channel.open(frame);
    if (!opened) return;
    const decoded = decodeToExtension(opened.message, this.#established?.features ?? [], this.#handlers());
    if (!decoded.ok) throw new ChannelError("protocol", decoded.error);
    await decoded.value;
  }

  async #start() {
    const { handshake, commit } = await ExtensionHandshake.start({
      staticKey: this.#options.staticKey,
      extVersion: this.#options.extVersion ?? "1.0.0",
      installId: this.#options.installId,
      features: this.#options.features ?? CHROME_BRIDGE_FEATURES,
      browser: this.#options.browser,
      consent: { version: 1, at: 1 },
      profileLabel: "Test profile",
    });
    this.#handshake = handshake;
    this.view.phase = "handshake";
    this.view.rejected = null;
    this.#options.send(commit);
  }

  #welcomed = false;

  async #handshakeStep(frame: unknown) {
    const handshake = this.#handshake;
    if (!handshake) return;
    if (!this.#welcomed) {
      const answer = await handshake.onWelcome(frame);
      if ("rejected" in answer) {
        this.#rejected(answer.rejected);
        return;
      }
      this.#welcomed = true;
      for (const message of answer.frames) this.#options.send(message);
      return;
    }
    this.#welcomed = false;
    const result = await handshake.onConfirm(frame);
    this.#handshake = null;
    if ("rejected" in result) {
      this.#rejected(result.rejected);
      return;
    }
    this.#established = result;
    this.#gate.sessionStarted();
    this.view.sessions += 1;
    if (this.view.pinnedAppKey !== null && this.view.pinnedAppKey === result.peerKey) {
      this.view.phase = "ready";
      await this.#event("ready", { groups: [], handles: [], attached: [], stopped: [] });
    } else {
      // A new or changed app key: the person must tap the app's words here before anything else.
      const { options, correctIndex } = pairingOptions(result.codes.app);
      this.view.chromeCode = result.codes.chrome;
      this.view.options = options;
      this.#correctIndex = correctIndex;
      this.view.chose = "none";
      this.view.phase = "pairing";
    }
    this.#options.onChange?.();
  }

  #rejected(code: string) {
    this.#welcomed = false;
    this.#handshake = null;
    this.view.rejected = code;
    this.view.phase = "rejected";
    this.#options.onChange?.();
  }

  /** The person taps one of the three options on the welcome page. */
  async choose(index: number): Promise<void> {
    const established = this.#established;
    if (this.view.phase !== "pairing" || !established) return;
    const chosen = this.view.options[index];
    if (index !== this.#correctIndex || !chosen || !samePairingCode(chosen, established.codes.app)) {
      this.view.chose = "wrong";
      this.#established = null;
      this.view.phase = "closed";
      this.#options.disconnect("the words did not match in Chrome");
      this.#options.onChange?.();
      return;
    }
    this.view.chose = "right";
    this.#provisional = established.peerKey;
    await this.#event("pair.chrome-ok", {});
    this.#options.onChange?.();
  }

  async #event<E extends ChromeBridgeEvent>(op: E, body: EventBodies[E]) {
    const channel = this.#established?.channel;
    if (!channel) return;
    const frames = await channel.seal({ t: "evt", seq: this.#seq, op, body });
    this.#seq += 1;
    for (const frame of frames) this.#options.send(frame);
  }

  async #respond(id: number, outcome: { body: object } | { err: { code: "cdp_error"; message: string } }) {
    const channel = this.#established?.channel;
    if (!channel) return;
    const frames = await channel.seal({ t: "res", id, ...outcome });
    for (const frame of frames) this.#options.send(frame);
  }

  #handlers(): OperationHandlers<Promise<void>> {
    const refuse = (_body: unknown, id: number) =>
      this.#respond(id, { err: { code: "cdp_error", message: "not in the stub" } });
    return {
      "session.configure": refuse,
      "group.ensure": refuse,
      "group.update": refuse,
      "group.release": refuse,
      "lease.open": refuse,
      "lease.close": refuse,
      "tab.create": refuse,
      "tab.claim": refuse,
      "tab.release": refuse,
      "tab.close": refuse,
      "tab.activate": refuse,
      "tab.history": refuse,
      "tab.zoom": refuse,
      "tab.discard": refuse,
      "tab.mark": refuse,
      "cdp.batch": refuse,
      "script.run": refuse,
      "secret.fill": refuse,
      "project.pause": refuse,
      "project.resume": refuse,
      "stop.all": refuse,
      resync: refuse,
      ping: (_body, id) => {
        this.view.pings += 1;
        return this.#respond(id, { body: {} });
      },
      "pair.done": (_body, id) => {
        if (this.view.phase !== "pairing" || this.view.chose !== "right" || this.#provisional === null)
          return Promise.reject(new ChannelError("protocol", "pair.done before the person chose here"));
        this.view.pinnedAppKey = this.#provisional;
        this.view.phase = "ready";
        this.#options.onChange?.();
        return this.#respond(id, { body: {} }).then(() =>
          this.#event("ready", { groups: [], handles: [], attached: [], stopped: [] }),
        );
      },
      "cdp.send": async (body, id) => {
        if (this.view.phase !== "ready") throw new ChannelError("protocol", "an operation came before pairing");
        this.view.largestParamsBytes = Math.max(this.view.largestParamsBytes, JSON.stringify(body.params).length);
        if (body.method === "Page.captureScreenshot") {
          const size =
            typeof body.params === "object" && body.params !== null && "stubBytes" in body.params
              ? Number(body.params.stubBytes)
              : 1000;
          await this.#respond(id, { body: { result: { data: "A".repeat(size) } } });
          return;
        }
        const count = (this.#inFlightByHandle.get(body.handle) ?? 0) + 1;
        this.#inFlightByHandle.set(body.handle, count);
        this.view.inFlight += 1;
        this.view.maxInFlight = Math.max(this.view.maxInFlight, this.view.inFlight);
        this.view.maxInFlightPerHandle = Math.max(this.view.maxInFlightPerHandle, count);
        const order =
          typeof body.params === "object" && body.params !== null && "order" in body.params
            ? Number(body.params.order)
            : 0;
        if (order <= (this.#lastByHandle.get(body.handle) ?? -1)) this.view.orderBroken = true;
        this.#lastByHandle.set(body.handle, order);
        // A test can make one answer late, as a stuck page makes it.
        const delay =
          typeof body.params === "object" && body.params !== null && "stubDelayMs" in body.params
            ? Number(body.params.stubDelayMs)
            : (this.#options.evaluateDelayMs ?? 0);
        // Answer later, outside the frame queue, so requests overlap as they would in Chrome.
        setTimeout(() => {
          this.view.inFlight -= 1;
          this.#inFlightByHandle.set(body.handle, (this.#inFlightByHandle.get(body.handle) ?? 1) - 1);
          void this.#respond(id, { body: { result: { order } } });
        }, delay);
      },
    };
  }
}
