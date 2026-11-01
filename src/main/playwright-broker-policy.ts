/**
 * What the Playwright broker decides: how many agent sessions, and how many tabs they may open
 * between them. It reads MCP JSON-RPC messages and holds counts. It starts no process and opens no
 * socket, so each rule can be tested alone.
 *
 * The counts are of tabs that agents opened through the broker, not of the tabs of the person's own
 * browser. A tab counts when a `browser_tabs` call with `action: "new"` succeeded, and stops
 * counting when a close succeeded or the session ends. Tabs that a page opens by itself are not
 * counted: they are bounded by the session end, not by a rule here.
 */

import { isDynamicRecord } from "@openbot/contracts/runtime-values";

export type RpcKind = "initialize" | "tab-new" | "tab-close";

export interface RpcEntry {
  id: number | string | null;
  kind: RpcKind;
}

function inspectOne(message: unknown): RpcEntry[] {
  if (!isDynamicRecord(message)) return [];
  const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
  if (message.method === "initialize") return [{ id, kind: "initialize" }];
  if (message.method !== "tools/call" || !isDynamicRecord(message.params)) return [];
  const { name } = message.params;
  const args = isDynamicRecord(message.params.arguments) ? message.params.arguments : {};
  if (name === "browser_close") return [{ id, kind: "tab-close" }];
  if (name !== "browser_tabs") return [];
  if (args.action === "new") return [{ id, kind: "tab-new" }];
  if (args.action === "close") return [{ id, kind: "tab-close" }];
  return [];
}

/** The messages of one request body that the broker cares about. A batch is read message by message. */
export function inspectRpc(body: unknown): RpcEntry[] {
  return Array.isArray(body) ? body.flatMap(inspectOne) : inspectOne(body);
}

/** The JSON bodies of a response, whether it is an event stream or plain JSON. */
export function responseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  const push = (raw: string) => {
    try {
      messages.push(...[JSON.parse(raw)].flat());
    } catch {
      // Not JSON: not a response to read.
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    push(trimmed);
    return messages;
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) push(line.slice(5).trim());
  }
  return messages;
}

/**
 * The change in open tabs that a response proves, for the entries of its request: plus one for each
 * successful new tab, minus one for each successful close. A failed call, or a response that does
 * not name the request, changes nothing.
 */
export function tabsDelta(entries: readonly RpcEntry[], responseText: string) {
  let delta = 0;
  for (const message of responseMessages(responseText)) {
    if (!isDynamicRecord(message) || !isDynamicRecord(message.result) || message.result.isError === true) continue;
    const entry = entries.find((candidate) => candidate.id !== null && candidate.id === message.id);
    if (entry?.kind === "tab-new") delta += 1;
    else if (entry?.kind === "tab-close") delta -= 1;
  }
  return delta;
}

/**
 * The text parts of the tool results in a response, joined, or null when the response is not a whole
 * JSON-RPC answer. A response that is cut off is never read: the broker reads nothing it cannot frame.
 */
export function resultText(responseText: string): string | null {
  const parts: string[] = [];
  for (const message of responseMessages(responseText)) {
    if (!isDynamicRecord(message) || !isDynamicRecord(message.result)) continue;
    const content = Array.isArray(message.result.content) ? message.result.content : [];
    for (const item of content) if (isDynamicRecord(item) && typeof item.text === "string") parts.push(item.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Whether the tool result of a response says that the call failed. */
export function resultFailed(responseText: string): boolean {
  return responseMessages(responseText).some(
    (message) =>
      isDynamicRecord(message) &&
      (message.error !== undefined || (isDynamicRecord(message.result) && message.result.isError === true)),
  );
}

/** One tab as the Playwright server lists it: `- 0: (current) [Title](url)`. */
export interface ListedTab {
  index: number;
  /**
   * The URL, or null when the line cannot be read in one way only. The page writes the title and can
   * put `](` in its URL, so a line with two of them is not trusted.
   */
  url: string | null;
  current: boolean;
}

const TAB_LINE = /^- (\d+):( \(current\))? \[(.*)\]\((.*)\)( \[crashed\])?$/u;

function listedTab(line: string): ListedTab | null {
  const match = TAB_LINE.exec(line);
  if (!match) return null;
  const ambiguous = line.split("](").length !== 2;
  return { index: Number(match[1]), url: ambiguous ? null : (match[4] ?? null), current: match[2] !== undefined };
}

/**
 * The tabs of a `browser_tabs` result, or null when the text is not one. Only the broker's own
 * `browser_tabs` calls are read: their text starts with the `Result` section, and each of its lines is
 * a tab line, with the indexes 0, 1, 2 in order. A page cannot add a line, because a title and a URL
 * hold no line break. A result of an agent's call is never read, because a page can write its text.
 */
export function listedTabs(text: string | null): ListedTab[] | null {
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines[0] !== "### Result") return null;
  const rest = lines.slice(1);
  const end = rest.findIndex((line) => line.startsWith("### "));
  const body = (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.length > 0);
  if (body.length === 1 && body[0]?.startsWith("No open tabs")) return [];
  const tabs: ListedTab[] = [];
  for (const [position, line] of body.entries()) {
    const tab = listedTab(line);
    if (!tab || tab.index !== position) return null;
    tabs.push(tab);
  }
  return tabs.length > 0 ? tabs : null;
}

/** The number of tabs of a `browser_tabs` result, or null when the text is not one. */
export function listedTabCount(text: string | null): number | null {
  return listedTabs(text)?.length ?? null;
}

const CONNECT_PAGE = /^chrome-extension:\/\/[a-p]{32}\/connect\.html(\?[^\s()[\]]*)?$/u;

/** A page that an agent leaves as nothing: `about:blank`, or the connect page of the extension. */
export function isBlankTab(tab: ListedTab): boolean {
  return tab.url !== null && (tab.url === "about:blank" || CONNECT_PAGE.test(tab.url));
}

export interface BrowserLimits {
  /** Tabs one agent session may hold open. */
  tabsPerSession: number;
  /** Tabs all agent sessions may hold open together. */
  tabsTotal: number;
  /** Agent sessions that may use the browser at once. */
  sessions: number;
  /**
   * Projects that may have a tab group of their own at once. Each one is a Playwright process and a
   * connection to the extension. Absent: 3. A project past the limit uses the shared group.
   */
  projects?: number;
}

/**
 * The sessions are many on purpose: each live agent keeps one open for as long as it runs, also while it
 * does nothing, so the number of sessions is the number of agents that are on, not of agents that browse.
 * What uses the memory is the tabs, and those are held to a few.
 */
export const DEFAULT_BROWSER_LIMITS: BrowserLimits = { tabsPerSession: 4, tabsTotal: 12, sessions: 64, projects: 3 };

export type TabDecision = { allowed: true } | { allowed: false; reason: "session" | "total"; limit: number };

interface SessionState {
  tabs: number;
  lastSeenAt: number;
}

export class BrowserLedger {
  readonly #limits: BrowserLimits;
  readonly #sessions = new Map<string, SessionState>();

  constructor(limits: BrowserLimits) {
    this.#limits = limits;
  }

  /** Whether the session is known: the upstream issued its id through this broker and it has not ended. */
  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  /** Whether one more session fits under the limit. */
  canAdmit(): boolean {
    return this.#sessions.size < this.#limits.sessions;
  }

  /**
   * Records a session that the upstream has already created. It is recorded even at the limit: the
   * check came before the upstream was asked, and two that ask together may both pass it.
   */
  register(id: string, now = Date.now()): void {
    if (!this.#sessions.has(id)) this.#sessions.set(id, { tabs: 0, lastSeenAt: now });
  }

  /** Forgets every session, as when the upstream ends and takes them with it. */
  endAll(): void {
    this.#sessions.clear();
  }

  /** Whether this session may use the browser. A session that is known already always may. */
  admitSession(id: string, now = Date.now()): boolean {
    if (this.#sessions.has(id)) return true;
    if (this.#sessions.size >= this.#limits.sessions) return false;
    this.#sessions.set(id, { tabs: 0, lastSeenAt: now });
    return true;
  }

  touch(id: string, now = Date.now()): void {
    const session = this.#sessions.get(id);
    if (session) session.lastSeenAt = now;
  }

  sessionCount(): number {
    return this.#sessions.size;
  }

  tabsOf(id: string): number {
    return this.#sessions.get(id)?.tabs ?? 0;
  }

  totalTabs(): number {
    let total = 0;
    for (const session of this.#sessions.values()) total += session.tabs;
    return total;
  }

  /**
   * `openTabs` is the number of tabs open in the browser groups now, when the broker has read it. Tabs
   * that an ended session left open stay in the group for the next turn, so they count too.
   */
  checkNewTab(id: string, openTabs?: number): TabDecision {
    if (this.tabsOf(id) >= this.#limits.tabsPerSession)
      return { allowed: false, reason: "session", limit: this.#limits.tabsPerSession };
    if (Math.max(openTabs ?? 0, this.totalTabs()) >= this.#limits.tabsTotal)
      return { allowed: false, reason: "total", limit: this.#limits.tabsTotal };
    return { allowed: true };
  }

  /** A session that is not known changes nothing, and the count never goes below zero. */
  applyDelta(id: string, delta: number): void {
    const session = this.#sessions.get(id);
    if (session) session.tabs = Math.max(0, session.tabs + delta);
  }

  /** Forgets a session and gives back the number of tabs it still held. */
  endSession(id: string): number {
    const tabs = this.#sessions.get(id)?.tabs ?? 0;
    this.#sessions.delete(id);
    return tabs;
  }

  /** The sessions with no request for `idleMs`. */
  idleSessions(now: number, idleMs: number): string[] {
    return [...this.#sessions].filter(([, state]) => now - state.lastSeenAt >= idleMs).map(([id]) => id);
  }
}

/**
 * Tools of the Playwright server that the broker never forwards. `browser_run_code_unsafe` runs any
 * Playwright code with the reach of the whole browser context (the server calls it "RCE-equivalent"):
 * every tab of the project's group, the cookies of the person's sites, and new pages. The broker answers
 * it with a refusal and leaves it out of `tools/list`.
 */
export const REFUSED_BROWSER_TOOLS: ReadonlySet<string> = new Set(["browser_run_code_unsafe"]);

export const REFUSED_BROWSER_TOOL_MESSAGE =
  "This tool is off in Builders Bot: it runs code with the reach of the whole browser. Use browser_evaluate on the current page, or the other browser tools.";

/** A tool result that says a call was refused. */
export interface ToolRefusal {
  isError: true;
  content: { type: "text"; text: string }[];
}

/** The failed tool result an agent reads in place of a new tab, with the way out. */
export function refusalResult(decision: Extract<TabDecision, { allowed: false }>): ToolRefusal {
  const where =
    decision.reason === "session"
      ? `This agent already has ${decision.limit} tabs open.`
      : `The agents together already have ${decision.limit} tabs open.`;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${where} Close a tab you opened with browser_tabs action=close, or reuse an open tab, then open the new one.`,
      },
    ],
  };
}
