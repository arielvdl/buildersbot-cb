import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger, toLogValue } from "@openbot/logging";
import { type BrokerCallCheck, type BrokerCallDecision, guardBrokerCall } from "../backend/guard/guard-broker-calls";
import { GUARD_UNREAD_REASON, guardStrongNotice } from "../backend/guard/guard-gate";
import { type GuardResultCheck, McpResultGuard } from "../backend/guard/guard-mcp-results";
import { listenLoopback } from "./listen-loopback";
import { BROKER_TOKEN_ENV, BROKER_TOKEN_HEADER, guardNodeOptions } from "./playwright-broker-guard";
import {
  BrowserLedger,
  type BrowserLimits,
  DEFAULT_BROWSER_LIMITS,
  inspectRpc,
  isBlankTab,
  type ListedTab,
  listedTabCount,
  listedTabs,
  REFUSED_BROWSER_TOOL_MESSAGE,
  REFUSED_BROWSER_TOOLS,
  type RpcEntry,
  refusalResult,
  responseMessages,
  resultFailed,
  resultText,
  tabsDelta,
} from "./playwright-broker-policy";
import { maskSecrets } from "./playwright-broker-runtime";

const logger = createBuildersBotLogger("playwright-broker");

const MAX_BODY_BYTES = 1_000_000;
/** The part of a response the broker reads to count tabs. A longer answer is passed on, not counted. */
const MAX_TEE_BYTES = 256_000;
const UPSTREAM_START_TIMEOUT_MS = 45_000;
const REAP_INTERVAL_MS = 30_000;
/** Forwarded as they are. Anything else, the `Authorization` of the agent above all, stays behind. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control", "mcp-protocol-version"];

const LOW_MEMORY_MESSAGE =
  "The computer is low on memory, so the browser opens no new connection now. Try again in a minute, or go on without the browser.";
const LOW_MEMORY_TAB_MESSAGE =
  "The computer is low on memory, so no new tab opens now. Close a tab you opened with browser_tabs action=close, or reuse an open tab, and try again in a minute.";

/** The group of the agents that have no project, and of the projects past the limit. */
const SHARED_LANE = "shared";
const SHARED_LANE_TITLE = "Builders Bot";
/** The extension shows at most this much of a group title well. */
const MAX_GROUP_TITLE = 40;
/** An agent that made a call this recently is at work in its tab, and another agent does not take that tab. */
const BUSY_MS = 2 * 60_000;
/** How often the broker confirms that its own session still holds the group, at most. */
const GROUP_CHECK_MS = 30_000;
const PROTOCOL_VERSION = "2025-06-18";
const AGENT_KEY = /^[A-Za-z0-9_-]{22}$/u;
const MAX_INTERNAL_RESPONSE_BYTES = 512_000;

/** What every agent reads when it connects: one tab, reused. */
const SERVER_INSTRUCTIONS =
  "These tools drive the person's own Chrome. Use one tab: open each page in your current tab with browser_navigate. Open a second tab with browser_tabs action=new only when you need two pages at the same time, and close it with browser_tabs action=close when you are done with it. Your last tab is not closed: it stays open for your next page, also in your next turn. The tabs of your project are in one tab group with the name of the project; do not use a tab that another agent works in.";
/** Added to the description of these tools, so that the agent reads it where it chooses the call. */
const TOOL_NOTES: Readonly<Record<string, string>> = {
  browser_tabs:
    "Reuse your current tab: open a page in it with browser_navigate. Use action=new only when you need two pages at the same time, and close that tab with action=close when you are done. Your last tab is not closed: it stays for your next page.",
  browser_navigate:
    "This opens the page in your current tab, which is the normal way to open a page. Do not open a new tab for each page.",
};
const LAST_TAB_MESSAGE =
  "This is the last tab of your group, so it stays open for your next page, and it now shows about:blank. Open your next page in it with browser_navigate.";

/** A group title as the extension shows it: one line, no control or direction characters, not too long. */
function groupTitle(name: string): string {
  const clean = name
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return SHARED_LANE_TITLE;
  const characters = [...clean];
  return characters.length > MAX_GROUP_TITLE ? `${characters.slice(0, MAX_GROUP_TITLE - 1).join("")}…` : clean;
}

/** A change to one JSON-RPC answer of the upstream. */
type AnswerChange = (message: DynamicRecord) => DynamicRecord;

/** The JSON-RPC messages of a response, each one changed by `change`, in the framing they came in. */
function rewriteMessages(text: string, change: AnswerChange): string {
  const changed = (message: unknown) => (isDynamicRecord(message) ? change(message) : message);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const messages = responseMessages(trimmed);
    if (messages.length === 0) return text;
    return JSON.stringify(trimmed.startsWith("[") ? messages.map(changed) : changed(messages[0]));
  }
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const [message] = responseMessages(line.slice(5).trim());
      return message === undefined ? line : `data: ${JSON.stringify(changed(message))}`;
    })
    .join("\n");
}

/** The answer to `initialize`, with the instructions of the broker after those of the server. */
function withInstructions(message: DynamicRecord): DynamicRecord {
  if (!isDynamicRecord(message.result)) return message;
  const own = typeof message.result.instructions === "string" ? `${message.result.instructions}\n\n` : "";
  return { ...message, result: { ...message.result, instructions: `${own}${SERVER_INSTRUCTIONS}` } };
}

/** The answer to `tools/list`, with a note on the tools that open pages and tabs. */
function withToolNotes(message: DynamicRecord): DynamicRecord {
  if (!isDynamicRecord(message.result) || !Array.isArray(message.result.tools)) return message;
  const offered = message.result.tools.filter(
    (tool: unknown) =>
      !(isDynamicRecord(tool) && typeof tool.name === "string" && REFUSED_BROWSER_TOOLS.has(tool.name)),
  );
  const tools = offered.map((tool: unknown) => {
    if (!isDynamicRecord(tool) || typeof tool.name !== "string") return tool;
    const note = TOOL_NOTES[tool.name];
    if (!note) return tool;
    const description = typeof tool.description === "string" ? `${tool.description} ` : "";
    return { ...tool, description: `${description}${note}` };
  });
  return { ...message, result: { ...message.result, tools } };
}

/**
 * One tab group in the person's Chrome: one Playwright server, one connection to the extension, and
 * the tabs that the agents of one project use. The extension names the group after the MCP client
 * that made the connection, and that client is the broker's own session, named after the project.
 */
interface Lane {
  readonly key: string;
  readonly title: string;
  upstream: UpstreamProcess | null;
  /** The token of the running upstream. A new upstream has a new one. */
  token: string | null;
  starting: Promise<UpstreamProcess> | null;
  emptySince: number | null;
  /**
   * The broker's own session at the upstream. The server keeps its browser, and with it the extension
   * connection and the group, while one session holds it. The agent CLIs end their sessions at the end
   * of each turn, so without this one each turn made a new connection: a new tab, a new group, and the
   * focus taken.
   */
  holder: string | null;
  holding: Promise<void> | null;
  heldAt: number | null;
  /** The tabs of the group, as the last list showed them. */
  tabs: number | null;
  /** The page that each agent was on last, by agent key, so that its next turn finds its tab. */
  readonly lastPages: Map<string, string>;
  lastUsedAt: number;
}

interface SessionState {
  lane: Lane;
  /** The opaque key of the agent from its address, or null for an address with no agent. */
  agent: string | null;
  /** Set once the broker chose the tab of the session, at its first call. */
  placing: Promise<void> | null;
  /** The page of the session's current tab, as the broker's own list showed it. */
  pageUrl: string | null;
  /** Set by each call of the agent: the page may have changed since the broker read it. */
  pageStale: boolean;
  lastCallAt: number | null;
}

/** The arguments of a tool call that the broker makes itself. */
interface OwnToolArguments {
  action?: "list" | "new" | "select" | "close";
  index?: number;
  url?: string;
}

/** A JSON-RPC message that the broker writes itself. */
type OwnRpcMessage =
  | { jsonrpc: "2.0"; id: string; method: "tools/call"; params: { name: string; arguments: OwnToolArguments } }
  | {
      jsonrpc: "2.0";
      id: string;
      method: "initialize";
      params: {
        protocolVersion: string;
        capabilities: { roots?: { listChanged: boolean } };
        clientInfo: { name: string; version: string };
      };
    }
  | { jsonrpc: "2.0"; method: "notifications/initialized" };

/** A tool call that the broker makes in a session, and what came back. */
interface InternalReply {
  status: number;
  session: string | null;
  text: string;
}

/** How the Playwright MCP server is started: from the row the person saved, with the flags set below. */
export interface BrokerUpstreamSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A running upstream. */
export interface UpstreamProcess {
  /** Where to connect: the loopback address and the port the server printed. */
  url: string;
  /**
   * The `Host` header to send. The Playwright server refuses any host but the one it prints, which is
   * `localhost:PORT` even when it listens on 127.0.0.1, so it is not always the host of `url`.
   */
  hostHeader?: string;
  stop(): Promise<void>;
  /** Called once, when the process ends by itself. */
  onExit(listener: () => void): void;
}

export type UpstreamLauncher = (spec: BrokerUpstreamSpec) => Promise<UpstreamProcess>;

/** The port and bearer that stay the same across restarts, so a resumed provider session keeps its address. */
export interface BrokerIdentityStore {
  read(): { port: number | null; secret: string } | null;
  write(identity: { port: number; secret: string }): void;
}

export interface PlaywrightBrokerOptions {
  /**
   * The guard file that the Playwright process loads (`installGuard`). The process refuses every request
   * without the token that the broker makes for it, so the door is the only way in.
   */
  guardPath: string;
  /**
   * How much memory this computer has left. While it is low no new tab opens, and while it is critical no
   * new session opens either: a tab is the thing that grows. Listing and closing tabs always work, so an
   * agent can give memory back. Absent reads as ok.
   */
  memoryLevel?: () => "ok" | "low" | "critical";
  /** The upstream to start, from the saved Playwright row, or null while no such row is enabled. */
  upstream: () => BrokerUpstreamSpec | null;
  identity: BrokerIdentityStore;
  limits?: BrowserLimits;
  launch?: UpstreamLauncher;
  /** A session with no request for this long is ended. */
  idleSessionMs?: number;
  /** With no session for this long the upstream stops, so the person's browser is free. */
  idleUpstreamMs?: number;
  now?: () => number;
  /**
   * The Guard's check of a tool result, read at each call. A page that the browser reads is content
   * from outside: the check puts a note in front of a result that may hold a prompt injection. Null
   * while the Guard is off or not ready; results then pass as they are.
   */
  guardResult?: () => GuardResultCheck | null;
  /**
   * The Guard's check of a tool call before the browser runs it, read at each call: the URL, script,
   * text or files that the call sends out. Null while the Guard is off; calls then run as they are.
   */
  guardCall?: () => BrokerCallCheck | null;
  /**
   * The project of an agent: a stable key and the name its tab group shows. Each project gets a group
   * of its own, up to `limits.projects`. Null, or absent, puts the agent in the shared group.
   */
  projectOf?: (agentId: string) => { key: string; title: string } | null;
  /**
   * Whether projects may have groups of their own now. Each group is a Playwright process; when the
   * server starts a browser of its own (the egress proxy), two of them would share one profile, so then
   * all agents use one. Absent reads as true.
   */
  projectGroups?: () => boolean;
}

export interface BrokerEndpoint {
  url: string;
  bearer: string;
  /** The address for one agent. The broker reads the agent from it to give the agent its project's group. */
  agentUrl: (agentId: string) => string;
}

function jsonRpcError(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * One Playwright MCP server for each project's tab group, and a loopback door in front of them.
 *
 * Without this, each agent starts its own `@playwright/mcp`, and each of those starts its own
 * Chrome or asks the extension for the person's browser. A few at once use all the memory. Here,
 * `@playwright/mcp --extension --shared-browser-context` talks to the extension once for each
 * project, and every agent is a session of the server of its project. No browser is started by
 * Builders Bot at any point.
 *
 * The door adds what the Playwright server has not: a bearer (the server has no sign-in, and its
 * browser holds the person's logged-in sites), a limit on agent sessions, and a limit on the tabs
 * that agents hold open. It starts a server only when the first agent of the project asks, and stops
 * it when no agent has used it for a while.
 *
 * It also keeps the tabs few. The broker holds a session of its own in each server, so the connection
 * to the extension, its tab group and its tabs stay between the turns of the agents. At the first call
 * of a session it puts the agent back in the tab it used last, or in a tab that no other agent works
 * in. The last tab of a group is not closed, because the extension ends the connection with it.
 */
export class PlaywrightBroker {
  readonly #options: PlaywrightBrokerOptions;
  readonly #ledger: BrowserLedger;
  readonly #limits: BrowserLimits;
  readonly #launch: UpstreamLauncher;
  readonly #now: () => number;
  readonly #lanes = new Map<string, Lane>();
  readonly #sessions = new Map<string, SessionState>();
  /** The agent of each key that an agent address carries. Filled when the address is handed out. */
  readonly #agents = new Map<string, string>();
  #server: Server | null = null;
  #port: number | null = null;
  #secret: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #internalId = 0;

  constructor(options: PlaywrightBrokerOptions) {
    this.#options = options;
    this.#limits = options.limits ?? DEFAULT_BROWSER_LIMITS;
    this.#ledger = new BrowserLedger(this.#limits);
    this.#launch = options.launch ?? launchPlaywrightMcp;
    this.#now = options.now ?? Date.now;
  }

  /** The address and bearer that agents are given, or null before `start`. */
  endpoint(): BrokerEndpoint | null {
    if (this.#port === null || this.#secret === null) return null;
    const url = `http://127.0.0.1:${this.#port}/mcp`;
    const secret = this.#secret;
    return {
      url,
      bearer: secret,
      agentUrl: (agentId) => {
        // The key is opaque and the same across restarts, because the bearer is: a resumed session keeps it.
        const key = createHmac("sha256", secret).update(`agent:${agentId}`).digest("base64url").slice(0, 22);
        this.#agents.set(key, agentId);
        return `${url}?agent=${key}`;
      },
    };
  }

  /** Listens on the port it had, when it is free. Nothing else starts here: the upstream waits for an agent. */
  async start(): Promise<void> {
    if (this.#server) return;
    const saved = this.#options.identity.read();
    this.#secret = saved?.secret ?? randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        logger.warn("A browser request failed.", { cause: toLogValue(error) });
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(jsonRpcError(null, -32603, "The browser broker failed."));
      });
    });
    this.#port = await listenLoopback(
      server,
      () => new Error("The browser broker has no loopback port."),
      saved?.port ?? undefined,
    );
    this.#server = server;
    this.#options.identity.write({ port: this.#port, secret: this.#secret });
    this.#timer = setInterval(() => void this.releaseIdle(), REAP_INTERVAL_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.#stopAll();
  }

  /**
   * How many agent sessions and tabs the broker holds now. For the load panel and for tests. `tabs` is
   * what the agents opened in their sessions; `openTabs` is all the tabs of the groups, as last listed.
   */
  usage(): { sessions: number; tabs: number; openTabs: number; groups: number; upstream: boolean } {
    return {
      sessions: this.#ledger.sessionCount(),
      tabs: this.#ledger.totalTabs(),
      openTabs: this.#openTabs(),
      groups: [...this.#lanes.values()].filter((lane) => lane.upstream !== null).length,
      upstream: [...this.#lanes.values()].some((lane) => lane.upstream !== null),
    };
  }

  #openTabs(): number {
    let total = 0;
    for (const lane of this.#lanes.values()) if (lane.upstream) total += lane.tabs ?? 0;
    return total;
  }

  #lane(key: string, title: string): Lane {
    const existing = this.#lanes.get(key);
    if (existing) return existing;
    const lane: Lane = {
      key,
      title,
      upstream: null,
      token: null,
      starting: null,
      emptySince: null,
      holder: null,
      holding: null,
      heldAt: null,
      tabs: null,
      lastPages: new Map(),
      lastUsedAt: this.#now(),
    };
    this.#lanes.set(key, lane);
    return lane;
  }

  #laneSessions(lane: Lane): string[] {
    return [...this.#sessions].filter(([, state]) => state.lane === lane).map(([id]) => id);
  }

  /** The group of a new session: the one of the agent's project, or the shared one. */
  #laneFor(agentKey: string | null): Lane {
    const agentId = agentKey === null ? undefined : this.#agents.get(agentKey);
    const project =
      agentId !== undefined && (this.#options.projectGroups?.() ?? true)
        ? (this.#options.projectOf?.(agentId) ?? null)
        : null;
    if (!project) return this.#lane(SHARED_LANE, SHARED_LANE_TITLE);
    const key = `project:${project.key}`;
    const existing = this.#lanes.get(key);
    if (existing) return existing;
    const projects = [...this.#lanes.values()].filter((lane) => lane.key !== SHARED_LANE);
    if (projects.length >= (this.#limits.projects ?? 3)) {
      // Each group is a process and a connection: the one that waits longest with no agent gives its place.
      const idle = projects
        .filter((lane) => this.#laneSessions(lane).length === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!idle) return this.#lane(SHARED_LANE, SHARED_LANE_TITLE);
      void this.#retire(idle);
    }
    return this.#lane(key, groupTitle(project.title));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const secret = this.#secret;
    if (secret === null) return reply(response, 503, jsonRpcError(null, -32000, "The browser broker is not ready."));
    // A browser page that points a name at this address must not reach the person's browser.
    const host = singleHeader(request.headers.host) ?? "";
    if (host !== `127.0.0.1:${this.#port}` && host !== `localhost:${this.#port}`)
      return reply(response, 403, jsonRpcError(null, -32000, "Wrong host."));
    if (!bearerMatches(singleHeader(request.headers.authorization), secret))
      return reply(response, 401, jsonRpcError(null, -32001, "Unauthorized."));
    const address = new URL(request.url ?? "/", "http://127.0.0.1");
    if (address.pathname !== "/mcp") return reply(response, 404, jsonRpcError(null, -32000, "Not found."));
    const method = request.method ?? "";
    if (method !== "POST" && method !== "GET" && method !== "DELETE")
      return reply(response, 405, jsonRpcError(null, -32000, "Method not allowed."));

    const session = singleHeader(request.headers["mcp-session-id"]);
    // A session id this broker did not issue, or one that ended, reads as missing: the client starts a new one.
    if (session !== undefined && !this.#ledger.has(session))
      return reply(response, 404, jsonRpcError(null, -32001, "Session not found."));
    if (session !== undefined) this.#ledger.touch(session, this.#now());

    const agent = address.searchParams.get("agent");
    const agentKey = agent !== null && AGENT_KEY.test(agent) ? agent : null;
    if (method === "POST") return this.#handlePost(request, response, session, agentKey);
    // The agent's next turn goes back to the page that this one ends on.
    const ending = method === "DELETE" && session !== undefined ? this.#sessions.get(session) : undefined;
    if (session !== undefined && ending?.pageStale && ending.agent !== null) await this.#readPage(session, ending);
    if (session === undefined) return reply(response, 400, jsonRpcError(null, -32000, "A session id is required."));
    return this.#forward(request, response, this.#sessionLane(session), session, undefined, []);
  }

  #sessionLane(session: string): Lane {
    return this.#sessions.get(session)?.lane ?? this.#lane(SHARED_LANE, SHARED_LANE_TITLE);
  }

  #busyMessage(): string {
    return `Too many agents use the browser at once (${this.#limits.sessions} is the limit). Try again in a minute, or go on without the browser.`;
  }

  async #handlePost(
    request: IncomingMessage,
    response: ServerResponse,
    session: string | undefined,
    agentKey: string | null,
  ): Promise<void> {
    const raw = await readBody(request);
    if (raw === "too-large") return reply(response, 413, jsonRpcError(null, -32000, "Request too large."));
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(response, 400, jsonRpcError(null, -32700, "Parse error."));
    }
    if (Array.isArray(body) && body.length > 1)
      return reply(response, 400, jsonRpcError(null, -32600, "Batches are not supported."));
    const entries = inspectRpc(body);
    const initialize = entries.find((entry) => entry.kind === "initialize");

    if (initialize && session === undefined && !this.#ledger.canAdmit())
      return reply(response, 200, jsonRpcError(initialize.id, -32000, this.#busyMessage()));
    if (initialize && session === undefined && this.#options.memoryLevel?.() === "critical")
      return reply(response, 200, jsonRpcError(initialize.id, -32000, LOW_MEMORY_MESSAGE));
    if (!initialize && session === undefined)
      return reply(response, 400, jsonRpcError(null, -32000, "A session id is required."));

    const lane = session === undefined ? this.#laneFor(agentKey) : this.#sessionLane(session);
    lane.lastUsedAt = this.#now();
    const message = Array.isArray(body) ? body[0] : body;
    const toolCall = isDynamicRecord(message) && message.method === "tools/call";
    const toolName =
      toolCall && isDynamicRecord(message.params) && typeof message.params.name === "string"
        ? message.params.name
        : null;
    const state = session === undefined ? undefined : this.#sessions.get(session);

    // A refused tool never reaches the server, whatever the Guard would say, and changes no tab.
    if (toolCall && toolName !== null && REFUSED_BROWSER_TOOLS.has(toolName)) {
      logger.info("The broker refused a browser call.", { tool: toolName });
      return reply(
        response,
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: { isError: true, content: [{ type: "text", text: REFUSED_BROWSER_TOOL_MESSAGE }] },
        }),
      );
    }
    // A tool call sends what the agent chose out of the computer, as the person: the Guard checks it first,
    // before the broker reads or changes any tab for it.
    let forwarded = raw;
    if (toolCall && isDynamicRecord(message.params) && toolName !== null) {
      const decision = await this.#guardCall(toolName, message.params.arguments);
      if (!decision.proceed) {
        logger.info("The Guard held back a browser call.", { tool: toolName });
        return reply(
          response,
          200,
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id ?? null,
            result: { isError: true, content: [{ type: "text", text: decision.text }] },
          }),
        );
      }
      // An upload opens the real paths that the Guard checked, not a link that changed since.
      if (decision.paths && isDynamicRecord(message.params.arguments)) {
        const args = { ...message.params.arguments, paths: decision.paths };
        const changed = { ...message, params: { ...message.params, arguments: args } };
        forwarded = Buffer.from(JSON.stringify(Array.isArray(body) ? [changed] : changed));
      }
    }
    if (session !== undefined && state && toolName !== null) {
      // The group first, so that the broker's own session makes the connection and names the group.
      await this.#holdGroup(lane);
      state.placing ??= this.#place(session, state, toolName);
      await state.placing;
      state.lastCallAt = this.#now();
    }

    if (session !== undefined) {
      const newTab = entries.find((entry) => entry.kind === "tab-new");
      if (newTab && (this.#options.memoryLevel?.() ?? "ok") !== "ok")
        return reply(
          response,
          200,
          JSON.stringify({
            jsonrpc: "2.0",
            id: newTab.id,
            result: { isError: true, content: [{ type: "text", text: LOW_MEMORY_TAB_MESSAGE }] },
          }),
        );
      if (newTab) {
        // The tabs that ended turns left in the groups count too, so the broker reads them first.
        const open = state ? await this.#refreshTabs(session, state) : undefined;
        const decision = this.#ledger.checkNewTab(session, open);
        if (!decision.allowed)
          return reply(
            response,
            200,
            JSON.stringify({ jsonrpc: "2.0", id: newTab.id, result: refusalResult(decision) }),
          );
      }
      const close = entries.find((entry) => entry.kind === "tab-close");
      if (close && toolName === "browser_tabs" && state) {
        const kept = await this.#keepLastTab(session, state, close.id);
        if (kept !== null) return reply(response, 200, kept);
      }
    }
    const listing = isDynamicRecord(message) && message.method === "tools/list";
    const rewrite = initialize ? withInstructions : listing ? withToolNotes : null;
    // A tool result can hold a page: the Guard reads it on its way to the agent.
    await this.#forward(request, response, lane, session, forwarded, entries, toolCall ? this.#guardCheck() : null, {
      agentKey,
      toolName,
      rewrite,
    });
  }

  /** The Guard's decision on one call, made safe: a check that fails lets the call run, and the broker logs it. */
  async #guardCall(name: string, args: unknown): Promise<BrokerCallDecision> {
    const check = this.#options.guardCall?.() ?? null;
    if (!check) return { proceed: true };
    try {
      return await guardBrokerCall(name, args, check);
    } catch (error) {
      logger.warn("The Guard did not check a browser call.", { tool: name, cause: toLogValue(error) });
      return { proceed: true };
    }
  }

  /** The Guard's check for one response, made safe: a check that fails lets the result pass as it is. */
  #guardCheck(): GuardResultCheck | null {
    const check = this.#options.guardResult?.() ?? null;
    if (!check) return null;
    return async (text) => {
      try {
        return await check(text);
      } catch (error) {
        logger.warn("The Guard did not check a browser result.", { cause: toLogValue(error) });
        return null;
      }
    };
  }

  async #forward(
    request: IncomingMessage,
    response: ServerResponse,
    lane: Lane,
    session: string | undefined,
    body: Buffer | undefined,
    entries: readonly RpcEntry[],
    guard: GuardResultCheck | null = null,
    call: {
      agentKey: string | null;
      toolName: string | null;
      rewrite: AnswerChange | null;
    } = { agentKey: null, toolName: null, rewrite: null },
  ): Promise<void> {
    let upstream: UpstreamProcess;
    try {
      upstream = await this.#ensureUpstream(lane);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The browser did not start.";
      const id = entries[0]?.id ?? null;
      return reply(response, 200, jsonRpcError(id, -32000, message));
    }
    lane.emptySince = null;
    const target = new URL(upstream.url);
    const headers: Record<string, string> = {
      host: upstream.hostHeader ?? target.host,
      [BROKER_TOKEN_HEADER]: lane.token ?? "",
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = singleHeader(request.headers[name]);
      if (value !== undefined) headers[name] = value;
    }
    if (body) headers["content-length"] = String(body.length);
    await new Promise<void>((resolve) => {
      const outgoing = httpRequest(
        { host: target.hostname, port: target.port, path: "/mcp", method: request.method, headers },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          const responseHeaders: Record<string, string> = {};
          for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = singleHeader(incoming.headers[name]);
            if (value !== undefined) responseHeaders[name] = value;
          }
          response.writeHead(status, responseHeaders);
          const tee: Buffer[] = [];
          let teeSize = 0;
          // A short answer that the broker changes (the server's instructions, the tool list) is held whole.
          const held: Buffer[] | null = call.rewrite ? [] : null;
          // With the Guard, each tool result passes through its reader, in order; other events at once.
          const reader = guard
            ? new McpResultGuard(singleHeader(incoming.headers["content-type"]) ?? null, guard, {
                uncoveredNotice: guardStrongNotice(GUARD_UNREAD_REASON),
                onUncovered: (noted) =>
                  logger.warn("The Guard could not read a long browser result in full.", { noted }),
              })
            : null;
          let written = Promise.resolve();
          incoming.on("data", (chunk: Buffer) => {
            if (teeSize < MAX_TEE_BYTES) {
              tee.push(chunk);
              teeSize += chunk.length;
            }
            if (held) {
              held.push(chunk);
              return;
            }
            if (!reader) {
              response.write(chunk);
              return;
            }
            written = written.then(async () => {
              const text = await reader.push(chunk);
              if (text) response.write(text);
            });
          });
          incoming.on("end", () => {
            const finish = () => {
              if (held && call.rewrite)
                response.write(rewriteMessages(Buffer.concat(held).toString("utf8"), call.rewrite));
              response.end();
              this.#afterResponse(request.method ?? "", lane, session, status, incoming.headers, entries, {
                text: Buffer.concat(tee).toString("utf8"),
                agentKey: call.agentKey,
                toolName: call.toolName,
              });
              resolve();
            };
            if (!reader) return finish();
            written = written
              .then(async () => {
                const text = await reader.end();
                if (text) response.write(text);
              })
              .catch((error: unknown) => {
                logger.warn("The Guard reader of a browser result failed.", { cause: toLogValue(error) });
              })
              .then(finish);
          });
          incoming.on("error", () => {
            response.destroy();
            resolve();
          });
        },
      );
      outgoing.on("error", () => {
        if (!response.headersSent)
          reply(response, 502, jsonRpcError(entries[0]?.id ?? null, -32000, "The browser server did not answer."));
        else response.destroy();
        resolve();
      });
      request.on("close", () => {
        if (!response.writableEnded) outgoing.destroy();
      });
      if (body) outgoing.write(body);
      outgoing.end();
    });
  }

  #afterResponse(
    method: string,
    lane: Lane,
    session: string | undefined,
    status: number,
    headers: IncomingHttpHeaders,
    entries: readonly RpcEntry[],
    call: { text: string; agentKey: string | null; toolName: string | null },
  ): void {
    const issued = singleHeader(headers["mcp-session-id"]);
    if (method === "POST" && entries.some((entry) => entry.kind === "initialize") && issued) {
      this.#ledger.register(issued, this.#now());
      this.#sessions.set(issued, {
        lane,
        agent: call.agentKey,
        placing: null,
        pageUrl: null,
        pageStale: false,
        lastCallAt: null,
      });
      return;
    }
    if (session === undefined) return;
    // A session the agent ended, or one the upstream lost (it ended it, or started again): the agent starts a new one.
    if (method === "DELETE" || status === 404) {
      this.#endSession(session);
      return;
    }
    if (method !== "POST") return;
    this.#ledger.applyDelta(session, tabsDelta(entries, call.text));
    // The result of an agent's call holds text that the page writes, so it is not read for the tabs: the
    // broker reads the page again with a list of its own when it needs it.
    const state = this.#sessions.get(session);
    if (state && call.toolName !== null) state.pageStale = true;
  }

  /** Reads the current page of a session with a `browser_tabs` list of the broker's own. */
  async #readPage(session: string, state: SessionState): Promise<void> {
    const tabs = listedTabs(await this.#tool(state.lane, session, "browser_tabs", { action: "list" }));
    if (!tabs) return;
    state.lane.tabs = tabs.length;
    state.pageStale = false;
    const current = tabs.find((tab) => tab.current)?.url ?? null;
    state.pageUrl = current;
    if (current !== null && state.agent !== null) state.lane.lastPages.set(state.agent, current);
  }

  #endSession(id: string): void {
    this.#ledger.endSession(id);
    this.#sessions.delete(id);
  }

  /** A JSON-RPC request that the broker itself sends to the upstream of a group. */
  async #internal(lane: Lane, session: string | null, message: OwnRpcMessage): Promise<InternalReply> {
    const upstream = lane.upstream;
    if (!upstream) return { status: 0, session: null, text: "" };
    const target = new URL(upstream.url);
    const body = Buffer.from(JSON.stringify(message));
    return new Promise<InternalReply>((resolve) => {
      const outgoing = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: upstream.hostHeader ?? target.host,
            [BROKER_TOKEN_HEADER]: lane.token ?? "",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "content-length": String(body.length),
            ...(session === null ? {} : { "mcp-session-id": session }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on("data", (chunk: Buffer) => {
            if (size < MAX_INTERNAL_RESPONSE_BYTES) chunks.push(chunk);
            size += chunk.length;
          });
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              session: singleHeader(incoming.headers["mcp-session-id"]) ?? null,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          incoming.on("error", () => resolve({ status: 0, session: null, text: "" }));
        },
      );
      outgoing.on("error", () => resolve({ status: 0, session: null, text: "" }));
      outgoing.end(body);
    });
  }

  /** A tool call that the broker makes in a session. Null when it failed or did not reach the server. */
  async #tool(lane: Lane, session: string, name: string, args: OwnToolArguments): Promise<string | null> {
    this.#internalId += 1;
    const answer = await this.#internal(lane, session, {
      jsonrpc: "2.0",
      id: `builders-bot-${this.#internalId}`,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (answer.status === 404 && session === lane.holder) lane.holder = null;
    if (answer.status !== 200 || resultFailed(answer.text)) return null;
    return resultText(answer.text);
  }

  /**
   * Makes sure that the broker's own session holds the group's connection. It is made at the first
   * tool call of the group, before the agent's own, so that the extension names the group after the
   * project. It is checked again at most every 30 s: when the person closes the group, the next call
   * makes a new connection, and this session must hold that one too.
   */
  async #holdGroup(lane: Lane): Promise<void> {
    if (lane.heldAt !== null && this.#now() - lane.heldAt < GROUP_CHECK_MS) return;
    lane.holding ??= this.#takeHold(lane).finally(() => {
      lane.holding = null;
    });
    await lane.holding;
  }

  async #takeHold(lane: Lane): Promise<void> {
    try {
      await this.#ensureUpstream(lane);
    } catch {
      return; // The agent's own call reports why.
    }
    if (lane.holder === null) {
      const opened = await this.#internal(lane, null, {
        jsonrpc: "2.0",
        id: "builders-bot-group",
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: lane.title, version: "1" } },
      });
      if (opened.status !== 200 || opened.session === null || resultFailed(opened.text)) return;
      lane.holder = opened.session;
      await this.#internal(lane, lane.holder, { jsonrpc: "2.0", method: "notifications/initialized" });
    }
    const listed = await this.#tool(lane, lane.holder, "browser_tabs", { action: "list" });
    // The extension did not connect, for example: the agent's call tries again and says why.
    if (listed === null) return;
    lane.heldAt = this.#now();
    lane.tabs = listedTabCount(listed) ?? lane.tabs;
  }

  /**
   * Chooses the tab of a new session, at its first tool call. A new session of the server starts on the
   * first tab of the group, which may be the tab of another agent. The agent goes back to the tab it
   * used last; else to a tab that no other agent works in now; else it gets a new tab, within the limits.
   * A session that starts with `browser_tabs` chooses its tab itself.
   */
  async #place(session: string, state: SessionState, toolName: string): Promise<void> {
    if (toolName === "browser_tabs") return;
    const lane = state.lane;
    const now = this.#now();
    const taken = new Set<string>();
    for (const [id, other] of this.#sessions) {
      if (id === session || other.lane !== lane || other.lastCallAt === null || now - other.lastCallAt >= BUSY_MS)
        continue;
      if (other.pageStale) await this.#readPage(id, other);
      if (other.pageUrl !== null) taken.add(other.pageUrl);
    }
    const tabs = listedTabs(await this.#tool(lane, session, "browser_tabs", { action: "list" }));
    if (!tabs) return;
    lane.tabs = tabs.length;
    // A tab whose line cannot be read in one way only is not chosen: it may be the tab of another agent.
    const free = tabs.filter((tab) => tab.url !== null && !taken.has(tab.url));
    const last = state.agent === null ? undefined : lane.lastPages.get(state.agent);
    const choice: ListedTab | undefined = free.find((tab) => tab.url === last) ?? free[0];
    if (choice) {
      if (!choice.current) await this.#tool(lane, session, "browser_tabs", { action: "select", index: choice.index });
      state.pageUrl = choice.url;
      return;
    }
    // Every tab is in use by another agent: a tab of its own, if the limits and the memory allow one.
    if ((this.#options.memoryLevel?.() ?? "ok") !== "ok") return;
    if (!this.#ledger.checkNewTab(session, this.#openTabs()).allowed) return;
    const opened = await this.#tool(lane, session, "browser_tabs", { action: "new" });
    if (opened === null) return;
    this.#ledger.applyDelta(session, 1);
    lane.tabs = listedTabCount(opened) ?? (lane.tabs ?? 0) + 1;
    state.pageUrl = "about:blank";
  }

  /** Reads the tabs of the session's group again, and gives the number of tabs open in all groups. */
  async #refreshTabs(session: string, state: SessionState): Promise<number> {
    const listed = await this.#tool(state.lane, session, "browser_tabs", { action: "list" });
    const count = listedTabCount(listed);
    if (count !== null) state.lane.tabs = count;
    return this.#openTabs();
  }

  /**
   * The answer to a close of the last tab of a group, or null when it is not the last. The extension
   * ends its connection with the last tab, and the next call then opens a new connect page: a new tab
   * and a new group. So the tab stays, with nothing in it.
   */
  async #keepLastTab(session: string, state: SessionState, id: number | string | null): Promise<string | null> {
    const listed = await this.#tool(state.lane, session, "browser_tabs", { action: "list" });
    const tabs = listedTabs(listed);
    if (!tabs || tabs.length > 1) return null;
    if (tabs.length === 1) await this.#tool(state.lane, session, "browser_navigate", { url: "about:blank" });
    state.pageUrl = "about:blank";
    if (state.agent !== null) state.lane.lastPages.set(state.agent, "about:blank");
    return JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: LAST_TAB_MESSAGE }] } });
  }

  async #ensureUpstream(lane: Lane): Promise<UpstreamProcess> {
    if (lane.upstream) return lane.upstream;
    if (!lane.starting) {
      const spec = this.#options.upstream();
      if (!spec) throw new Error("No Playwright server is set up in Builders Bot.");
      const token = randomBytes(32).toString("base64url");
      const env: NodeJS.ProcessEnv = {
        ...spec.env,
        [BROKER_TOKEN_ENV]: token,
        NODE_OPTIONS: guardNodeOptions(this.#options.guardPath, spec.env.NODE_OPTIONS),
      };
      lane.starting = this.#launch({ ...spec, env }).then(
        (process) => {
          lane.upstream = process;
          lane.token = token;
          lane.starting = null;
          process.onExit(() => {
            if (lane.upstream !== process) return;
            // Its sessions went with it. The agents read a missing session and start again.
            this.#forgetUpstream(lane);
          });
          return process;
        },
        (error: unknown) => {
          lane.starting = null;
          throw error;
        },
      );
    }
    return lane.starting;
  }

  /** What the broker knew of a group's upstream, forgotten when it ends. */
  #forgetUpstream(lane: Lane): void {
    lane.upstream = null;
    lane.token = null;
    lane.holder = null;
    lane.heldAt = null;
    lane.tabs = null;
    lane.lastPages.clear();
    for (const id of this.#laneSessions(lane)) this.#endSession(id);
  }

  /**
   * Stops every upstream and ends its sessions, so the next request starts one with the options of now.
   * The egress proxy calls it when its switch changes. The agents read a missing session and start again.
   */
  async resetUpstream(): Promise<void> {
    await this.#stopAll();
  }

  async #stopAll(): Promise<void> {
    const lanes = [...this.#lanes.values()];
    this.#lanes.clear();
    this.#ledger.endAll();
    this.#sessions.clear();
    await Promise.all(lanes.map((lane) => this.#stopLane(lane)));
  }

  async #stopLane(lane: Lane): Promise<void> {
    const upstream = lane.upstream;
    this.#forgetUpstream(lane);
    if (upstream) await upstream.stop();
  }

  /**
   * Puts a group away: closes the blank tabs that agents left in it, then stops its upstream. Its
   * other tabs stay open, out of the group: the person may read what an agent left.
   */
  async #retire(lane: Lane): Promise<void> {
    if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    lane.emptySince = null;
    await this.#closeBlankTabs(lane);
    await this.#stopLane(lane);
  }

  async #closeBlankTabs(lane: Lane): Promise<void> {
    // Only a group that the broker's session holds: a list in another session could open a new connection.
    if (!lane.upstream || lane.holder === null || lane.heldAt === null) return;
    const listed = await this.#tool(lane, lane.holder, "browser_tabs", { action: "list" });
    const tabs = listedTabs(listed);
    if (!tabs) return;
    const blank = tabs.filter(isBlankTab).sort((a, b) => b.index - a.index);
    for (const tab of blank) await this.#tool(lane, lane.holder, "browser_tabs", { action: "close", index: tab.index });
  }

  /**
   * Ends the sessions that no agent has used for a while, and puts away a group that has had no
   * session for a while. A timer calls it; it is public so a test can run it at a chosen time.
   */
  async releaseIdle(): Promise<void> {
    const now = this.#now();
    // An agent that is on keeps its session while it is quiet, and a client is not sure to start a new one when
    // it reads 404. So a session ends only after hours with no request, for the one a closed agent leaves behind.
    const idleSessionMs = this.#options.idleSessionMs ?? 3 * 60 * 60_000;
    for (const id of this.#ledger.idleSessions(now, idleSessionMs)) {
      const lane = this.#sessions.get(id)?.lane ?? null;
      this.#endSession(id);
      if (lane) await this.#endUpstreamSession(lane, id);
    }
    for (const lane of [...this.#lanes.values()]) {
      if (!lane.upstream) {
        // A group with no process and no agent holds nothing: its place goes back.
        if (!lane.starting && this.#laneSessions(lane).length === 0) this.#lanes.delete(lane.key);
        continue;
      }
      if (this.#laneSessions(lane).length > 0) {
        lane.emptySince = null;
        continue;
      }
      lane.emptySince ??= now;
      if (now - lane.emptySince >= (this.#options.idleUpstreamMs ?? 10 * 60_000)) await this.#retire(lane);
    }
  }

  /** Tells the upstream that a session is over, so it lets go of what the session held. */
  #endUpstreamSession(lane: Lane, id: string): Promise<void> {
    const upstream = lane.upstream;
    if (!upstream) return Promise.resolve();
    const target = new URL(upstream.url);
    return new Promise<void>((resolve) => {
      const outgoing = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: "/mcp",
          method: "DELETE",
          headers: {
            host: upstream.hostHeader ?? target.host,
            "mcp-session-id": id,
            [BROKER_TOKEN_HEADER]: lane.token ?? "",
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.on("end", () => resolve());
        },
      );
      outgoing.on("error", () => resolve());
      outgoing.end();
    });
  }
}

function reply(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return "too-large";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Starts the Playwright MCP server as a child process and waits for the address it prints. */
export const launchPlaywrightMcp: UpstreamLauncher = (spec) =>
  new Promise<UpstreamProcess>((resolve, reject) => {
    // The server prints the connect URL, with the token of the extension, when the extension does not
    // answer. A message that reaches an agent must not carry it.
    const secrets = [spec.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, spec.env[BROKER_TOKEN_ENV]].filter(
      (value): value is string => typeof value === "string",
    );
    const child: ChildProcess = spawn(spec.command, spec.args, { env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const exitListeners: (() => void)[] = [];
    const timeout = setTimeout(() => {
      fail(new Error("The Playwright server did not start in time."));
      child.kill("SIGKILL");
    }, UPSTREAM_START_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(maskSecrets(error.message, secrets)));
    };
    const onData = (data: Buffer) => {
      if (settled) return;
      output = (output + data.toString("utf8")).slice(-4_000);
      const match = /Listening on (https?:\/\/[^\s]+)/u.exec(output);
      if (!match?.[1]) return;
      settled = true;
      clearTimeout(timeout);
      const printed = new URL(match[1]);
      // `localhost` can resolve to ::1, which a server bound to 127.0.0.1 does not answer.
      const url = new URL(printed.origin);
      url.hostname = "127.0.0.1";
      resolve({
        url: url.origin,
        hostHeader: printed.host,
        onExit: (listener) => void exitListeners.push(listener),
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            child.once("exit", () => done());
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
          }),
      });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => fail(new Error(`The Playwright server could not start: ${error.message}`)));
    child.on("exit", () => {
      fail(
        new Error(
          `The Playwright server stopped before it was ready. ${output.trim().split("\n").at(-1) ?? ""}`.trim(),
        ),
      );
      for (const listener of exitListeners) listener();
    });
  });
