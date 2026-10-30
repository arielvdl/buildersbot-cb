import type { McpServerConfig } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { applyBrowserAccess, BROWSER_BROKER_MCP_SERVER_ID, playwrightUpstream } from "./playwright-browser-access";

function server(overrides: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "mcp-1",
    name: "playwright",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.83"],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
    ...overrides,
  };
}

const other = server({ id: "mcp-2", name: "context7", command: "npx", args: ["-y", "context7"] });

describe("applyBrowserAccess", () => {
  it("attaches Playwright to the browser that is open, through its extension", () => {
    const [playwright] = applyBrowserAccess([server({})], false);
    expect(playwright?.args).toEqual(["-y", "@playwright/mcp@0.0.83", "--extension"]);
    expect(playwright?.envPassthrough).toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
  });

  it("does not add the extension flag twice", () => {
    const once = applyBrowserAccess([server({})], false);
    const twice = applyBrowserAccess(once, false);
    expect(twice[0]?.args.filter((arg) => arg === "--extension")).toHaveLength(1);
    expect(twice[0]?.envPassthrough.filter((name) => name === "PLAYWRIGHT_MCP_EXTENSION_TOKEN")).toHaveLength(1);
  });

  it("asks the gated launcher for its user mode instead of a flag it does not read", () => {
    const gated = server({ command: "node", args: ["/x/browser-gate/playwright-mcp-gated.mjs"] });
    expect(applyBrowserAccess([gated], false)[0]?.args).toEqual([
      "/x/browser-gate/playwright-mcp-gated.mjs",
      "--mode",
      "user",
    ]);
  });

  it("leaves Playwright out when the Builders Bot browser is the way in", () => {
    expect(applyBrowserAccess([server({}), other], true)).toEqual([other]);
  });

  it("does not touch another server, nor a row the person edited into something else", () => {
    const custom = server({ command: "/usr/local/bin/my-browser", args: ["--headless"] });
    expect(applyBrowserAccess([other, custom], false)).toEqual([other, custom]);
    expect(applyBrowserAccess([custom], true)).toEqual([custom]);
  });
});

describe("applyBrowserAccess with the browser broker", () => {
  const broker = { url: "http://127.0.0.1:5555/mcp", bearer: "secret" };

  it("hands Playwright as one http server, the broker's, in place of a process of its own", () => {
    const [playwright] = applyBrowserAccess([server({})], false, broker);
    expect(playwright).toMatchObject({
      id: BROWSER_BROKER_MCP_SERVER_ID,
      name: "playwright",
      transport: "http",
      url: broker.url,
      command: "",
      args: [],
      envPassthrough: [],
    });
  });

  it("keeps the bearer out of the row: the gateway adds it at the hand-off", () => {
    const [playwright] = applyBrowserAccess([server({})], false, broker);
    expect(playwright?.headers).toEqual([]);
    expect(JSON.stringify(playwright)).not.toContain(broker.bearer);
  });

  it("does the same for the gated launcher", () => {
    const gated = server({
      command: "node",
      args: ["/x/browser-gate/playwright-mcp-gated.mjs", "--viewport-size=1280x800"],
    });
    expect(applyBrowserAccess([gated], false, broker)[0]?.transport).toBe("http");
  });

  it("leaves the other servers, and a row the person edited into something else, as they are", () => {
    const custom = server({ command: "/usr/local/bin/my-browser", args: ["--headless"] });
    expect(applyBrowserAccess([other, custom], false, broker)).toEqual([other, custom]);
  });

  it("still leaves Playwright out when the Builders Bot browser is the way in", () => {
    expect(applyBrowserAccess([server({}), other], true, broker)).toEqual([other]);
  });

  it("falls back to the process of its own when the broker has no address", () => {
    expect(applyBrowserAccess([server({})], false, null)[0]?.args).toContain("--extension");
  });
});

describe("playwrightUpstream", () => {
  const found = (name: string) => (name === "playwright-mcp" ? "/opt/homebrew/bin/playwright-mcp" : null);

  it("starts the Playwright package of the saved row, with the extension and a shared context", () => {
    const upstream = playwrightUpstream(
      [server({ args: ["-y", "@playwright/mcp@0.0.83", "--viewport-size=1280x800"] })],
      found,
    );
    expect(upstream?.command).toBe("npx");
    expect(upstream?.args).toEqual([
      "-y",
      "@playwright/mcp@0.0.83",
      "--viewport-size=1280x800",
      "--extension",
      "--shared-browser-context",
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("replaces the gated launcher with the playwright-mcp program and keeps the person's flags", () => {
    const gated = server({
      command: "node",
      args: ["/x/browser-gate/playwright-mcp-gated.mjs", "--viewport-size=1280x800", "--timeout-action=5000"],
    });
    const upstream = playwrightUpstream([gated], found);
    expect(upstream?.command).toBe("/opt/homebrew/bin/playwright-mcp");
    expect(upstream?.args.slice(0, 2)).toEqual(["--viewport-size=1280x800", "--timeout-action=5000"]);
    expect(upstream?.args).not.toContain("/x/browser-gate/playwright-mcp-gated.mjs");
  });

  it("drops the flags that would start a browser of its own, or move the server", () => {
    const messy = server({
      args: [
        "-y",
        "@playwright/mcp@0.0.83",
        "--isolated",
        "--headless",
        "--port",
        "9",
        "--host",
        "0.0.0.0",
        "--cdp-endpoint",
        "http://x",
        "--extension",
      ],
    });
    const args = playwrightUpstream([messy], found)?.args ?? [];
    for (const flag of ["--isolated", "--headless", "--cdp-endpoint", "http://x", "9", "0.0.0.0"])
      expect(args).not.toContain(flag);
    expect(args.filter((arg) => arg === "--extension")).toHaveLength(1);
    expect(args.slice(-4)).toEqual(["--port", "0", "--host", "127.0.0.1"]);
  });

  it("pins the package when the gated launcher is set and no program is installed", () => {
    const gated = server({ command: "node", args: ["/x/browser-gate/playwright-mcp-gated.mjs"] });
    const upstream = playwrightUpstream([gated], () => null);
    expect(upstream?.command).toBe("npx");
    expect(upstream?.args.slice(0, 2)).toEqual(["-y", "@playwright/mcp@0.0.83"]);
  });

  it("is null with no Playwright row, a disabled one, or one the person edited into something else", () => {
    expect(playwrightUpstream([other], found)).toBeNull();
    expect(playwrightUpstream([server({ enabled: false })], found)).toBeNull();
    expect(playwrightUpstream([server({ command: "/usr/local/bin/my-browser", args: [] })], found)).toBeNull();
  });

  it("carries the environment the row names, and nothing from the rest of the app", () => {
    const upstream = playwrightUpstream([server({ env: [{ key: "PLAYWRIGHT_BROWSERS_PATH", value: "/b" }] })], found);
    expect(upstream?.env).toEqual({ PLAYWRIGHT_BROWSERS_PATH: "/b" });
    expect(upstream?.passthrough).toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
    expect(upstream?.passthrough).toContain("PATH");
    expect(upstream?.passthrough).not.toContain("ANTHROPIC_API_KEY");
  });
});
