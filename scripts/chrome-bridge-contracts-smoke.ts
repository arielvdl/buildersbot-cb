// Phase 1 of the Builders Bot Chrome extension: the contracts and the web access mode, before any
// browser or extension exists.
//
// It runs the real code: the closed decoders of the bridge protocol, the CDP allowlist and its event
// projection, the site floor, the group titles and colors, the engine gesture table, and the app's
// `AppBehaviorService` on a real preference file, including what an older app reads and writes there.
// The engine methods are read from `src/backend/browser-*.ts`, so a new CDP call that the allowlist
// does not cover fails here, before it fails in someone's Chrome.
//
// `bun scripts/chrome-bridge-contracts-smoke.ts`. Writes .buildersbot-build/chrome-bridge-contracts-smoke/report.json.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CDP_ALLOWLIST,
  CDP_RESULTS,
  type CdpCheckContext,
  checkCdpCommand,
  ENGINE_WORLD_NAME,
  projectCdpEvent,
  projectCdpResult,
} from "@openbot/contracts/chrome-bridge/cdp-allowlist";
import { ENGINE_FUNCTIONS, ENGINE_GESTURE_FUNCTIONS } from "@openbot/contracts/chrome-bridge/cdp-functions";
import {
  groupColorForHash,
  groupColorForHex,
  MAX_GROUP_TITLE,
  projectGroupTitle,
} from "@openbot/contracts/chrome-bridge/groups";
import {
  type AppMessageHandlers,
  BRIDGE_LIMITS,
  CHROME_BRIDGE_FEATURES,
  type ChromeBridgeOperation,
  decodeToApp,
  decodeToExtension,
  frameFits,
  HANDSHAKE_DECODERS,
  negotiateProtocol,
  type OperationHandlers,
} from "@openbot/contracts/chrome-bridge/protocol";
import { siteFloorDecision } from "@openbot/contracts/chrome-bridge/site-floor";
import { Effect } from "effect";
import { AppBehaviorService } from "../src/main/app-behavior-service";
import { parseAppBehaviorPreferenceChange } from "../src/main/ipc/app-inputs";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".buildersbot-build/chrome-bridge-contracts-smoke");

interface Check {
  name: string;
  ok: boolean;
  detail: unknown;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: unknown = null): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}\n`);
}

const opaque = () => randomBytes(16).toString("base64url");
const ALL_FEATURES: readonly string[] = CHROME_BRIDGE_FEATURES;

// ---------------------------------------------------------------------------------------------------
// The protocol

const seen: string[] = [];
const record =
  (op: ChromeBridgeOperation) =>
  (_body: unknown, id: number): string => {
    seen.push(`${op}#${id}`);
    return op;
  };
const operationHandlers: OperationHandlers<string> = {
  "session.configure": record("session.configure"),
  "group.ensure": record("group.ensure"),
  "group.update": record("group.update"),
  "group.release": record("group.release"),
  "lease.open": record("lease.open"),
  "lease.close": record("lease.close"),
  "tab.create": record("tab.create"),
  "tab.claim": record("tab.claim"),
  "tab.release": record("tab.release"),
  "tab.close": record("tab.close"),
  "tab.activate": record("tab.activate"),
  "tab.history": record("tab.history"),
  "tab.zoom": record("tab.zoom"),
  "tab.discard": record("tab.discard"),
  "tab.mark": record("tab.mark"),
  "cdp.send": record("cdp.send"),
  "cdp.batch": record("cdp.batch"),
  "script.run": record("script.run"),
  "secret.fill": record("secret.fill"),
  "project.pause": record("project.pause"),
  "project.resume": record("project.resume"),
  "stop.all": record("stop.all"),
  resync: record("resync"),
  ping: record("ping"),
  "pair.done": record("pair.done"),
};

const leaseId = opaque();
const handle = opaque();
const created = decodeToExtension(
  { t: "req", id: 7, op: "tab.create", body: { leaseId, url: "https://example.com/" } },
  ALL_FEATURES,
  operationHandlers,
);
check("a tab.create request decodes and reaches its handler", created.ok && seen.includes("tab.create#7"), created);
const extraField = decodeToExtension(
  { t: "req", id: 8, op: "tab.create", body: { leaseId, url: "https://example.com/", windowId: 1 } },
  ALL_FEATURES,
  operationHandlers,
);
check("a body field that the protocol does not name breaks the protocol", !extraField.ok, extraField);
const reflective = decodeToExtension(
  { t: "req", id: 9, op: "chrome.tabs.query", body: {} },
  ALL_FEATURES,
  operationHandlers,
);
check("there is no reflective chrome.* operation", !reflective.ok, reflective);
const unannounced = decodeToExtension(
  { t: "req", id: 10, op: "cdp.batch", body: { handle, commands: [] } },
  ["core"],
  operationHandlers,
);
check("an operation of a feature the extension did not announce breaks the protocol", !unannounced.ok, unannounced);
const consentGrant = decodeToExtension(
  { t: "req", id: 11, op: "consent.grant", body: { origin: "https://bank.example" } },
  ALL_FEATURES,
  operationHandlers,
);
check("the app has no operation that grants consent or lowers the floor", !consentGrant.ok, consentGrant);
const badUrl = decodeToExtension(
  { t: "req", id: 12, op: "tab.create", body: { leaseId: "short", url: "https://example.com/" } },
  ALL_FEATURES,
  operationHandlers,
);
check("an identifier that is not a 128-bit opaque value is refused", !badUrl.ok, badUrl);

const event = (name: string) => () => `event:${name}`;
const result = (name: string) => () => `result:${name}`;
const appHandlers: AppMessageHandlers<string> = {
  event: {
    ready: event("ready"),
    "cdp.event": event("cdp.event"),
    "tab.created": event("tab.created"),
    "tab.updated": event("tab.updated"),
    "tab.removed": event("tab.removed"),
    "tab.detached": event("tab.detached"),
    "tab.viewed": event("tab.viewed"),
    "tab.candidate": event("tab.candidate"),
    "tab.handed": event("tab.handed"),
    "tab.taken": event("tab.taken"),
    "tab.blocked": event("tab.blocked"),
    "tab.quarantined": event("tab.quarantined"),
    "tab.secret-present": event("tab.secret-present"),
    "group.removed": event("group.removed"),
    "group.moved": event("group.moved"),
    "group.renamed": event("group.renamed"),
    "group.shared": event("group.shared"),
    "user.stop": event("user.stop"),
    "user.resume": event("user.resume"),
    "user.unblock": event("user.unblock"),
    "pair.chrome-ok": event("pair.chrome-ok"),
    "ext.updating": event("ext.updating"),
    audit: event("audit"),
  },
  result: {
    "session.configure": result("session.configure"),
    "group.ensure": result("group.ensure"),
    "group.update": result("group.update"),
    "group.release": result("group.release"),
    "lease.open": result("lease.open"),
    "lease.close": result("lease.close"),
    "tab.create": result("tab.create"),
    "tab.claim": result("tab.claim"),
    "tab.release": result("tab.release"),
    "tab.close": result("tab.close"),
    "tab.activate": result("tab.activate"),
    "tab.history": result("tab.history"),
    "tab.zoom": result("tab.zoom"),
    "tab.discard": result("tab.discard"),
    "tab.mark": result("tab.mark"),
    "cdp.send": result("cdp.send"),
    "cdp.batch": result("cdp.batch"),
    "script.run": result("script.run"),
    "secret.fill": result("secret.fill"),
    "project.pause": result("project.pause"),
    "project.resume": result("project.resume"),
    "stop.all": result("stop.all"),
    resync: result("resync"),
    ping: result("ping"),
    "pair.done": result("pair.done"),
  },
  error: (error) => `error:${error.code}`,
};
const pending = new Map<number, ChromeBridgeOperation>([[7, "tab.create"]]);
const answered = decodeToApp({ t: "res", id: 7, body: { handle } }, ALL_FEATURES, (id) => pending.get(id), appHandlers);
check(
  "a response is checked against the operation it answers",
  answered.ok && answered.value === "result:tab.create",
  answered,
);
const wrongBody = decodeToApp(
  { t: "res", id: 7, body: { handle, tabId: 3 } },
  ALL_FEATURES,
  (id) => pending.get(id),
  appHandlers,
);
check("a response that leaks a Chrome tab id is refused", !wrongBody.ok, wrongBody);
const stray = decodeToApp({ t: "res", id: 99, body: {} }, ALL_FEATURES, (id) => pending.get(id), appHandlers);
check("a response to no pending request breaks the protocol", !stray.ok, stray);
const denied = decodeToApp(
  { t: "res", id: 7, err: { code: "site_blocked", message: "blocked" } },
  ALL_FEATURES,
  (id) => pending.get(id),
  appHandlers,
);
check("an error response carries a closed error code", denied.ok && denied.value === "error:site_blocked", denied);
const unknownCode = decodeToApp(
  { t: "res", id: 7, err: { code: "teapot", message: "x" } },
  ALL_FEATURES,
  (id) => pending.get(id),
  appHandlers,
);
check("an error code outside the list breaks the protocol", !unknownCode.ok, unknownCode);
const stop = decodeToApp(
  { t: "evt", seq: 1, op: "user.stop", body: { scope: "all", source: "infobar" } },
  ALL_FEATURES,
  () => undefined,
  appHandlers,
);
check("a stop from the Chrome infobar decodes", stop.ok && stop.value === "event:user.stop", stop);
const networkEvent = decodeToApp(
  { t: "evt", seq: 2, op: "network.event", body: {} },
  ALL_FEATURES,
  () => undefined,
  appHandlers,
);
check("an event outside the list breaks the protocol", !networkEvent.ok, networkEvent);

check(
  "protocol ranges that do not meet give no version",
  negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 3 }) === null,
);
check(
  "protocol ranges that meet give the highest common version",
  negotiateProtocol({ min: 1, max: 3 }, { min: 1, max: 2 }) === 2,
);

const key = randomBytes(65).toString("base64url");
const nonce = randomBytes(32).toString("base64url");
const hello = {
  k: "hello",
  proto: { min: 1, max: 1 },
  extVersion: "1.0.0",
  installId: opaque(),
  sPub: key,
  ePub: key,
  nonce,
  features: ["core"],
  browser: { brand: "chrome-for-testing", version: "142.0.7444.0" },
};
check("a hello without consent decodes", HANDSHAKE_DECODERS.hello(hello, "hello").ok);
check("a hello that carries a token field is refused", !HANDSHAKE_DECODERS.hello({ ...hello, token: "x" }, "hello").ok);
check(
  "a commit that is not a 32-byte digest is refused",
  !HANDSHAKE_DECODERS.commit({ k: "commit", digest: "abc" }, "commit").ok,
);

const part = randomBytes(BRIDGE_LIMITS.partBytes).toString("base64url");
const partFrame = JSON.stringify({ v: 1, c: 2 ** 32, p: { i: 31, n: 32 }, d: part });
check("a full 512 KiB part stays under Chrome's 1 MB limit after encoding", frameFits(partFrame, "to-chrome"), {
  bytes: partFrame.length,
});

// ---------------------------------------------------------------------------------------------------
// The CDP allowlist

const engineDigest = [...ENGINE_GESTURE_FUNCTIONS][0] ?? "";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** An object of context 5, in V8's form `<isolate>.<context>.<object>`. */
const OBJECT = "-4242.5.1";
const context: CdpCheckContext = {
  operation: "other",
  agentTab: true,
  contexts: new Set([5]),
  childSessions: new Set(["CHILD"]),
  engineFunctions: ENGINE_FUNCTIONS,
  gestureFunctions: ENGINE_GESTURE_FUNCTIONS,
  scripts: false,
  floor: {},
};
const decision = (method: string, params: unknown, extra: Partial<CdpCheckContext> = {}, session?: string) =>
  checkCdpCommand(method, params, session, { ...context, ...extra });
const code = (result: ReturnType<typeof decision>) => (result.ok ? "ok" : result.code);

check("Network.getCookies is denied", code(decision("Network.getCookies", {})) === "method_denied");
check("Storage.getCookies is denied", code(decision("Storage.getCookies", {})) === "method_denied");
check(
  "Target.attachToTarget is denied",
  code(decision("Target.attachToTarget", { targetId: "x" })) === "method_denied",
);
check(
  "DOM.setFileInputFiles is denied",
  code(decision("DOM.setFileInputFiles", { files: ["/etc/passwd"] })) === "method_denied",
);
check(
  "a paste command, which would read the person's clipboard, is denied",
  code(decision("Input.dispatchKeyEvent", { type: "keyDown", commands: ["paste"] })) === "param_denied",
);
check(
  "the selectAll command that the engine sends is allowed",
  code(decision("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", commands: ["selectAll"] })) ===
    "ok",
);
check(
  "a drag that carries files is denied",
  code(
    decision("Input.dispatchDragEvent", {
      type: "drop",
      x: 1,
      y: 1,
      data: { items: [], dragOperationsMask: 1, files: ["/Users/x/secret.pdf"] },
    }),
  ) === "param_denied",
);
check(
  "a user gesture for a function outside the engine table is denied, also with scripts on",
  code(
    decision(
      "Runtime.callFunctionOn",
      { functionDeclaration: "function() { fetch('https://evil.test') }", objectId: OBJECT, userGesture: true },
      { functionDigest: sha256("function() { fetch('https://evil.test') }"), scripts: true },
    ),
  ) === "param_denied",
);
// Security review of 02/11, item 1: page code is an engine function, unless the person turned scripts on.
const foreign = "function() { return document.cookie; }";
check(
  "a function outside the engine table is refused while scripts are off",
  code(
    decision(
      "Runtime.callFunctionOn",
      { functionDeclaration: foreign, objectId: OBJECT },
      { functionDigest: sha256(foreign) },
    ),
  ) === "scripts_disabled",
);
check(
  "a function with no digest is refused while scripts are off",
  code(decision("Runtime.callFunctionOn", { functionDeclaration: foreign, objectId: OBJECT })) === "scripts_disabled",
);
const readyState = "function() { return document.readyState !== 'loading'; }";
const engineCall = decision(
  "Runtime.callFunctionOn",
  { functionDeclaration: readyState, executionContextId: 5, arguments: [], returnByValue: true },
  { functionDigest: sha256(readyState) },
);
check(
  "an engine function runs, after the strict secret check",
  ENGINE_FUNCTIONS.has(sha256(readyState)) && engineCall.ok && engineCall.secretCheck === "strict",
  engineCall,
);
check(
  "the agent's own expression is refused while scripts are off",
  code(decision("Runtime.evaluate", { expression: "document.cookie", returnByValue: true })) === "scripts_disabled",
);
check(
  "an engine expression is refused too: the engine runs no Runtime.evaluate",
  code(decision("Runtime.evaluate", { expression: "document.readyState !== 'loading'", contextId: 5 })) ===
    "scripts_disabled",
);
const withScripts = decision("Runtime.evaluate", { expression: "document.title" }, { scripts: true });
check(
  "with scripts on, the agent's own expression runs after the strict secret check",
  withScripts.ok && withScripts.secretCheck === "strict",
  withScripts,
);
// Item 6: an object id is checked as a context id is, so a made-up id cannot reach the guard world.
check(
  "an object id of a context that the tab may not name is denied",
  code(decision("Runtime.getProperties", { objectId: "-4242.6.1" })) === "param_denied",
);
check(
  "an object id in another form is denied",
  code(decision("DOM.describeNode", { objectId: '{"injectedScriptId":5,"id":1}' })) === "param_denied",
);
check(
  "an argument object of a context that the tab may not name is denied",
  code(
    decision(
      "Runtime.callFunctionOn",
      { functionDeclaration: readyState, objectId: OBJECT, arguments: [{ objectId: "-4242.6.2" }] },
      { functionDigest: sha256(readyState) },
    ),
  ) === "param_denied",
);
for (const method of ["Runtime.getProperties", "DOM.describeNode", "DOM.getDocument"]) {
  const read = decision(method, method === "DOM.getDocument" ? {} : { objectId: OBJECT });
  check(`${method} runs the strict secret check`, read.ok && read.secretCheck === "strict", read);
}
for (const method of ["Page.captureScreenshot", "Accessibility.getFullAXTree"]) {
  const read = decision(method, {});
  check(`${method} runs the masked secret check`, read.ok && read.secretCheck === "masked", read);
}
// Item 6: the agent makes only the engine's world, never one of the extension's.
for (const worldName of ["builders-bot-guard", "builders-bot-agent", "", "other"])
  check(
    `an isolated world named "${worldName}" is denied`,
    code(decision("Page.createIsolatedWorld", { frameId: "F", worldName })) === "param_denied",
  );
check(
  "an isolated world with no name is denied",
  code(decision("Page.createIsolatedWorld", { frameId: "F" })) === "param_denied",
);
check(
  "the engine's world is allowed",
  code(decision("Page.createIsolatedWorld", { frameId: "F", worldName: ENGINE_WORLD_NAME })) === "ok",
);
// Item 2: the tab's history is not a command.
check("Page.getNavigationHistory is denied", code(decision("Page.getNavigationHistory", {})) === "method_denied");
// Item 3: copy, cut and paste keys, in every spelling.
/** A key event as `Input.dispatchKeyEvent` takes it. */
interface KeyEvent {
  readonly type: string;
  readonly key?: string;
  readonly code?: string;
  readonly text?: string;
  readonly modifiers?: number;
  readonly windowsVirtualKeyCode?: number;
  readonly nativeVirtualKeyCode?: number;
}
const clipboardKeys: { readonly [name: string]: KeyEvent } = {
  ctrlV: { type: "keyDown", key: "v", modifiers: 2 },
  cmdV: { type: "rawKeyDown", code: "KeyV", modifiers: 4 },
  cmdVByWindowsCode: { type: "rawKeyDown", windowsVirtualKeyCode: 86, modifiers: 4 },
  cmdVByMacCode: { type: "rawKeyDown", nativeVirtualKeyCode: 9, modifiers: 4 },
  cmdVByText: { type: "rawKeyDown", text: "v", modifiers: 4 },
  ctrlC: { type: "keyDown", key: "c", code: "KeyC", modifiers: 2 },
  cmdC: { type: "rawKeyDown", key: "C", modifiers: 4 },
  cmdX: { type: "rawKeyDown", key: "x", modifiers: 4 },
  ctrlXByCode: { type: "rawKeyDown", windowsVirtualKeyCode: 88, modifiers: 2 },
  ctrlInsert: { type: "rawKeyDown", key: "Insert", modifiers: 2 },
  shiftInsert: { type: "rawKeyDown", code: "Insert", modifiers: 8 },
  shiftInsertByCode: { type: "rawKeyDown", windowsVirtualKeyCode: 45, modifiers: 8 },
  shiftDelete: { type: "rawKeyDown", key: "Delete", modifiers: 8 },
  pasteKey: { type: "rawKeyDown", key: "Paste" },
  copyKey: { type: "rawKeyDown", code: "Copy" },
  ctrlVControlCharacter: { type: "char", text: String.fromCharCode(0x16) },
};
for (const [name, params] of Object.entries(clipboardKeys))
  check(`the clipboard key ${name} is denied`, code(decision("Input.dispatchKeyEvent", params)) === "param_denied");
for (const [name, params] of Object.entries({
  letterV: { type: "keyDown", key: "v", code: "KeyV", text: "v" },
  shiftV: { type: "rawKeyDown", key: "V", code: "KeyV", modifiers: 8 },
  ctrlA: { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 },
  delete: { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  enter: { type: "char", key: "Enter", text: "\r" },
}))
  check(`the engine's key ${name} is allowed`, code(decision("Input.dispatchKeyEvent", params)) === "ok");
check(
  "a user gesture for an engine function is allowed",
  ENGINE_GESTURE_FUNCTIONS.size > 0 &&
    code(
      decision(
        "Runtime.callFunctionOn",
        { functionDeclaration: "x", objectId: OBJECT, userGesture: true },
        { functionDigest: engineDigest },
      ),
    ) === "ok",
);
check(
  "an evaluate with a user gesture is denied (agent code goes through script.run)",
  code(decision("Runtime.evaluate", { expression: "1", userGesture: true })) === "param_denied",
);
check(
  "an evaluate in a context the tab never reported is denied, also with scripts on",
  code(decision("Runtime.evaluate", { expression: "1", contextId: 9 }, { scripts: true })) === "param_denied",
);
check(
  "an engine function in a context the tab never reported is denied",
  code(
    decision(
      "Runtime.callFunctionOn",
      { functionDeclaration: readyState, executionContextId: 9 },
      { functionDigest: sha256(readyState) },
    ),
  ) === "param_denied",
);
check(
  "the command line API is denied",
  code(decision("Runtime.evaluate", { expression: "1", includeCommandLineAPI: true })) === "param_denied",
);
check(
  "auto-attach without the iframe filter is denied",
  code(decision("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })) ===
    "param_denied",
);
check(
  "the engine's auto-attach with the iframe filter is allowed",
  code(
    decision("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    }),
  ) === "ok",
);
check(
  "an isolated world with universal access is denied",
  code(decision("Page.createIsolatedWorld", { frameId: "F", grantUniveralAccess: true })) === "param_denied",
);
check(
  "navigation to an exchange on the floor is blocked",
  code(decision("Page.navigate", { url: "https://www.binance.com/en" })) === "site_blocked",
);
check(
  "navigation to javascript: is blocked",
  code(decision("Page.navigate", { url: "javascript:alert(1)" })) === "site_blocked",
);
check(
  "navigation to an ordinary site is allowed",
  code(decision("Page.navigate", { url: "https://example.com/" })) === "ok",
);
check("Network.enable outside a navigation is denied", code(decision("Network.enable", {})) === "method_denied");
check(
  "Network.enable inside a navigation is allowed",
  code(decision("Network.enable", {}, { operation: "navigate" })) === "ok",
);
check(
  "a network buffer is denied",
  code(decision("Network.enable", { maxTotalBufferSize: 1_000_000 }, { operation: "navigate" })) === "param_denied",
);
check(
  "emulation in a tab of the person is denied",
  code(decision("Emulation.setEmulatedMedia", { media: "print" }, { agentTab: false })) === "method_denied",
);
check(
  "a command for a session that is not a frame of the tab is out of scope",
  code(decision("DOM.getDocument", {}, {}, "OTHER")) === "out_of_scope",
);
check(
  "a command for a registered frame session is allowed",
  code(decision("DOM.getDocument", {}, {}, "CHILD")) === "ok",
);
// JSON.parse makes `__proto__` an own key. A parameter list that read the prototype would let these pass.
for (const key of ["constructor", "__proto__", "toString"]) {
  const params = JSON.parse(`{"expression":"1",${JSON.stringify(key)}:{"t":"str"}}`);
  check(
    `a parameter named ${key} is denied`,
    code(decision("Runtime.evaluate", params)) === "param_denied",
    decision("Runtime.evaluate", params),
  );
}
const history = decision("Page.navigateToHistoryEntry", { entryId: 3 });
check(
  "a history navigation asks for the floor check of its entry, which no request may show",
  history.ok && history.historyFloorCheck,
);
const screenshot = decision("Page.captureScreenshot", { format: "png" });
check("a screenshot asks for the secret check", screenshot.ok && screenshot.secretCheck !== "none");
const front = decision("Page.bringToFront", {});
check("bringToFront is a no-op unless the person allowed it", front.ok && front.noOp);

// Every CDP method that the engine sends today is either allowed or one of the Electron-only calls.
const ELECTRON_ONLY = new Set([
  "DOM.setFileInputFiles",
  "Target.attachToTarget",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
]);
const engineMethods = new Set<string>();
// The Chrome host sends commands of its own through the same target (`chrome-tabs-host.ts`).
for (const file of (await readdir(join(ROOT, "src/backend"))).filter(
  (name) => /^(browser|chrome)-.*\.ts$/u.test(name) && !name.endsWith(".test.ts"),
)) {
  const source = await readFile(join(ROOT, "src/backend", file), "utf8");
  for (const match of source.matchAll(/(?:send|sendCommand)\(\s*"([A-Z][A-Za-z]+\.[a-z][A-Za-z]+)"/gu))
    if (match[1]) engineMethods.add(match[1]);
}
const uncovered = [...engineMethods].filter(
  (method) => !Object.hasOwn(CDP_ALLOWLIST, method) && !ELECTRON_ONLY.has(method),
);
check(
  "every CDP method the engine sends is in the allowlist or Electron-only",
  uncovered.length === 0 && engineMethods.size > 30,
  {
    engineMethods: engineMethods.size,
    uncovered,
  },
);

check(
  "no Network event leaves the extension",
  projectCdpEvent("Network.responseReceivedExtraInfo", { headers: { "set-cookie": "a=b" } }) === null,
);
check(
  "no WebSocket frame leaves the extension",
  projectCdpEvent("Network.webSocketFrameReceived", { response: { payloadData: "x" } }) === null,
);
const navigated = projectCdpEvent("Page.frameNavigated", {
  frame: {
    id: "F",
    url: "https://app.example/cb#access_token=secret",
    securityOrigin: "https://app.example",
    mimeType: "text/html",
  },
});
check(
  "a navigation event loses its fragment and its other fields",
  JSON.stringify(navigated) ===
    JSON.stringify({ frame: { id: "F", url: "https://app.example/cb", securityOrigin: "https://app.example" } }),
  navigated,
);
const consoleEvent = projectCdpEvent("Runtime.consoleAPICalled", {
  type: "log",
  args: [
    { type: "string", value: "token" },
    { type: "object", objectId: "7", preview: { properties: [] } },
  ],
});
check(
  "a console event keeps only primitive arguments",
  JSON.stringify(consoleEvent) === JSON.stringify({ level: "log", text: "token" }),
  consoleEvent,
);

// Item 2: results leave with closed fields, without fragments, and without floor frames.
const noFloor = { onFloor: (url: string) => siteFloorDecision(url, { subframe: true }).blocked };
const missingResults = Object.keys(CDP_ALLOWLIST).filter((method) => !Object.hasOwn(CDP_RESULTS, method));
check("every allowed method has a closed result projection", missingResults.length === 0, missingResults);
const tree = projectCdpResult(
  "Page.getFrameTree",
  {
    frameTree: {
      frame: {
        id: "M",
        loaderId: "L",
        url: "https://app.example/cb?x=1#access_token=secret",
        urlFragment: "#access_token=secret",
        unreachableUrl: "https://app.example/#t",
        securityOrigin: "https://app.example",
        mimeType: "text/html",
        adFrameStatus: { adFrameType: "none" },
      },
      childFrames: [
        {
          frame: {
            id: "B",
            parentId: "M",
            url: "https://www.itau.com.br/login#x",
            securityOrigin: "https://www.itau.com.br",
            name: "bank",
          },
        },
      ],
    },
  },
  noFloor,
);
check(
  "a frame tree keeps only its closed fields, with no fragment, and a floor frame hidden",
  JSON.stringify(tree) ===
    JSON.stringify({
      frameTree: {
        frame: {
          id: "M",
          loaderId: "L",
          securityOrigin: "https://app.example",
          mimeType: "text/html",
          url: "https://app.example/cb?x=1",
        },
        childFrames: [{ frame: { id: "B", parentId: "M", name: "", securityOrigin: "null", url: "about:blank" } }],
      },
    }),
  tree,
);
const documentResult = projectCdpResult(
  "DOM.getDocument",
  {
    root: {
      nodeId: 1,
      backendNodeId: 2,
      nodeType: 9,
      nodeName: "#document",
      documentURL: "https://app.example/#token",
      baseURL: "https://app.example/#token",
      futureField: "x",
      children: [
        {
          nodeId: 3,
          nodeName: "IFRAME",
          contentDocument: { nodeId: 4, documentURL: "https://frame.example/#t", nodeName: "#document" },
        },
      ],
      shadowRoots: [{ nodeId: 5, nodeName: "#document-fragment", shadowRootType: "open" }],
    },
  },
  noFloor,
);
const documentText = JSON.stringify(documentResult);
check(
  "a DOM tree keeps its closed fields and loses every fragment",
  !documentText.includes("#t") && !documentText.includes("futureField") && documentText.includes("shadowRootType"),
  documentResult,
);
const targetInfo = projectCdpResult(
  "Target.getTargetInfo",
  { targetInfo: { targetId: "T", type: "page", url: "https://app.example/#token", title: "App", extra: 1 } },
  noFloor,
);
check(
  "the target info loses its fragment and the fields it does not name",
  JSON.stringify(targetInfo) ===
    JSON.stringify({ targetInfo: { targetId: "T", type: "page", title: "App", url: "https://app.example/" } }),
  targetInfo,
);
const thrown = projectCdpResult(
  "Runtime.callFunctionOn",
  {
    result: { type: "object", subtype: "error", description: "Error", objectId: "9", preview: { properties: [] } },
    exceptionDetails: {
      text: "Uncaught",
      url: "https://app.example/#token",
      stackTrace: { callFrames: [] },
      lineNumber: 1,
    },
  },
  noFloor,
);
check(
  "a call result keeps its remote object and loses the script URL and stack of an exception",
  !JSON.stringify(thrown).includes("#token") && !JSON.stringify(thrown).includes("preview"),
  thrown,
);
// The send gate reads no listener: the tab's event listeners are not a command.
check(
  "DOMDebugger.getEventListeners is denied",
  code(decision("DOMDebugger.getEventListeners", { objectId: OBJECT })) === "method_denied",
);
check(
  "a method outside the list gives an empty result",
  JSON.stringify(projectCdpResult("Network.getAllCookies", { cookies: [{ value: "x" }] }, noFloor)) === "{}",
);

// ---------------------------------------------------------------------------------------------------
// The site floor and the groups

check("a subdomain of gov.br is on the floor", siteFloorDecision("https://sso.acesso.gov.br/login").blocked);
check("a domain that only ends like gov.br is not", !siteFloorDecision("https://notgov.br.example.com/").blocked);
check("credentials in a URL are blocked", siteFloorDecision("https://user:pass@example.com/").blocked);
check(
  "an origin the person unlocked for the project passes",
  !siteFloorDecision("https://www.binance.com/x", { unlocked: ["https://www.binance.com"] }).blocked,
);
check(
  "an origin the app added is blocked",
  siteFloorDecision("https://intranet.example/", { added: ["intranet.example"] }).blocked,
);
check(
  "about:srcdoc is allowed only in a frame",
  siteFloorDecision("about:srcdoc").blocked && !siteFloorDecision("about:srcdoc", { subframe: true }).blocked,
);
check("an app scheme is blocked", siteFloorDecision("buildersbot://browser/connect").blocked);

// A right-to-left override (U+202E), a bell (U+0007) and a line break, built from their code points.
const unsafe = [0x202e, 0x07, 0x0a].map((code) => String.fromCharCode(code));
const spoofed = projectGroupTitle(`Projeto${unsafe[0]}${unsafe[1]} Alfa${unsafe[2]}Beta`);
check(
  "a group title has no direction or control characters",
  !unsafe.some((character) => spoofed.includes(character)) && spoofed === "Projeto Alfa Beta",
  spoofed,
);
const long = projectGroupTitle("x".repeat(100));
check(
  "a long group title ends with an ellipsis within the limit",
  [...long].length === MAX_GROUP_TITLE && long.endsWith("…"),
  long,
);
check(
  "a section color maps to the nearest group color",
  groupColorForHex("#2f6fdb") === "blue" && groupColorForHex("#e5484d") === "red",
);
check("a grey section color falls back to the hash", groupColorForHex("#808080") === null);
check("a hashed color skips one already used in the window", groupColorForHash(0, ["red"]) !== "red");
const hashed = new Set<string>([...Array(256).keys()].map((byte) => groupColorForHash(byte)));
check("no project ever gets grey, and the hash reaches all eight colors", !hashed.has("grey") && hashed.size === 8, [
  ...hashed,
]);

// ---------------------------------------------------------------------------------------------------
// The web access mode, on a real preference file

const folder = await mkdtemp(join(tmpdir(), "bb-web-access-"));
try {
  const path = join(folder, "app-behavior.json");
  const service = () =>
    new AppBehaviorService({ path, loginItem: null, offersBackground: false, offersKeepAwake: true });
  const first = service();
  await Effect.runPromise(first.load());
  check(
    "with no file, web access is the legacy path, as before",
    first.webAccess === "playwright-legacy" && !first.browserInApp,
  );
  const saved = await Effect.runPromise(first.set({ webAccess: "chrome" }));
  const file = JSON.parse(await readFile(path, "utf8"));
  check(
    "the chrome mode is saved with the released switch off",
    saved.webAccess === "chrome" &&
      saved.browserInApp === false &&
      file.webAccess === "chrome" &&
      file.browserInApp === false,
    file,
  );
  // An older app reads only the switch, and writes the whole file back without `webAccess`.
  const olderReadsChrome = file.version === 1 && file.browserInApp === true;
  check("an older app reads the chrome mode as the legacy path", olderReadsChrome === false);
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, keepRunningInBackground: false, keepAwake: false, keepAwakeOnBattery: false, browserInApp: true, culturaBuilderFullContext: false })}\n`,
  );
  const afterDowngrade = service();
  await Effect.runPromise(afterDowngrade.load());
  check(
    "a file an older app wrote reads from its switch",
    afterDowngrade.webAccess === "app" && afterDowngrade.browserInApp,
  );
  await Effect.runPromise(afterDowngrade.set({ browserInApp: false }));
  check(
    "the released switch still turns the Builders Bot browser off",
    afterDowngrade.webAccess === "playwright-legacy",
  );
  await Effect.runPromise(afterDowngrade.set({ webAccess: "app", browserInApp: false }));
  check(
    "webAccess wins over the switch in the same change",
    afterDowngrade.webAccess === "app" && afterDowngrade.browserInApp,
  );
  const inApp = JSON.parse(await readFile(path, "utf8"));
  check("an older app reads the app mode from the switch", inApp.browserInApp === true, inApp);
  await writeFile(path, `${JSON.stringify({ ...inApp, webAccess: "firefox" })}\n`);
  const unknownMode = service();
  await Effect.runPromise(unknownMode.load());
  check("a mode a newer app wrote that this app does not know reads from the switch", unknownMode.webAccess === "app");
} finally {
  await rm(folder, { recursive: true, force: true });
}

const parse = (input: unknown) => {
  try {
    return parseAppBehaviorPreferenceChange(input);
  } catch {
    return null;
  }
};
check(
  "the IPC input accepts a known mode",
  JSON.stringify(parse({ webAccess: "chrome" })) === JSON.stringify({ webAccess: "chrome" }),
);
check("the IPC input refuses an unknown mode", parse({ webAccess: "firefox" }) === null);
check("the IPC input refuses a mode that is not a string", parse({ webAccess: true }) === null);
check(
  "the IPC input still takes the released switch",
  JSON.stringify(parse({ browserInApp: true })) === JSON.stringify({ browserInApp: true }),
);
check("the IPC input refuses an empty change", parse({}) === null);

const passed = checks.every((entry) => entry.ok);
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, total: checks.length, checks }, null, 2)}\n`);
process.stdout.write(
  `${passed ? "PASSED" : "FAILED"} ${checks.filter((entry) => entry.ok).length}/${checks.length}: ${join(OUT, "report.json")}\n`,
);
if (!passed) process.exitCode = 1;
