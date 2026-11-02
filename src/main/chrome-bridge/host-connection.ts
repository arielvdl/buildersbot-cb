/**
 * One connection from a Chrome host to the app: one Chrome profile with the Builders Bot extension.
 *
 * The bytes are frames: a uint32 length in native byte order (little endian on every Mac), then UTF-8
 * JSON. This side runs the app's half of the handshake (`AppHandshake`), then the sealed channel, then
 * requests to the extension and its events, all decoded by the closed decoders of the contracts.
 *
 * Bounds that keep many profiles and many agents from overloading the app or Chrome:
 *
 * - a frame from the host above 16 MiB closes the connection before it is buffered;
 * - frames are decrypted one at a time; when more than 32 wait, the socket stops reading until they
 *   are done, so a fast extension slows down instead of filling memory;
 * - outgoing frames go through one queue that waits for the socket's `drain`;
 * - at most 64 requests are in flight (16 for one queue key, such as one tab); up to 1024 more wait
 *   in order, and past that a request fails at once with `limit`;
 * - each request has a deadline counted from the moment its frames go to the socket, not from the queue.
 */

import type { Socket } from "node:net";
import {
  AppHandshake,
  ChannelError,
  type ChannelKeyPair,
  type Established,
  type PairingCode,
  type PeerKeyStatus,
  pairingOptions,
  type SealedFrame,
  samePairingCode,
} from "@openbot/contracts/chrome-bridge/channel";
import {
  BRIDGE_LIMITS,
  type ChromeBridgeErrorCode,
  type ChromeBridgeEvent,
  type ChromeBridgeOperation,
  decodeOperationBody,
  decodeResponseEnvelope,
  decodeResultBody,
  decodeToApp,
  type EventBodies,
  frameFits,
  type HandshakeMessage,
  OPERATION_FEATURES,
  type OperationBodies,
  type ResultBodies,
} from "@openbot/contracts/chrome-bridge/protocol";

export const CONNECTION_LIMITS = {
  pendingFrames: 32,
  staleFramesBeforeCommit: 64,
  inFlight: BRIDGE_LIMITS.inFlightTotal,
  inFlightPerKey: BRIDGE_LIMITS.inFlightPerTab,
  waiting: 1024,
  /** Bytes queued for the socket; above this, new requests fail with `limit`. */
  queuedBytes: 64 * 1024 * 1024,
} as const;

/** A request failed. `code` is a protocol error code, or `chrome_not_connected` when the connection ended. */
export class BridgeRequestError extends Error {
  readonly code: ChromeBridgeErrorCode;
  constructor(code: ChromeBridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeRequestError";
    this.code = code;
  }
}

/** The card the app shows for a new pairing: the person taps the words that Chrome shows. */
export interface PairingRequest {
  readonly reason: "window" | "unexpected";
  /** Three options; the right one is the code Chrome shows. */
  readonly options: readonly PairingCode[];
  /** The code the app shows, for the person to tap in Chrome. */
  readonly appCode: PairingCode;
  /** Reported by the extension, not proven. */
  readonly browser: HandshakeMessage<"hello">["browser"];
  readonly profileLabel: string | null;
}

export interface PairingPrompt {
  /** Shows the card; resolves with the index of the option the person tapped, or null for "Not now". */
  ask(request: PairingRequest, signal: AbortSignal): Promise<number | null>;
}

/** What the connection asks of the service that owns it. */
export interface ConnectionHost {
  readonly appKey: ChannelKeyPair;
  readonly appVersion: string;
  readonly appInstanceId: string;
  readonly features: readonly string[];
  /** "new" while a pairing window is open. */
  pairingHint(): "known" | "new";
  keyStatus(installId: string, publicKey: string): PeerKeyStatus;
  /** Whether an unknown key may show the pairing card now; false means `reject{busy}`. */
  admitPairing(connection: HostConnection): "window" | "unexpected" | null;
  readonly prompt: PairingPrompt;
  pinned(connection: HostConnection, hello: HandshakeMessage<"hello">): Promise<void>;
  /** The extension never confirmed `pair.done`: the pin is taken back, so no half pairing remains. */
  unpinned(connection: HostConnection, hello: HandshakeMessage<"hello">): Promise<void>;
  refused(connection: HostConnection): void;
  ready(connection: HostConnection): void;
  event<E extends ChromeBridgeEvent>(connection: HostConnection, event: E, body: EventBodies[E]): void;
  closed(connection: HostConnection, reason: string): void;
}

interface Pending {
  readonly op: ChromeBridgeOperation;
  readonly key: string | null;
  /** Checks the body against the operation of this request, and resolves with it; false when it fails. */
  readonly accept: (body: unknown) => boolean;
  readonly reject: (error: BridgeRequestError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Waiting {
  readonly key: string | null;
  readonly start: () => void;
  readonly fail: (error: BridgeRequestError) => void;
}

/** What the app writes to the host: its handshake messages in clear, then sealed frames. */
type OutgoingFrame =
  | HandshakeMessage<"welcome">
  | HandshakeMessage<"reject">
  | HandshakeMessage<"confirm">
  | SealedFrame;

type Phase = "commit" | "hello" | "confirm" | "pairing" | "ready" | "rejected" | "closed";

export class HostConnection {
  readonly #socket: Socket;
  readonly #host: ConnectionHost;
  readonly #log: (line: string) => void;
  #phase: Phase = "commit";
  #handshake: AppHandshake | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #established: Established | null = null;
  #hello: HandshakeMessage<"hello"> | null = null;
  #staleFrames = 0;
  // Reading
  #chunks: Buffer[] = [];
  #buffered = 0;
  #frames: Buffer[] = [];
  #processing = false;
  // Writing
  #out: Buffer[] = [];
  #queuedBytes = 0;
  #draining = false;
  // Requests
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #inFlightByKey = new Map<string, number>();
  #inFlight = 0;
  #waiting: Waiting[] = [];
  #admitted: "window" | "unexpected" | null = null;
  // Pairing
  #pairing: {
    abort: AbortController;
    appChoseRight: boolean;
    chromeOk: boolean;
    finishing: boolean;
    /**
     * The extension reports its state (`ready`) right after its person chose the words, before the app
     * pins its key. The app keeps that one report and hands it on once the pairing is final.
     */
    heldReady: EventBodies["ready"] | null;
  } | null = null;
  readonly openedAt = Date.now();
  readonly peerPid: number;

  constructor(socket: Socket, host: ConnectionHost, options: { peerPid: number; log?: (line: string) => void }) {
    this.#socket = socket;
    this.#host = host;
    this.peerPid = options.peerPid;
    this.#log = options.log ?? (() => undefined);
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("drain", () => this.#flush());
    socket.on("error", () => this.close("socket error"));
    socket.on("close", () => this.close("socket closed"));
    socket.resume();
  }

  get phase(): Phase {
    return this.#phase;
  }

  get installId(): string | null {
    return this.#hello?.installId ?? null;
  }

  get hello(): HandshakeMessage<"hello"> | null {
    return this.#hello;
  }

  get features(): readonly string[] {
    return this.#established?.features ?? [];
  }

  /** Requests in flight and waiting, for diagnostics and tests. */
  get load() {
    return { inFlight: this.#inFlight, waiting: this.#waiting.length, queuedBytes: this.#queuedBytes };
  }

  close(reason: string): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#pairing?.abort.abort();
    this.#pairing = null;
    const gone = new BridgeRequestError("chrome_not_connected", "The Chrome connection closed.");
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(gone);
    }
    this.#pending.clear();
    for (const waiting of this.#waiting) waiting.fail(gone);
    this.#waiting = [];
    this.#out = [];
    this.#frames = [];
    this.#chunks = [];
    this.#socket.destroy();
    this.#log(`chrome bridge: connection closed (${reason})`);
    this.#host.closed(this, reason);
  }

  // -------------------------------------------------------------------------------------------------
  // Frames in

  #receive(chunk: Buffer) {
    if (this.#phase === "closed") return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    while (this.#buffered >= 4) {
      const head = this.#peek(4);
      const length = head.readUInt32LE(0);
      if (length === 0 || length > BRIDGE_LIMITS.maxFrameToAppBytes) {
        this.close("frame size refused");
        return;
      }
      if (this.#buffered < 4 + length) break;
      this.#take(4);
      this.#frames.push(this.#take(length));
    }
    if (this.#frames.length > CONNECTION_LIMITS.pendingFrames) this.#socket.pause();
    void this.#process();
  }

  #peek(count: number): Buffer {
    const first = this.#chunks[0];
    if (first && first.length >= count) return first.subarray(0, count);
    return Buffer.concat(this.#chunks).subarray(0, count);
  }

  #take(count: number): Buffer {
    const whole = this.#chunks.length === 1 ? (this.#chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(this.#chunks);
    const taken = whole.subarray(0, count);
    const rest = whole.subarray(count);
    this.#chunks = rest.length > 0 ? [rest] : [];
    this.#buffered = rest.length;
    return taken;
  }

  async #process() {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#frames.length > 0 && this.#phase !== "closed") {
        const frame = this.#frames.shift();
        if (!frame) break;
        let value: unknown;
        try {
          value = JSON.parse(frame.toString("utf8"));
        } catch {
          this.close("a frame is not JSON");
          return;
        }
        await this.#handle(value);
        if (this.#frames.length <= CONNECTION_LIMITS.pendingFrames / 2) this.#socket.resume();
      }
    } catch (error) {
      this.close(error instanceof ChannelError ? `protocol: ${error.code}` : "protocol: unexpected failure");
    } finally {
      this.#processing = false;
    }
  }

  async #handle(value: unknown) {
    switch (this.#phase) {
      case "commit": {
        // Sealed frames of a session that ended before this connection began: they never decrypt here.
        if (isObject(value) && "v" in value) {
          this.#staleFrames += 1;
          if (this.#staleFrames > CONNECTION_LIMITS.staleFramesBeforeCommit) this.close("too many stale frames");
          return;
        }
        this.#handshake = await AppHandshake.create({
          staticKey: this.#host.appKey,
          appVersion: this.#host.appVersion,
          appInstanceId: this.#host.appInstanceId,
          features: this.#host.features,
          pairing: this.#host.pairingHint(),
        });
        const welcome = this.#handshake.onCommit(value);
        this.#phase = "hello";
        this.#handshakeTimer = setTimeout(() => this.close("handshake deadline"), BRIDGE_LIMITS.handshakeTimeoutMs);
        this.#writeFrame(welcome);
        return;
      }
      case "hello": {
        if (!this.#handshake) throw new ChannelError("protocol", "no handshake");
        const answer = await this.#handshake.onHello(value, (installId, publicKey) =>
          this.#host.keyStatus(installId, publicKey),
        );
        if ("reject" in answer) {
          this.#rejectWith(answer.reject);
          return;
        }
        this.#hello = answer.hello;
        if (answer.keyStatus === "unknown") {
          // A key the app has never pinned: a pairing card, if one may show now; else `busy`.
          this.#admitted = this.#host.admitPairing(this);
          if (!this.#admitted) {
            this.#rejectWith({ k: "reject", code: "busy" });
            this.#host.refused(this);
            return;
          }
        }
        this.#writeFrame(answer.confirm);
        this.#phase = "confirm";
        return;
      }
      case "confirm": {
        if (!this.#handshake) throw new ChannelError("protocol", "no handshake");
        this.#established = await this.#handshake.onConfirm(value);
        if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
        this.#handshakeTimer = null;
        this.#handshake = null;
        if (this.#admitted) {
          this.#phase = "pairing";
          this.#startPairing(this.#admitted);
        } else {
          this.#phase = "ready";
          this.#host.ready(this);
        }
        return;
      }
      case "pairing":
      case "ready":
        await this.#onSealed(value);
        return;
      case "rejected":
        this.close("a frame came after a reject");
        return;
      case "closed":
        return;
    }
  }

  #rejectWith(reject: HandshakeMessage<"reject">) {
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
    this.#handshake = null;
    this.#phase = "rejected";
    this.#writeFrame(reject);
    this.#log(`chrome bridge: handshake refused (${reject.code})`);
  }

  /** A connection that was refused with `busy` waits idle; the service ends it when a pairing window opens. */
  get rejected(): boolean {
    return this.#phase === "rejected";
  }

  async #onSealed(value: unknown) {
    const channel = this.#established?.channel;
    if (!channel) throw new ChannelError("protocol", "no channel");
    const opened = await channel.open(value);
    if (!opened) return;
    const { message } = opened;
    if (isObject(message) && "t" in message && message.t === "res") {
      // A response: its body is checked once, against the operation of the request it answers.
      const envelope = decodeResponseEnvelope(message);
      if (!envelope.ok) throw new ChannelError("protocol", envelope.error);
      const { id, body, err } = envelope.value;
      if (!this.#pending.has(id)) throw new ChannelError("protocol", "a response answers no pending request");
      if (!this.#settle(id, err ? { error: err } : { body: body ?? {} }))
        throw new ChannelError("protocol", "a response body does not match its operation");
    } else {
      const features = this.#established?.features ?? [];
      const decoded = decodeToApp(message, features, () => undefined, {
        event: { ...eventHandlers((event, body) => this.#onEvent(event, body)), ready: (body) => this.#onReady(body) },
        result: resultHandlers(),
        error: () => undefined,
      });
      if (!decoded.ok) throw new ChannelError("protocol", decoded.error);
    }
    if (channel.needsNewKeys()) this.close("keys are due for renewal");
  }

  /** After its consent, the extension sends its state once, before the pin: it waits for the pin. */
  #onReady(body: EventBodies["ready"]) {
    const pairing = this.#pairing;
    if (this.#phase === "pairing" && pairing?.chromeOk && pairing.heldReady === null) {
      pairing.heldReady = body;
      return;
    }
    this.#onEvent("ready", body);
  }

  #onEvent<E extends ChromeBridgeEvent>(event: E, body: EventBodies[E]) {
    if (this.#phase === "pairing") {
      const pairing = this.#pairing;
      // Before the pin, the extension sends nothing but its own consent: no state, no page data.
      if (event !== "pair.chrome-ok" || !pairing || pairing.chromeOk)
        throw new ChannelError("protocol", "an event came before pairing");
      pairing.chromeOk = true;
      void this.#finishPairing();
      return;
    }
    if (event === "pair.chrome-ok") return;
    this.#host.event(this, event, body);
  }

  // -------------------------------------------------------------------------------------------------
  // Pairing

  #startPairing(reason: "window" | "unexpected") {
    const established = this.#established;
    const hello = this.#hello;
    if (!established || !hello) return;
    const { options, correctIndex } = pairingOptions(established.codes.chrome);
    const abort = new AbortController();
    this.#pairing = { abort, appChoseRight: false, chromeOk: false, finishing: false, heldReady: null };
    const deadline = setTimeout(() => this.close("pairing deadline"), BRIDGE_LIMITS.pairingWindowMs);
    abort.signal.addEventListener("abort", () => clearTimeout(deadline));
    this.#host.prompt
      .ask(
        {
          reason,
          options,
          appCode: established.codes.app,
          browser: hello.browser,
          profileLabel: hello.consent ? (hello.profileLabel ?? null) : null,
        },
        abort.signal,
      )
      .then((choice) => {
        if (!this.#pairing || abort.signal.aborted) return;
        const chosen = choice === null ? undefined : options[choice];
        if (choice !== correctIndex || !chosen || !samePairingCode(chosen, established.codes.chrome)) {
          this.#host.refused(this);
          this.close(choice === null ? "pairing cancelled in the app" : "the words did not match in the app");
          return;
        }
        this.#pairing.appChoseRight = true;
        void this.#finishPairing();
      })
      .catch(() => this.close("the pairing card failed"));
  }

  async #finishPairing() {
    const pairing = this.#pairing;
    const hello = this.#hello;
    if (!pairing || !hello || !pairing.appChoseRight || !pairing.chromeOk || pairing.finishing) return;
    pairing.finishing = true;
    let pinned = false;
    try {
      await this.#host.pinned(this, hello);
      pinned = true;
      this.#phase = "ready";
      await this.#send("pair.done", {}, { key: null, timeoutMs: BRIDGE_LIMITS.commandTimeoutMs });
      pairing.abort.abort();
      this.#pairing = null;
      this.#host.ready(this);
      if (pairing.heldReady) this.#host.event(this, "ready", pairing.heldReady);
    } catch {
      if (pinned) await this.#host.unpinned(this, hello).catch(() => undefined);
      this.close("pairing could not finish");
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Requests

  /**
   * Sends one operation and resolves with its result body. The operation must belong to a feature
   * that both sides announced, and its body is checked by the same decoder the extension runs.
   */
  request<O extends ChromeBridgeOperation>(
    op: O,
    body: OperationBodies[O],
    options: { key?: string; timeoutMs?: number } = {},
  ): Promise<ResultBodies[O]> {
    if (this.#phase !== "ready")
      return Promise.reject(new BridgeRequestError("chrome_not_connected", "Chrome is not connected."));
    return this.#send(op, body, {
      key: options.key ?? null,
      timeoutMs: options.timeoutMs ?? BRIDGE_LIMITS.commandTimeoutMs,
    });
  }

  #send<O extends ChromeBridgeOperation>(
    op: O,
    body: OperationBodies[O],
    options: { key: string | null; timeoutMs: number },
  ): Promise<ResultBodies[O]> {
    if (!this.features.includes(OPERATION_FEATURES[op]))
      return Promise.reject(new BridgeRequestError("method_denied", `The extension did not announce ${op}.`));
    const checked = decodeOperationBody(op, body);
    if (!checked.ok) return Promise.reject(new BridgeRequestError("param_denied", checked.error));
    if (this.#queuedBytes > CONNECTION_LIMITS.queuedBytes)
      return Promise.reject(new BridgeRequestError("limit", "Too much is waiting for Chrome."));
    return new Promise<ResultBodies[O]>((resolve, reject) => {
      const start = () => {
        const id = this.#nextId;
        this.#nextId += 1;
        this.#inFlight += 1;
        if (options.key !== null) this.#inFlightByKey.set(options.key, (this.#inFlightByKey.get(options.key) ?? 0) + 1);
        const pending: Pending = {
          op,
          key: options.key,
          accept: (raw) => {
            const decoded = decodeResultBody(op, raw);
            if (decoded.ok) resolve(decoded.value);
            return decoded.ok;
          },
          reject,
          timer: null,
        };
        this.#pending.set(id, pending);
        this.#seal({ t: "req", id, op, body })
          .then(() => {
            if (!this.#pending.has(id)) return;
            pending.timer = setTimeout(
              () => this.#settle(id, { error: { code: "timeout", message: `${op} took too long.` } }),
              options.timeoutMs,
            );
          })
          .catch(() => this.close("a message could not be sealed"));
      };
      if (this.#canStart(options.key)) start();
      else if (this.#waiting.length >= CONNECTION_LIMITS.waiting)
        reject(new BridgeRequestError("limit", "Too many requests are waiting for Chrome."));
      else this.#waiting.push({ key: options.key, start, fail: reject });
    });
  }

  #canStart(key: string | null): boolean {
    if (this.#inFlight >= CONNECTION_LIMITS.inFlight) return false;
    if (key !== null && (this.#inFlightByKey.get(key) ?? 0) >= CONNECTION_LIMITS.inFlightPerKey) return false;
    // Keep the order of one key: a later request of the same key does not pass an earlier one.
    return !this.#waiting.some((waiting) => key !== null && waiting.key === key);
  }

  /** Ends a request. False when its body does not match its operation, which breaks the protocol. */
  #settle(
    id: number,
    outcome: { body: unknown } | { error: { code: ChromeBridgeErrorCode; message: string } },
  ): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return true;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    this.#inFlight -= 1;
    if (pending.key !== null) {
      const count = (this.#inFlightByKey.get(pending.key) ?? 1) - 1;
      if (count <= 0) this.#inFlightByKey.delete(pending.key);
      else this.#inFlightByKey.set(pending.key, count);
    }
    let matched = true;
    if ("body" in outcome) matched = pending.accept(outcome.body);
    else pending.reject(new BridgeRequestError(outcome.error.code, outcome.error.message));
    if (!matched) pending.reject(new BridgeRequestError("cdp_error", "The extension answered with a wrong body."));
    this.#startWaiting();
    return matched;
  }

  #startWaiting() {
    for (let index = 0; index < this.#waiting.length; ) {
      const waiting = this.#waiting[index];
      if (!waiting) break;
      const earlierSameKey = this.#waiting
        .slice(0, index)
        .some((other) => waiting.key !== null && other.key === waiting.key);
      const fits =
        this.#inFlight < CONNECTION_LIMITS.inFlight &&
        (waiting.key === null || (this.#inFlightByKey.get(waiting.key) ?? 0) < CONNECTION_LIMITS.inFlightPerKey);
      if (!earlierSameKey && fits) {
        this.#waiting.splice(index, 1);
        waiting.start();
      } else index += 1;
      if (this.#inFlight >= CONNECTION_LIMITS.inFlight) break;
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Frames out

  async #seal(message: unknown) {
    const channel = this.#established?.channel;
    if (!channel) throw new ChannelError("protocol", "no channel");
    const frames = await channel.seal(message);
    for (const frame of frames) this.#writeFrame(frame);
  }

  #writeFrame(frame: OutgoingFrame) {
    if (this.#phase === "closed") return;
    const text = JSON.stringify(frame);
    // The host passes this frame to Chrome, which refuses a message from a host above 1 MB.
    if (!frameFits(text, "to-chrome")) {
      this.close("a frame for Chrome is too large");
      return;
    }
    const body = Buffer.from(text, "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.#out.push(head, body);
    this.#queuedBytes += 4 + body.length;
    this.#flush();
  }

  #flush() {
    if (this.#phase === "closed") return;
    while (this.#out.length > 0) {
      const next = this.#out.shift();
      if (!next) break;
      this.#queuedBytes -= next.length;
      if (!this.#socket.write(next)) {
        this.#draining = true;
        return;
      }
    }
    this.#draining = false;
  }

  get draining(): boolean {
    return this.#draining;
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** One handler for every event, keyed so the decoder can call it with the event's own body type. */
function eventHandlers(handle: <E extends ChromeBridgeEvent>(event: E, body: EventBodies[E]) => void): {
  readonly [E in ChromeBridgeEvent]: (body: EventBodies[E], seq: number) => void;
} {
  const make =
    <E extends ChromeBridgeEvent>(event: E) =>
    (body: EventBodies[E]) =>
      handle(event, body);
  return {
    ready: make("ready"),
    "cdp.event": make("cdp.event"),
    "tab.created": make("tab.created"),
    "tab.updated": make("tab.updated"),
    "tab.removed": make("tab.removed"),
    "tab.detached": make("tab.detached"),
    "tab.viewed": make("tab.viewed"),
    "tab.candidate": make("tab.candidate"),
    "tab.handed": make("tab.handed"),
    "tab.taken": make("tab.taken"),
    "tab.blocked": make("tab.blocked"),
    "tab.quarantined": make("tab.quarantined"),
    "tab.secret-present": make("tab.secret-present"),
    "group.removed": make("group.removed"),
    "group.moved": make("group.moved"),
    "group.renamed": make("group.renamed"),
    "group.shared": make("group.shared"),
    "user.stop": make("user.stop"),
    "user.resume": make("user.resume"),
    "user.unblock": make("user.unblock"),
    "pair.chrome-ok": make("pair.chrome-ok"),
    "ext.updating": make("ext.updating"),
    audit: make("audit"),
  };
}

/** Responses never reach `decodeToApp` here (see `#onSealed`); these handlers are never called. */
function resultHandlers(): { readonly [O in ChromeBridgeOperation]: (body: ResultBodies[O], id: number) => void } {
  const make =
    <O extends ChromeBridgeOperation>() =>
    (_body: ResultBodies[O], _id: number) =>
      undefined;
  return {
    "session.configure": make(),
    "group.ensure": make(),
    "group.update": make(),
    "group.release": make(),
    "lease.open": make(),
    "lease.close": make(),
    "tab.create": make(),
    "tab.claim": make(),
    "tab.release": make(),
    "tab.close": make(),
    "tab.activate": make(),
    "tab.history": make(),
    "tab.zoom": make(),
    "tab.discard": make(),
    "tab.mark": make(),
    "cdp.send": make(),
    "cdp.batch": make(),
    "script.run": make(),
    "secret.fill": make(),
    "project.pause": make(),
    "project.resume": make(),
    "stop.all": make(),
    resync: make(),
    ping: make(),
    "pair.done": make(),
  };
}
