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
  type CdpCheckContext,
  checkCdpCommand,
  projectCdpEvent,
} from "@openbot/contracts/chrome-bridge/cdp-allowlist";
import { ENGINE_GESTURE_FUNCTIONS } from "@openbot/contracts/chrome-bridge/cdp-functions";
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
const context: CdpCheckContext = {
  operation: "other",
  agentTab: true,
  contexts: new Set([5]),
  childSessions: new Set(["CHILD"]),
  gestureFunctions: ENGINE_GESTURE_FUNCTIONS,
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
  "a user gesture for a function outside the engine table is denied",
  code(
    decision(
      "Runtime.callFunctionOn",
      { functionDeclaration: "function() { fetch('https://evil.test') }", objectId: "1", userGesture: true },
      { functionDigest: createHash("sha256").update("function() { fetch('https://evil.test') }").digest("hex") },
    ),
  ) === "param_denied",
);
check(
  "a user gesture for an engine function is allowed",
  ENGINE_GESTURE_FUNCTIONS.size > 0 &&
    code(
      decision(
        "Runtime.callFunctionOn",
        { functionDeclaration: "x", objectId: "1", userGesture: true },
        { functionDigest: engineDigest },
      ),
    ) === "ok",
);
check(
  "an evaluate with a user gesture is denied (agent code goes through script.run)",
  code(decision("Runtime.evaluate", { expression: "1", userGesture: true })) === "param_denied",
);
check(
  "an evaluate in a context the tab never reported is denied",
  code(decision("Runtime.evaluate", { expression: "1", contextId: 9 })) === "param_denied",
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
check("a screenshot asks for the secret check", screenshot.ok && screenshot.secretCheck);
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
for (const file of (await readdir(join(ROOT, "src/backend"))).filter(
  (name) => /^browser-.*\.ts$/u.test(name) && !name.endsWith(".test.ts"),
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
