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
function responseMessages(text: string): unknown[] {
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

export interface BrowserLimits {
  /** Tabs one agent session may hold open. */
  tabsPerSession: number;
  /** Tabs all agent sessions may hold open together. */
  tabsTotal: number;
  /** Agent sessions that may use the browser at once. */
  sessions: number;
}

/**
 * The sessions are many on purpose: each live agent keeps one open for as long as it runs, also while it
 * does nothing, so the number of sessions is the number of agents that are on, not of agents that browse.
 * What uses the memory is the tabs, and those are held to a few.
 */
export const DEFAULT_BROWSER_LIMITS: BrowserLimits = { tabsPerSession: 4, tabsTotal: 12, sessions: 64 };

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

  checkNewTab(id: string): TabDecision {
    if (this.tabsOf(id) >= this.#limits.tabsPerSession)
      return { allowed: false, reason: "session", limit: this.#limits.tabsPerSession };
    if (this.totalTabs() >= this.#limits.tabsTotal)
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
