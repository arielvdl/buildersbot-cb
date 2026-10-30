// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BrowserLedger,
  DEFAULT_BROWSER_LIMITS,
  inspectRpc,
  refusalResult,
  tabsDelta,
} from "./playwright-broker-policy";

interface ToolArguments {
  action?: string;
  url?: string;
}

const call = (id: number, name: string, args: ToolArguments = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("reading a request", () => {
  it("names the tab action of a browser_tabs call", () => {
    expect(inspectRpc(call(1, "browser_tabs", { action: "new" }))).toEqual([{ id: 1, kind: "tab-new" }]);
    expect(inspectRpc(call(2, "browser_tabs", { action: "close" }))).toEqual([{ id: 2, kind: "tab-close" }]);
    expect(inspectRpc(call(3, "browser_close"))).toEqual([{ id: 3, kind: "tab-close" }]);
  });

  it("ignores every other call and every other message", () => {
    expect(inspectRpc(call(1, "browser_tabs", { action: "list" }))).toEqual([]);
    expect(inspectRpc(call(2, "browser_navigate", { url: "https://example.com" }))).toEqual([]);
    expect(inspectRpc({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual([]);
    expect(inspectRpc("nonsense")).toEqual([]);
    expect(inspectRpc(null)).toEqual([]);
  });

  it("reads each message of a batch", () => {
    const batch = [call(1, "browser_tabs", { action: "new" }), call(2, "browser_tabs", { action: "close" })];
    expect(inspectRpc(batch).map((entry) => entry.kind)).toEqual(["tab-new", "tab-close"]);
  });

  it("flags an initialize request", () => {
    expect(inspectRpc({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })).toEqual([
      { id: 7, kind: "initialize" },
    ]);
  });
});

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe("the tabs a response says were opened or closed", () => {
  const sse = (id: number, result: ToolResult): string =>
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
  const ok = { content: [{ type: "text", text: "### Result\n- 0: (current) [x](about:blank)" }] };

  it("counts a successful new tab as one", () => {
    expect(tabsDelta([{ id: 5, kind: "tab-new" }], sse(5, ok))).toBe(1);
  });

  it("counts a successful close as minus one", () => {
    expect(tabsDelta([{ id: 5, kind: "tab-close" }], sse(5, ok))).toBe(-1);
  });

  it("counts nothing when the call failed", () => {
    expect(tabsDelta([{ id: 5, kind: "tab-new" }], sse(5, { ...ok, isError: true }))).toBe(0);
  });

  it("counts nothing for another request id, or text that is not a response", () => {
    expect(tabsDelta([{ id: 5, kind: "tab-new" }], sse(6, ok))).toBe(0);
    expect(tabsDelta([{ id: 5, kind: "tab-new" }], "not sse at all")).toBe(0);
  });

  it("reads a plain JSON response as well as an event stream", () => {
    const json = JSON.stringify({ jsonrpc: "2.0", id: 5, result: ok });
    expect(tabsDelta([{ id: 5, kind: "tab-new" }], json)).toBe(1);
  });
});

describe("the browser ledger", () => {
  const limits = { tabsPerSession: 2, tabsTotal: 3, sessions: 2 };

  it("admits a session until the session limit, and frees a place when one ends", () => {
    const ledger = new BrowserLedger(limits);
    expect(ledger.admitSession("a")).toBe(true);
    expect(ledger.admitSession("b")).toBe(true);
    expect(ledger.admitSession("c")).toBe(false);
    ledger.endSession("a");
    expect(ledger.admitSession("c")).toBe(true);
  });

  it("knows only the sessions it recorded", () => {
    const ledger = new BrowserLedger(limits);
    expect(ledger.has("a")).toBe(false);
    ledger.register("a");
    expect(ledger.has("a")).toBe(true);
    ledger.endSession("a");
    expect(ledger.has("a")).toBe(false);
  });

  it("records a session even at the limit, because the upstream made it", () => {
    const ledger = new BrowserLedger(limits);
    ledger.register("a");
    ledger.register("b");
    expect(ledger.canAdmit()).toBe(false);
    ledger.register("c");
    expect(ledger.sessionCount()).toBe(3);
  });

  it("forgets every session at once", () => {
    const ledger = new BrowserLedger(limits);
    ledger.register("a");
    ledger.applyDelta("a", 2);
    ledger.endAll();
    expect(ledger.sessionCount()).toBe(0);
    expect(ledger.totalTabs()).toBe(0);
  });

  it("admitting a known session again is free", () => {
    const ledger = new BrowserLedger(limits);
    ledger.admitSession("a");
    ledger.admitSession("b");
    expect(ledger.admitSession("a")).toBe(true);
  });

  it("refuses a new tab past the limit of the session, and says how many", () => {
    const ledger = new BrowserLedger(limits);
    ledger.admitSession("a");
    ledger.applyDelta("a", 1);
    ledger.applyDelta("a", 1);
    expect(ledger.checkNewTab("a")).toMatchObject({ allowed: false, reason: "session" });
  });

  it("refuses a new tab past the total, whichever session asks", () => {
    const ledger = new BrowserLedger(limits);
    ledger.admitSession("a");
    ledger.admitSession("b");
    ledger.applyDelta("a", 2);
    ledger.applyDelta("b", 1);
    expect(ledger.checkNewTab("b")).toMatchObject({ allowed: false, reason: "total" });
  });

  it("allows a new tab again after a close", () => {
    const ledger = new BrowserLedger(limits);
    ledger.admitSession("a");
    ledger.applyDelta("a", 2);
    ledger.applyDelta("a", -1);
    expect(ledger.checkNewTab("a")).toEqual({ allowed: true });
  });

  it("never goes below zero", () => {
    const ledger = new BrowserLedger(limits);
    ledger.admitSession("a");
    ledger.applyDelta("a", -5);
    expect(ledger.tabsOf("a")).toBe(0);
    expect(ledger.totalTabs()).toBe(0);
  });

  it("forgets the tabs of a session that ends", () => {
    const ledger = new BrowserLedger(limits);
    ledger.admitSession("a");
    ledger.applyDelta("a", 2);
    expect(ledger.endSession("a")).toBe(2);
    expect(ledger.totalTabs()).toBe(0);
  });

  it("ignores a delta for a session it does not know", () => {
    const ledger = new BrowserLedger(limits);
    ledger.applyDelta("ghost", 3);
    expect(ledger.totalTabs()).toBe(0);
  });

  it("lists the sessions that were idle for a given time", () => {
    const ledger = new BrowserLedger(limits);
    ledger.admitSession("a", 1_000);
    ledger.admitSession("b", 9_000);
    ledger.touch("b", 9_500);
    expect(ledger.idleSessions(10_000, 5_000)).toEqual(["a"]);
  });
});

describe("the refusal an agent reads", () => {
  it("is a failed tool result that says what to do, in words", () => {
    const result = refusalResult({ allowed: false, reason: "session", limit: 4 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("4");
    expect(result.content[0]?.text).toContain("browser_tabs");
  });

  it("names the total when the total is the limit", () => {
    const result = refusalResult({ allowed: false, reason: "total", limit: 12 });
    expect(result.content[0]?.text).toContain("12");
  });
});

describe("the default limits", () => {
  it("hold many agent sessions, because each live agent keeps one open even when it is idle", () => {
    expect(DEFAULT_BROWSER_LIMITS.sessions).toBeGreaterThanOrEqual(32);
  });

  it("keep the tabs, which are what use the memory, few", () => {
    expect(DEFAULT_BROWSER_LIMITS.tabsPerSession).toBeLessThanOrEqual(6);
    expect(DEFAULT_BROWSER_LIMITS.tabsTotal).toBeLessThanOrEqual(16);
  });
});
