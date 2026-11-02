/**
 * Secrets in the page (DESIGN §6.5 check 7, `secret.fill`).
 *
 * The check runs in an isolated world of the extension's own, in every frame of the tab: the frames of
 * the main session and the frames of each child session (a frame of another site, such as the card
 * fields of a payment provider). It looks for a password, one-time code or card field with a value: in
 * each document and its open shadow roots from the guard world, and in closed shadow roots from a DOM
 * snapshot of the session (`DOMSnapshot.captureSnapshot`, which reads them as the accessibility tree and
 * a screenshot do). A page past `MAX_WALK` elements, or a snapshot that fails, counts as a secret: the
 * check fails closed, so a very large page refuses reads. Chrome's password manager and autofill fill such fields, and a
 * screenshot, an accessibility tree or a read of the page would then carry the value. The check reads
 * the value but never sends it anywhere.
 *
 * - A field that `secret.fill` typed does not count only for a read that shows it masked (a screenshot,
 *   the accessibility tree), and only while it is still the password field that it was. Any other read
 *   (page code, the DOM) is strict: every secret counts.
 * - No command of the agents can reach the guard world: its name is not one that a command may give,
 *   and its contexts are never ones that a command may name (`reserveContext`).
 *
 * - The world is made again for each check (`Page.createIsolatedWorld` gives the same world of a frame
 *   back), never taken from a cache: a context id names another document after a navigation.
 * - A frame that the check cannot reach counts as a secret (fail closed). A frame on the floor is
 *   detached and not checked: no read reaches it.
 * - A clean result holds for one second, and only until the next command that can change the page.
 *
 * `secret.fill` is one atomic step: the tab's commands in Chrome end first, and no other command of the
 * tab runs in between. The text never comes back in a result, an event, an error or a log.
 */

import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { frameTargets, internalCommand, reserveContext, whenIdle } from "./debugger";
import { BridgeError, originOf } from "./util";

const GUARD_WORLD = "builders-bot-guard";
const CLEAN_FOR_MS = 1_000;

/**
 * What the last check of each tab found, until a command that can change the page: 0 no secret, 1 only
 * passwords that `secret.fill` typed, still in their password fields.
 */
const cleanAt = new Map<number, { at: number; level: 0 | 1 }>();

const SECRET_FIELDS =
  'input[type="password" i],input[autocomplete~="one-time-code" i],input[autocomplete^="cc-" i],input[autocomplete*=" cc-" i]';
/** The fields that `secret.fill` typed, with what they were then: element to "type|autocomplete". */
const FILLED = "__bbFilledFields";
/**
 * Elements past which the walk for open shadow roots stops, and the page counts as holding a secret
 * (fail closed). A time budget in place of a count would let larger pages through on a fast computer.
 */
const MAX_WALK = 100_000;

/**
 * 2 when a frame holds a secret, 1 when it holds only passwords that `secret.fill` typed and that are
 * still password fields as they were, 0 when it holds neither. A typed field that changed (its type,
 * its autocomplete, or no longer a secret field) is a secret: a screenshot would show its value.
 */
const CHECK = `(() => {
  const fields = ${JSON.stringify(SECRET_FIELDS)};
  const filled = globalThis[${JSON.stringify(FILLED)}];
  const signature = (field) => String(field.type) + "|" + String(field.getAttribute("autocomplete") ?? "");
  const masked = (field) => {
    const kept = filled instanceof Map ? filled.get(field) : undefined;
    return kept !== undefined && kept === signature(field) && field.type === "password";
  };
  let level = 0;
  const roots = [document];
  let walked = 0;
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    for (const field of root.querySelectorAll(fields)) {
      if (field.value === "" && (field.getAttribute("value") ?? "") === "") continue;
      if (!masked(field)) return 2;
      level = 1;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      walked += 1;
      // A page this large is not read to its end: it counts as a secret (fail closed).
      if (walked > ${MAX_WALK}) return 2;
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }
  if (filled instanceof Map)
    for (const field of filled.keys()) {
      if (!field.isConnected || field.value === "") continue;
      if (!field.matches(fields) || !masked(field)) return 2;
      level = 1;
    }
  return level;
})()`;

/** The ids of every frame in a session's frame tree. */
function frameIds(tree: unknown): string[] {
  const ids: string[] = [];
  const pending: unknown[] = [tree];
  while (pending.length > 0 && ids.length < 256) {
    const node = pending.pop();
    if (!isDynamicRecord(node)) continue;
    const frame = isDynamicRecord(node.frame) ? node.frame : {};
    if (isString(frame.id)) ids.push(frame.id);
    if (Array.isArray(node.childFrames)) pending.push(...node.childFrames);
  }
  return ids;
}

/** The guard world of one frame, made now. No command of the agents may name its context. */
async function guardWorld(tabId: number, frameId: string, session: string | undefined): Promise<number> {
  const world = await internalCommand(
    tabId,
    "Page.createIsolatedWorld",
    { frameId, worldName: GUARD_WORLD, grantUniveralAccess: false },
    session,
  );
  if (!isNumber(world.executionContextId)) throw new BridgeError("cdp_error", "no isolated world");
  reserveContext(tabId, session, world.executionContextId);
  return world.executionContextId;
}

const SECRET_AUTOCOMPLETE = /(^|\s)(one-time-code|cc-[a-z-]+)(\s|$)/iu;

/**
 * Whether a closed shadow root of this session holds a secret field with a value. The guard world
 * cannot open a closed shadow root; a DOM snapshot reads the documents of the session (frames of
 * another process have a session of their own), their shadow roots and the value of each input.
 */
async function closedShadowSecret(tabId: number, session: string | undefined): Promise<boolean> {
  const snapshot = await internalCommand(tabId, "DOMSnapshot.captureSnapshot", { computedStyles: [] }, session);
  const strings = Array.isArray(snapshot.strings) ? snapshot.strings : [];
  const text = (index: unknown): string => (isNumber(index) && isString(strings[index]) ? strings[index] : "");
  const documents = Array.isArray(snapshot.documents) ? snapshot.documents : [];
  for (const document of documents) {
    const nodes = isDynamicRecord(document) && isDynamicRecord(document.nodes) ? document.nodes : null;
    if (!nodes) throw new BridgeError("cdp_error", "the DOM snapshot has no nodes");
    const parents = Array.isArray(nodes.parentIndex) ? nodes.parentIndex : [];
    const names = Array.isArray(nodes.nodeName) ? nodes.nodeName : [];
    const attributes = Array.isArray(nodes.attributes) ? nodes.attributes : [];
    const rare = (key: string): Map<number, unknown> => {
      const data = isDynamicRecord(nodes[key]) ? nodes[key] : {};
      const indexes = Array.isArray(data.index) ? data.index : [];
      const values = Array.isArray(data.value) ? data.value : [];
      return new Map(indexes.map((node, position) => [Number(node), values[position]]));
    };
    const closedRoots = new Set(
      [...rare("shadowRootType")].filter(([, value]) => text(value) === "closed").map(([node]) => node),
    );
    if (closedRoots.size === 0) continue;
    const inClosed = new Map<number, boolean>();
    const underClosedRoot = (start: number): boolean => {
      const path: number[] = [];
      let found = false;
      for (let node = start; node >= 0 && path.length < 4096; node = Number(parents[node] ?? -1)) {
        const known = inClosed.get(node);
        if (known !== undefined) {
          found = known;
          break;
        }
        path.push(node);
        if (closedRoots.has(node)) {
          found = true;
          break;
        }
      }
      for (const node of path) inClosed.set(node, found);
      return found;
    };
    for (const [node, value] of rare("inputValue")) {
      if (text(value) === "" || text(names[node]).toUpperCase() !== "INPUT") continue;
      const pairs = Array.isArray(attributes[node]) ? attributes[node] : [];
      let secret = false;
      for (let index = 0; index + 1 < pairs.length; index += 2) {
        const name = text(pairs[index]).toLowerCase();
        const attribute = text(pairs[index + 1]);
        if (name === "type" && attribute.toLowerCase() === "password") secret = true;
        if (name === "autocomplete" && SECRET_AUTOCOMPLETE.test(attribute)) secret = true;
      }
      if (secret && underClosedRoot(node)) return true;
    }
  }
  return false;
}

/** The highest level of `CHECK` in the frames of this session. `remote` frames have a session of their own. */
async function sessionLevel(tabId: number, session: string | undefined, remote: ReadonlySet<string>): Promise<number> {
  const tree = await internalCommand(tabId, "Page.getFrameTree", {}, session);
  let level = 0;
  for (const frameId of frameIds(tree.frameTree)) {
    if (remote.has(frameId)) continue;
    const contextId = await guardWorld(tabId, frameId, session);
    const answer = await internalCommand(
      tabId,
      "Runtime.evaluate",
      { expression: CHECK, contextId, returnByValue: true },
      session,
    );
    const result = isDynamicRecord(answer.result) ? answer.result : {};
    // Fail closed: an answer that is not 0 or 1 counts as a secret.
    const found = result.value === 0 || result.value === 1 ? result.value : 2;
    if (found === 2) return 2;
    level = Math.max(level, found);
  }
  // A secret field in a closed shadow root: `secret.fill` never types there, so it always counts.
  return (await closedShadowSecret(tabId, session)) ? 2 : level;
}

/**
 * Whether any frame of the tab holds a secret. `strict` counts the fields that `secret.fill` typed too;
 * otherwise a password that it typed, still in its password field, does not count.
 */
export async function secretPresent(tabId: number, strict: boolean): Promise<boolean> {
  const clean = cleanAt.get(tabId);
  if (clean !== undefined && Date.now() - clean.at < CLEAN_FOR_MS && (clean.level === 0 || !strict)) return false;
  const children = [...frameTargets(tabId)];
  // A frame of another process is listed in the main tree too; its own session checks it.
  const remote = new Set(children.map(([, frame]) => frame.targetId));
  let level: number;
  try {
    level = await sessionLevel(tabId, undefined, remote);
    for (const [sessionId, frame] of children) {
      if (level === 2) break;
      if (frame.blocked) continue;
      level = Math.max(level, await sessionLevel(tabId, sessionId, new Set()));
    }
  } catch {
    // A frame that the check could not reach can hold a secret.
    level = 2;
  }
  if (level === 0 || level === 1) cleanAt.set(tabId, { at: Date.now(), level });
  else cleanAt.delete(tabId);
  return level === 2 || (strict && level === 1);
}

/** A command that can change the page ends the clean result of the tab. */
export function pageMayChange(tabId: number): void {
  cleanAt.delete(tabId);
}

export function forgetSecrets(tabId: number): void {
  cleanAt.delete(tabId);
}

/** The node is a secret field of this document, and it holds focus: the text goes nowhere else. */
const IS_FOCUSED_FIELD = `function () {
  return this instanceof HTMLInputElement && this.matches(${JSON.stringify(SECRET_FIELDS)}) &&
    this.isConnected && this === document.activeElement;
}`;
/** Remembers the field and what it was, so a change of its type makes its value a secret again. */
const REMEMBER_FILLED = `function () {
  const filled = globalThis[${JSON.stringify(FILLED)}] instanceof Map ? globalThis[${JSON.stringify(FILLED)}] : new Map();
  globalThis[${JSON.stringify(FILLED)}] = filled;
  filled.set(this, String(this.type) + "|" + String(this.getAttribute("autocomplete") ?? ""));
  return true;
}`;

/** The guard world of the main frame, made now. */
async function mainGuardWorld(tabId: number): Promise<number> {
  const tree = await internalCommand(tabId, "Page.getFrameTree", {});
  const [main] = frameIds(tree.frameTree);
  if (main === undefined) throw new BridgeError("cdp_error", "the tab has no main frame");
  return guardWorld(tabId, main, undefined);
}

/**
 * Types a secret into one field: (0) the tab's commands in Chrome end; (1) the main frame must still be
 * the expected origin, as the extension sees it; (2) focus the node; (3) in the guard world, the
 * focused element must be that node and not a frame; (4) only then insert the text.
 */
export async function fillSecret(tabId: number, expectOrigin: string, nodeId: number, text: string): Promise<void> {
  await whenIdle(tabId);
  cleanAt.delete(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (originOf(tab.url) !== expectOrigin) throw new BridgeError("out_of_scope", "the page is not the expected site");
  await internalCommand(tabId, "DOM.focus", { nodeId });
  const resolved = await internalCommand(tabId, "DOM.resolveNode", {
    nodeId,
    executionContextId: await mainGuardWorld(tabId),
  });
  const object = isDynamicRecord(resolved.object) ? resolved.object : {};
  if (!isString(object.objectId)) throw new BridgeError("cdp_error", "the field is gone");
  const objectId = object.objectId;
  try {
    const focused = await internalCommand(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: IS_FOCUSED_FIELD,
      returnByValue: true,
    });
    const result = isDynamicRecord(focused.result) ? focused.result : {};
    if (result.value !== true)
      throw new BridgeError("out_of_scope", "the focus is not on a password, code or card field that was expected");
    const after = await chrome.tabs.get(tabId);
    if (originOf(after.url) !== expectOrigin)
      throw new BridgeError("out_of_scope", "the page is not the expected site");
    await internalCommand(tabId, "Input.insertText", { text });
    await internalCommand(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: REMEMBER_FILLED });
  } catch (error) {
    // The message of a Chrome error never holds the text: Chrome does not echo parameters.
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("cdp_error", "the secret could not be typed");
  } finally {
    await internalCommand(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}
