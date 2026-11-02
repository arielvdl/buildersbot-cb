/**
 * The CDP methods, parameters and events that may cross the Chrome bridge. The extension checks each
 * command against this list before `chrome.debugger.sendCommand`, and the app checks it before it sends
 * (defense in depth). Both lists are closed: a method that is not here is `method_denied`, and a
 * parameter that its method does not name is `param_denied`, so a CDP release that adds a parameter
 * adds nothing here.
 *
 * The list comes from the methods that `src/backend/browser-*.ts` sends today, less what an extension
 * cannot do (`Target.attachToTarget`, `DOM.setFileInputFiles`) and what reads data the agent must not
 * get (cookies, storage, network bodies, the clipboard, the tab's history). Page code runs only as an
 * engine function of `cdp-functions.ts` (by digest), unless the person turned on the agent's own
 * scripts. Events and results leave the extension reduced to the fields here; no `Network.*` event
 * leaves it, because those carry cookie values, `HttpOnly` ones too.
 */

import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "../runtime-values";
import { utf8Length } from "./decode";
import { type FloorOptions, siteFloorDecision } from "./site-floor";

export type CdpParamRule =
  | { readonly t: "bool"; readonly only?: boolean }
  | { readonly t: "int"; readonly min: number; readonly max: number }
  | { readonly t: "num"; readonly min: number; readonly max: number }
  | { readonly t: "str"; readonly max: number; readonly oneOf?: readonly string[] }
  | { readonly t: "arr"; readonly item: CdpParamRule; readonly max: number }
  | {
      readonly t: "obj";
      readonly fields: Readonly<Record<string, CdpParamRule>>;
      readonly required?: readonly string[];
    }
  /** A JSON value whose meaning the page reads, such as an argument of an engine function. */
  | { readonly t: "json"; readonly maxBytes: number };

/** A condition that the shape cannot say, checked with the context of the call. */
export type CdpCondition =
  /** Only inside the operation that navigates, as the engine's `navigate` does. */
  | "navigation"
  /** Only inside an upload. */
  | "upload"
  /** Only in a tab that an agent created, not in a tab of the person. */
  | "agent-tab"
  /**
   * The extension runs its secret check before the command and refuses with `secret_present`. A field
   * that `secret.fill` typed counts too, unless the read shows it masked (`secret-masked`).
   */
  | "secret-check"
  /**
   * The read shows a password field only as dots (a screenshot, the accessibility tree), so a password
   * that `secret.fill` typed, in a field that is still a password field, does not count.
   */
  | "secret-masked"
  /**
   * Page code. It runs only when its declaration is an engine function of `cdp-functions.ts` (by
   * SHA-256), or when the person turned on the agent's own scripts for the project. `Runtime.evaluate`
   * has no engine function: the engine runs its code through `Runtime.callFunctionOn`.
   */
  | "scripts"
  /**
   * The extension checks the floor on the URL of the history entry before the command. A page from
   * the back-forward cache loads with no request, so the `declarativeNetRequest` rule cannot stop it.
   */
  | "history-floor"
  /** The extension answers success and sends nothing, unless the person allowed agents to raise tabs. */
  | "no-op";

export interface CdpMethodRule {
  readonly params: Readonly<Record<string, CdpParamRule>>;
  readonly required?: readonly string[];
  readonly when?: readonly CdpCondition[];
}

const bool: CdpParamRule = { t: "bool" };
const falseOnly: CdpParamRule = { t: "bool", only: false };
const trueOnly: CdpParamRule = { t: "bool", only: true };
const nodeId: CdpParamRule = { t: "int", min: 1, max: 2 ** 31 - 1 };
const contextId: CdpParamRule = { t: "int", min: 1, max: 2 ** 31 - 1 };
const objectId: CdpParamRule = { t: "str", max: 256 };
const frameId: CdpParamRule = { t: "str", max: 128 };
const coordinate: CdpParamRule = { t: "num", min: -1_000_000, max: 1_000_000 };
const pixels: CdpParamRule = { t: "int", min: 0, max: 10_000_000 };
const modifiers: CdpParamRule = { t: "int", min: 0, max: 15 };
const timestamp: CdpParamRule = { t: "num", min: 0, max: 1e13 };
const nodeTarget = { backendNodeId: nodeId, nodeId, objectId } as const;
const rect: CdpParamRule = {
  t: "obj",
  fields: { x: coordinate, y: coordinate, width: coordinate, height: coordinate },
  required: ["x", "y", "width", "height"],
};
const empty = { params: {} } as const;

/** The isolated world of the browser engine, the only world that a command may make. */
export const ENGINE_WORLD_NAME = "openbot-browser-automation";

export const CDP_ALLOWLIST: Readonly<Record<string, CdpMethodRule>> = {
  "Accessibility.enable": empty,
  "Accessibility.getFullAXTree": {
    params: { depth: { t: "int", min: -1, max: 1000 }, frameId },
    when: ["secret-check", "secret-masked"],
  },
  "Accessibility.getPartialAXTree": {
    params: { ...nodeTarget, fetchRelatives: bool },
    when: ["secret-check", "secret-masked"],
  },

  "DOM.enable": { params: { includeWhitespace: { t: "str", max: 8, oneOf: ["none", "all"] } } },
  // Attributes can hold a value that the server wrote into a secret field.
  "DOM.describeNode": {
    params: { ...nodeTarget, depth: { t: "int", min: -1, max: 64 }, pierce: bool },
    when: ["secret-check"],
  },
  "DOM.focus": { params: nodeTarget },
  "DOM.getBoxModel": { params: nodeTarget },
  "DOM.getDocument": { params: { depth: { t: "int", min: -1, max: 64 }, pierce: bool }, when: ["secret-check"] },
  "DOM.getFrameOwner": { params: { frameId }, required: ["frameId"] },
  "DOM.getNodeForLocation": {
    params: { x: pixels, y: pixels, includeUserAgentShadowDOM: bool, ignorePointerEventsNone: bool },
    required: ["x", "y"],
  },
  "DOM.resolveNode": {
    params: { backendNodeId: nodeId, nodeId, objectGroup: { t: "str", max: 64 }, executionContextId: contextId },
  },
  "DOM.scrollIntoViewIfNeeded": { params: { ...nodeTarget, rect } },

  "Emulation.setFocusEmulationEnabled": { params: { enabled: bool }, required: ["enabled"] },
  "Emulation.setDeviceMetricsOverride": {
    params: {
      width: pixels,
      height: pixels,
      deviceScaleFactor: { t: "num", min: 0, max: 10 },
      mobile: bool,
      screenWidth: pixels,
      screenHeight: pixels,
    },
    required: ["width", "height", "deviceScaleFactor", "mobile"],
    when: ["agent-tab"],
  },
  "Emulation.clearDeviceMetricsOverride": empty,
  "Emulation.setEmulatedMedia": {
    params: {
      media: { t: "str", max: 16, oneOf: ["", "screen", "print"] },
      features: {
        t: "arr",
        max: 16,
        item: {
          t: "obj",
          fields: { name: { t: "str", max: 64 }, value: { t: "str", max: 64 } },
          required: ["name", "value"],
        },
      },
    },
    when: ["agent-tab"],
  },

  "Input.dispatchMouseEvent": {
    params: {
      type: { t: "str", max: 16, oneOf: ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"] },
      x: coordinate,
      y: coordinate,
      modifiers,
      timestamp,
      button: { t: "str", max: 8, oneOf: ["none", "left", "middle", "right", "back", "forward"] },
      buttons: { t: "int", min: 0, max: 31 },
      clickCount: { t: "int", min: 0, max: 3 },
      deltaX: coordinate,
      deltaY: coordinate,
      pointerType: { t: "str", max: 8, oneOf: ["mouse", "pen"] },
    },
    required: ["type", "x", "y"],
  },
  "Input.dispatchKeyEvent": {
    params: {
      type: { t: "str", max: 16, oneOf: ["keyDown", "keyUp", "rawKeyDown", "char"] },
      modifiers,
      timestamp,
      text: { t: "str", max: 16 },
      unmodifiedText: { t: "str", max: 16 },
      code: { t: "str", max: 32 },
      key: { t: "str", max: 32 },
      windowsVirtualKeyCode: { t: "int", min: 0, max: 255 },
      nativeVirtualKeyCode: { t: "int", min: 0, max: 65_535 },
      autoRepeat: bool,
      isKeypad: bool,
      isSystemKey: bool,
      location: { t: "int", min: 0, max: 3 },
      // `paste` would hand the page the person's clipboard; the engine sends only `selectAll`.
      commands: { t: "arr", max: 1, item: { t: "str", max: 16, oneOf: ["selectAll"] } },
    },
    required: ["type"],
    // The keys of copy, cut and paste are refused in `checkCdpCommand`, see `isClipboardKey`.
  },
  "Input.insertText": { params: { text: { t: "str", max: 64 * 1024 } }, required: ["text"] },
  "Input.dispatchDragEvent": {
    params: {
      type: { t: "str", max: 16, oneOf: ["dragEnter", "dragOver", "drop", "dragCancel"] },
      x: coordinate,
      y: coordinate,
      modifiers,
      // No `files`: a drag carries only the data the page itself put in it.
      data: {
        t: "obj",
        fields: {
          items: {
            t: "arr",
            max: 64,
            item: {
              t: "obj",
              fields: {
                mimeType: { t: "str", max: 128 },
                data: { t: "str", max: 256 * 1024 },
                title: { t: "str", max: 512 },
                baseURL: { t: "str", max: 8192 },
              },
              required: ["mimeType", "data"],
            },
          },
          dragOperationsMask: { t: "int", min: 0, max: 255 },
        },
        required: ["items", "dragOperationsMask"],
      },
    },
    required: ["type", "x", "y", "data"],
  },
  "Input.setInterceptDrags": { params: { enabled: bool }, required: ["enabled"] },

  "Log.enable": empty,
  "Log.disable": empty,

  // A buffer of zero keeps no body; the extension drops every Network event.
  "Network.enable": {
    params: {
      maxTotalBufferSize: { t: "int", min: 0, max: 0 },
      maxResourceBufferSize: { t: "int", min: 0, max: 0 },
      maxPostDataSize: { t: "int", min: 0, max: 0 },
    },
    when: ["navigation"],
  },
  "Network.disable": { params: {}, when: ["navigation"] },
  "Network.setCacheDisabled": { params: { cacheDisabled: bool }, required: ["cacheDisabled"], when: ["navigation"] },

  "Overlay.enable": empty,
  "Overlay.highlightNode": {
    params: { ...nodeTarget, highlightConfig: { t: "json", maxBytes: 4096 }, selector: { t: "str", max: 512 } },
    required: ["highlightConfig"],
  },
  "Overlay.hideHighlight": empty,

  "Page.enable": empty,
  "Page.disable": empty,
  "Page.getFrameTree": empty,
  "Page.getLayoutMetrics": empty,
  "Page.navigate": { params: { url: { t: "str", max: 8192 } }, required: ["url"] },
  "Page.reload": { params: { ignoreCache: bool } },
  "Page.stopLoading": empty,
  "Page.navigateToHistoryEntry": {
    params: { entryId: { t: "int", min: 0, max: 2 ** 31 - 1 } },
    required: ["entryId"],
    when: ["history-floor"],
  },
  "Page.setLifecycleEventsEnabled": { params: { enabled: bool }, required: ["enabled"] },
  "Page.handleJavaScriptDialog": {
    params: { accept: bool, promptText: { t: "str", max: 2048 } },
    required: ["accept"],
  },
  // Only the engine's world: the extension's own worlds (the secret check) have names of their own.
  "Page.createIsolatedWorld": {
    params: { frameId, worldName: { t: "str", max: 64, oneOf: [ENGINE_WORLD_NAME] }, grantUniveralAccess: falseOnly },
    required: ["frameId", "worldName"],
  },
  "Page.setInterceptFileChooserDialog": { params: { enabled: bool }, required: ["enabled"], when: ["upload"] },
  "Page.captureScreenshot": {
    params: {
      format: { t: "str", max: 8, oneOf: ["png", "jpeg", "webp"] },
      quality: { t: "int", min: 0, max: 100 },
      clip: {
        t: "obj",
        fields: {
          x: coordinate,
          y: coordinate,
          width: coordinate,
          height: coordinate,
          scale: { t: "num", min: 0, max: 4 },
        },
        required: ["x", "y", "width", "height", "scale"],
      },
      fromSurface: bool,
      captureBeyondViewport: falseOnly,
      optimizeForSpeed: bool,
    },
    when: ["secret-check", "secret-masked"],
  },
  "Page.setWebLifecycleState": { params: { state: { t: "str", max: 8, oneOf: ["active"] } }, required: ["state"] },
  "Page.bringToFront": { params: {}, when: ["no-op"] },

  "Runtime.enable": empty,
  "Runtime.evaluate": {
    params: {
      expression: { t: "str", max: 256 * 1024 },
      contextId,
      returnByValue: bool,
      awaitPromise: bool,
      // An agent's own code goes through `script.run`, with no gesture.
      userGesture: falseOnly,
      timeout: { t: "num", min: 0, max: 60_000 },
      disableBreaks: bool,
      silent: bool,
      objectGroup: { t: "str", max: 64 },
      includeCommandLineAPI: falseOnly,
    },
    required: ["expression"],
    when: ["scripts", "secret-check"],
  },
  "Runtime.callFunctionOn": {
    params: {
      functionDeclaration: { t: "str", max: 64 * 1024 },
      objectId,
      executionContextId: contextId,
      arguments: {
        t: "arr",
        max: 32,
        item: { t: "obj", fields: { value: { t: "json", maxBytes: 768 * 1024 }, objectId } },
      },
      returnByValue: bool,
      awaitPromise: bool,
      silent: bool,
      objectGroup: { t: "str", max: 64 },
      // Allowed true only for a declaration in the engine table, see `checkCdpCommand`.
      userGesture: bool,
    },
    required: ["functionDeclaration"],
    when: ["scripts", "secret-check"],
  },
  "Runtime.getProperties": {
    params: { objectId, ownProperties: bool, accessorPropertiesOnly: bool, nonIndexedPropertiesOnly: bool },
    required: ["objectId"],
    when: ["secret-check"],
  },
  "Runtime.releaseObject": { params: { objectId }, required: ["objectId"] },

  // Without the iframe filter, service and shared workers that serve tabs outside the group would attach.
  "Target.setAutoAttach": {
    params: {
      autoAttach: trueOnly,
      waitForDebuggerOnStart: falseOnly,
      flatten: trueOnly,
      filter: {
        t: "arr",
        max: 1,
        item: {
          t: "obj",
          fields: { type: { t: "str", max: 8, oneOf: ["iframe"] }, exclude: falseOnly },
          required: ["type", "exclude"],
        },
      },
    },
    required: ["autoAttach", "waitForDebuggerOnStart", "flatten", "filter"],
  },
  "Target.detachFromTarget": { params: { sessionId: { t: "str", max: 64 } }, required: ["sessionId"] },
  "Target.getTargetInfo": empty,
};

export type CdpDenial = {
  readonly ok: false;
  readonly code: "method_denied" | "param_denied" | "site_blocked" | "out_of_scope" | "scripts_disabled";
  readonly reason: string;
};
export type CdpAllowed = {
  readonly ok: true;
  /**
   * The secret check before the command: "strict" counts every secret, "masked" lets a password that
   * `secret.fill` typed pass, because the read shows it only as dots.
   */
  readonly secretCheck: "none" | "strict" | "masked";
  /** Check the floor on the URL of the history entry before the command. */
  readonly historyFloorCheck: boolean;
  /** Answer success and send nothing. */
  readonly noOp: boolean;
};

/** What the caller knows of the tab and of the call, for the checks that the shape cannot make. */
export interface CdpCheckContext {
  readonly operation: "navigate" | "upload" | "other";
  readonly agentTab: boolean;
  /**
   * The execution contexts of the command's session that a command may name: the page's worlds and the
   * engine's world, never the extension's own worlds (the secret check). An object id names one too.
   */
  readonly contexts: ReadonlySet<number>;
  /** The child sessions of the tab that the extension registered, less the blocked ones. */
  readonly childSessions: ReadonlySet<string>;
  /**
   * The SHA-256, in lower-case hex, of `functionDeclaration` when the command has one. The caller
   * computes it (WebCrypto in the extension, `node:crypto` in the app); this file holds no crypto.
   */
  readonly functionDigest?: string;
  /** Digests of every engine function (`cdp-functions.ts`). */
  readonly engineFunctions: ReadonlySet<string>;
  /** Digests of the engine functions that may run with a user gesture (`cdp-functions.ts`). */
  readonly gestureFunctions: ReadonlySet<string>;
  /** The person turned on the agent's own scripts for this project. */
  readonly scripts: boolean;
  readonly floor: FloorOptions;
  /** The person allowed agents to bring tabs to the front. */
  readonly raiseTabs?: boolean;
}

function checkParam(rule: CdpParamRule, value: unknown, path: string): string | null {
  switch (rule.t) {
    case "bool":
      if (!isBoolean(value)) return `${path} is not a boolean`;
      return rule.only !== undefined && value !== rule.only ? `${path} must be ${rule.only}` : null;
    case "int":
      return isNumber(value) && Number.isSafeInteger(value) && value >= rule.min && value <= rule.max
        ? null
        : `${path} is out of range`;
    case "num":
      return isNumber(value) && Number.isFinite(value) && value >= rule.min && value <= rule.max
        ? null
        : `${path} is out of range`;
    case "str":
      if (!isString(value) || value.length > rule.max) return `${path} is not a string within ${rule.max}`;
      return rule.oneOf && !rule.oneOf.includes(value) ? `${path} has a value that is not allowed` : null;
    case "arr":
      if (!Array.isArray(value) || value.length > rule.max) return `${path} is not an array within ${rule.max}`;
      for (const [index, item] of value.entries()) {
        const problem = checkParam(rule.item, item, `${path}[${index}]`);
        if (problem) return problem;
      }
      return null;
    case "obj":
      return checkFields(rule.fields, rule.required ?? [], value, path);
    case "json": {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(value);
      } catch {
        return `${path} is not JSON`;
      }
      return serialized === undefined || utf8Length(serialized) > rule.maxBytes ? `${path} is too large` : null;
    }
  }
}

function checkFields(
  fields: Readonly<Record<string, CdpParamRule>>,
  required: readonly string[],
  value: unknown,
  path: string,
): string | null {
  if (!isDynamicRecord(value)) return `${path} is not an object`;
  for (const key of Object.keys(value)) {
    // Own keys only: `constructor` or `__proto__` would otherwise find a rule on the prototype.
    const rule = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!rule) return `${path}.${key} is not an allowed parameter`;
    const problem = checkParam(rule, value[key], `${path}.${key}`);
    if (problem) return problem;
  }
  for (const key of required) if (!Object.hasOwn(value, key)) return `${path}.${key} is missing`;
  return null;
}

const denied = (code: CdpDenial["code"], reason: string): CdpDenial => ({ ok: false, code, reason });

/**
 * The execution context of a remote object id, which V8 writes as `<isolate>.<context>.<object>`; null
 * for an id in another form. An id is easy to make up: its context is checked as a context id is.
 */
export function objectIdContext(objectId: string): number | null {
  const match = /^-?\d{1,20}\.(\d{1,10})\.\d{1,10}$/u.exec(objectId);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** The object ids of a command: its own, and those of the arguments of a function call. */
function objectIdsOf(values: DynamicRecord): string[] {
  const ids = isString(values.objectId) ? [values.objectId] : [];
  if (Array.isArray(values.arguments))
    for (const argument of values.arguments)
      if (isDynamicRecord(argument) && isString(argument.objectId)) ids.push(argument.objectId);
  return ids;
}

const CONTROL = 2;
const META = 4;
const SHIFT = 8;
/** The letters of copy, cut and paste: `key`, `code`, Windows key code, macOS key code. */
const CLIPBOARD_LETTERS: readonly { key: string; code: string; windows: number; mac: number }[] = [
  { key: "c", code: "KeyC", windows: 67, mac: 8 },
  { key: "v", code: "KeyV", windows: 86, mac: 9 },
  { key: "x", code: "KeyX", windows: 88, mac: 7 },
];
/** The keys that are copy, cut or paste by themselves, as some keyboards have them. */
const CLIPBOARD_KEYS = new Set(["copy", "cut", "paste"]);

/**
 * Whether a key event can reach the person's clipboard: Ctrl or Cmd with C, V or X; Insert with Ctrl
 * or Shift and Delete with Shift (copy, paste and cut on Windows and Linux); and the Copy, Cut and
 * Paste keys. Each key is known by `key`, `code` and both key codes, so another spelling of the same
 * key does not pass. The engine types with `Input.insertText` and pastes with a page event, never
 * with these keys.
 */
export function isClipboardKey(params: DynamicRecord): boolean {
  const modifiers = isNumber(params.modifiers) ? params.modifiers : 0;
  const key = isString(params.key) ? params.key.toLowerCase() : "";
  const code = isString(params.code) ? params.code.toLowerCase() : "";
  const windows = isNumber(params.windowsVirtualKeyCode) ? params.windowsVirtualKeyCode : -1;
  const mac = isNumber(params.nativeVirtualKeyCode) ? params.nativeVirtualKeyCode : -1;
  const texts = [params.text, params.unmodifiedText].filter(isString).map((text) => text.toLowerCase());
  if (CLIPBOARD_KEYS.has(key) || CLIPBOARD_KEYS.has(code)) return true;
  const command = (modifiers & (CONTROL | META)) !== 0;
  const letter = CLIPBOARD_LETTERS.some(
    (entry) =>
      key === entry.key ||
      code === entry.code.toLowerCase() ||
      windows === entry.windows ||
      mac === entry.mac ||
      texts.includes(entry.key),
  );
  if (command && letter) return true;
  // Ctrl+V types the control character U+0016 on some layouts; C and X are U+0003 and U+0018.
  if (texts.some((text) => ["\u0003", "\u0016", "\u0018"].includes(text))) return true;
  const insert = key === "insert" || code === "insert" || windows === 45 || mac === 114;
  const del = key === "delete" || code === "delete" || windows === 46 || mac === 117;
  if (insert && (modifiers & (CONTROL | SHIFT)) !== 0) return true;
  return del && (modifiers & SHIFT) !== 0;
}

/**
 * The decision for one CDP command: the method, every parameter, and the conditions of its context.
 * `session` is the child session it targets, or undefined for the tab itself.
 */
export function checkCdpCommand(
  method: string,
  params: unknown,
  session: string | undefined,
  context: CdpCheckContext,
): CdpAllowed | CdpDenial {
  const rule = Object.hasOwn(CDP_ALLOWLIST, method) ? CDP_ALLOWLIST[method] : undefined;
  if (!rule) return denied("method_denied", `${method} is not allowed`);
  if (session !== undefined && !context.childSessions.has(session))
    return denied("out_of_scope", "the session is not a frame of this tab");
  const shape = checkFields(rule.params, rule.required ?? [], params ?? {}, "params");
  if (shape) return denied("param_denied", shape);
  const values = isDynamicRecord(params) ? params : {};
  const when = rule.when ?? [];
  if (when.includes("navigation") && context.operation !== "navigate")
    return denied("method_denied", `${method} is allowed only while the tab navigates`);
  if (when.includes("upload") && context.operation !== "upload")
    return denied("method_denied", `${method} is allowed only during an upload`);
  if (when.includes("agent-tab") && !context.agentTab)
    return denied("method_denied", `${method} is allowed only in a tab an agent opened`);
  if (
    when.includes("scripts") &&
    !context.scripts &&
    !(
      method === "Runtime.callFunctionOn" &&
      context.functionDigest !== undefined &&
      context.engineFunctions.has(context.functionDigest)
    )
  )
    return denied("scripts_disabled", `${method} runs only the engine's own functions while scripts are off`);

  for (const objectId of objectIdsOf(values)) {
    const objectContext = objectIdContext(objectId);
    if (objectContext === null || !context.contexts.has(objectContext))
      return denied("param_denied", "an object id names an object outside the contexts of this tab");
  }

  switch (method) {
    case "Page.navigate": {
      const decision = siteFloorDecision(String(values.url), context.floor);
      if (decision.blocked) return denied("site_blocked", `the address is blocked (${decision.rule})`);
      break;
    }
    case "Runtime.evaluate":
      if (isNumber(values.contextId) && !context.contexts.has(values.contextId))
        return denied("param_denied", "params.contextId is not a context of this tab");
      break;
    case "DOM.resolveNode":
    case "Runtime.callFunctionOn": {
      const id = values.executionContextId;
      if (isNumber(id) && !context.contexts.has(id))
        return denied("param_denied", "params.executionContextId is not a context of this tab");
      if (
        method === "Runtime.callFunctionOn" &&
        values.userGesture === true &&
        (context.functionDigest === undefined || !context.gestureFunctions.has(context.functionDigest))
      )
        return denied("param_denied", "params.userGesture is allowed only for an engine function");
      break;
    }
    case "Target.detachFromTarget":
      if (!isString(values.sessionId) || !context.childSessions.has(values.sessionId))
        return denied("out_of_scope", "params.sessionId is not a frame of this tab");
      break;
    case "Input.dispatchKeyEvent":
      if (isClipboardKey(values))
        return denied("param_denied", "a copy, cut or paste key would reach the person's clipboard");
      break;
  }
  return {
    ok: true,
    secretCheck: !when.includes("secret-check") ? "none" : when.includes("secret-masked") ? "masked" : "strict",
    historyFloorCheck: when.includes("history-floor"),
    noOp: when.includes("no-op") && context.raiseTabs !== true,
  };
}

// ---------------------------------------------------------------------------------------------------
// Events

/** A field of an event that may leave the extension. */
export type CdpEventValue = string | number | boolean | readonly CdpEventValue[] | CdpEventFields;
export interface CdpEventFields {
  readonly [field: string]: CdpEventValue;
}

type EventProjection = (params: DynamicRecord) => CdpEventFields;

const recordAt = (value: DynamicRecord | undefined, key: string): DynamicRecord | undefined => {
  const nested = value?.[key];
  return isDynamicRecord(nested) ? nested : undefined;
};
const textAt = (value: DynamicRecord | undefined, key: string, max: number): string | undefined => {
  const text = value?.[key];
  return isString(text) ? text.slice(0, max) : undefined;
};
const numberAt = (value: DynamicRecord | undefined, key: string): number | undefined => {
  const number = value?.[key];
  return isNumber(number) && Number.isFinite(number) ? number : undefined;
};
const booleanAt = (value: DynamicRecord | undefined, key: string): boolean | undefined => {
  const flag = value?.[key];
  return isBoolean(flag) ? flag : undefined;
};
/** A URL with no fragment: a fragment can carry a token (`#access_token=`), and no consumer reads it. */
const urlAt = (value: DynamicRecord | undefined, key: string): string | undefined => {
  const url = textAt(value, key, 16_384);
  if (url === undefined) return undefined;
  const hash = url.indexOf("#");
  return (hash === -1 ? url : url.slice(0, hash)).slice(0, 8192);
};
const originAt = (value: DynamicRecord | undefined, key: string): string | undefined => {
  const url = textAt(value, key, 16_384);
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};
/** The fields that have a value. */
const defined = (entries: { readonly [field: string]: CdpEventValue | undefined }): CdpEventFields => {
  const fields: { [field: string]: CdpEventValue } = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) fields[key] = value;
  return fields;
};
const targetInfo = (params: DynamicRecord): CdpEventFields => {
  const info = recordAt(params, "targetInfo");
  return defined({ type: textAt(info, "type", 16), url: urlAt(info, "url"), targetId: textAt(info, "targetId", 64) });
};

/** The console reduced to a text made only of primitive arguments, never the objects themselves. */
function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return "";
  return args
    .map((argument) => {
      const value = isDynamicRecord(argument) ? argument.value : undefined;
      return isString(value) || isNumber(value) || isBoolean(value) ? String(value) : "";
    })
    .filter((part) => part.length > 0)
    .join(" ")
    .slice(0, 1024);
}

/**
 * The events that leave the extension, each reduced to its allowed fields. An event that is not here
 * stays in the extension; it never reaches the app or an agent.
 */
export const CDP_EVENTS: { readonly [method: string]: EventProjection } = {
  "Page.javascriptDialogOpening": (params) =>
    defined({
      type: textAt(params, "type", 16),
      message: textAt(params, "message", 2048),
      url: originAt(params, "url"),
    }),
  "Page.javascriptDialogClosed": (params) => defined({ result: booleanAt(params, "result") }),
  "Page.fileChooserOpened": (params) =>
    defined({
      frameId: textAt(params, "frameId", 128),
      backendNodeId: numberAt(params, "backendNodeId"),
      mode: textAt(params, "mode", 16),
    }),
  "Page.frameNavigated": (params) => {
    const frame = recordAt(params, "frame");
    return {
      frame: defined({
        id: textAt(frame, "id", 128),
        parentId: textAt(frame, "parentId", 128),
        url: urlAt(frame, "url"),
        securityOrigin: textAt(frame, "securityOrigin", 2048),
      }),
    };
  },
  "Page.navigatedWithinDocument": (params) =>
    defined({ frameId: textAt(params, "frameId", 128), url: urlAt(params, "url") }),
  "Page.lifecycleEvent": (params) =>
    defined({ frameId: textAt(params, "frameId", 128), name: textAt(params, "name", 64) }),
  "Page.loadEventFired": () => ({}),
  "Page.domContentEventFired": () => ({}),
  "Page.windowOpen": (params) => defined({ url: urlAt(params, "url") }),
  "Target.attachedToTarget": (params) =>
    defined({ sessionId: textAt(params, "sessionId", 64), targetInfo: targetInfo(params) }),
  "Target.detachedFromTarget": (params) => defined({ sessionId: textAt(params, "sessionId", 64) }),
  "Target.targetInfoChanged": (params) => ({ targetInfo: targetInfo(params) }),
  "Runtime.executionContextCreated": (params) => {
    const context = recordAt(params, "context");
    const aux = recordAt(context, "auxData");
    return {
      context: defined({
        id: numberAt(context, "id"),
        origin: textAt(context, "origin", 2048),
        auxData: defined({ frameId: textAt(aux, "frameId", 128), isDefault: booleanAt(aux, "isDefault") }),
      }),
    };
  },
  "Runtime.executionContextDestroyed": (params) =>
    defined({ executionContextId: numberAt(params, "executionContextId") }),
  "Runtime.executionContextsCleared": () => ({}),
  "Input.dragIntercepted": (params) => {
    const data = recordAt(params, "data");
    const items = data?.items;
    return {
      data: {
        // No `files`: a drop of the person's files never leaves the extension.
        items: Array.isArray(items)
          ? items.slice(0, 64).map((item) => {
              const entry = isDynamicRecord(item) ? item : undefined;
              return defined({
                mimeType: textAt(entry, "mimeType", 128),
                data: textAt(entry, "data", 256 * 1024),
                title: textAt(entry, "title", 512),
                baseURL: textAt(entry, "baseURL", 8192),
              });
            })
          : [],
        dragOperationsMask: numberAt(data, "dragOperationsMask") ?? 0,
      },
    };
  },
  "Log.entryAdded": (params) => {
    const entry = recordAt(params, "entry");
    return defined({
      level: textAt(entry, "level", 16),
      text: textAt(entry, "text", 1024),
      origin: originAt(entry, "url"),
    });
  },
  "Runtime.consoleAPICalled": (params) =>
    defined({ level: textAt(params, "type", 16), text: consoleText(params.args) }),
};

/**
 * The event as it may leave the extension, or null when it may not. Every `Network.*` event, and every
 * `*ExtraInfo`, `webSocket*` and `eventSource*` event, is null.
 */
export function projectCdpEvent(method: string, params: unknown): CdpEventFields | null {
  const projection = Object.hasOwn(CDP_EVENTS, method) ? CDP_EVENTS[method] : undefined;
  return projection ? projection(isDynamicRecord(params) ? params : {}) : null;
}

// ---------------------------------------------------------------------------------------------------
// Results

/** What a result projection needs from the caller. */
export interface CdpResultContext {
  /** Whether the URL of a frame is a site of the floor. Its URL and origin leave hidden. */
  readonly onFloor: (url: string) => boolean;
}

type ResultProjection = (result: DynamicRecord, context: CdpResultContext) => DynamicRecord;

/** The fields of `value` that this list names, as they are. */
const pick = (value: unknown, fields: readonly string[]): { [field: string]: unknown } => {
  const out: { [field: string]: unknown } = {};
  if (!isDynamicRecord(value)) return out;
  for (const field of fields) if (Object.hasOwn(value, field) && value[field] !== undefined) out[field] = value[field];
  return out;
};
const withoutFragment = (url: string): string => {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
};
/** A list of the projected entries, or nothing when the value is not a list. */
const listOf = <T>(value: unknown, project: (entry: unknown) => T): T[] | undefined =>
  Array.isArray(value) ? value.map(project) : undefined;
const setDefined = (out: { [field: string]: unknown }, field: string, value: unknown): void => {
  if (value !== undefined) out[field] = value;
};

const REMOTE_OBJECT_FIELDS = [
  "type",
  "subtype",
  "className",
  "value",
  "unserializableValue",
  "description",
  "objectId",
] as const;
const remoteObject = (value: unknown) => pick(value, REMOTE_OBJECT_FIELDS);
/** An exception, without the URL and the stack of the script that threw. */
const exceptionDetails = (value: unknown) => {
  const out = pick(value, ["exceptionId", "text", "lineNumber", "columnNumber", "executionContextId"]);
  if (isDynamicRecord(value) && value.exception !== undefined) out.exception = remoteObject(value.exception);
  return out;
};
const evaluation: ResultProjection = (result) => {
  const out: { [field: string]: unknown } = { result: remoteObject(result.result) };
  if (result.exceptionDetails !== undefined) out.exceptionDetails = exceptionDetails(result.exceptionDetails);
  return out;
};

const NODE_FIELDS = [
  "nodeId",
  "parentId",
  "backendNodeId",
  "nodeType",
  "nodeName",
  "localName",
  "nodeValue",
  "childNodeCount",
  "attributes",
  "publicId",
  "systemId",
  "internalSubset",
  "xmlVersion",
  "name",
  "value",
  "pseudoType",
  "pseudoIdentifier",
  "shadowRootType",
  "frameId",
  "isSVG",
  "compatibilityMode",
  "isScrollable",
] as const;
const backendNode = (value: unknown) => pick(value, ["nodeType", "nodeName", "backendNodeId"]);
/** A DOM node and the nodes in it, with the closed fields and no URL fragment. */
function domNode(value: unknown, depth = 0): { [field: string]: unknown } {
  const out = pick(value, NODE_FIELDS);
  if (!isDynamicRecord(value)) return out;
  if (isString(value.documentURL)) out.documentURL = withoutFragment(value.documentURL);
  if (isString(value.baseURL)) out.baseURL = withoutFragment(value.baseURL);
  if (depth >= 256) return out;
  const nested = (entry: unknown) => domNode(entry, depth + 1);
  setDefined(out, "children", listOf(value.children, nested));
  setDefined(out, "shadowRoots", listOf(value.shadowRoots, nested));
  setDefined(out, "pseudoElements", listOf(value.pseudoElements, nested));
  setDefined(out, "distributedNodes", listOf(value.distributedNodes, backendNode));
  if (value.contentDocument !== undefined) out.contentDocument = nested(value.contentDocument);
  if (value.templateContent !== undefined) out.templateContent = nested(value.templateContent);
  if (value.importedDocument !== undefined) out.importedDocument = nested(value.importedDocument);
  if (value.assignedSlot !== undefined) out.assignedSlot = backendNode(value.assignedSlot);
  return out;
}

/** A frame tree with the closed fields, no URL fragment, and frames of the floor hidden. */
function frameTree(value: unknown, context: CdpResultContext, depth = 0): { [field: string]: unknown } {
  const tree = isDynamicRecord(value) ? value : {};
  const source = isDynamicRecord(tree.frame) ? tree.frame : {};
  const frame = pick(source, ["id", "parentId", "loaderId", "name", "securityOrigin", "mimeType"]);
  const url = isString(source.url) ? withoutFragment(source.url) : "";
  frame.url = url;
  if (url !== "" && context.onFloor(url)) {
    frame.url = "about:blank";
    frame.securityOrigin = "null";
    frame.name = "";
  }
  const out: { [field: string]: unknown } = { frame };
  if (depth < 64)
    setDefined(
      out,
      "childFrames",
      listOf(tree.childFrames, (entry) => frameTree(entry, context, depth + 1)),
    );
  return out;
}

const AX_NODE_FIELDS = [
  "nodeId",
  "ignored",
  "ignoredReasons",
  "role",
  "chromeRole",
  "name",
  "description",
  "value",
  "properties",
  "parentId",
  "childIds",
  "backendDOMNodeId",
  "frameId",
] as const;
/** An accessibility node. The document's own node names the page URL, which loses its fragment. */
function axNode(value: unknown): { [field: string]: unknown } {
  const out = pick(value, AX_NODE_FIELDS);
  const role = isDynamicRecord(out.role) ? out.role.value : undefined;
  if ((role === "RootWebArea" || role === "WebArea") && Array.isArray(out.properties))
    out.properties = out.properties.map((property) => {
      if (!isDynamicRecord(property) || property.name !== "url" || !isDynamicRecord(property.value)) return property;
      const url = property.value.value;
      return isString(url) ? { ...property, value: { ...property.value, value: withoutFragment(url) } } : property;
    });
  return out;
}

const emptyResult: ResultProjection = () => ({});
const axTree: ResultProjection = (result) => ({ nodes: listOf(result.nodes, axNode) ?? [] });

/**
 * The fields of each result that may leave the extension, for every method of `CDP_ALLOWLIST`. A field
 * that a projection does not name stays in the extension, so a CDP release that adds a field adds
 * nothing here.
 */
export const CDP_RESULTS: { readonly [method: string]: ResultProjection } = {
  "Accessibility.enable": emptyResult,
  "Accessibility.getFullAXTree": axTree,
  "Accessibility.getPartialAXTree": axTree,
  "DOM.enable": emptyResult,
  "DOM.describeNode": (result) => ({ node: domNode(result.node) }),
  "DOM.focus": emptyResult,
  "DOM.getBoxModel": (result) => ({
    model: pick(result.model, ["content", "padding", "border", "margin", "width", "height", "shapeOutside"]),
  }),
  "DOM.getDocument": (result) => ({ root: domNode(result.root) }),
  "DOM.getFrameOwner": (result) => pick(result, ["backendNodeId", "nodeId"]),
  "DOM.getNodeForLocation": (result) => pick(result, ["backendNodeId", "frameId", "nodeId"]),
  "DOM.resolveNode": (result) => ({ object: remoteObject(result.object) }),
  "DOM.scrollIntoViewIfNeeded": emptyResult,
  "Emulation.setFocusEmulationEnabled": emptyResult,
  "Emulation.setDeviceMetricsOverride": emptyResult,
  "Emulation.clearDeviceMetricsOverride": emptyResult,
  "Emulation.setEmulatedMedia": emptyResult,
  "Input.dispatchMouseEvent": emptyResult,
  "Input.dispatchKeyEvent": emptyResult,
  "Input.insertText": emptyResult,
  "Input.dispatchDragEvent": emptyResult,
  "Input.setInterceptDrags": emptyResult,
  "Log.enable": emptyResult,
  "Log.disable": emptyResult,
  "Network.enable": emptyResult,
  "Network.disable": emptyResult,
  "Network.setCacheDisabled": emptyResult,
  "Overlay.enable": emptyResult,
  "Overlay.highlightNode": emptyResult,
  "Overlay.hideHighlight": emptyResult,
  "Page.enable": emptyResult,
  "Page.disable": emptyResult,
  "Page.getFrameTree": (result, context) => ({ frameTree: frameTree(result.frameTree, context) }),
  "Page.getLayoutMetrics": (result) =>
    pick(result, [
      "layoutViewport",
      "visualViewport",
      "contentSize",
      "cssLayoutViewport",
      "cssVisualViewport",
      "cssContentSize",
    ]),
  "Page.navigate": (result) => pick(result, ["frameId", "loaderId", "errorText", "isDownload"]),
  "Page.reload": emptyResult,
  "Page.stopLoading": emptyResult,
  "Page.navigateToHistoryEntry": emptyResult,
  "Page.setLifecycleEventsEnabled": emptyResult,
  "Page.handleJavaScriptDialog": emptyResult,
  "Page.createIsolatedWorld": (result) => pick(result, ["executionContextId"]),
  "Page.setInterceptFileChooserDialog": emptyResult,
  "Page.captureScreenshot": (result) => pick(result, ["data"]),
  "Page.setWebLifecycleState": emptyResult,
  "Page.bringToFront": emptyResult,
  "Runtime.enable": emptyResult,
  "Runtime.evaluate": evaluation,
  "Runtime.callFunctionOn": evaluation,
  "Runtime.getProperties": (result) => {
    const descriptor = (entry: unknown) => {
      const out = pick(entry, ["name", "writable", "configurable", "enumerable", "wasThrown", "isOwn"]);
      if (!isDynamicRecord(entry)) return out;
      for (const field of ["value", "get", "set", "symbol"])
        if (entry[field] !== undefined) out[field] = remoteObject(entry[field]);
      return out;
    };
    const out: { [field: string]: unknown } = { result: listOf(result.result, descriptor) ?? [] };
    setDefined(out, "internalProperties", listOf(result.internalProperties, descriptor));
    setDefined(out, "privateProperties", listOf(result.privateProperties, descriptor));
    if (result.exceptionDetails !== undefined) out.exceptionDetails = exceptionDetails(result.exceptionDetails);
    return out;
  },
  "Runtime.releaseObject": emptyResult,
  "Target.setAutoAttach": emptyResult,
  "Target.detachFromTarget": emptyResult,
  "Target.getTargetInfo": (result) => {
    const source = isDynamicRecord(result.targetInfo) ? result.targetInfo : {};
    const info = pick(source, ["targetId", "type", "title", "attached", "openerId", "canAccessOpener", "subtype"]);
    if (isString(source.url)) info.url = withoutFragment(source.url);
    return { targetInfo: info };
  },
};

/** The result as it may leave the extension: only the fields of `CDP_RESULTS`, and `{}` for no method. */
export function projectCdpResult(method: string, result: unknown, context: CdpResultContext): DynamicRecord {
  const projection = Object.hasOwn(CDP_RESULTS, method) ? CDP_RESULTS[method] : undefined;
  return projection ? projection(isDynamicRecord(result) ? result : {}, context) : {};
}
