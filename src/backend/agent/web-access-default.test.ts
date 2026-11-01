// Web access is Playwright on the person's computer, and it is the default: the instructions must
// name it, must not offer Firecrawl, and must say where to install it when it is missing.
import { type AgentSummary, DEFAULT_AGENT_DEFAULTS } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { developerInstructions } from "./developer-instructions";
import { toolGuidance } from "./tool-guidance";

function agent(): AgentSummary {
  return {
    id: "bot-web",
    name: "Web",
    title: "Web",
    description: "Reads pages.",
    notifications: true,
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    threadId: null,
    workspacePath: "/tmp",
    preview: "",
    updatedAt: null,
    avatarSeed: "seed",
    avatarHue: null,
    avatarUrl: null,
  };
}

const instructions = () => developerInstructions(agent(), "/tmp/shared", [], "/tmp/automation", DEFAULT_AGENT_DEFAULTS);

describe("web access when the Builders Bot browser is chosen", () => {
  it("points at openbot_browser and does not name Playwright as the way in", () => {
    const text = developerInstructions(agent(), "/tmp/shared", [], "/tmp/automation", DEFAULT_AGENT_DEFAULTS, {
      browserInApp: true,
    });
    expect(text).toContain("Web access is the Builders Bot browser");
    expect(text).not.toContain("Web access is Playwright");
  });

  it("tells Playwright to reuse one tab, and to close the extra ones it opened", () => {
    const text = instructions();
    expect(text).toContain("every agent shares that one connection");
    expect(text).toContain("Use one tab: open each page in your current tab with browser_navigate");
    expect(text).toContain("Close the extra tabs you opened as soon as you are done");
    expect(text).not.toContain("open each page in a new tab");
  });

  it("says what to do when the browser refuses a new tab, and when too many agents use it", () => {
    const text = instructions();
    expect(text).toContain("close a tab you opened, or reuse an open tab");
    expect(text).toContain("too many agents use the browser");
  });
});

describe("web access in the developer instructions", () => {
  it("names Playwright as the default and points at its tools", () => {
    const text = instructions();
    expect(text).toContain("Web access is Playwright, on the person's own computer");
    expect(text).toContain("playwright.browser_navigate");
  });

  it("forbids offering a scraping service and asking about one", () => {
    const text = instructions();
    expect(text).toContain("do not propose Firecrawl");
    expect(text).toContain("do not ask whether to add one");
  });

  it("tells where to install Playwright when its tools are missing", () => {
    const text = instructions();
    expect(text).toContain("Playwright is not installed and where to get it (Marketplace, Apps tab, Playwright");
    expect(text).toContain("npx -y @playwright/mcp@latest");
  });

  it("keeps openbot_browser for the sign-ins, the Vault, and a tab that outlives the turn", () => {
    const text = instructions();
    expect(text).toContain("openbot_browser is Builders Bot's own persistent browser, and it carries the sign-ins");
    expect(text).toContain("request_takeover");
  });
});

describe("web access in the tool guidance", () => {
  it("says Playwright is the default in the browser guidance", () => {
    expect(toolGuidance("openbot_browser", "snapshot").join("\n")).toContain("Web access is Playwright");
  });

  it("keeps a web-access service out of the Marketplace suggestions", () => {
    const guidance = toolGuidance("openbot", "suggest_marketplace_app").join("\n");
    expect(guidance).toContain("Web access is not a Marketplace case");
    expect(guidance).toContain("do not suggest firecrawl");
  });
});
