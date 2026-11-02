/**
 * CDP commands of the agents (`cdp.send`, `cdp.batch`, `script.run`, `secret.fill`), each one through
 * the checks of DESIGN §6.5, in this order, failing closed:
 *
 * 1. no stop or pause holds the project;
 * 2. the handle exists, and its lease is open;
 * 3. Chrome says, now, that the tab is in the project's registered group (or is a satellite of one);
 * 4. the main frame is not on the floor; a child session is a registered frame and not on the floor;
 * 5. the method and each parameter pass the closed allowlist of `cdp-allowlist.ts`;
 * 6. a click over a frame on the floor is refused;
 * 7. reads that can show a secret run the secret check first.
 *
 * The commands of one tab keep their order: each one passes the gate and reaches Chrome before the next
 * one starts its gate. They do not wait for each other's result, so a tab still has up to
 * `inFlightPerTab` commands in Chrome at once, and different tabs run side by side. At most
 * `MAX_CHAIN` commands of one tab wait in its order; more get `limit`. The answer to a page dialog does
 * not wait in that order: the commands before it may be the ones that the dialog holds.
 *
 * A tab that Chrome discarded loads again before a command reaches it, so a read never gets the empty
 * page of a discarded tab.
 */

import { type CdpCheckContext, checkCdpCommand } from "@openbot/contracts/chrome-bridge/cdp-allowlist";
import { ENGINE_GESTURE_FUNCTIONS } from "@openbot/contracts/chrome-bridge/cdp-functions";
import { BRIDGE_LIMITS, type ChromeBridgeErrorCode } from "@openbot/contracts/chrome-bridge/protocol";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  type CdpParams,
  contextsOf,
  type Dispatched,
  detach,
  dispatch,
  ensureAttached,
  frameTargets,
  internalCommand,
  openFrameSessions,
  rememberContext,
} from "./debugger";
import { floorDecision } from "./floor";
import { audit, emit } from "./outbox";
import { fillSecret, pageMayChange, secretPresent } from "./secrets";
import type { AgentTab, Project } from "./state";
import { state } from "./state";
import {
  noteUsed,
  requireActiveLease,
  requireInGroup,
  requireProject,
  requireRunning,
  requireTab,
  takeNavigation,
  touch,
  waitForComplete,
} from "./tabs";
import { BridgeError, chromeErrorText, originOf } from "./util";

interface Gate {
  tab: AgentTab;
  project: Project;
  /** The origin of the main frame when the gate passed. */
  origin: string | null;
}

const chains = new Map<number, Promise<void>>();
/** Steps of each tab that wait in its order or run their gate. */
const chainDepth = new Map<number, number>();
const MAX_CHAIN = 64;

/**
 * Runs `step` after the earlier steps of the same tab. A step resolves once its commands are in
 * Chrome; their results settle later, outside the chain.
 */
function sequenced<T>(tabId: number, step: () => Promise<{ readonly done: Promise<T> }>): Promise<T> {
  const depth = chainDepth.get(tabId) ?? 0;
  if (depth >= MAX_CHAIN) return Promise.reject(new BridgeError("limit", "too many commands wait for this tab"));
  chainDepth.set(tabId, depth + 1);
  const before = chains.get(tabId) ?? Promise.resolve();
  const started = before.then(step);
  const link = started.then(
    () => undefined,
    () => undefined,
  );
  chains.set(tabId, link);
  void link.then(() => {
    const left = (chainDepth.get(tabId) ?? 1) - 1;
    if (left <= 0) chainDepth.delete(tabId);
    else chainDepth.set(tabId, left);
    if (chains.get(tabId) === link) chains.delete(tabId);
  });
  return started.then((step) => step.done);
}

/** A tab that Chrome discarded, or that never loaded, loads again and its load ends first. */
async function loadIfDiscarded(tabId: number, chromeTab: chrome.tabs.Tab): Promise<chrome.tabs.Tab> {
  if (chromeTab.discarded !== true && chromeTab.status !== "unloaded") return chromeTab;
  const complete = waitForComplete(tabId, BRIDGE_LIMITS.commandTimeoutMs);
  await chrome.tabs.reload(tabId);
  await complete;
  return chrome.tabs.get(tabId);
}

async function authorize(handle: string): Promise<Gate> {
  const tab = requireTab(handle);
  const project = requireProject(tab.projectKey);
  requireRunning(project);
  const lease = requireActiveLease(tab.leaseId);
  let chromeTab: chrome.tabs.Tab;
  try {
    chromeTab = await chrome.tabs.get(tab.tabId);
  } catch {
    throw new BridgeError("out_of_scope", "the tab is closed");
  }
  await requireInGroup(chromeTab, tab, project);
  if (tab.quarantined) throw new BridgeError("site_blocked", "the tab shows a site that agents may not use");
  chromeTab = await loadIfDiscarded(tab.tabId, chromeTab);
  for (const url of [chromeTab.url, chromeTab.pendingUrl]) {
    if (url === undefined || url === "" || url === "about:blank") continue;
    const decision = floorDecision(url, tab.projectKey);
    if (decision.blocked) throw new BridgeError("site_blocked", `the page is blocked (${decision.rule})`);
  }
  touch(tab, lease, project);
  noteUsed(tab);
  await ensureAttached(tab);
  // A stop, a pause or the end of the lease while the debugger attached: the command does not run.
  try {
    requireRunning(project);
    requireActiveLease(tab.leaseId);
  } catch (error) {
    await detach(tab.tabId, "person");
    throw error;
  }
  return { tab, project, origin: originOf(chromeTab.url) };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const READS = new Set(["Page.captureScreenshot", "Accessibility.getFullAXTree", "Accessibility.getPartialAXTree"]);
const CLICKS = new Set(["mousePressed", "mouseReleased"]);
const fileChooserTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Checks one command with the context of its call. It throws the denial; it returns whether to skip it. */
async function check(
  gate: Gate,
  method: string,
  params: CdpParams,
  session: string | undefined,
  operation: CdpCheckContext["operation"],
): Promise<{ noOp: boolean }> {
  const { tab } = gate;
  if (session !== undefined && frameTargets(tab.tabId).get(session)?.blocked === true) {
    audit.denied += 1;
    throw new BridgeError("site_blocked", "the frame is a site that agents may not use");
  }
  const declaration = params.functionDeclaration;
  const context: CdpCheckContext = {
    operation,
    agentTab: tab.createdBy !== "person",
    contexts: contextsOf(tab.tabId),
    childSessions: openFrameSessions(tab.tabId),
    functionDigest: params.userGesture === true && isString(declaration) ? await sha256Hex(declaration) : undefined,
    gestureFunctions: ENGINE_GESTURE_FUNCTIONS,
    floor: { added: state.policyAdd, unlocked: state.unlocks.get(tab.projectKey) ?? [] },
    raiseTabs: false,
  };
  const decision = checkCdpCommand(method, params, session, context);
  if (!decision.ok) {
    audit.denied += 1;
    throw new BridgeError(decision.code, decision.reason);
  }
  if (method === "Page.navigate" && isString(params.url)) takeNavigation(tab.projectKey, params.url);
  if (decision.historyFloorCheck && isNumber(params.entryId)) await checkHistoryEntry(tab, params.entryId);
  // Only a read keeps the last clean secret check of the tab: any other command can change the page.
  if (!READS.has(method)) pageMayChange(tab.tabId);
  if (decision.secretCheck && (await secretPresent(tab.tabId))) {
    emit("tab.secret-present", { handle: tab.handle });
    throw new BridgeError("secret_present", "the page holds a secret that was not typed by secret.fill");
  }
  if (method === "Input.dispatchKeyEvent" && isPasteKey(params)) {
    audit.denied += 1;
    throw new BridgeError("param_denied", "a paste key would hand the page the person's clipboard");
  }
  if (method === "Input.dispatchMouseEvent" && isString(params.type) && CLICKS.has(params.type))
    await checkClickTarget(tab.tabId, params.x, params.y);
  if (method === "Page.setInterceptFileChooserDialog") boundFileChooser(tab.tabId, params.enabled === true);
  return { noOp: decision.noOp };
}

const CONTROL = 2;
const META = 4;
const SHIFT = 8;

/**
 * Ctrl+V, Cmd+V and Shift+Insert paste the person's clipboard into the page, like the `paste` command
 * that the allowlist already refuses. The engine types text with `Input.insertText`, never with these.
 */
function isPasteKey(params: CdpParams): boolean {
  const modifiers = isNumber(params.modifiers) ? params.modifiers : 0;
  const key = isString(params.key) ? params.key.toLowerCase() : "";
  const code = isString(params.code) ? params.code : "";
  const virtual = isNumber(params.windowsVirtualKeyCode) ? params.windowsVirtualKeyCode : 0;
  const isV = key === "v" || code === "KeyV" || virtual === 86;
  const isInsert = key === "insert" || code === "Insert" || virtual === 45;
  return ((modifiers & (CONTROL | META)) !== 0 && isV) || ((modifiers & SHIFT) !== 0 && isInsert);
}

async function checkHistoryEntry(tab: AgentTab, entryId: number): Promise<void> {
  const history = await internalCommand(tab.tabId, "Page.getNavigationHistory", {});
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const entry = entries.find((item) => isDynamicRecord(item) && item.id === entryId);
  const url = isDynamicRecord(entry) && isString(entry.url) ? entry.url : "";
  if (url === "" || floorDecision(url, tab.projectKey).blocked)
    throw new BridgeError("site_blocked", "the history entry is a site that agents may not use");
}

/** A click at a point over a frame on the floor is refused, also when the frame is out of process. */
async function checkClickTarget(tabId: number, x: unknown, y: unknown): Promise<void> {
  const blocked = [...frameTargets(tabId).values()].filter((frame) => frame.blocked);
  if (blocked.length === 0 || !isNumber(x) || !isNumber(y)) return;
  try {
    const at = await internalCommand(tabId, "DOM.getNodeForLocation", {
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      ignorePointerEventsNone: true,
    });
    if (!isNumber(at.backendNodeId)) return;
    const described = await internalCommand(tabId, "DOM.describeNode", { backendNodeId: at.backendNodeId });
    const node = isDynamicRecord(described.node) ? described.node : {};
    if (isString(node.frameId) && blocked.some((frame) => frame.targetId === node.frameId))
      throw new BridgeError("site_blocked", "the click is over a frame of a site that agents may not use");
  } catch (error) {
    if (error instanceof BridgeError && error.code === "site_blocked") throw error;
    throw new BridgeError("site_blocked", `the click target could not be checked: ${chromeErrorText(error)}`);
  }
}

/** The file chooser of a tab is caught only for an upload: it is let go after 30 s at most. */
function boundFileChooser(tabId: number, enabled: boolean): void {
  const timer = fileChooserTimers.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  fileChooserTimers.delete(tabId);
  if (!enabled) return;
  fileChooserTimers.set(
    tabId,
    setTimeout(() => {
      fileChooserTimers.delete(tabId);
      // A closed tab gets no command: `internalCommand` refuses a tab that is not an agent tab.
      void internalCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
    }, 30_000),
  );
}

// ---------------------------------------------------------------------------------------------------
// Results

const paramsOf = (value: unknown): CdpParams => (isDynamicRecord(value) ? value : {});

const stripFragment = (url: unknown): string => {
  if (!isString(url)) return "";
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
};

/** DOM nodes name their document's URL; a fragment there can hold a token too. */
function nodeWithoutFragments(node: CdpParams, depth = 0): CdpParams {
  const out: { [key: string]: unknown } = { ...node };
  if (isString(node.documentURL)) out.documentURL = stripFragment(node.documentURL);
  if (isString(node.baseURL)) out.baseURL = stripFragment(node.baseURL);
  if (depth > 64) return out;
  if (isDynamicRecord(node.contentDocument))
    out.contentDocument = nodeWithoutFragments(node.contentDocument, depth + 1);
  if (Array.isArray(node.children))
    out.children = node.children.map((child) => nodeWithoutFragments(paramsOf(child), depth + 1));
  return out;
}

function frameTreeWithoutFragments(tree: CdpParams): CdpParams {
  const frame = isDynamicRecord(tree.frame) ? { ...tree.frame, url: stripFragment(tree.frame.url) } : tree.frame;
  if (!Array.isArray(tree.childFrames)) return { ...tree, frame };
  return { ...tree, frame, childFrames: tree.childFrames.map((child) => frameTreeWithoutFragments(paramsOf(child))) };
}

/**
 * Results that name URLs leave without fragments (a fragment can hold a token), and history entries of
 * floor sites leave without their URL and title.
 */
function projectResult(method: string, result: CdpParams, projectKey: string): CdpParams {
  if ((method === "DOM.getDocument" || method === "DOM.describeNode") && isDynamicRecord(result.root ?? result.node)) {
    const key = method === "DOM.getDocument" ? "root" : "node";
    return { ...result, [key]: nodeWithoutFragments(paramsOf(result[key])) };
  }
  if (method === "Page.getFrameTree")
    return { ...result, frameTree: frameTreeWithoutFragments(paramsOf(result.frameTree)) };
  if (method === "Page.getNavigationHistory" && Array.isArray(result.entries)) {
    const entries = result.entries.map((entry) => {
      if (!isDynamicRecord(entry)) return entry;
      const url = stripFragment(entry.url);
      if (url !== "" && url !== "about:blank" && floorDecision(url, projectKey).blocked)
        return { ...entry, url: "about:blank", userTypedURL: "about:blank", title: "" };
      return { ...entry, url, userTypedURL: stripFragment(entry.userTypedURL) };
    });
    return { ...result, entries };
  }
  if (
    method === "Page.captureScreenshot" &&
    isString(result.data) &&
    (result.data.length * 3) / 4 > BRIDGE_LIMITS.maxScreenshotBytes
  )
    throw new BridgeError("cdp_error", "the screenshot is larger than 8 MB");
  return result;
}

/** A read whose page changed origin while it ran is dropped: it may hold the new site's content. */
async function sameOrigin(gate: Gate): Promise<void> {
  const now = await chrome.tabs.get(gate.tab.tabId).then(
    (tab) => originOf(tab.url),
    () => null,
  );
  if (now !== gate.origin) throw new BridgeError("cdp_error", "origin_changed: the page changed during the read");
}

async function settle(gate: Gate, method: string, sent: Dispatched): Promise<CdpParams> {
  const result = projectResult(method, await sent.done, gate.tab.projectKey);
  if (READS.has(method)) await sameOrigin(gate);
  if (method === "Page.createIsolatedWorld" && isNumber(result.executionContextId))
    rememberContext(gate.tab.tabId, result.executionContextId);
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Operations

export function cdpSend(
  handle: string,
  method: string,
  params: unknown,
  session: string | undefined,
): Promise<{ result: CdpParams }> {
  const tab = requireTab(handle);
  if (method === "Page.handleJavaScriptDialog") return answerDialog(handle, params, session);
  return sequenced(tab.tabId, async () => {
    const gate = await authorize(handle);
    const values = paramsOf(params);
    const { noOp } = await check(
      gate,
      method,
      values,
      session,
      method === "Page.navigate" ? "navigate" : method === "Page.setInterceptFileChooserDialog" ? "upload" : "other",
    );
    if (noOp) return { done: Promise.resolve({ result: {} }) };
    const sent = await dispatch(gate.tab.tabId, method, values, session);
    return { done: settle(gate, method, sent).then((result) => ({ result })) };
  });
}

/**
 * The answer to a page dialog, outside the tab's order and its slots: the commands before it (a click
 * that opened `confirm()`) wait for it, so it cannot wait for them.
 */
async function answerDialog(
  handle: string,
  params: unknown,
  session: string | undefined,
): Promise<{ result: CdpParams }> {
  const gate = await authorize(handle);
  const values = paramsOf(params);
  await check(gate, "Page.handleJavaScriptDialog", values, session, "other");
  const sent = await dispatch(gate.tab.tabId, "Page.handleJavaScriptDialog", values, session, true);
  return { result: await settle(gate, "Page.handleJavaScriptDialog", sent) };
}

type BatchResult = { result?: CdpParams; err?: { code: ChromeBridgeErrorCode; message: string } };

/**
 * Several independent commands in one message, with one answer that holds the result or the error of
 * each. Each command passes the same checks. `Network.enable` and its kin pass only in a batch that
 * also navigates, which is how the engine's `navigate` sends them.
 */
export function cdpBatch(
  handle: string,
  commands: readonly { method: string; params: unknown; session?: string }[],
): Promise<{ results: BatchResult[] }> {
  const tab = requireTab(handle);
  return sequenced(tab.tabId, async () => {
    const gate = await authorize(handle);
    const operation = commands.some((command) => command.method === "Page.navigate") ? "navigate" : "other";
    const pending: Promise<BatchResult>[] = [];
    for (const command of commands) {
      const values = paramsOf(command.params);
      try {
        const { noOp } = await check(gate, command.method, values, command.session, operation);
        if (noOp) {
          pending.push(Promise.resolve({ result: {} }));
          continue;
        }
        const sent = await dispatch(gate.tab.tabId, command.method, values, command.session);
        pending.push(settle(gate, command.method, sent).then((result) => ({ result }), toErr));
      } catch (error) {
        pending.push(Promise.resolve(toErr(error)));
      }
    }
    return { done: Promise.all(pending).then((results) => ({ results })) };
  });
}

function toErr(error: unknown): BatchResult {
  if (error instanceof BridgeError) return { err: { code: error.code, message: error.message.slice(0, 2048) } };
  return { err: { code: "cdp_error", message: chromeErrorText(error) } };
}

const AGENT_WORLD = "builders-bot-agent";

/**
 * An agent's own script, never with a user gesture. The app turns this on per project; the extension
 * still runs the secret check first and drops the result when the page changed origin meanwhile.
 */
export function runScript(
  handle: string,
  source: string,
  args: unknown,
  world: "isolated" | "main",
  session: string | undefined,
): Promise<{ value: unknown }> {
  const tab = requireTab(handle);
  return sequenced(tab.tabId, async () => {
    if (session !== undefined) throw new BridgeError("param_denied", "scripts run in the main frame only");
    const gate = await authorize(handle);
    if (await secretPresent(gate.tab.tabId)) {
      emit("tab.secret-present", { handle });
      throw new BridgeError("secret_present", "the page holds a secret that was not typed by secret.fill");
    }
    let contextId: number | undefined;
    if (world === "isolated") {
      const tree = await internalCommand(gate.tab.tabId, "Page.getFrameTree", {});
      const frame = paramsOf(paramsOf(tree.frameTree).frame);
      const created = await internalCommand(gate.tab.tabId, "Page.createIsolatedWorld", {
        frameId: isString(frame.id) ? frame.id : "",
        worldName: AGENT_WORLD,
        grantUniveralAccess: false,
      });
      contextId = isNumber(created.executionContextId) ? created.executionContextId : undefined;
      if (contextId === undefined) throw new BridgeError("cdp_error", "no isolated world for the script");
    }
    const argumentList = Array.isArray(args) ? args : [args];
    const expression = `(${source})(...${JSON.stringify(argumentList)})`;
    const sent = await dispatch(
      gate.tab.tabId,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
        ...(contextId === undefined ? {} : { contextId }),
      },
      undefined,
    );
    const done = sent.done.then(async (answer) => {
      await sameOrigin(gate);
      if (answer.exceptionDetails !== undefined) throw new BridgeError("cdp_error", "the script threw an error");
      const value = paramsOf(answer.result).value ?? null;
      if (JSON.stringify(value).length > 64 * 1024)
        throw new BridgeError("cdp_error", "the script result is larger than 64 KB");
      return { value };
    });
    return { done };
  });
}

/** One atomic step: no other command of the tab runs until it ends. */
export function secretFill(handle: string, expectOrigin: string, nodeId: number, text: string): Promise<void> {
  const tab = requireTab(handle);
  return sequenced(tab.tabId, async () => {
    const gate = await authorize(handle);
    await fillSecret(gate.tab.tabId, expectOrigin, nodeId, text);
    return { done: Promise.resolve() };
  });
}
