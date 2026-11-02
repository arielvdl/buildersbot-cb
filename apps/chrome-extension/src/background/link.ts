/**
 * The one Native Messaging connection to the app (DESIGN §6). Every agent, project and window shares it:
 * requests carry an id, and the extension answers each one when its work ends, in any order, so a slow
 * command never holds a fast one.
 *
 * - The open port keeps the service worker alive (Chrome 105+), and so does an attached debugger (Chrome
 *   118+). There is no keepalive message and no polling.
 * - The host speaks first (`hello`), then says when the app is online. Then the handshake of
 *   `channel.ts` runs: commit, welcome, hello, confirm. After it, every frame is sealed.
 * - A new app key needs the person's choice of the words in the welcome page. Until then, only `ping`
 *   is answered.
 * - When the port closes, the extension tries again after 1 s, then by `chrome.alarms` (30 s, 1, 2, 5,
 *   15 and 30 min). A one-minute watchdog alarm brings the worker back if Chrome stopped it, and connects
 *   only when the wait of the current step has passed (the step is kept in session storage, so a worker
 *   that the alarm wakes does not start again at the first step).
 * - A new app key opens the welcome page by itself only when the app says that the person opened a
 *   pairing window there, and at most 3 times an hour; otherwise the icon shows "!" and the person
 *   opens it from the popup.
 * - 60 s with no app, the debugger leaves every tab; tabs and groups stay.
 */

import {
  ChannelError,
  type Established,
  ExtensionHandshake,
  HostFrameGate,
  type PairingCode,
  pairingOptions,
  type SealedChannel,
} from "@openbot/contracts/chrome-bridge/channel";
import {
  BRIDGE_LIMITS,
  CHROME_BRIDGE_FEATURES,
  type ChromeBridgeEvent,
  type ChromeBridgeFeature,
  decodeToExtension,
  EVENT_FEATURES,
  type EventBodies,
  MAX_TAB_LIMITS,
  NATIVE_HOST_NAMES,
  type RejectCode,
} from "@openbot/contracts/chrome-bridge/protocol";
import { isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import { detach, isAttached } from "./debugger";
import { type Consent, forgetPairing, installId, type Pin, readPairing, staticKey, writePairing } from "./keys";
import { operationHandlers } from "./operations";
import { audit, setEventSender } from "./outbox";
import { state } from "./state";
import { setLinkState } from "./stop";
import { BridgeError, chromeErrorText } from "./util";

/**
 * What this build implements. `tab-handoff` (handed tabs) is not in it yet, and `agent-scripts` (an
 * agent's own scripts) waits for a switch for each project in this popup: the app alone does not
 * turn scripts on.
 */
export const EXTENSION_FEATURES: readonly ChromeBridgeFeature[] = CHROME_BRIDGE_FEATURES.filter(
  (feature) => feature !== "tab-handoff" && feature !== "agent-scripts",
);

const HOST_NAME = NATIVE_HOST_NAMES[__BB_CHANNEL__];
const CONSENT_VERSION = 1;
const RETRY_ALARM = "bb-reconnect";
export const WATCHDOG_ALARM = "bb-watchdog";
const RETRY_MINUTES = [0.5, 1, 2, 5, 15, 30];
const LINK_KEY = "bb.link";
const WELCOME_OPENS_KEY = "bb.welcomeOpens";
const WELCOME_OPENS_PER_HOUR = 3;

interface Session {
  channel: SealedChannel;
  features: readonly string[];
  peerKey: string;
  /** False while the person has not chosen the words for a new app key. */
  trusted: boolean;
}

interface Pairing {
  chrome: PairingCode;
  options: PairingCode[];
  correctIndex: number;
  peerKey: string;
}

let port: chrome.runtime.Port | null = null;
let gate = new HostFrameGate();
let handshake: { run: ExtensionHandshake; stage: "welcome" | "confirm" } | null = null;
/** What the app said in its welcome: "new" while the person has a pairing window open there. */
let appHint: "known" | "new" = "known";
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
let session: Session | null = null;
let pairing: Pairing | null = null;
let inbound: Promise<void> = Promise.resolve();
let eventSeq = 0;
let retryStep = 0;
let lastAttemptAt = 0;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
/** After a wrong choice or "Not now", only a gesture of the person connects again. */
let heldForGesture = false;
let lastReject: RejectCode | null = null;
let lastError = "";
/** Times of the link, for the E2E report: when the worker started and when the last session opened. */
export const timings: { bootAt: number; readyAt: number; sessions: number; firstEvents: string[] } = {
  bootAt: Date.now(),
  readyAt: 0,
  sessions: 0,
  firstEvents: [],
};

/** Keeps the names of the first events of this worker, so a test can tell what woke it. */
export function noteEvent(name: string): void {
  if (timings.firstEvents.length < 8) timings.firstEvents.push(name);
}

export type ConnectCause = "start" | "alarm" | "gesture" | "event";

export function linkInfo() {
  return {
    connected: session?.trusted === true,
    port: port !== null,
    pairing: pairing ? { chrome: pairing.chrome, options: pairing.options } : null,
    heldForGesture,
    lastReject,
    lastError,
  };
}

export function connect(cause: ConnectCause): void {
  if (port) return;
  if (heldForGesture && cause !== "gesture") return;
  if (cause === "event" && Date.now() - lastAttemptAt < 5_000) return;
  heldForGesture = false;
  lastAttemptAt = Date.now();
  void saveLink();
  gate = new HostFrameGate();
  inbound = Promise.resolve();
  setLinkState("connecting");
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    lastError = chromeErrorText(error);
    port = null;
    setLinkState("no-host");
    scheduleRetry();
    return;
  }
  const opened = port;
  opened.onMessage.addListener((frame) => {
    if (port !== opened) return;
    inbound = inbound.then(() => onFrame(frame)).catch((error: unknown) => close(chromeErrorText(error)));
  });
  opened.onDisconnect.addListener(() => {
    if (port !== opened) return;
    lastError = chrome.runtime.lastError?.message ?? "the host closed the connection";
    port = null;
    endSession();
    setLinkState(/not found|forbidden/iu.test(lastError) ? "no-host" : "app-offline");
    startOfflineTimer();
    scheduleRetry();
  });
}

/** Closes the port on a broken protocol. Nothing is retried on the same keys. */
function close(reason: string): void {
  lastError = reason.slice(0, 300);
  const open = port;
  port = null;
  endSession();
  open?.disconnect();
  setLinkState("app-offline");
  startOfflineTimer();
  scheduleRetry();
}

function endSession(): void {
  session = null;
  handshake = null;
  pairing = null;
  setEventSender(null);
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  handshakeTimer = null;
}

/** The wait of the current retry step. */
function retryWaitMs(step: number): number {
  if (step <= 1) return 1_000;
  return (RETRY_MINUTES[Math.min(step - 2, RETRY_MINUTES.length - 1)] ?? 30) * 60_000;
}

function scheduleRetry(): void {
  if (heldForGesture) return;
  if (retryStep === 0) {
    retryStep = 1;
    void saveLink();
    setTimeout(() => connect("alarm"), 1_000);
    return;
  }
  const minutes = RETRY_MINUTES[Math.min(retryStep - 1, RETRY_MINUTES.length - 1)] ?? 30;
  retryStep += 1;
  void saveLink();
  void chrome.alarms.create(RETRY_ALARM, { delayInMinutes: minutes });
}

/** The retry step and the last attempt, for the next worker that an alarm wakes. */
async function saveLink(): Promise<void> {
  await chrome.storage.session.set({ [LINK_KEY]: { retryStep, lastAttemptAt } }).catch(() => undefined);
}

async function loadLink(): Promise<void> {
  const stored: { readonly [key: string]: unknown } = await chrome.storage.session.get(LINK_KEY).catch(() => ({}));
  const saved = stored[LINK_KEY];
  if (!isDynamicRecord(saved)) return;
  if (isNumber(saved.retryStep) && saved.retryStep > retryStep) retryStep = saved.retryStep;
  if (isNumber(saved.lastAttemptAt) && saved.lastAttemptAt > lastAttemptAt) lastAttemptAt = saved.lastAttemptAt;
}

function startOfflineTimer(): void {
  if (offlineTimer !== null) return;
  offlineTimer = setTimeout(() => {
    offlineTimer = null;
    if (session?.trusted) return;
    void Promise.all([...state.attachedTabIds].map((tabId) => detach(tabId, "lease_end")));
  }, BRIDGE_LIMITS.offlineDetachMs);
}

function post(frame: object): void {
  port?.postMessage(frame);
}

async function onFrame(frame: object): Promise<void> {
  if (HostFrameGate.isHostFrame(frame)) {
    const next = gate.accept(frame);
    if (next === "start-handshake") await startHandshake();
    else if (next === "app-offline") {
      endSession();
      setLinkState("app-offline");
      startOfflineTimer();
    }
    return;
  }
  if (handshake?.stage === "welcome") {
    const answer = await handshake.run.onWelcome(frame);
    if ("rejected" in answer) return rejected(answer.rejected);
    appHint = answer.welcome.pairing;
    handshake.stage = "confirm";
    for (const message of answer.frames) post(message);
    return;
  }
  if (handshake?.stage === "confirm") {
    const answer = await handshake.run.onConfirm(frame);
    if ("rejected" in answer) return rejected(answer.rejected);
    await opened(answer);
    return;
  }
  if (!session) throw new ChannelError("protocol", "a frame came with no session");
  const message = await session.channel.open(frame);
  if (message) onMessage(session, message.message);
}

async function startHandshake(): Promise<void> {
  const [key, id, { consent }] = await Promise.all([staticKey(), installId(), readPairing()]);
  const { handshake: run, commit } = await ExtensionHandshake.start({
    staticKey: key,
    extVersion: chrome.runtime.getManifest().version,
    installId: id,
    features: EXTENSION_FEATURES,
    browser: { brand: browserBrand(), version: chromeVersion() },
    ...(consent ? { consent } : {}),
  });
  handshake = { run, stage: "welcome" };
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  handshakeTimer = setTimeout(() => {
    if (handshake) close("the handshake took more than 5 s");
  }, BRIDGE_LIMITS.handshakeTimeoutMs);
  post(commit);
}

/** What the browser says it is. The app shows it as "reported by the extension"; it proves nothing. */
function browserBrand(): "google-chrome" | "chrome-for-testing" | "chromium" {
  if (__BB_CHANNEL__ === "e2e") return "chrome-for-testing";
  return /Google Chrome/u.test(navigator.userAgent) || __BB_CHANNEL__ === "store" || __BB_CHANNEL__ === "local"
    ? "google-chrome"
    : "chromium";
}

function chromeVersion(): string {
  return /Chrome\/([\d.]+)/u.exec(navigator.userAgent)?.[1]?.slice(0, 32) ?? "0";
}

/**
 * The app refused this handshake. A revoked key closes the port, and only a gesture of the person
 * connects again. Every other refusal keeps the port open and idle: closing it would make the host
 * connect again at once, in a loop (`busy` above all). The next `status` cycle of the host, when the
 * app opens a pairing window or restarts, starts a new handshake.
 */
function rejected(code: RejectCode): void {
  lastReject = code;
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  handshakeTimer = null;
  handshake = null;
  if (code === "revoked") {
    heldForGesture = true;
    close("the app revoked this Chrome");
    return;
  }
  if (code === "update_extension") chrome.runtime.requestUpdateCheck?.().catch(() => undefined);
  setLinkState("not-paired");
}

async function opened(established: Established): Promise<void> {
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  handshakeTimer = null;
  handshake = null;
  gate.sessionStarted();
  lastReject = null;
  const { pin } = await readPairing();
  const trusted = pin?.final === true && pin.appKey === established.peerKey;
  session = { channel: established.channel, features: established.features, peerKey: established.peerKey, trusted };
  setEventSender(sendEvent);
  if (trusted) {
    ready();
    return;
  }
  // A new app key: the person compares the words before anything else is answered.
  const choice = pairingOptions(established.codes.app);
  pairing = {
    chrome: established.codes.chrome,
    options: choice.options,
    correctIndex: choice.correctIndex,
    peerKey: established.peerKey,
  };
  setLinkState("not-paired");
  if (appHint === "new" && (await takeWelcomeOpen())) await showWelcome();
}

/** One of the 3 automatic openings of the welcome page in an hour; false when none is left. */
async function takeWelcomeOpen(): Promise<boolean> {
  const now = Date.now();
  const saved = (await chrome.storage.local.get(WELCOME_OPENS_KEY))[WELCOME_OPENS_KEY];
  const recent = (Array.isArray(saved) ? saved.filter(isNumber) : []).filter((at) => now - at < 60 * 60_000);
  if (recent.length >= WELCOME_OPENS_PER_HOUR) return false;
  await chrome.storage.local.set({ [WELCOME_OPENS_KEY]: [...recent, now] });
  return true;
}

/** The person asked to connect in the popup: a pairing that waits for the words opens the welcome page. */
export async function openPairingByPerson(): Promise<void> {
  if (pairing) await showWelcome();
}

function ready(): void {
  if (!session) return;
  retryStep = 0;
  void saveLink();
  if (offlineTimer !== null) clearTimeout(offlineTimer);
  offlineTimer = null;
  timings.readyAt = Date.now();
  timings.sessions += 1;
  setLinkState("connected");
  void sendEvent("ready", readyBody());
}

function readyBody(): EventBodies["ready"] {
  const groups = [...state.projects.values()]
    .filter((project) => project.groupId !== null && project.windowId !== null)
    .slice(0, 64)
    .map((project) => ({
      projectKey: project.projectKey,
      groupId: project.groupId ?? 0,
      windowId: project.windowId ?? 0,
      userTitle: project.userTitle,
      shared: project.shared,
    }));
  const tabs = [...state.tabs.values()].slice(0, MAX_TAB_LIMITS.tabsTotal);
  const handles = tabs.map((tab) => ({
    handle: tab.handle,
    projectKey: tab.projectKey,
    ...(tab.leaseId === null ? {} : { leaseId: tab.leaseId }),
    ...(tab.satelliteOf === null ? {} : { satellite: true }),
  }));
  const stopped: EventBodies["ready"]["stopped"] = [];
  if (state.stopAll !== null) stopped.push({ scope: "all", source: state.stopAll });
  for (const project of state.projects.values()) {
    if (project.pausedBy !== null && stopped.length < 65)
      stopped.push({ scope: "project", source: project.pausedBy, projectKey: project.projectKey });
  }
  return { groups, handles, attached: tabs.filter((tab) => isAttached(tab.tabId)).map((tab) => tab.handle), stopped };
}

/** Sends an event of a feature that both sides announced; others never leave. */
function sendEvent<E extends ChromeBridgeEvent>(op: E, body: EventBodies[E]): Promise<void> {
  const open = session;
  if (!open || (!open.trusted && op !== "pair.chrome-ok")) return Promise.resolve();
  if (!open.features.includes(EVENT_FEATURES[op])) return Promise.resolve();
  eventSeq += 1;
  return seal(open, { t: "evt", seq: eventSeq, op, body });
}

/** Seals a message and posts its frames; the promise settles when they are on the port. */
function seal(open: Session, message: object): Promise<void> {
  return open.channel.seal(message).then(
    (frames) => {
      if (session !== open) return;
      for (const frame of frames) post(frame);
    },
    (error: unknown) => close(chromeErrorText(error)),
  );
}

const handlers = operationHandlers({
  pairDone: async () => {
    // Only after the person chose the right words here: the provisional pin of this very key exists.
    const open = session;
    const { pin, consent } = await readPairing();
    if (!open?.trusted || !pin || pin.appKey !== open.peerKey || !consent)
      throw new BridgeError("consent_required", "the person has not chosen the words in Chrome");
    await writePairing({ appKey: open.peerKey, final: true }, consent);
  },
  ping: () => {
    // Counters ride on the app's ping: no timer of their own.
    void sendEvent("audit", { ...audit });
  },
});

/** Before the person chose the words, only a ping is answered. */
const UNTRUSTED_OPERATIONS = new Set(["ping"]);

function onMessage(open: Session, message: unknown): void {
  const id = isDynamicRecord(message) && isNumber(message.id) ? message.id : 0;
  const operation = isDynamicRecord(message) ? message.op : undefined;
  if (!open.trusted && !UNTRUSTED_OPERATIONS.has(String(operation))) {
    if (id > 0)
      void seal(open, {
        t: "res",
        id,
        err: { code: "consent_required", message: "the person has not paired this Chrome yet" },
      });
    return;
  }
  const answerError = (error: unknown) => {
    const err =
      error instanceof BridgeError
        ? { code: error.code, message: error.message.slice(0, 2048) }
        : { code: "cdp_error" as const, message: chromeErrorText(error) };
    void seal(open, { t: "res", id, err });
  };
  let decoded: ReturnType<typeof decodeToExtension<Promise<object>>>;
  try {
    decoded = decodeToExtension(message, open.features, handlers);
  } catch (error) {
    // The decode passed and a handler refused at once: that is an answer, not a broken protocol.
    answerError(error);
    return;
  }
  // A message that breaks the protocol closes the connection.
  if (!decoded.ok) throw new ChannelError("protocol", decoded.error);
  decoded.value.then((body) => seal(open, { t: "res", id, body }), answerError);
}

// ---------------------------------------------------------------------------------------------------
// Pairing in the welcome page

/** Opens the welcome page for the words, unless it is open. Reads only the extension's own pages. */
async function showWelcome(): Promise<void> {
  const url = chrome.runtime.getURL("welcome.html");
  const open = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  if (open.length > 0) return;
  await chrome.tabs.create({ url, active: true });
}

/** The person's choice in the welcome page. The right one pins the app key and gives consent. */
export async function choosePairing(index: number | null): Promise<"paired" | "mismatch" | "declined" | "none"> {
  const open = session;
  const current = pairing;
  if (!open || !current) return "none";
  pairing = null;
  if (index !== current.correctIndex) {
    heldForGesture = true;
    close(index === null ? "the person declined the pairing" : "the words did not match");
    return index === null ? "declined" : "mismatch";
  }
  const consent: Consent = { version: CONSENT_VERSION, at: Date.now() };
  const pin: Pin = { appKey: current.peerKey, final: false };
  await writePairing(pin, consent);
  open.trusted = true;
  void sendEvent("pair.chrome-ok", {});
  ready();
  return "paired";
}

export async function disconnectByPerson(): Promise<void> {
  heldForGesture = true;
  await forgetPairing();
  close("the person disconnected this Chrome");
}

export async function onAlarm(name: string): Promise<void> {
  noteEvent(`alarm:${name}`);
  if (name === RETRY_ALARM) connect("alarm");
  if (name === WATCHDOG_ALARM) await connectOnWake();
}

/**
 * A worker that Chrome started again (or that the watchdog woke) connects only when the wait of the
 * current retry step has passed: with no host or no app, it does not try at each wake.
 */
export async function connectOnWake(): Promise<void> {
  await loadLink();
  if (port) return;
  if (Date.now() - lastAttemptAt >= retryWaitMs(retryStep)) connect("alarm");
}
