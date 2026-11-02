/**
 * Secrets in the page (DESIGN §6.5 check 7, `secret.fill`).
 *
 * The check runs in an isolated world of the extension's own, in every frame of the tab: the frames of
 * the main session and the frames of each child session (a frame of another site, such as the card
 * fields of a payment provider). It looks for a password, one-time code or card field whose value was
 * not typed by `secret.fill`. Chrome's password manager and autofill fill such fields, and a screenshot,
 * an accessibility tree or an agent script would then carry the value. The check reads the value but
 * never sends it anywhere.
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

import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { frameTargets, internalCommand, whenIdle } from "./debugger";
import { BridgeError, originOf } from "./util";

const GUARD_WORLD = "builders-bot-guard";
const CLEAN_FOR_MS = 1_000;

/** When each tab was last found with no secret, until a command that can change the page. */
const cleanAt = new Map<number, number>();

const SECRET_FIELDS =
  'input[type="password" i],input[autocomplete~="one-time-code" i],input[autocomplete^="cc-" i],input[autocomplete*=" cc-" i]';

const CHECK = `(() => {
  const filled = globalThis.__bbFilled;
  for (const field of document.querySelectorAll(${JSON.stringify(SECRET_FIELDS)})) {
    if (field.value !== "" && !(filled && filled.has(field))) return true;
  }
  return false;
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

/** The guard world of one frame, made now. */
async function guardWorld(tabId: number, frameId: string, session: string | undefined): Promise<number> {
  const world = await internalCommand(
    tabId,
    "Page.createIsolatedWorld",
    { frameId, worldName: GUARD_WORLD, grantUniveralAccess: false },
    session,
  );
  if (!isNumber(world.executionContextId)) throw new BridgeError("cdp_error", "no isolated world");
  return world.executionContextId;
}

/** Whether a frame of this session holds a secret. `remote` frames have a session of their own. */
async function sessionHasSecret(
  tabId: number,
  session: string | undefined,
  remote: ReadonlySet<string>,
): Promise<boolean> {
  const tree = await internalCommand(tabId, "Page.getFrameTree", {}, session);
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
    // Fail closed: an answer that is not `false` counts as a secret.
    if (!(isBoolean(result.value) && result.value === false)) return true;
  }
  return false;
}

/** Whether any frame of the tab holds a secret that `secret.fill` did not type. */
export async function secretPresent(tabId: number): Promise<boolean> {
  const clean = cleanAt.get(tabId);
  if (clean !== undefined && Date.now() - clean < CLEAN_FOR_MS) return false;
  const children = [...frameTargets(tabId)];
  // A frame of another process is listed in the main tree too; its own session checks it.
  const remote = new Set(children.map(([, frame]) => frame.targetId));
  let present: boolean;
  try {
    present = await sessionHasSecret(tabId, undefined, remote);
    for (const [sessionId, frame] of children) {
      if (present) break;
      if (frame.blocked) continue;
      present = await sessionHasSecret(tabId, sessionId, new Set());
    }
  } catch {
    // A frame that the check could not reach can hold a secret.
    present = true;
  }
  if (present) cleanAt.delete(tabId);
  else cleanAt.set(tabId, Date.now());
  return present;
}

/** A command that can change the page ends the clean result of the tab. */
export function pageMayChange(tabId: number): void {
  cleanAt.delete(tabId);
}

export function forgetSecrets(tabId: number): void {
  cleanAt.delete(tabId);
}

const IS_FOCUSED_FIELD =
  "function () { return this.isConnected && this === document.activeElement && this.tagName !== 'IFRAME'; }";
const REMEMBER_FILLED = "function () { (globalThis.__bbFilled ||= new WeakSet()).add(this); return true; }";

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
    if (result.value !== true) throw new BridgeError("out_of_scope", "the focus is not on the expected field");
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
