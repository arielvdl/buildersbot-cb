/**
 * The wire protocol between Builders Bot and its Chrome extension. The extension and the app import
 * this file; it has no Node, Electron or Effect dependency.
 *
 * Transport: Native Messaging between the extension and a small signed host, then a private Unix socket
 * between the host and the app, with the same framing (a uint32 length in native byte order, then UTF-8
 * JSON). After a handshake in clear, every message is AES-256-GCM with keys that the two sides pinned
 * when they paired. This file holds the shapes, the closed lists and the limits. The cipher lives in the
 * app and in the extension.
 *
 * Everything here is a closed list: an operation, an event, a field or an error code that is not here
 * does not exist. A message that breaks the protocol closes the connection; there is no "unknown
 * message" to ignore. Each operation and event belongs to a feature, and each side only sends what the
 * other side announced in its handshake, so an app and an extension of different releases work together.
 * After the first store release, protocol 1 and the feature names are a frozen wire contract.
 */

import {
  boolean,
  type Decoded,
  type Decoder,
  finite,
  integer,
  json,
  list,
  literal,
  record,
  text,
  utf8Length,
} from "./decode";
import { MAX_GROUP_TITLE, PROJECT_GROUP_COLORS } from "./groups";

/** The protocol numbers this build speaks. A peer is refused only when the ranges do not meet. */
export const CHROME_BRIDGE_PROTOCOL = { current: 1, min: 1 } as const;

/** The app refuses an older extension with `reject{update_extension}`; the extension then asks for an update. */
export const MIN_EXTENSION_VERSION = "1.0.0";

/** The Native Messaging host name. Each channel has its own name and socket, so two apps never share one. */
export const NATIVE_HOST_NAMES = {
  store: "app.buildersbot.chrome_host",
  local: "app.buildersbot.chrome_host_local",
  dev: "app.buildersbot.chrome_host_dev",
  e2e: "app.buildersbot.chrome_host_e2e",
} as const;

export const BRIDGE_LIMITS = {
  /** Chrome refuses a message from a native host above 1 MiB; a frame stays below it after encoding. */
  maxFrameToChromeBytes: 1_000_000,
  /** The host closes the connection on a larger frame toward the app. */
  maxFrameToAppBytes: 16 * 1024 * 1024,
  /** A larger message is cut, after encryption, into binary parts of this size. */
  partBytes: 512 * 1024,
  /** The largest message after reassembly, in either direction. */
  maxMessageBytes: 16 * 1024 * 1024,
  reassemblyTimeoutMs: 30_000,
  /** From `commit` to the second `confirm`. */
  handshakeTimeoutMs: 5_000,
  /** Keys are new on each connection, and after this time or this many frames. */
  rekeyAfterMs: 24 * 60 * 60 * 1000,
  rekeyAfterFrames: 2 ** 32,
  /** From the send to Chrome, not from the queue. */
  commandTimeoutMs: 30_000,
  screenshotTimeoutMs: 5_000,
  maxScreenshotBytes: 8 * 1024 * 1024,
  /** CDP commands in flight for one tab, and in the whole extension. */
  inFlightPerTab: 16,
  inFlightTotal: 64,
  maxBatchCommands: 64,
  /** A pairing window of the app: open for this long, used once. */
  pairingWindowMs: 2 * 60 * 1000,
  /** An offline app makes the extension detach after this long. */
  offlineDetachMs: 60_000,
  uploadChunkBytes: 512 * 1024,
  maxUploadBytes: 10 * 1024 * 1024,
} as const;

/**
 * The defaults of the limits. They match the legacy broker (4 tabs for each agent and 12 in all),
 * because a detach does not free the memory of a renderer. Settings can raise them up to the maximums.
 */
export const DEFAULT_TAB_LIMITS = { tabsPerLease: 4, tabsPerProject: 12, tabsTotal: 12 } as const;
export const MAX_TAB_LIMITS = { tabsPerLease: 25, tabsPerProject: 32, tabsTotal: 40 } as const;
export const DEFAULT_NAVIGATION_RATE = { perOriginPerMinute: 30, perProjectPerMinute: 120 } as const;

/** Times of the tab life cycle, in milliseconds. */
export const TAB_TIMING = {
  /** A lease stays active this long after the last command of its thread. */
  leaseIdleMs: 2 * 60 * 1000,
  /** An agent tab with no command, no takeover and no look from the person is discarded after this. */
  discardIdleMs: 5 * 60 * 1000,
  /** A group with no active lease is collapsed after this, unless it holds the active tab. */
  collapseIdleMs: 2 * 60 * 1000,
  /** One reattach after `target_closed`, after this delay, at most once in `reattachPauseMs`. */
  reattachDelayMs: 150,
  reattachPauseMs: 3_000,
  /** A `noopener` popup is adopted only when exactly one new tab with its URL appears in this time. */
  noopenerWindowMs: 2_000,
  /** `tabGroups` edits fail while the person drags a tab; they are tried again this often, this many times. */
  editRetryMs: 200,
  editRetries: 5,
} as const;

// ---------------------------------------------------------------------------------------------------
// Features

export const CHROME_BRIDGE_FEATURES = [
  "core",
  "cdp-batch",
  "tab-history",
  "tab-zoom",
  "agent-scripts",
  "secret-fill",
  "tab-handoff",
  "site-floor-events",
  "secret-check",
  "group-events",
  "audit",
] as const;
export type ChromeBridgeFeature = (typeof CHROME_BRIDGE_FEATURES)[number];

// ---------------------------------------------------------------------------------------------------
// Identifiers

/** A 128-bit opaque value in base64url: tab handles, lease ids, project keys, install ids. */
const OPAQUE = /^[A-Za-z0-9_-]{22}$/u;
/** A raw uncompressed P-256 public key (65 bytes) in base64url. */
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/u;
/** 32 bytes in base64url: nonces, SHA-256 digests and HMAC-SHA256 tags. */
const BYTES_32 = /^[A-Za-z0-9_-]{43}$/u;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/u;
const CDP_METHOD = /^[A-Z][A-Za-z]{1,40}\.[a-z][A-Za-z]{1,60}$/u;
const CDP_SESSION = /^[A-Za-z0-9._-]{1,64}$/u;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const INITIALS = /^[\p{L}\p{N}]{1,3}$/u;

const opaque = text({ max: 22, min: 22, pattern: OPAQUE });
const handle = opaque;
const leaseId = opaque;
const projectKey = opaque;
const publicKey = text({ max: 87, min: 87, pattern: PUBLIC_KEY });
const bytes32 = text({ max: 43, min: 43, pattern: BYTES_32 });
const version = text({ max: 20, pattern: VERSION });
const cdpMethod = text({ max: 102, pattern: CDP_METHOD });
const cdpSession = text({ max: 64, pattern: CDP_SESSION });
const url = text({ max: 8192 });
const origin = text({ max: 2048 });
const chromeId = integer(0, 2 ** 31 - 1);
const groupTitleText = text({ max: MAX_GROUP_TITLE * 2, min: 1 });
const agentLabel = text({ max: 24, min: 1 });
const initials = text({ max: 12, pattern: INITIALS });
const projectColor = literal(PROJECT_GROUP_COLORS);
const protoRange = record({ min: integer(1, 1000), max: integer(1, 1000) });
const features = list(text({ max: 40, pattern: /^[a-z][a-z0-9-]{0,39}$/u }), 64);

// ---------------------------------------------------------------------------------------------------
// Handshake, in clear, and the host's own frames

export const REJECT_CODES = ["update_extension", "update_app", "revoked", "unknown_origin", "busy"] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export const BROWSER_BRANDS = ["google-chrome", "chrome-for-testing", "chromium", "other"] as const;

/**
 * The handshake decoders, by kind. The state machine of each side calls the one it expects next; any
 * other message closes the connection.
 */
export const HANDSHAKE_DECODERS = {
  /** The extension commits to its `hello` before it sees the app's `welcome`. */
  commit: record({ k: literal(["commit"]), digest: bytes32 }),
  welcome: record({
    k: literal(["welcome"]),
    proto: protoRange,
    appVersion: version,
    appInstanceId: opaque,
    sPub: publicKey,
    ePub: publicKey,
    nonce: bytes32,
    features,
    pairing: literal(["known", "new"]),
  }),
  reject: record({ k: literal(["reject"]), code: literal(REJECT_CODES) }),
  hello: record(
    {
      k: literal(["hello"]),
      proto: protoRange,
      extVersion: version,
      installId: opaque,
      sPub: publicKey,
      ePub: publicKey,
      nonce: bytes32,
      features,
      browser: record({ brand: literal(BROWSER_BRANDS), version: text({ max: 32, pattern: /^[\d.]{1,32}$/u }) }),
    },
    {
      consent: record({ version: integer(1, 1000), at: integer(0, Number.MAX_SAFE_INTEGER) }),
      /** Sent only after consent. The app shows it as "reported by the extension". */
      profileLabel: text({ max: 64 }),
    },
  ),
  confirm: record({ k: literal(["confirm"]), mac: bytes32 }),
} as const;

export type HandshakeKind = keyof typeof HANDSHAKE_DECODERS;
export type HandshakeMessage<K extends HandshakeKind> =
  (typeof HANDSHAKE_DECODERS)[K] extends Decoder<infer T> ? T : never;

/**
 * The host's own frames, outside the cipher: `hello` only before a handshake, and `status` only between
 * two encrypted sessions. The extension accepts them only there, and a `status` never changes a key.
 */
export const decodeHostFrame = (value: unknown) =>
  (value !== null && typeof value === "object" && "h" in value && value.h === "status"
    ? record({ h: literal(["status"]), app: literal(["online", "offline"]) })
    : record({
        h: literal(["hello"]),
        hostVersion: version,
        pid: integer(1, 2 ** 31 - 1),
        parent: literal(["google-chrome", "other", "unknown"]),
      }))(value, "host");

/** An encrypted frame: a whole message, or one part of one. */
export const decodeSealedFrame = record(
  {
    v: integer(1, 1),
    c: integer(0, 2 ** 32),
    d: text({ max: BRIDGE_LIMITS.maxFrameToAppBytes, pattern: /^[A-Za-z0-9_-]*$/u }),
  },
  { p: record({ i: integer(0, 64), n: integer(1, 64) }) },
);

// ---------------------------------------------------------------------------------------------------
// Messages inside the cipher

export const ERROR_CODES = [
  "out_of_scope",
  "method_denied",
  "param_denied",
  "site_blocked",
  "consent_required",
  "scripts_disabled",
  "secret_present",
  "message_send_requires_approval",
  "paused_by_user",
  "tab_not_owned",
  "tab_leased",
  "popup_window",
  "group_shared",
  "limit",
  "low_memory",
  "policy_blocks_debugger",
  "chrome_not_connected",
  "cdp_error",
  "timeout",
] as const;
export type ChromeBridgeErrorCode = (typeof ERROR_CODES)[number];

const groupBody = record({ projectKey }, { title: groupTitleText, color: projectColor, collapsed: boolean });
const handleBody = record({ handle });
const leaseHandleBody = record({ leaseId, handle });
const projectBody = record({ projectKey });
/** The parameters of a CDP command. Their meaning is checked by `cdp-allowlist.ts`, field by field. */
const cdpParams = json(2 * 1024 * 1024);
const cdpCommand = record({ method: cdpMethod, params: cdpParams }, { session: cdpSession });

/** App to extension. There is no reflective `chrome.*` call, no consent grant and no floor change here. */
const operationShapes = {
  "session.configure": record({
    limits: record({
      tabsPerLease: integer(1, MAX_TAB_LIMITS.tabsPerLease),
      tabsPerProject: integer(1, MAX_TAB_LIMITS.tabsPerProject),
      tabsTotal: integer(1, MAX_TAB_LIMITS.tabsTotal),
    }),
    ratePerOrigin: record({ perOriginPerMinute: integer(1, 600), perProjectPerMinute: integer(1, 2400) }),
    /** Hosts the app adds to the floor. The app cannot take one away. */
    policyAdd: list(text({ max: 253, pattern: HOSTNAME }), 256),
    projects: list(record({ projectKey, title: groupTitleText, color: projectColor }), 64),
  }),
  "group.ensure": groupBody,
  "group.update": groupBody,
  /** Closes the agent tabs that the person never activated, ungroups the rest, and gives back handed tabs. */
  "group.release": projectBody,
  "lease.open": record({ leaseId, projectKey, agentLabel, initials }, { routine: boolean }),
  "lease.close": record({ leaseId }),
  /** Only http, https or about:blank. The tab is made at about:blank, attached, then navigated. */
  "tab.create": record({ leaseId, url }),
  "tab.claim": leaseHandleBody,
  "tab.release": leaseHandleBody,
  "tab.close": handleBody,
  /** Only after a gesture of the person in the app. It focuses the window. */
  "tab.activate": record({ handle, gesture: literal(["show", "takeover"]) }),
  "tab.history": record({ handle, action: literal(["back", "forward", "reload"]) }),
  "tab.zoom": handleBody,
  "tab.discard": handleBody,
  "tab.mark": record({ handle, agentLabel, initials }),
  /**
   * The commands of a tab name the lease that sends them: the extension runs them only when that lease
   * holds the tab (`tab_not_owned` otherwise), so an agent's handle in another agent's request fails.
   */
  "cdp.send": record({ leaseId, handle, method: cdpMethod, params: cdpParams }, { session: cdpSession }),
  "cdp.batch": record({ leaseId, handle, commands: list(cdpCommand, BRIDGE_LIMITS.maxBatchCommands) }),
  /** An agent's own script. Off by default in Chrome; never with a user gesture. */
  "script.run": record(
    {
      leaseId,
      handle,
      source: text({ max: 256 * 1024, min: 1 }),
      args: json(256 * 1024),
      world: literal(["isolated", "main"]),
    },
    { session: cdpSession },
  ),
  /** One atomic step in the extension; the text never comes back in an event, an error or a log. */
  "secret.fill": record({
    leaseId,
    handle,
    expectOrigin: origin,
    nodeId: integer(1, 2 ** 31 - 1),
    text: text({ max: 4096 }),
  }),
  "project.pause": projectBody,
  /** Undoes only a pause that the app started. A stop from Chrome ends only with a gesture in Chrome. */
  "project.resume": projectBody,
  "stop.all": record({ reason: literal(["person", "shutdown", "memory"]) }),
  /** The extension adopts only the groups of its own registry. */
  resync: record({
    tabs: list(record({ handle, tabId: chromeId, groupId: chromeId, projectKey, leaseId }), MAX_TAB_LIMITS.tabsTotal),
  }),
  ping: record({}),
  /**
   * The app pinned the extension's key after the person chose the right words in the app and the
   * extension sent `pair.chrome-ok`. The extension then makes its own pin of the app's key final.
   */
  "pair.done": record({}),
} as const;

export type ChromeBridgeOperation = keyof typeof operationShapes;
export type OperationBodies = {
  readonly [O in ChromeBridgeOperation]: (typeof operationShapes)[O] extends Decoder<infer T> ? T : never;
};
const operationDecoders: { readonly [O in ChromeBridgeOperation]: Decoder<OperationBodies[O]> } = operationShapes;
export const CHROME_BRIDGE_OPERATIONS: readonly ChromeBridgeOperation[] =
  Object.keys(operationShapes).filter(isOperation);

export const OPERATION_FEATURES: Readonly<Record<ChromeBridgeOperation, ChromeBridgeFeature>> = {
  "session.configure": "core",
  "group.ensure": "core",
  "group.update": "core",
  "group.release": "core",
  "lease.open": "core",
  "lease.close": "core",
  "tab.create": "core",
  "tab.claim": "tab-handoff",
  "tab.release": "tab-handoff",
  "tab.close": "core",
  "tab.activate": "core",
  "tab.history": "tab-history",
  "tab.zoom": "tab-zoom",
  "tab.discard": "core",
  "tab.mark": "core",
  "cdp.send": "core",
  "cdp.batch": "cdp-batch",
  "script.run": "agent-scripts",
  "secret.fill": "secret-fill",
  "project.pause": "core",
  "project.resume": "core",
  "stop.all": "core",
  resync: "core",
  ping: "core",
  "pair.done": "core",
};

const cdpResultValue = json(BRIDGE_LIMITS.maxMessageBytes);

/** The body of a successful response, by operation. An error response carries `err` instead. */
const resultShapes = {
  "session.configure": record({}),
  "group.ensure": record({ groupId: chromeId, windowId: chromeId }),
  "group.update": record({}),
  "group.release": record({ closed: integer(0, 1000), kept: integer(0, 1000) }),
  "lease.open": record({}),
  "lease.close": record({}),
  "tab.create": record({ handle }),
  "tab.claim": record({ url, title: text({ max: 512 }) }),
  "tab.release": record({}),
  "tab.close": record({ closed: boolean }),
  "tab.activate": record({}),
  "tab.history": record({}),
  "tab.zoom": record({ factor: finite(0.25, 5) }),
  "tab.discard": record({}),
  "tab.mark": record({}),
  "cdp.send": record({ result: cdpResultValue }),
  "cdp.batch": record({
    results: list(
      record({}, { result: cdpResultValue, err: record({ code: literal(ERROR_CODES), message: text({ max: 2048 }) }) }),
      BRIDGE_LIMITS.maxBatchCommands,
    ),
  }),
  "script.run": record({ value: json(64 * 1024) }),
  "secret.fill": record({}),
  "project.pause": record({}),
  "project.resume": record({}),
  "stop.all": record({}),
  resync: record({ adopted: list(handle, MAX_TAB_LIMITS.tabsTotal), refused: list(handle, MAX_TAB_LIMITS.tabsTotal) }),
  ping: record({}),
  "pair.done": record({}),
} as const satisfies { readonly [O in ChromeBridgeOperation]: Decoder<unknown> };

export type ResultBodies = {
  readonly [O in ChromeBridgeOperation]: (typeof resultShapes)[O] extends Decoder<infer T> ? T : never;
};
const resultDecoders: { readonly [O in ChromeBridgeOperation]: Decoder<ResultBodies[O]> } = resultShapes;

const tabRemovedBy = literal(["person", "agent", "extension", "browser"]);
const stopSource = literal(["popup", "shortcut", "infobar", "group"]);

/** Extension to app. `cdp.event` carries only the events and fields of `cdp-allowlist.ts`. */
const eventShapes = {
  ready: record({
    groups: list(
      record({ projectKey, groupId: chromeId, windowId: chromeId, userTitle: boolean, shared: boolean }),
      64,
    ),
    handles: list(record({ handle, projectKey }, { leaseId, satellite: boolean }), MAX_TAB_LIMITS.tabsTotal),
    attached: list(handle, MAX_TAB_LIMITS.tabsTotal),
    stopped: list(
      record(
        { scope: literal(["all", "project"]), source: literal(["popup", "shortcut", "infobar", "group", "app"]) },
        {
          projectKey,
        },
      ),
      65,
    ),
  }),
  "cdp.event": record({ handle, method: cdpMethod, params: json(64 * 1024) }, { session: cdpSession }),
  "tab.created": record({ handle }, { leaseId, opener: handle, satellite: boolean }),
  "tab.updated": record(
    { handle },
    {
      url,
      title: text({ max: 512 }),
      status: literal(["loading", "complete", "unloaded"]),
      discarded: boolean,
      frozen: boolean,
    },
  ),
  "tab.removed": record({ handle, by: tabRemovedBy }),
  "tab.detached": record({
    handle,
    reason: literal(["target_closed", "canceled_by_user", "site_blocked", "memory", "lease_end", "person"]),
  }),
  "tab.viewed": handleBody,
  "tab.candidate": record({ handle, origin }),
  "tab.handed": record({ handle, projectKey, origin, gesture: literal(["popup", "badge", "drag"]) }),
  "tab.taken": handleBody,
  "tab.blocked": record({ handle, origin, rule: text({ max: 32, pattern: /^[a-z-]{1,32}$/u }) }),
  "tab.quarantined": handleBody,
  "tab.secret-present": handleBody,
  "group.removed": projectBody,
  "group.moved": record({ projectKey, windowId: chromeId }),
  "group.renamed": record({ projectKey, userTitle: boolean }),
  "group.shared": projectBody,
  "user.stop": record({ scope: literal(["all", "project"]), source: stopSource }, { projectKey }),
  "user.resume": record({ source: literal(["popup"]) }, { projectKey }),
  "user.unblock": record({ projectKey, origin }),
  "pair.chrome-ok": record({}),
  "ext.updating": record({}),
  /** Counters only: no page text, no typed text, no URL beyond what other events already carry. */
  audit: record(
    {},
    {
      commands: integer(0, Number.MAX_SAFE_INTEGER),
      denied: integer(0, Number.MAX_SAFE_INTEGER),
      blocked: integer(0, Number.MAX_SAFE_INTEGER),
      navigations: integer(0, Number.MAX_SAFE_INTEGER),
      stops: integer(0, Number.MAX_SAFE_INTEGER),
    },
  ),
} as const;

export type ChromeBridgeEvent = keyof typeof eventShapes;
export type EventBodies = {
  readonly [E in ChromeBridgeEvent]: (typeof eventShapes)[E] extends Decoder<infer T> ? T : never;
};
const eventDecoders: { readonly [E in ChromeBridgeEvent]: Decoder<EventBodies[E]> } = eventShapes;
export const CHROME_BRIDGE_EVENTS: readonly ChromeBridgeEvent[] = Object.keys(eventShapes).filter(isEvent);

export const EVENT_FEATURES: Readonly<Record<ChromeBridgeEvent, ChromeBridgeFeature>> = {
  ready: "core",
  "cdp.event": "core",
  "tab.created": "core",
  "tab.updated": "core",
  "tab.removed": "core",
  "tab.detached": "core",
  "tab.viewed": "tab-handoff",
  "tab.candidate": "tab-handoff",
  "tab.handed": "tab-handoff",
  "tab.taken": "tab-handoff",
  "tab.blocked": "site-floor-events",
  "tab.quarantined": "site-floor-events",
  "tab.secret-present": "secret-check",
  "group.removed": "core",
  "group.moved": "group-events",
  "group.renamed": "group-events",
  "group.shared": "group-events",
  "user.stop": "core",
  "user.resume": "core",
  "user.unblock": "site-floor-events",
  "pair.chrome-ok": "core",
  "ext.updating": "core",
  audit: "audit",
};

/** What the extension does with each operation. `decodeToExtension` calls the one the message names. */
export type OperationHandlers<R> = {
  readonly [O in ChromeBridgeOperation]: (body: OperationBodies[O], id: number) => R;
};

/** What the app does with each event, each successful response, and each error response. */
export interface AppMessageHandlers<R> {
  readonly event: { readonly [E in ChromeBridgeEvent]: (body: EventBodies[E], seq: number) => R };
  readonly result: { readonly [O in ChromeBridgeOperation]: (body: ResultBodies[O], id: number) => R };
  readonly error: (error: { code: ChromeBridgeErrorCode; message: string }, id: number) => R;
}

const MESSAGE_ID = integer(1, Number.MAX_SAFE_INTEGER);
const errorBody = record({ code: literal(ERROR_CODES), message: text({ max: 2048 }) });

function isOperation(value: unknown): value is ChromeBridgeOperation {
  return typeof value === "string" && Object.hasOwn(operationShapes, value);
}

function isEvent(value: unknown): value is ChromeBridgeEvent {
  return typeof value === "string" && Object.hasOwn(eventShapes, value);
}

function runOperation<O extends ChromeBridgeOperation, R>(
  op: O,
  id: number,
  body: unknown,
  handlers: OperationHandlers<R>,
): Decoded<R> {
  const decoded = operationDecoders[op](body, "message.body");
  if (!decoded.ok) return decoded;
  return { ok: true, value: handlers[op](decoded.value, id) };
}

function runEvent<E extends ChromeBridgeEvent, R>(
  op: E,
  seq: number,
  body: unknown,
  handlers: AppMessageHandlers<R>["event"],
): Decoded<R> {
  const decoded = eventDecoders[op](body, "message.body");
  if (!decoded.ok) return decoded;
  return { ok: true, value: handlers[op](decoded.value, seq) };
}

function runResult<O extends ChromeBridgeOperation, R>(
  op: O,
  id: number,
  body: unknown,
  handlers: AppMessageHandlers<R>["result"],
): Decoded<R> {
  const decoded = resultDecoders[op](body, "message.body");
  if (!decoded.ok) return decoded;
  return { ok: true, value: handlers[op](decoded.value, id) };
}

/** Checks the body of an operation before the app sends it, as the extension will. */
export function decodeOperationBody<O extends ChromeBridgeOperation>(
  op: O,
  body: unknown,
): Decoded<OperationBodies[O]> {
  return operationDecoders[op](body, "body");
}

/** Checks the body of a successful response against the operation it answers. */
export function decodeResultBody<O extends ChromeBridgeOperation>(op: O, body: unknown): Decoded<ResultBodies[O]> {
  return resultDecoders[op](body, "message.body");
}

/**
 * The envelope of a response, without its body checked: the side that sent the request checks the body
 * against the operation it remembers for `id` (`decodeResultBody`), once.
 */
export function decodeResponseEnvelope(
  value: unknown,
): Decoded<{ id: number; body?: unknown; err?: { code: ChromeBridgeErrorCode; message: string } }> {
  // The message came from JSON.parse of a sealed message, so its size is bound already; the body is
  // checked by `decodeResultBody`, which bounds it again by operation.
  const anyBody: Decoder<unknown> = (body) => ({ ok: true, value: body });
  const envelope = record({ t: literal(["res"]), id: MESSAGE_ID }, { body: anyBody, err: errorBody })(value, "message");
  if (!envelope.ok) return envelope;
  if (envelope.value.err !== undefined && envelope.value.body !== undefined)
    return { ok: false, error: "message: has both body and err" };
  return envelope;
}

/**
 * Decodes a message the extension received from the app and hands its body to the handler of its
 * operation. `features` is what the extension announced: an operation of a feature it did not announce
 * breaks the protocol, as does every decode failure.
 */
export function decodeToExtension<R>(
  value: unknown,
  features: readonly string[],
  handlers: OperationHandlers<R>,
): Decoded<R> {
  const envelope = record({
    t: literal(["req"]),
    id: MESSAGE_ID,
    op: text({ max: 40 }),
    body: json(BRIDGE_LIMITS.maxMessageBytes),
  })(value, "message");
  if (!envelope.ok) return envelope;
  const { op, id, body } = envelope.value;
  if (!isOperation(op)) return { ok: false, error: "message.op: is not a known operation" };
  if (!features.includes(OPERATION_FEATURES[op]))
    return { ok: false, error: "message.op: its feature was not announced" };
  return runOperation(op, id, body, handlers);
}

/**
 * Decodes a message the app received from the extension and hands it to its handler. `pending` gives
 * the operation of each request still waiting for its response, so a response body is checked against
 * that operation; a response to no pending request breaks the protocol.
 */
export function decodeToApp<R>(
  value: unknown,
  features: readonly string[],
  pending: (id: number) => ChromeBridgeOperation | undefined,
  handlers: AppMessageHandlers<R>,
): Decoded<R> {
  const kind = value !== null && typeof value === "object" && "t" in value ? value.t : undefined;
  if (kind === "evt") {
    const envelope = record({
      t: literal(["evt"]),
      seq: MESSAGE_ID,
      op: text({ max: 40 }),
      body: json(BRIDGE_LIMITS.maxMessageBytes),
    })(value, "message");
    if (!envelope.ok) return envelope;
    const { op, seq, body } = envelope.value;
    if (!isEvent(op)) return { ok: false, error: "message.op: is not a known event" };
    if (!features.includes(EVENT_FEATURES[op]))
      return { ok: false, error: "message.op: its feature was not announced" };
    return runEvent(op, seq, body, handlers.event);
  }
  const envelope = record(
    { t: literal(["res"]), id: MESSAGE_ID },
    { body: json(BRIDGE_LIMITS.maxMessageBytes), err: errorBody },
  )(value, "message");
  if (!envelope.ok) return envelope;
  const { id, body, err } = envelope.value;
  const op = pending(id);
  if (op === undefined) return { ok: false, error: "message.id: answers no pending request" };
  if (err !== undefined && body !== undefined) return { ok: false, error: "message: has both body and err" };
  if (err !== undefined) return { ok: true, value: handlers.error(err, id) };
  return runResult(op, id, body ?? {}, handlers.result);
}

/** The highest protocol both ranges hold, or null when they do not meet. */
export function negotiateProtocol(
  local: { readonly min: number; readonly max: number },
  remote: { readonly min: number; readonly max: number },
): number | null {
  const high = Math.min(local.max, remote.max);
  return high >= Math.max(local.min, remote.min) ? high : null;
}

/** The features both sides announced. Each side then sends only these. */
export function sharedFeatures(local: readonly string[], remote: readonly string[]): ChromeBridgeFeature[] {
  return CHROME_BRIDGE_FEATURES.filter((feature) => local.includes(feature) && remote.includes(feature));
}

/** Compares two `major.minor.patch` versions: negative, zero or positive. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether a frame text fits the limit of its direction after encoding. */
export function frameFits(frame: string, direction: "to-chrome" | "to-app"): boolean {
  const bytes = utf8Length(frame);
  return direction === "to-chrome"
    ? bytes < BRIDGE_LIMITS.maxFrameToChromeBytes
    : bytes <= BRIDGE_LIMITS.maxFrameToAppBytes;
}
