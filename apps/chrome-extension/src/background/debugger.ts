/**
 * `chrome.debugger` for the agent tabs, and only for them. One debugger session for each tab, attached
 * at the first command of a lease and kept until the lease ends (DESIGN §5.4), so Chrome's debugging bar
 * does not flash at each tool call. Commands of all agents share bounded slots: at most
 * `inFlightPerTab` at once in a tab and `inFlightTotal` in the extension; a command that finds no slot
 * waits in a bounded queue, and a full queue refuses with `limit` instead of growing without end.
 *
 * Each frame target of another origin is checked against the floor when it attaches and when its URL
 * changes; a frame on the floor is detached at once and its session is refused from then on. Events
 * leave reduced to the closed fields of `projectCdpEvent`; no `Network.*` event ever leaves.
 */

import { ENGINE_WORLD_NAME, projectCdpEvent } from "@openbot/contracts/chrome-bridge/cdp-allowlist";
import { BRIDGE_LIMITS, TAB_TIMING } from "@openbot/contracts/chrome-bridge/protocol";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { floorDecision } from "./floor";
import { audit, emit } from "./outbox";
import { type AgentTab, persist, state, tabByChromeId } from "./state";
import { BridgeError, chromeErrorText, originOf, withDeadline } from "./util";

export interface CdpParams {
  readonly [key: string]: unknown;
}

export interface FrameTarget {
  targetId: string;
  url: string;
  blocked: boolean;
}

interface TabDebugger {
  attached: boolean;
  attaching: Promise<void> | null;
  /** Who waits for the tab to have no command in Chrome (`secret.fill`). */
  idle: Array<() => void>;
  /** Child sessions of frames of another process, by session id. */
  frames: Map<string, FrameTarget>;
  /**
   * The execution contexts that a command may name, by session (`MAIN` for the tab itself): the page's
   * own worlds and the engine's world. Context ids are counted per renderer process, so the same id
   * names another context in another session. Worlds of the extension's own (the secret check) and of
   * other extensions are never here.
   */
  contexts: Map<string, Set<number>>;
  /** Contexts of the extension's own worlds, by session: never named by a command. */
  reserved: Map<string, Set<number>>;
  inFlight: number;
  lastReattachAt: number;
  console: { second: number; count: number };
}

type DetachReason = "target_closed" | "canceled_by_user" | "site_blocked" | "memory" | "lease_end" | "person";

const tabs = new Map<number, TabDebugger>();
/** The detach count of each tab, kept after its record goes, so an attach in flight sees a detach. */
const generations = new Map<number, number>();
let globalInFlight = 0;
/** Commands that wait for a slot, in arrival order. A slot is taken for the waiter before it wakes. */
const waiters: Array<{ entry: TabDebugger; resolve: () => void }> = [];
/** The most commands that may wait for a slot, in the whole extension. */
const MAX_WAITING = 512;
const CONSOLE_PER_SECOND = 20;

function record(tabId: number): TabDebugger {
  let entry = tabs.get(tabId);
  if (!entry) {
    entry = {
      attached: false,
      attaching: null,
      idle: [],
      frames: new Map(),
      contexts: new Map(),
      reserved: new Map(),
      inFlight: 0,
      lastReattachAt: 0,
      console: { second: 0, count: 0 },
    };
    tabs.set(tabId, entry);
  }
  return entry;
}

export function isAttached(tabId: number): boolean {
  return tabs.get(tabId)?.attached === true;
}

export function frameTargets(tabId: number): ReadonlyMap<string, FrameTarget> {
  return tabs.get(tabId)?.frames ?? new Map();
}

/** The key of the tab's own session in the context maps. */
const MAIN = "";
const sessionKey = (session: string | undefined): string => session ?? MAIN;

function contextSet(map: Map<string, Set<number>>, session: string | undefined): Set<number> {
  const key = sessionKey(session);
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** The contexts that a command of this session may name. */
export function contextsOf(tabId: number, session: string | undefined): ReadonlySet<number> {
  return tabs.get(tabId)?.contexts.get(sessionKey(session)) ?? new Set();
}

/**
 * A world that a checked `Page.createIsolatedWorld` made in the tab. Chrome reports a new context only
 * to a session with `Runtime` on, and the engine does not turn it on; the answer names the context. A
 * context of the extension's own worlds is never taken.
 */
export function rememberContext(tabId: number, session: string | undefined, contextId: number): void {
  const entry = tabs.get(tabId);
  if (!entry || entry.reserved.get(sessionKey(session))?.has(contextId)) return;
  contextSet(entry.contexts, session).add(contextId);
}

/** A context of the extension's own world (the secret check, an agent script): no command names it. */
export function reserveContext(tabId: number, session: string | undefined, contextId: number): void {
  const entry = tabs.get(tabId);
  if (!entry) return;
  contextSet(entry.reserved, session).add(contextId);
  entry.contexts.get(sessionKey(session))?.delete(contextId);
}

/** Child sessions that a command may name: registered and not on the floor. */
export function openFrameSessions(tabId: number): Set<string> {
  const open = new Set<string>();
  for (const [sessionId, frame] of frameTargets(tabId)) if (!frame.blocked) open.add(sessionId);
  return open;
}

export function load(): { inFlight: number; waiting: number } {
  return { inFlight: globalInFlight, waiting: waiters.length };
}

/**
 * Attaches the debugger to an agent tab, once, however many commands ask at the same time. A detach
 * (a stop, a pause, the end of the lease) during the attach wins: the new session leaves at once and
 * the command fails.
 */
export function ensureAttached(tab: AgentTab): Promise<void> {
  const entry = record(tab.tabId);
  if (entry.attached) return Promise.resolve();
  if (entry.attaching) return entry.attaching;
  const generation = generations.get(tab.tabId) ?? 0;
  entry.attaching = (async () => {
    try {
      await chrome.debugger.attach({ tabId: tab.tabId }, "1.3");
    } catch (error) {
      const text = chromeErrorText(error);
      // Startup drops stale sessions. A competing debugger must not become our session.
      if (/Cannot access|Cannot attach|chrome:\/\/|policy/iu.test(text))
        throw new BridgeError("policy_blocks_debugger", "Chrome does not let the extension debug this tab");
      throw new BridgeError("cdp_error", `attach failed: ${text}`);
    }
    if ((generations.get(tab.tabId) ?? 0) !== generation) {
      await chrome.debugger.detach({ tabId: tab.tabId }).catch(() => undefined);
      throw new BridgeError("paused_by_user", "the tab was let go while the debugger attached");
    }
    entry.attached = true;
    entry.frames.clear();
    entry.contexts.clear();
    entry.reserved.clear();
    state.attachedTabIds.add(tab.tabId);
    persist();
    // Frames of another origin become targets of their own; the floor check needs to see each one.
    await internalCommand(tab.tabId, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    }).catch(() => undefined);
    await internalCommand(tab.tabId, "Inspector.enable", {}).catch(() => undefined);
    // An agent tab that Chrome discards in the middle of a lease would lose its page.
    await chrome.tabs.update(tab.tabId, { autoDiscardable: false }).catch(() => undefined);
  })().finally(() => {
    entry.attaching = null;
  });
  return entry.attaching;
}

/** Detaches the debugger from a tab, and tells the app why. An attach in flight leaves too. */
export async function detach(tabId: number, reason: DetachReason): Promise<void> {
  generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
  const entry = tabs.get(tabId);
  const wasAttached = entry?.attached === true || state.attachedTabIds.has(tabId);
  tabs.delete(tabId);
  state.attachedTabIds.delete(tabId);
  persist();
  if (!wasAttached) return;
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
  await chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => undefined);
  const tab = tabByChromeId(tabId);
  if (tab) emit("tab.detached", { handle: tab.handle, reason });
}

/**
 * After a restart of the worker, the sessions of the last one are dropped. The state of their frames
 * and contexts is gone with the old worker, so a clean attach at the next command is the safe way.
 */
export async function dropStaleSessions(): Promise<void> {
  const stale = [...state.attachedTabIds];
  state.attachedTabIds.clear();
  persist();
  await Promise.all(stale.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => undefined)));
}

function take(entry: TabDebugger): void {
  entry.inFlight += 1;
  globalInFlight += 1;
}

/** Waits for a slot of the tab and of the extension. A full queue refuses rather than grows. */
async function slot(entry: TabDebugger): Promise<void> {
  if (entry.inFlight < BRIDGE_LIMITS.inFlightPerTab && globalInFlight < BRIDGE_LIMITS.inFlightTotal) {
    take(entry);
    return;
  }
  if (waiters.length >= MAX_WAITING) throw new BridgeError("limit", "too many commands wait for Chrome; try again");
  await new Promise<void>((resolve) => {
    waiters.push({ entry, resolve });
  });
}

/** Frees a slot and gives free slots, in order, to the first waiters whose tab has room. */
function release(entry: TabDebugger): void {
  entry.inFlight -= 1;
  globalInFlight -= 1;
  if (entry.inFlight === 0) for (const wake of entry.idle.splice(0)) wake();
  for (let index = 0; index < waiters.length && globalInFlight < BRIDGE_LIMITS.inFlightTotal; ) {
    const waiter = waiters[index];
    if (waiter && waiter.entry.inFlight < BRIDGE_LIMITS.inFlightPerTab) {
      waiters.splice(index, 1);
      take(waiter.entry);
      waiter.resolve();
    } else index += 1;
  }
}

/** Resolves when no command of the tab is in Chrome. */
export function whenIdle(tabId: number): Promise<void> {
  const entry = tabs.get(tabId);
  if (!entry || entry.inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => entry.idle.push(resolve));
}

/** A command that Chrome has: `done` settles with its result. */
export interface Dispatched {
  readonly done: Promise<CdpParams>;
}

/**
 * Takes a slot and hands one command that passed the gate to Chrome. It resolves as soon as Chrome has
 * the command, so the caller can keep the order of a tab's commands without waiting for each result.
 * The deadline counts from the send to Chrome, not from the wait for a slot.
 */
export async function dispatch(
  tabId: number,
  method: string,
  params: CdpParams,
  session: string | undefined,
  urgent = false,
): Promise<Dispatched> {
  const entry = record(tabId);
  // An answer to a page dialog does not wait behind the commands that the dialog holds.
  if (urgent) take(entry);
  else await slot(entry);
  const target: chrome.debugger.Debuggee = session === undefined ? { tabId } : { tabId, sessionId: session };
  const timeout =
    method === "Page.captureScreenshot" ? BRIDGE_LIMITS.screenshotTimeoutMs : BRIDGE_LIMITS.commandTimeoutMs;
  const done = withDeadline(chrome.debugger.sendCommand(target, method, params), timeout, method)
    .then((result) => {
      audit.commands += 1;
      return asParams(result);
    })
    .catch((error: unknown) => {
      if (error instanceof BridgeError) throw error;
      const text = chromeErrorText(error);
      if (text.includes("not attached") || text.includes("Detached while")) {
        entry.attached = false;
        state.attachedTabIds.delete(tabId);
      }
      throw new BridgeError("cdp_error", text);
    })
    .finally(() => release(entry));
  return { done };
}

const asParams = (value: object | undefined): CdpParams => (isDynamicRecord(value) ? value : {});

/** A command of the extension's own, outside the gate: a fixed method with fixed parameters. */
export async function internalCommand(
  tabId: number,
  method: string,
  params: CdpParams,
  session?: string,
): Promise<CdpParams> {
  // A tab that is no longer an agent tab gets no new record (a late timer of a closed tab).
  if (!tabs.has(tabId) && !tabByChromeId(tabId)) throw new BridgeError("out_of_scope", "the tab is gone");
  return (await dispatch(tabId, method, params, session)).done;
}

// ---------------------------------------------------------------------------------------------------
// Events from Chrome

function checkFrame(tab: AgentTab, entry: TabDebugger, sessionId: string, url: string, targetId: string): void {
  const frame = entry.frames.get(sessionId) ?? { targetId, url, blocked: false };
  frame.url = url;
  entry.frames.set(sessionId, frame);
  if (frame.blocked || url === "" || url === "about:blank") return;
  const decision = floorDecision(url, tab.projectKey, true);
  if (!decision.blocked) return;
  frame.blocked = true;
  audit.blocked += 1;
  void chrome.debugger
    .sendCommand({ tabId: tab.tabId }, "Target.detachFromTarget", { sessionId })
    .catch(() => undefined);
  emit("tab.blocked", { handle: tab.handle, origin: originOf(url) ?? "null", rule: decision.rule });
}

type MainFrameCheck = (tab: AgentTab, url: string) => boolean;
let mainFrameOnFloor: MainFrameCheck = () => false;

/** The tabs module gives the check of a main frame URL (quarantine on the floor), to keep imports one way. */
export function setMainFrameCheck(check: MainFrameCheck): void {
  mainFrameOnFloor = check;
}

function forward(tab: AgentTab, method: string, params: { readonly [key: string]: unknown }, session?: string): void {
  const projected = projectCdpEvent(method, params);
  if (projected === null) return;
  const body =
    session === undefined
      ? { handle: tab.handle, method, params: projected }
      : { handle: tab.handle, method, params: projected, session };
  emit("cdp.event", body);
}

export function onDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params: { readonly [key: string]: unknown } = {},
): void {
  if (source.tabId === undefined) return;
  const tab = tabByChromeId(source.tabId);
  const entry = tabs.get(source.tabId);
  if (!tab || !entry) return;
  const session = source.sessionId;
  // Events of a frame on the floor never leave.
  if (session !== undefined && entry.frames.get(session)?.blocked === true) return;
  // A main frame that lands on the floor (the back-forward cache makes no request) goes to quarantine
  // at its first event, before `tabs.onUpdated`; nothing of it leaves.
  if (session === undefined && tab.quarantined) return;
  if (session === undefined && method === "Page.frameNavigated") {
    const frame = isDynamicRecord(params.frame) ? params.frame : {};
    if (frame.parentId === undefined && isString(frame.url) && mainFrameOnFloor(tab, frame.url)) return;
  }
  // A new document in the top frame of a session: the contexts of the last one are gone.
  if (method === "Page.frameNavigated" && isDynamicRecord(params.frame) && params.frame.parentId === undefined) {
    entry.contexts.delete(sessionKey(session));
    entry.reserved.delete(sessionKey(session));
  }
  switch (method) {
    case "Target.attachedToTarget":
    case "Target.targetInfoChanged": {
      const info = isDynamicRecord(params.targetInfo) ? params.targetInfo : {};
      const child = isString(params.sessionId) ? params.sessionId : findSession(entry, info.targetId);
      if (child === undefined || info.type !== "iframe") break;
      checkFrame(tab, entry, child, isString(info.url) ? info.url : "", isString(info.targetId) ? info.targetId : "");
      if (entry.frames.get(child)?.blocked) return;
      break;
    }
    case "Target.detachedFromTarget": {
      if (isString(params.sessionId)) {
        entry.contexts.delete(params.sessionId);
        entry.reserved.delete(params.sessionId);
        const frame = entry.frames.get(params.sessionId);
        // A blocked frame stays listed, so its session id is refused if the app still names it.
        if (frame && !frame.blocked) entry.frames.delete(params.sessionId);
        if (frame?.blocked) return;
      }
      break;
    }
    case "Runtime.executionContextCreated": {
      const context = isDynamicRecord(params.context) ? params.context : {};
      const aux = isDynamicRecord(context.auxData) ? context.auxData : {};
      // Only the page's own worlds and the engine's world: not the secret check's, not the content
      // scripts of another extension (a password manager's world is one of them).
      const pageWorld = aux.isDefault === true || aux.type === "default";
      if (!isNumber(context.id) || !(pageWorld || context.name === ENGINE_WORLD_NAME)) return;
      if (entry.reserved.get(sessionKey(session))?.has(context.id)) return;
      contextSet(entry.contexts, session).add(context.id);
      break;
    }
    case "Runtime.executionContextDestroyed":
      if (isNumber(params.executionContextId))
        entry.contexts.get(sessionKey(session))?.delete(params.executionContextId);
      break;
    case "Runtime.executionContextsCleared":
      entry.contexts.delete(sessionKey(session));
      entry.reserved.delete(sessionKey(session));
      break;
    case "Inspector.targetCrashed":
      emit("tab.updated", { handle: tab.handle, status: "unloaded" });
      void detach(tab.tabId, "target_closed");
      return;
    case "Log.entryAdded":
    case "Runtime.consoleAPICalled": {
      const second = Math.floor(Date.now() / 1000);
      if (entry.console.second !== second) entry.console = { second, count: 0 };
      entry.console.count += 1;
      if (entry.console.count > CONSOLE_PER_SECOND) return;
      break;
    }
  }
  forward(tab, method, params, session);
}

function findSession(entry: TabDebugger, targetId: unknown): string | undefined {
  for (const [sessionId, frame] of entry.frames) if (frame.targetId === targetId) return sessionId;
  return undefined;
}

type StopAll = (source: "infobar") => void;
let stopAllFromInfobar: StopAll = () => undefined;

export function setInfobarStop(action: StopAll): void {
  stopAllFromInfobar = action;
}

export function onDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
  if (source.tabId === undefined) return;
  const tabId = source.tabId;
  const entry = tabs.get(tabId);
  const tab = tabByChromeId(tabId);
  tabs.delete(tabId);
  state.attachedTabIds.delete(tabId);
  persist();
  if (!tab) return;
  if (reason === "canceled_by_user") {
    // The "Cancel" of Chrome's debugging bar detaches every tab of every extension: a stop of all.
    emit("tab.detached", { handle: tab.handle, reason: "canceled_by_user" });
    stopAllFromInfobar("infobar");
    return;
  }
  emit("tab.detached", { handle: tab.handle, reason: "target_closed" });
  // DevTools or a crash took the session while the tab lives: one new attach, not more than once
  // in a pause, while the lease is active.
  const lease = tab.leaseId === null ? undefined : state.leases.get(tab.leaseId);
  const now = Date.now();
  if (!lease?.active || (entry && now - entry.lastReattachAt < TAB_TIMING.reattachPauseMs)) return;
  setTimeout(() => {
    chrome.tabs
      .get(tabId)
      .then(() => ensureAttached(tab))
      .then(() => {
        record(tabId).lastReattachAt = Date.now();
      })
      .catch(() => undefined);
  }, TAB_TIMING.reattachDelayMs);
}

/** Forgets a tab that closed. */
export function forgetTab(tabId: number): void {
  tabs.delete(tabId);
  generations.delete(tabId);
  state.attachedTabIds.delete(tabId);
}
