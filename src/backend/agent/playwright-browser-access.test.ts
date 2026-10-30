import type { McpServerConfig } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { applyBrowserAccess } from "./playwright-browser-access";

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
