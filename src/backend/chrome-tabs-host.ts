/**
 * `ChromeTabsHost`: the agents' tabs in the person's own Chrome, through the Builders Bot extension
 * (DESIGN §5, §10.2). It answers the `openbot_chrome` tools with the same engine, queue and result
 * format as the Builders Bot browser, so an agent reads one shape in either browser.
 *
 * - Project: each call's project comes from the app (a name the person set, the channel, the sidebar
 *   section, the agent's single folder, or the agent), never from the agent's text. The extension sees
 *   only an opaque key (an HMAC of this install's secret) and the title, and makes one tab group per
 *   project with that title and a stable color.
 * - Lease: one agent in one thread, with an id that stays the same across turns and restarts, so the
 *   extension keeps the same tabs for it: no new tab or group at each turn, and no focus taken.
 * - Owner: a tab belongs to its thread and agent (`canUseBrowserTab`); another agent of the same
 *   project reads it as unknown.
 * - Limits: 4 tabs for an agent, 12 in all, counted by the extension from its own records. The app
 *   checks its own count first, so a call over the limit costs no message.
 * - Gates before any message: the turn must come from the owner (or the owner's agents); the agent's
 *   own scripts are off; a send on a mail, chat or social site waits for the person's card.
 * - Messages: commands of one tab that leave together go in one `cdp.batch`, and the page state comes
 *   from the extension's events. Nothing polls.
 */

import { createHmac, randomUUID } from "node:crypto";
import { groupColorForHash, groupColorForHex, type TabGroupColor } from "@openbot/contracts/chrome-bridge/groups";
import {
  type ChromeBridgeEvent,
  type ChromeBridgeOperation,
  DEFAULT_TAB_LIMITS,
  type OperationBodies,
  type ResultBodies,
  TAB_TIMING,
} from "@openbot/contracts/chrome-bridge/protocol";
import { type SensitiveSiteKind, sensitiveSiteKind } from "@openbot/contracts/chrome-bridge/site-floor";
import type { BrowserSnapshot, BrowserTab, BrowserTarget } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { redactText } from "@openbot/logging";
import { Deferred, Effect, Exit, Option, Schema, Scope } from "effect";
import { BrowserCdpEngine, type SnapshotReadResult } from "./browser-cdp";
import { BrowserDiagnostics } from "./browser-diagnostics";
import { type BrowserOperationError, browserFailure, browserSync } from "./browser-effects";
import { defaultBrowserEnvironment } from "./browser-state";
import {
  type ActionResultReader,
  BrowserDialogTurn,
  boundEngineOperation,
  dialogTabResult,
  enqueueTabOperation,
  hasCurrentImage,
  type KeepQueueBlocked,
  markImageTaken,
  passImageOn,
  type QueuedBrowserTab,
  readActionSnapshot,
  readActionStatus,
  readTabSnapshot,
  remainingTime,
  runTabAction,
  runTabFillFields,
} from "./browser-tab-operations";
import { canUseBrowserTab, unknownBrowserTabError } from "./browser-tab-ownership";
import { browserInputAction, browserToolTimeout } from "./browser-tool-actions";
import { snapshotImageResult, snapshotTextResult, textResult } from "./browser-tool-results";
import { normalizeBrowserUrl } from "./browser-url";
import { ChromeCdpTarget, type ChromeTabChannel, type ChromeTabState } from "./chrome-cdp-target";
import { type ChromeAction, type MessageSendCard, messageSendCard } from "./chrome-message-send";
import { CHROME_SCRIPT_TOOLS, type ChromeToolCall, parseChromeToolCall } from "./chrome-tools";
import { CHROME_TURN_ORIGINS } from "./chrome-turn-origin";
import type { HubTurnOrigin } from "./hub-connections/turn-origin";
import type { DynamicToolCallParams, DynamicToolResult } from "./protocol";

// ---------------------------------------------------------------------------------------------------
// The port to the bridge (main process), and what the router passes per call

/** A request to the extension that it, or the bridge, refused. `code` is a protocol error code. */
export class ChromeBridgeCallError extends Schema.TaggedError<ChromeBridgeCallError>()("ChromeBridgeCallError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export interface ChromeBridgeConnection {
  readonly installId: string;
  readonly features: readonly string[];
}

/** What the host needs of `ChromeBridgeService`. The main process binds it. */
export interface ChromeBridgePort {
  /** The Chrome profiles connected now. */
  readonly connected: () => readonly ChromeBridgeConnection[];
  readonly request: <O extends ChromeBridgeOperation>(
    installId: string,
    op: O,
    body: OperationBodies[O],
    options?: { readonly key?: string; readonly timeoutMs?: number },
  ) => Effect.Effect<ResultBodies[O], ChromeBridgeCallError>;
}

/** A project as the app names it. `id` is the app's own (`section:<id>`, `channel:<id>`, …). */
export interface ChromeProject {
  readonly id: string;
  readonly title: string;
  /** The sidebar section's `#rrggbb`, when it has one. */
  readonly color?: string | null;
}

/** What the router knows of one call, decided in code from the stored messages of the turn. */
export interface ChromeCallContext {
  readonly origin: HubTurnOrigin;
  /** Shows the person the card of a message send. Absent where nobody answers a card (a routine). */
  readonly approveMessageSend?: (card: MessageSendCard) => Effect.Effect<boolean>;
  /**
   * Asks the person whether the agents of a project may use a sensitive site (mail, chat, a cloud
   * console, a social network, a payment frame, the person's own network). Absent where nobody answers.
   */
  readonly approveSiteAccess?: (card: SiteAccessCard) => Effect.Effect<boolean>;
}

/** What the person reads on the card of a sensitive site (DESIGN §2.4, §7 item 10). */
export interface SiteAccessCard {
  readonly project: string;
  readonly site: string;
  readonly kind: SensitiveSiteKind;
}

export interface ChromeTabsHostOptions {
  readonly bridge: ChromeBridgePort;
  /** The project of an agent's call in a thread. Null: the agent alone is the project. */
  readonly projectOf: (agentId: string, threadId: string) => ChromeProject | null;
  readonly agentName: (agentId: string) => string | null;
  /**
   * A secret of this app install. Project keys and lease ids are HMACs of it, so the extension never
   * sees an app id, and the same agent in the same thread gets the same lease after a restart.
   */
  readonly secret: Uint8Array;
  readonly limits?: { readonly tabsPerLease: number; readonly tabsPerProject: number; readonly tabsTotal: number };
  readonly memoryLevel?: () => "ok" | "low" | "critical";
  /** The Chrome profile that agents use when several are connected. */
  readonly preferredInstall?: () => string | null;
  readonly log?: (line: string) => void;
}

/** One tab of the person's Chrome that an agent owns. */
export interface ChromeHostTab extends QueuedBrowserTab {
  readonly id: string;
  readonly handle: string;
  readonly installId: string;
  readonly leaseId: string;
  readonly projectKey: string;
  readonly ownerThreadId: string;
  readonly ownerAgentId: string;
  readonly target: ChromeCdpTarget;
  /** The last snapshot that the owner read: the message-send card takes its fields from it. */
  lastSnapshot: BrowserSnapshot | null;
  /** Counts the agent's actions in the tab, in the order of its queue. */
  actionSeq: number;
  /** `actionSeq` when `lastSnapshot` was read: equal means that no action ran after it. */
  snapshotSeq: number;
  lastUsedAt: number;
}

interface LeaseRecord {
  readonly leaseId: string;
  readonly installId: string;
  readonly projectKey: string;
  readonly agentId: string;
  readonly threadId: string;
  /** The connection epoch in which the extension last opened it, and when. */
  openedEpoch: number;
  usedAt: number;
}

interface ProjectRecord {
  readonly key: string;
  title: string;
  color: Exclude<TabGroupColor, "grey">;
}

const MAX_CAPTURE_PIXELS = 4_194_304;
const DIALOG_ACTION_WAIT_MS = 10_000;
const OPEN_LOAD_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 45_000;
/** A lease is opened again a little before the extension would end it for idleness. */
const LEASE_REFRESH_MS = TAB_TIMING.leaseIdleMs - 20_000;
/** Projects that one `session.configure` names: the protocol's list holds 64. */
const MAX_CONFIGURED_PROJECTS = 64;
/** Events of a tab that the app does not know yet, such as the load of a tab before its handle comes. */
const MAX_EARLY_HANDLES = 64;

const ORIGIN_TEXT: Readonly<Record<HubTurnOrigin, string>> = {
  owner_ui: "the owner",
  agent: "an agent of the owner",
  routine: "a routine",
  routine_agent: "an agent that a routine or a webhook started",
  team_member: "a team member or a channel with people who are not the owner",
  messaging: "a chat app",
  unknown: "a source that Builders Bot cannot prove",
};

function opaqueKey(secret: Uint8Array, kind: string, ...parts: readonly string[]): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(kind);
  for (const part of parts) hmac.update(`\u0000${part}`);
  return hmac.digest("base64url").slice(0, 22);
}

/** Up to three letters of the agent's name, for the badge of its tabs. */
function initialsOf(name: string): string {
  const words = name.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters =
    words.length > 1 ? words.slice(0, 3).map((word) => [...word][0] ?? "") : [...(words[0] ?? "")].slice(0, 2);
  const initials = letters.join("").toUpperCase();
  return initials.length > 0 ? initials : "A";
}

/** The agent's name as the extension shows it: at most 24 characters, with no control characters. */
function agentLabelOf(name: string): string {
  const clean = name
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...(clean || "Agent")].slice(0, 24).join("");
}

/** The sentence an agent reads for a refusal of the extension or the bridge. */
export function chromeRefusalText(code: string, message: string): string {
  switch (code) {
    case "site_blocked":
      return `This site is blocked for agents in the person's Chrome (${message}). Banks, exchanges, password vaults, Google and Apple accounts, and government sites stay with the person. Ask the person to do this step.`;
    case "limit":
      return `Chrome tab limit: ${message}.`;
    case "low_memory":
      return "The computer is low on memory, so no new Chrome tab opens now. Close a tab you opened, or reuse one.";
    case "paused_by_user":
      return "The person paused the agents in Chrome. Stop, and tell the person: only the person resumes them, from the Builders Bot extension.";
    case "group_shared":
      return "The tab group of this project is shared with other people, so agents are paused in it. Tell the person.";
    case "chrome_not_connected":
      return "The person's Chrome is not connected to Builders Bot. Ask the person to open Chrome with the Builders Bot extension; meanwhile, use openbot_browser.";
    case "out_of_scope":
    case "tab_not_owned":
    case "tab_leased":
      return `This Chrome tab is no longer yours (${message}). Call list_tabs.`;
    case "policy_blocks_debugger":
      return "A policy of this Chrome does not let Builders Bot control this tab. Tell the person.";
    case "secret_present":
      return "The page holds a password or a code that Builders Bot did not type, so Chrome does not let agents read it until the page navigates. Ask the person.";
    case "message_send_requires_approval":
      return "A send on this site needs the person's approval of the text and recipients, and nobody can answer a card here. Report the draft instead.";
    case "consent_required":
      return `The agents of this project may use ${message} in the person's Chrome only after the person allows it, and nobody can answer a card here. Tell the person.`;
    case "scripts_disabled":
      return "Your own scripts (evaluate and run_script) are off in the person's Chrome. Use snapshot, wait_for and the action tools.";
    case "timeout":
      return `Chrome did not answer in time (${message}).`;
    default:
      return `Chrome refused the command: ${code}: ${message}`;
  }
}

function tabStatus(value: unknown): ChromeTabState["status"] {
  switch (value) {
    case "loading":
    case "complete":
    case "unloaded":
      return value;
    default:
      return undefined;
  }
}

const refusal = (code: string, message = "") => browserFailure(new Error(chromeRefusalText(code, message)));

export class ChromeTabsHost {
  readonly #options: ChromeTabsHostOptions;
  readonly #limits: { readonly tabsPerLease: number; readonly tabsPerProject: number; readonly tabsTotal: number };
  readonly #tabs = new Map<string, ChromeHostTab>();
  readonly #byHandle = new Map<string, string>();
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #projects = new Map<string, ProjectRecord>();
  /** The connection epoch of each install: a new `ready` starts a new one. */
  readonly #epochs = new Map<string, number>();
  /** What the last `session.configure` of an install said, and in which epoch. */
  readonly #configured = new Map<string, { epoch: number; signature: string }>();
  /** Requests in flight, so concurrent calls share one `session.configure` or `lease.open`. */
  readonly #inflight = new Map<string, Deferred.Deferred<void, BrowserOperationError>>();
  /** Tabs that the extension still has after an app restart, by lease, until their agent calls again. */
  readonly #unclaimed = new Map<string, { installId: string; handles: string[] }>();
  readonly #early = new Map<string, ChromeTabState[]>();
  /** Sensitive origins that the person allowed for each project key, until the app restarts. */
  readonly #siteConsents = new Map<string, Set<string>>();
  #lastUsedTabId: string | null = null;

  constructor(options: ChromeTabsHostOptions) {
    this.#options = options;
    this.#limits = options.limits ?? DEFAULT_TAB_LIMITS;
  }

  // -------------------------------------------------------------------------------------------------
  // Events of the extension, which the main process forwards

  /**
   * One event of the extension. The decoders of the bridge already checked its body against the event;
   * each case reads only the fields it needs.
   */
  receiveEvent(installId: string, event: ChromeBridgeEvent, value: unknown): void {
    if (!isDynamicRecord(value)) return;
    switch (event) {
      case "ready":
        this.#onReady(installId, value);
        return;
      case "cdp.event": {
        const tab = this.#tabByHandle(value.handle);
        if (!tab || !isString(value.method)) return;
        if (value.method === "Log.entryAdded" || value.method === "Runtime.consoleAPICalled")
          this.#console(tab, value.params);
        tab.target.receiveCdpEvent(value.method, value.params, isString(value.session) ? value.session : undefined);
        return;
      }
      case "tab.updated": {
        const status = tabStatus(value.status);
        const state: ChromeTabState = {
          ...(isString(value.url) ? { url: value.url } : {}),
          ...(isString(value.title) ? { title: value.title } : {}),
          ...(status ? { status } : {}),
        };
        const tab = this.#tabByHandle(value.handle);
        if (tab) tab.target.receiveTabState(state);
        else if (isString(value.handle)) this.#keepEarly(value.handle, state);
        return;
      }
      case "tab.removed":
        if (isString(value.handle)) this.#forget(value.handle);
        return;
      case "tab.detached": {
        this.#tabByHandle(value.handle)?.target.receiveDetached();
        return;
      }
      case "tab.created":
        this.#adoptPopup(installId, value);
        return;
      case "tab.blocked": {
        const tab = this.#tabByHandle(value.handle);
        if (tab && isString(value.origin))
          tab.diagnostics.add({ kind: "load", level: "error", message: `Chrome blocked ${value.origin} for agents.` });
        return;
      }
      default:
        return;
    }
  }

  #keepEarly(handle: string, state: ChromeTabState): void {
    const list = this.#early.get(handle) ?? [];
    list.push(state);
    this.#early.set(handle, list.slice(-8));
    while (this.#early.size > MAX_EARLY_HANDLES) {
      const oldest = this.#early.keys().next().value;
      if (oldest === undefined) break;
      this.#early.delete(oldest);
    }
  }

  #console(tab: ChromeHostTab, params: unknown): void {
    if (!isDynamicRecord(params) || !isString(params.text)) return;
    const level =
      params.level === "error" ? "error" : params.level === "warning" || params.level === "warn" ? "warning" : null;
    // Errors and warnings only, as the Builders Bot browser reports them.
    if (!level) return;
    tab.diagnostics.add({ kind: "console", level, message: params.text });
  }

  #onReady(installId: string, body: DynamicRecord): void {
    this.#epochs.set(installId, (this.#epochs.get(installId) ?? 0) + 1);
    const listed = Array.isArray(body.handles) ? body.handles.filter(isDynamicRecord) : [];
    const alive = new Set(listed.map((entry) => entry.handle).filter(isString));
    const attached = new Set(Array.isArray(body.attached) ? body.attached.filter(isString) : []);
    // A tab that the extension no longer has is gone: Chrome restarted, or the person closed it.
    for (const tab of [...this.#tabs.values()]) {
      if (tab.installId !== installId) continue;
      if (!alive.has(tab.handle)) this.#forget(tab.handle);
      // A worker that Chrome restarted dropped its debugger sessions: the engine sets up the next one.
      else if (!attached.has(tab.handle)) tab.target.receiveDetached();
    }
    // Tabs of leases that this app does not know now (it restarted): their agent takes them back.
    for (const entry of listed) {
      if (!isString(entry.handle) || !isString(entry.leaseId) || this.#byHandle.has(entry.handle)) continue;
      const known = this.#unclaimed.get(entry.leaseId) ?? { installId, handles: [] };
      if (!known.handles.includes(entry.handle)) known.handles.push(entry.handle);
      this.#unclaimed.set(entry.leaseId, known);
    }
  }

  #tabByHandle(handle: unknown): ChromeHostTab | undefined {
    if (!isString(handle)) return undefined;
    const id = this.#byHandle.get(handle);
    return id === undefined ? undefined : this.#tabs.get(id);
  }

  #forget(handle: string): void {
    const tab = this.#tabByHandle(handle);
    this.#early.delete(handle);
    if (!tab) return;
    this.#byHandle.delete(handle);
    this.#tabs.delete(tab.id);
    tab.closing = true;
    tab.target.markClosed();
    if (this.#lastUsedTabId === tab.id) this.#lastUsedTabId = null;
    void Effect.runPromise(tab.engine.destroy().pipe(Effect.ignore, Effect.andThen(Scope.close(tab.scope, Exit.void))));
  }

  // -------------------------------------------------------------------------------------------------
  // Tools

  readonly handleDynamicTool = Effect.fn("ChromeTabsHost.handleDynamicTool")(function* (
    this: ChromeTabsHost,
    params: DynamicToolCallParams,
    context: ChromeCallContext,
  ): Effect.fn.Return<DynamicToolResult> {
    return yield* this.#run(params, context).pipe(
      Effect.provideService(BrowserDialogTurn, { threadId: params.threadId, turnId: params.turnId }),
      Effect.catch((failure) =>
        Effect.succeed<DynamicToolResult>({
          success: false,
          // A page writes the text of its own errors, so they go through the same redaction as a snapshot.
          contentItems: [{ type: "inputText", text: redactText(String(failure.cause)) }],
        }),
      ),
    );
  }).bind(this);

  readonly #run = Effect.fn("ChromeTabsHost.run")(function* (
    this: ChromeTabsHost,
    params: DynamicToolCallParams,
    context: ChromeCallContext,
  ): Effect.fn.Return<DynamicToolResult, BrowserOperationError> {
    if (!CHROME_TURN_ORIGINS.has(context.origin))
      return yield* browserFailure(
        new Error(
          `The owner's Chrome is not available for this request: this turn came from ${ORIGIN_TEXT[context.origin]}. Use openbot_browser, or ask the owner.`,
        ),
      );
    if (CHROME_SCRIPT_TOOLS.has(params.tool)) return yield* refusal("scripts_disabled");
    const call = yield* browserSync(() => parseChromeToolCall(params.tool, params.arguments));
    const agentId = params.ownerAgentId ?? null;
    if (!agentId) return yield* browserFailure(new Error("The Chrome tools need the calling agent."));
    const caller = { threadId: params.threadId, ownerAgentId: agentId };
    switch (call.tool) {
      case "open":
        return yield* this.#open(caller, call.args.url, context);
      case "list_tabs":
        return textResult(this.#toolTabs(caller));
      case "status":
        return textResult({ ...this.#toolTabs(caller), control: { sessions: [] } });
      case "snapshot":
        return yield* this.#snapshot(caller, call.args.tabId, call.args.image ?? "auto", context);
      case "navigate": {
        const tab = yield* this.#gatedTab(caller, call.args.tabId, context);
        const url = call.args.url;
        if (url) yield* this.#siteGate(tab.projectKey, yield* browserSync(() => normalizeBrowserUrl(url)), context);
        const snapshot = yield* this.#navigate(tab, call.args, this.#remember(readActionSnapshot));
        // A redirect or a history entry can land on a sensitive site: its content waits for the consent.
        yield* this.#siteGate(tab.projectKey, tab.engine.page.url(), context);
        return snapshotTextResult(snapshot);
      }
      case "click":
      case "type":
      case "press":
      case "hover":
      case "scroll":
      case "select_option":
      case "set_checked":
      case "drag":
        return yield* this.#input(caller, call, context);
      case "fill_fields": {
        const tab = yield* this.#gatedTab(caller, call.args.tabId, context);
        let seq = tab.actionSeq;
        const result = yield* runTabFillFields(
          tab,
          call.args.revision,
          call.args.fields,
          call.args.timeoutMs ?? 10_000,
          () => {
            this.#requireOwned(caller, call.args.tabId);
            // Runs in the tab's queue, before each field: the fields change after the last snapshot.
            tab.actionSeq += 1;
            seq = tab.actionSeq;
          },
        );
        // The snapshot of the result is fresh when no other action of the tab ran after this one.
        if (result.snapshot && tab.actionSeq === seq) {
          tab.lastSnapshot = result.snapshot;
          tab.snapshotSeq = seq;
        }
        return { ...snapshotTextResult(result), success: result.status === "completed" };
      }
      case "wait_for":
        return yield* this.#waitFor(caller, call.args, context);
      case "screenshot":
        return yield* this.#screenshot(caller, call.args.tabId, call.args.ref, context);
      case "handle_dialog":
        return yield* this.#handleDialog(caller, params, call.args, context);
      case "close_tab":
        return yield* this.#closeTab(caller, call.args.tabId);
    }
  });

  // -------------------------------------------------------------------------------------------------
  // The connection, the project and the lease

  #connection(): ChromeBridgeConnection | null {
    const connected = this.#options.bridge.connected();
    const preferred = this.#options.preferredInstall?.() ?? null;
    return connected.find((entry) => entry.installId === preferred) ?? connected[0] ?? null;
  }

  #request<O extends ChromeBridgeOperation>(
    installId: string,
    op: O,
    body: OperationBodies[O],
    options?: { readonly key?: string; readonly timeoutMs?: number },
  ): Effect.Effect<ResultBodies[O], BrowserOperationError> {
    return this.#options.bridge
      .request(installId, op, body, options)
      .pipe(Effect.mapError((failure) => refusal(failure.code, failure.message)));
  }

  /** The project of a call, in the form the extension takes. */
  #project(agentId: string, threadId: string): ProjectRecord {
    const project = this.#options.projectOf(agentId, threadId) ?? {
      id: `agent:${agentId}`,
      title: this.#options.agentName(agentId) ?? "Agent",
    };
    const key = opaqueKey(this.#options.secret, "project", project.id);
    const digest = createHmac("sha256", this.#options.secret).update(`color\u0000${key}`).digest();
    const color = (project.color ? groupColorForHex(project.color) : null) ?? groupColorForHash(digest[0] ?? 0);
    const known = this.#projects.get(key);
    if (known) {
      known.title = project.title;
      known.color = color;
      // The newest projects go into `session.configure`: a project in use moves to the end.
      this.#projects.delete(key);
      this.#projects.set(key, known);
      return known;
    }
    const record: ProjectRecord = { key, title: project.title, color };
    this.#projects.set(key, record);
    return record;
  }

  /** Runs `work` once for `key`, however many calls ask for it at the same time. */
  #once(key: string, work: Effect.Effect<void, BrowserOperationError>): Effect.Effect<void, BrowserOperationError> {
    const inflight = this.#inflight;
    return Effect.suspend(() => {
      const running = inflight.get(key);
      if (running) return Deferred.await(running);
      const done = Deferred.makeUnsafe<void, BrowserOperationError>();
      inflight.set(key, done);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(work);
        inflight.delete(key);
        yield* Deferred.done(done, exit);
        return yield* Deferred.await(done);
      });
    });
  }

  /** Sends `session.configure` when the projects changed or the connection is new. */
  #configure(installId: string): Effect.Effect<void, BrowserOperationError> {
    const epoch = this.#epochs.get(installId) ?? 0;
    const projects = [...this.#projects.values()]
      .slice(-MAX_CONFIGURED_PROJECTS)
      .map((project) => ({ projectKey: project.key, title: project.title || "Agent", color: project.color }));
    const signature = JSON.stringify(projects);
    const done = this.#configured.get(installId);
    if (done && done.epoch === epoch && done.signature === signature) return Effect.void;
    return this.#once(
      `configure:${installId}`,
      this.#request(installId, "session.configure", {
        limits: { ...this.#limits },
        ratePerOrigin: { perOriginPerMinute: 30, perProjectPerMinute: 120 },
        policyAdd: [],
        projects,
      }).pipe(Effect.tap(() => Effect.sync(() => this.#configured.set(installId, { epoch, signature })))),
    );
  }

  /** The lease of an agent in a thread for its project now, open in the extension. */
  readonly #lease = Effect.fn("ChromeTabsHost.lease")(function* (
    this: ChromeTabsHost,
    installId: string,
    agentId: string,
    threadId: string,
  ) {
    const project = this.#project(agentId, threadId);
    yield* this.#configure(installId);
    const leaseId = opaqueKey(this.#options.secret, "lease", agentId, threadId, project.key);
    const known = this.#leases.get(leaseId);
    // A lease follows the Chrome profile that agents use now (a reinstall gives a new install id).
    const lease =
      known && known.installId === installId
        ? known
        : { leaseId, installId, projectKey: project.key, agentId, threadId, openedEpoch: -1, usedAt: 0 };
    this.#leases.set(leaseId, lease);
    yield* this.#openLease(lease);
    this.#claimUnclaimed(lease);
    return lease;
  });

  /** Opens the lease in the extension when this connection has not, or when it is about to end there. */
  #openLease(lease: LeaseRecord): Effect.Effect<void, BrowserOperationError> {
    const epoch = this.#epochs.get(lease.installId) ?? 0;
    const now = Date.now();
    if (lease.openedEpoch === epoch && now - lease.usedAt < LEASE_REFRESH_MS) {
      lease.usedAt = now;
      return Effect.void;
    }
    const name = this.#options.agentName(lease.agentId) ?? "Agent";
    return this.#once(
      `lease:${lease.leaseId}`,
      this.#request(lease.installId, "lease.open", {
        leaseId: lease.leaseId,
        projectKey: lease.projectKey,
        agentLabel: agentLabelOf(name),
        initials: initialsOf(name),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            lease.openedEpoch = epoch;
            lease.usedAt = Date.now();
          }),
        ),
      ),
    );
  }

  /** After an app restart, the tabs that the extension kept for this lease become its tabs again. */
  #claimUnclaimed(lease: LeaseRecord): void {
    const kept = this.#unclaimed.get(lease.leaseId);
    if (!kept || kept.installId !== lease.installId) return;
    this.#unclaimed.delete(lease.leaseId);
    for (const handle of kept.handles) {
      if (this.#byHandle.has(handle)) continue;
      const tab = this.#register(lease, handle, null);
      // The page of a tab taken back is unknown here until Chrome reports it: read it once, from the
      // tab's target (the tab's history is not a command in the person's Chrome).
      void Effect.runPromise(
        Effect.tryPromise(() => tab.target.sendCommand("Target.getTargetInfo", {})).pipe(
          Effect.tap((target) =>
            Effect.sync(() => {
              const info = isDynamicRecord(target) && isDynamicRecord(target.targetInfo) ? target.targetInfo : null;
              if (info)
                tab.target.receiveTabState({
                  ...(isString(info.url) ? { url: info.url } : {}),
                  ...(isString(info.title) ? { title: info.title } : {}),
                  status: "complete",
                });
            }),
          ),
          Effect.ignore,
        ),
      );
    }
  }

  #register(lease: LeaseRecord, handle: string, openerTabId: string | null): ChromeHostTab {
    const installId = lease.installId;
    const connection = this.#options.bridge.connected().find((entry) => entry.installId === installId);
    const run = <O extends ChromeBridgeOperation>(op: O, body: OperationBodies[O]) =>
      Effect.runPromise(
        this.#options.bridge
          .request(installId, op, body, { key: handle })
          .pipe(Effect.mapError((failure) => new Error(chromeRefusalText(failure.code, failure.message)))),
      );
    const channel: ChromeTabChannel = {
      send: (command) =>
        run("cdp.send", {
          leaseId: lease.leaseId,
          handle,
          method: command.method,
          params: command.params,
          ...(command.session === undefined ? {} : { session: command.session }),
        }).then((answer) => answer.result),
      ...(connection?.features.includes("cdp-batch")
        ? {
            batch: (commands) =>
              run("cdp.batch", {
                leaseId: lease.leaseId,
                handle,
                commands: commands.map((command) => ({
                  method: command.method,
                  params: command.params,
                  ...(command.session === undefined ? {} : { session: command.session }),
                })),
              }).then((answer) =>
                answer.results.map((entry) =>
                  entry.err
                    ? { error: new Error(chromeRefusalText(entry.err.code, entry.err.message)) }
                    : { result: entry.result ?? {} },
                ),
              ),
          }
        : {}),
      stopLoading: () =>
        run("cdp.send", { leaseId: lease.leaseId, handle, method: "Page.stopLoading", params: {} }).then(
          () => undefined,
        ),
    };
    const target = new ChromeCdpTarget(channel);
    for (const state of this.#early.get(handle) ?? []) target.receiveTabState(state);
    this.#early.delete(handle);
    const queue = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(queue, Exit.void);
    const tab: ChromeHostTab = {
      id: randomUUID(),
      handle,
      installId,
      leaseId: lease.leaseId,
      projectKey: lease.projectKey,
      ownerThreadId: lease.threadId,
      ownerAgentId: lease.agentId,
      target,
      engine: new BrowserCdpEngine(target),
      diagnostics: new BrowserDiagnostics(),
      scope: Scope.makeUnsafe(),
      queue,
      pendingOperations: 0,
      revision: 0,
      environment: defaultBrowserEnvironment(),
      lastSnapshot: null,
      actionSeq: 0,
      snapshotSeq: -1,
      lastUsedAt: Date.now(),
      ...(openerTabId ? { openerTabId } : {}),
    };
    this.#tabs.set(tab.id, tab);
    this.#byHandle.set(handle, tab.id);
    return tab;
  }

  /** A popup that an agent's page opened: the extension gave it to the opener's lease. */
  #adoptPopup(installId: string, body: DynamicRecord): void {
    if (!isString(body.handle) || this.#byHandle.has(body.handle)) return;
    const opener = this.#tabByHandle(body.opener);
    const lease = isString(body.leaseId) ? this.#leases.get(body.leaseId) : undefined;
    if (!opener || !lease || lease.installId !== installId) return;
    this.#register(lease, body.handle, opener.id);
  }

  // -------------------------------------------------------------------------------------------------
  // Tabs

  #ownedTabs(caller: { threadId: string; ownerAgentId: string }): ChromeHostTab[] {
    return [...this.#tabs.values()].filter((tab) => !tab.closing && canUseBrowserTab(caller, tab));
  }

  #publicTab(tab: ChromeHostTab): BrowserTab {
    const url = tab.engine.page.url();
    // A sensitive site that the project may not use yet shows its origin only: no path, no title.
    const hidden = sensitiveSiteKind(url) !== null && !this.#siteConsents.get(tab.projectKey)?.has(new URL(url).origin);
    const title = hidden ? "" : tab.engine.scrubText(tab.engine.page.title());
    return {
      id: tab.id,
      title: title || "New tab",
      url: hidden ? new URL(url).origin : tab.engine.scrubText(url),
      loading: tab.engine.page.isLoading(),
      ownerThreadId: tab.ownerThreadId,
      ownerAgentId: tab.ownerAgentId,
      environment: tab.environment,
      diagnosticErrorCount: tab.diagnostics.errorCount,
      ...(tab.openerTabId ? { openerTabId: tab.openerTabId } : {}),
    };
  }

  #toolTabs(caller: { threadId: string; ownerAgentId: string }): { tabs: BrowserTab[]; activeTabId: string | null } {
    const tabs = this.#ownedTabs(caller);
    const last =
      tabs.find((tab) => tab.id === this.#lastUsedTabId) ?? [...tabs].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    return { tabs: tabs.map((tab) => this.#publicTab(tab)), activeTabId: last?.id ?? null };
  }

  #requireOwned(caller: { threadId: string; ownerAgentId: string }, tabId: string): ChromeHostTab {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.closing || !canUseBrowserTab(caller, tab)) throw unknownBrowserTabError(tabId);
    return tab;
  }

  /** A tab of the caller, with its lease open in the extension. */
  readonly #usableTab = Effect.fn("ChromeTabsHost.usableTab")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    tabId: string,
  ) {
    const tab = yield* browserSync(() => this.#requireOwned(caller, tabId));
    const lease = this.#leases.get(tab.leaseId);
    if (lease) yield* this.#openLease(lease);
    tab.lastUsedAt = Date.now();
    this.#lastUsedTabId = tab.id;
    return tab;
  });

  /**
   * The consent for a sensitive site (DESIGN §2.4, §7 item 10): mail, chat, a cloud console, a social
   * network, a payment frame or the person's own network. The person answers once for a project and an
   * origin, until the app restarts; a turn where nobody answers gets `consent_required` at once. It runs
   * before a call reads or acts on such a page, and again after an action that can change the page.
   */
  #siteGate(projectKey: string, url: string, context: ChromeCallContext): Effect.Effect<void, BrowserOperationError> {
    const kind = sensitiveSiteKind(url);
    if (!kind) return Effect.void;
    const site = new URL(url).origin;
    const granted = this.#siteConsents;
    if (granted.get(projectKey)?.has(site)) return Effect.void;
    const ask = context.approveSiteAccess;
    if (!ask) return refusal("consent_required", site);
    const project = this.#projectTitle(projectKey);
    return this.#once(
      `consent:${projectKey}:${site}`,
      ask({ project, site, kind }).pipe(
        Effect.flatMap((allowed) => {
          if (!allowed)
            return browserFailure(
              new Error(
                `The person did not allow the agents of this project on ${site}. Do not use that site; tell the person.`,
              ),
            );
          const sites = granted.get(projectKey) ?? new Set<string>();
          sites.add(site);
          granted.set(projectKey, sites);
          return Effect.void;
        }),
      ),
    );
  }

  #projectTitle(projectKey: string): string {
    return this.#projects.get(projectKey)?.title || "Agent";
  }

  /** A tab of the caller whose page the project may use now. */
  readonly #gatedTab = Effect.fn("ChromeTabsHost.gatedTab")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    tabId: string,
    context: ChromeCallContext,
  ) {
    const tab = yield* this.#usableTab(caller, tabId);
    yield* this.#siteGate(tab.projectKey, tab.engine.page.url(), context);
    return tab;
  });

  readonly #open = Effect.fn("ChromeTabsHost.open")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    url: string,
    context: ChromeCallContext,
  ) {
    const address = url.trim() === "about:blank" ? "about:blank" : yield* browserSync(() => normalizeBrowserUrl(url));
    const connection = this.#connection();
    if (!connection) return yield* refusal("chrome_not_connected");
    const memory = this.#options.memoryLevel?.() ?? "ok";
    if (memory === "critical") return yield* refusal("low_memory");
    const lease = yield* this.#lease(connection.installId, caller.ownerAgentId, caller.threadId);
    yield* this.#siteGate(lease.projectKey, address, context);
    // A blank tab of this agent is used before a new one: no tab is made where one waits.
    const blank = this.#ownedTabs(caller).find(
      (tab) =>
        tab.leaseId === lease.leaseId &&
        tab.engine.page.url() === "about:blank" &&
        !tab.engine.page.isLoading() &&
        tab.pendingOperations === 0,
    );
    if (blank) {
      blank.lastUsedAt = Date.now();
      this.#lastUsedTabId = blank.id;
      if (address !== "about:blank")
        yield* enqueueTabOperation(blank, (tab) =>
          Effect.suspend(() => {
            tab.actionSeq += 1;
            return this.#loadUrl(tab, address, Date.now() + OPEN_LOAD_TIMEOUT_MS);
          }),
        );
      yield* this.#siteGate(lease.projectKey, blank.engine.page.url(), context);
      return textResult({ tab: this.#publicTab(blank), reused: true });
    }
    if (memory === "low") return yield* refusal("low_memory");
    const leaseTabs = [...this.#tabs.values()].filter((tab) => tab.leaseId === lease.leaseId && !tab.closing).length;
    if (leaseTabs >= this.#limits.tabsPerLease)
      return yield* refusal("limit", `this agent has ${leaseTabs} tabs open, its limit; close or reuse one`);
    const created = yield* this.#request(
      connection.installId,
      "tab.create",
      { leaseId: lease.leaseId, url: address },
      { timeoutMs: CREATE_TIMEOUT_MS },
    );
    const tab = this.#register(lease, created.handle, null);
    tab.lastUsedAt = Date.now();
    this.#lastUsedTabId = tab.id;
    // The extension navigates the new tab itself; its load events can come before its handle.
    if (address !== "about:blank") yield* tab.target.waitForFirstPage(OPEN_LOAD_TIMEOUT_MS).pipe(Effect.ignore);
    yield* this.#siteGate(lease.projectKey, tab.engine.page.url(), context);
    return textResult({ tab: this.#publicTab(tab) });
  });

  /** `Page.navigate`, then the end of that load. A navigation in the same document loads nothing. */
  #loadUrl(tab: ChromeHostTab, url: string, deadline: number): Effect.Effect<void, BrowserOperationError> {
    return Effect.gen(function* () {
      const mark = tab.target.statusMark();
      const answer = yield* Effect.tryPromise({
        try: () => tab.target.sendCommand("Page.navigate", { url }),
        catch: browserFailure,
      });
      const result = isDynamicRecord(answer) ? answer : {};
      if (isString(result.errorText) && result.errorText !== "")
        return yield* browserFailure(new Error(`Navigation failed: ${result.errorText}`));
      if (!isString(result.loaderId)) return;
      yield* tab.target.waitForLoadAfter(
        mark,
        yield* browserSync(() => remainingTime(deadline, "Navigation timed out.")),
      );
    });
  }

  readonly #navigate = Effect.fn("ChromeTabsHost.navigate")(function* <A>(
    this: ChromeTabsHost,
    tab: ChromeHostTab,
    args: {
      readonly url?: string | undefined;
      readonly direction?: "back" | "forward" | "reload" | undefined;
      readonly timeoutMs?: number | undefined;
    },
    readResult: ActionResultReader<A>,
  ) {
    const { url, direction } = args;
    if (!url && !direction) return yield* browserFailure(new Error("navigate requires url or direction."));
    return yield* runTabAction(
      tab,
      "navigate",
      undefined,
      (current, deadline) =>
        Effect.gen({ self: this }, function* () {
          current.actionSeq += 1;
          if (url) {
            const address = yield* browserSync(() => normalizeBrowserUrl(url));
            yield* this.#loadUrl(current, address, deadline);
            return;
          }
          if (!direction) return;
          const mark = current.target.statusMark();
          yield* this.#request(
            current.installId,
            "tab.history",
            { handle: current.handle, action: direction },
            {
              key: current.handle,
            },
          );
          // A page from the back-forward cache can come back with no load: the wait then ends at its deadline.
          yield* current.target
            .waitForLoadAfter(mark, Math.min(5_000, Math.max(1, deadline - Date.now())))
            .pipe(Effect.ignore);
          // Chrome reports no new title for a page that the back-forward cache gives back: read it once,
          // from the tab's target. The tab's history is not a command in the person's Chrome.
          if (direction !== "reload") {
            const target = yield* Effect.tryPromise({
              try: () => current.target.sendCommand("Target.getTargetInfo", {}),
              catch: browserFailure,
            }).pipe(Effect.orElseSucceed(() => null));
            const info = isDynamicRecord(target) && isDynamicRecord(target.targetInfo) ? target.targetInfo : null;
            if (info && isString(info.title)) current.target.receiveTabState({ title: info.title });
          }
        }),
      readResult,
      browserToolTimeout(args.timeoutMs),
    );
  });

  /** Keeps the snapshot that a reader returns, for the card of a later send. It runs in the tab's queue. */
  #remember(reader: ActionResultReader<BrowserSnapshot>): ActionResultReader<BrowserSnapshot> {
    return (tab, keepQueueBlocked, timeoutMessage) =>
      reader(tab, keepQueueBlocked, timeoutMessage).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            const owned = this.#tabs.get(tab.id);
            if (!owned) return;
            owned.lastSnapshot = snapshot;
            owned.snapshotSeq = owned.actionSeq;
          }),
        ),
      );
  }

  readonly #snapshot = Effect.fn("ChromeTabsHost.snapshot")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    tabId: string,
    mode: "auto" | "always" | "never",
    context: ChromeCallContext,
  ) {
    const tab = yield* this.#gatedTab(caller, tabId, context);
    const capture = yield* enqueueTabOperation(tab, (current, keepQueueBlocked) =>
      Effect.gen(function* () {
        let imageUrl: string | null = null;
        const seq = current.actionSeq;
        const result: SnapshotReadResult = yield* readTabSnapshot(
          current,
          current.revision + 1,
          keepQueueBlocked,
          undefined,
          undefined,
          (read) =>
            Effect.gen(function* () {
              const recommended = mode === "auto" && read.recommendImage;
              const imageCurrent = hasCurrentImage(current);
              if (mode !== "always" && (!recommended || imageCurrent)) {
                if (imageCurrent) passImageOn(current);
                if (recommended)
                  read.snapshot.image = {
                    included: false,
                    reason:
                      "The last image is of this page, and no tool action ran since. Pass image: always if the page can have changed.",
                    width: read.snapshot.viewport.width,
                    height: read.snapshot.viewport.height,
                  };
                return;
              }
              imageUrl = yield* boundEngineOperation(
                current,
                current.engine.captureImageData(undefined, MAX_CAPTURE_PIXELS, Date.now() + 10_000),
                10_000,
                "Browser screenshot timed out.",
                keepQueueBlocked,
              );
              markImageTaken(current);
            }),
        );
        current.lastSnapshot = result.snapshot;
        current.snapshotSeq = seq;
        return { result, imageUrl };
      }),
    );
    return snapshotImageResult(capture.result, mode, capture.imageUrl);
  });

  readonly #input = Effect.fn("ChromeTabsHost.input")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    call: Extract<
      ChromeToolCall,
      { tool: "click" | "type" | "press" | "hover" | "scroll" | "select_option" | "set_checked" | "drag" }
    >,
    context: ChromeCallContext,
  ) {
    const tab = yield* this.#gatedTab(caller, call.args.tabId, context);
    const gated: ChromeAction | null =
      call.tool === "click"
        ? { tool: "click", target: call.args.target }
        : call.tool === "press"
          ? { tool: "press", key: call.args.key, target: call.args.target }
          : call.tool === "type"
            ? { tool: "type", text: call.args.text, submit: call.args.submit === true, target: call.args.target }
            : null;
    const card = gated ? messageSendCard(tab.engine.page.url(), gated, tab.lastSnapshot) : null;
    /** The tab's action count that the person approved; another action meanwhile voids the card. */
    let approvedSeq: number | null = null;
    if (card) {
      // The card shows the page as the last snapshot read it: an action after it would hide a change.
      if (!tab.lastSnapshot || tab.snapshotSeq !== tab.actionSeq)
        return yield* browserFailure(
          new Error(
            "Take a fresh snapshot before this send: the person's card shows the page as your last snapshot read it, and an action ran after that snapshot.",
          ),
        );
      if (!context.approveMessageSend) return yield* refusal("message_send_requires_approval");
      const seq = tab.actionSeq;
      const approved = yield* context.approveMessageSend(card);
      if (!approved)
        return yield* browserFailure(
          new Error("The person did not approve this message. It was not sent; do not send it another way."),
        );
      // The person read the page as it was: a change since then needs a new card.
      if (tab.engine.page.url() !== card.site && !tab.engine.page.url().startsWith(`${card.site}/`))
        return yield* browserFailure(new Error("The page changed during the approval. Take a fresh snapshot."));
      approvedSeq = seq;
    }
    const action = yield* browserSync(() => browserInputAction(call, {}));
    const run = <A>(readResult: ActionResultReader<A>) =>
      runTabAction(
        tab,
        action.name,
        action.target,
        (current, deadline, markDispatched) =>
          Effect.suspend(() => {
            // In the tab's queue: an action that ran during the approval changed what the card showed.
            if (approvedSeq !== null && current.actionSeq !== approvedSeq)
              return browserFailure(
                new Error("The page changed during the approval. Nothing was sent; take a fresh snapshot."),
              );
            current.actionSeq += 1;
            return action.run(current.engine, deadline, markDispatched);
          }),
        readResult,
        browserToolTimeout(call.args.timeoutMs),
      );
    const result = call.args.snapshot
      ? snapshotTextResult(yield* run(this.#remember(readActionSnapshot)))
      : textResult(yield* run(readActionStatus));
    // A click can lead to a sensitive site: its address and content wait for the consent.
    yield* this.#siteGate(tab.projectKey, tab.engine.page.url(), context);
    return result;
  });

  readonly #waitFor = Effect.fn("ChromeTabsHost.waitFor")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    args: {
      readonly tabId: string;
      readonly target?: BrowserTarget | undefined;
      readonly text?: string | undefined;
      readonly url?: string | undefined;
      readonly state?: "load" | "domcontentloaded" | "dom-quiet" | undefined;
      readonly timeoutMs?: number | undefined;
    },
    context: ChromeCallContext,
  ) {
    const condition = {
      ...(args.target === undefined ? {} : { target: args.target }),
      ...(args.text === undefined ? {} : { text: args.text }),
      ...(args.url === undefined ? {} : { url: args.url }),
      ...(args.state === undefined ? {} : { state: args.state }),
    };
    if (!condition.target && !condition.text && !condition.url && !condition.state)
      return yield* browserFailure(new Error("wait_for requires a condition."));
    const tab = yield* this.#gatedTab(caller, args.tabId, context);
    const timeoutMs = browserToolTimeout(args.timeoutMs);
    const snapshot = yield* enqueueTabOperation(tab, (current, keepQueueBlocked: KeepQueueBlocked) =>
      Effect.gen(function* () {
        const timeoutMessage = "Browser wait condition timed out.";
        const deadline = Date.now() + timeoutMs;
        const waitTimeout = remainingTime(deadline, timeoutMessage);
        yield* boundEngineOperation(
          current,
          current.engine.waitFor(condition, waitTimeout),
          waitTimeout,
          timeoutMessage,
          keepQueueBlocked,
        );
        const seq = current.actionSeq;
        const read = yield* readTabSnapshot(
          current,
          current.revision + 1,
          keepQueueBlocked,
          remainingTime(deadline, timeoutMessage),
          timeoutMessage,
        );
        current.lastSnapshot = read.snapshot;
        current.snapshotSeq = seq;
        return read.snapshot;
      }),
    );
    yield* this.#siteGate(tab.projectKey, tab.engine.page.url(), context);
    return snapshotTextResult(snapshot);
  });

  readonly #screenshot = Effect.fn("ChromeTabsHost.screenshot")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    tabId: string,
    ref: string | undefined,
    context: ChromeCallContext,
  ) {
    const tab = yield* this.#gatedTab(caller, tabId, context);
    // A ref starts with the snapshot revision that made it.
    const target: BrowserTarget | undefined = ref
      ? { kind: "ref", ref, revision: Number(ref.split(":", 1)[0]) }
      : undefined;
    if (target) {
      // An element's clip is in view pixels, which the page zoom scales.
      const zoom = yield* this.#request(tab.installId, "tab.zoom", { handle: tab.handle }, { key: tab.handle }).pipe(
        Effect.map((answer) => answer.factor),
        Effect.orElseSucceed(() => 1),
      );
      tab.target.setZoomFactor(zoom);
    }
    const imageUrl = yield* enqueueTabOperation(tab, (current, keepQueueBlocked) =>
      boundEngineOperation(
        current,
        current.engine.captureImageData(target, MAX_CAPTURE_PIXELS, Date.now() + 10_000),
        10_000,
        "Browser screenshot timed out.",
        keepQueueBlocked,
      ).pipe(Effect.tap(() => Effect.sync(() => markImageTaken(current)))),
    );
    return { success: true, contentItems: [{ type: "inputImage" as const, imageUrl }] } satisfies DynamicToolResult;
  });

  readonly #handleDialog = Effect.fn("ChromeTabsHost.handleDialog")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    params: DynamicToolCallParams,
    args: { readonly tabId: string; readonly dialogId: string; readonly accept: boolean },
    context: ChromeCallContext,
  ) {
    const tab = yield* this.#gatedTab(caller, args.tabId, context);
    yield* tab.engine.answerDialog(args.dialogId, args.accept, { threadId: params.threadId, turnId: params.turnId });
    const answered = args.accept ? "accepted" : "dismissed";
    // The action that opened the dialog goes on, and can open the next one.
    const next = Option.getOrUndefined(
      yield* tab.engine.nextDialog().pipe(Effect.timeoutOption(DIALOG_ACTION_WAIT_MS)),
    );
    if (next) return textResult({ answered, ...dialogTabResult(args.tabId, next) });
    const status = yield* runTabAction(tab, "handle_dialog", undefined, () => Effect.void, readActionStatus);
    return textResult({ answered, ...status });
  });

  readonly #closeTab = Effect.fn("ChromeTabsHost.closeTab")(function* (
    this: ChromeTabsHost,
    caller: { threadId: string; ownerAgentId: string },
    tabId: string,
  ) {
    // A tab that is already gone closes as a silent success, so a repeated close is idempotent.
    const tab = this.#tabs.get(tabId);
    if (!tab) return textResult({ closed: true });
    yield* browserSync(() => this.#requireOwned(caller, tabId));
    const lease = this.#leases.get(tab.leaseId);
    if (lease) yield* this.#openLease(lease);
    yield* this.#request(tab.installId, "tab.close", { handle: tab.handle }, { key: tab.handle }).pipe(
      Effect.catch((failure) =>
        // The person closed it meanwhile: it is closed either way.
        String(failure.cause).includes("no longer yours") ? Effect.void : Effect.fail(failure),
      ),
    );
    this.#forget(tab.handle);
    return textResult({ closed: true });
  });

  // -------------------------------------------------------------------------------------------------
  // For the app and its checks

  /** The tabs of all agents, for diagnostics and the E2E: no page content. */
  tabCount(): number {
    return this.#tabs.size;
  }

  /** The tab of the person's Chrome behind an agent's tab id, for the router's approval card. */
  tabUrl(tabId: string): string | null {
    return this.#tabs.get(tabId)?.engine.page.url() ?? null;
  }

  /** Ends every tab record; the tabs stay in Chrome, and the extension keeps their leases. */
  dispose(): void {
    for (const tab of [...this.#tabs.values()]) this.#forget(tab.handle);
  }
}
