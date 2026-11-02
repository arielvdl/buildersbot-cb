/**
 * Secrets in the page (DESIGN §6.5 check 7, `secret.fill`).
 *
 * The check runs in an isolated world of the extension's own: it looks for a password, one-time code or
 * card field whose value was not typed by `secret.fill`. Chrome's password manager fills a saved login
 * that way, and a screenshot, an accessibility tree or an agent script would then carry it. The check
 * reads the value but never sends it anywhere.
 *
 * `secret.fill` is one atomic step: no other command of the tab runs in between. The text never comes
 * back in a result, an event, an error or a log.
 */

import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { type CdpParams, internalCommand } from "./debugger";
import { BridgeError, chromeErrorText, originOf } from "./util";

const GUARD_WORLD = "builders-bot-guard";

/** The context id of the guard world in the main frame of each tab, while that document lives. */
const worlds = new Map<number, number>();

const SECRET_FIELDS =
  'input[type="password" i],input[autocomplete~="one-time-code" i],input[autocomplete^="cc-" i],input[autocomplete*=" cc-" i]';

const CHECK = `(() => {
  const filled = globalThis.__bbFilled;
  for (const field of document.querySelectorAll(${JSON.stringify(SECRET_FIELDS)})) {
    if (field.value !== "" && !(filled && filled.has(field))) return true;
  }
  return false;
})()`;

async function guardWorld(tabId: number): Promise<number> {
  const known = worlds.get(tabId);
  if (known !== undefined) return known;
  const tree = await internalCommand(tabId, "Page.getFrameTree", {});
  const frameTree = isDynamicRecord(tree.frameTree) ? tree.frameTree : {};
  const frame = isDynamicRecord(frameTree.frame) ? frameTree.frame : {};
  if (!isString(frame.id)) throw new BridgeError("cdp_error", "the tab has no main frame");
  const world = await internalCommand(tabId, "Page.createIsolatedWorld", {
    frameId: frame.id,
    worldName: GUARD_WORLD,
    grantUniveralAccess: false,
  });
  if (!isNumber(world.executionContextId)) throw new BridgeError("cdp_error", "no isolated world");
  worlds.set(tabId, world.executionContextId);
  return world.executionContextId;
}

/** Runs a fixed command in the guard world, once more in a new world when the page changed. */
async function inGuardWorld(tabId: number, run: (contextId: number) => Promise<CdpParams>): Promise<CdpParams> {
  try {
    return await run(await guardWorld(tabId));
  } catch (error) {
    if (!/context|Cannot find|not found/iu.test(chromeErrorText(error))) throw error;
    worlds.delete(tabId);
    return run(await guardWorld(tabId));
  }
}

export function forgetWorld(tabId: number): void {
  worlds.delete(tabId);
}

/** Whether the main frame holds a secret that `secret.fill` did not type. */
export async function secretPresent(tabId: number): Promise<boolean> {
  const answer = await inGuardWorld(tabId, (contextId) =>
    internalCommand(tabId, "Runtime.evaluate", { expression: CHECK, contextId, returnByValue: true }),
  );
  const result = isDynamicRecord(answer.result) ? answer.result : {};
  // Fail closed: an answer that is not `false` counts as a secret.
  return !(isBoolean(result.value) && result.value === false);
}

const IS_FOCUSED_FIELD =
  "function () { return this.isConnected && this === document.activeElement && this.tagName !== 'IFRAME'; }";
const REMEMBER_FILLED = "function () { (globalThis.__bbFilled ||= new WeakSet()).add(this); return true; }";

/**
 * Types a secret into one field: (1) the main frame must still be the expected origin, as the
 * extension sees it; (2) focus the node; (3) in the guard world, the focused element must be that node
 * and not a frame; (4) only then insert the text.
 */
export async function fillSecret(tabId: number, expectOrigin: string, nodeId: number, text: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (originOf(tab.url) !== expectOrigin) throw new BridgeError("out_of_scope", "the page is not the expected site");
  await internalCommand(tabId, "DOM.focus", { nodeId });
  const resolved = await inGuardWorld(tabId, (contextId) =>
    internalCommand(tabId, "DOM.resolveNode", { nodeId, executionContextId: contextId }),
  );
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
