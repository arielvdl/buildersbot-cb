// @vitest-environment node
import { describe, expect, it } from "vitest";
import { culturaBuilderConfigEnv, openCodeConfigEnv } from "./opencode-config";

const NO_PROVIDERS = () => [];

interface Overlay {
  mcp?: { playwright?: { type?: string; command?: string[]; enabled?: boolean } };
  enabled_providers?: string[];
  provider?: object;
}

/**
 * OpenCode 2 drops an MCP entry that has `enabled` and no `type` ("omitted enabled-only legacy MCP
 * entry"), so the entry must be a complete local server that is off.
 */
const PLAYWRIGHT_OFF = { playwright: { type: "local", command: ["true"], enabled: false } };

function overlay(env: { [name: string]: string }): Overlay {
  const raw = env.OPENCODE_CONFIG_CONTENT;
  if (raw === undefined) throw new Error("no overlay");
  const parsed: Overlay = JSON.parse(raw);
  return parsed;
}

/**
 * The entry as OpenCode 2.2.5 reads it: an entry with no `type` and a boolean `enabled` is omitted, and
 * the server of the person's file then still starts. Otherwise the entry must be a disabled local one.
 */
function turnsPlaywrightOff(config: Overlay): boolean {
  const entry = config.mcp?.playwright;
  if (!entry || entry.type === undefined) return false;
  return entry.type === "local" && (entry.command?.length ?? 0) > 0 && entry.enabled === false;
}

describe("the Playwright that OpenCode starts by itself", () => {
  it("is turned off for an agent, because the shared browser of Builders Bot is handed to it instead", () => {
    const config = overlay(openCodeConfigEnv({}, NO_PROVIDERS, null));
    expect(config.mcp).toEqual(PLAYWRIGHT_OFF);
    expect(turnsPlaywrightOff(config)).toBe(true);
  });

  it("is turned off for a Cultura Builder agent too", () => {
    const config = overlay(culturaBuilderConfigEnv("https://hub.example/v1", "token-value"));
    expect(config.mcp).toEqual(PLAYWRIGHT_OFF);
    expect(turnsPlaywrightOff(config)).toBe(true);
  });

  it("is turned off for a profile run", () => {
    const config = overlay(openCodeConfigEnv({ enabled_providers: ["opencode"] }, NO_PROVIDERS, null));
    expect(config.mcp).toEqual(PLAYWRIGHT_OFF);
    expect(turnsPlaywrightOff(config)).toBe(true);
    expect(config.enabled_providers).toEqual(["opencode"]);
  });

  it("is a full entry, because OpenCode 2 omits an entry with only enabled", () => {
    const config = overlay(openCodeConfigEnv({}, NO_PROVIDERS, null));
    expect(turnsPlaywrightOff({ mcp: { playwright: { enabled: false } } })).toBe(false);
    expect(config.mcp?.playwright?.type).toBe("local");
  });

  it("touches no other server of the person: only the name playwright is overridden", () => {
    const config = overlay(openCodeConfigEnv({}, NO_PROVIDERS, null));
    expect(Object.keys(config.mcp ?? {})).toEqual(["playwright"]);
  });

  it("is a complete entry, because OpenCode 2 drops an entry that has only enabled", () => {
    for (const env of [
      openCodeConfigEnv({}, NO_PROVIDERS, null),
      culturaBuilderConfigEnv("https://hub.example/v1", null),
    ]) {
      const entry = overlay(env).mcp?.playwright;
      expect(entry?.type).toBe("local");
      expect(entry?.command?.length).toBeGreaterThan(0);
      expect(entry?.enabled).toBe(false);
    }
  });

  it("keeps the provider layer that was there, and the key of the person", () => {
    const config = overlay(culturaBuilderConfigEnv("https://hub.example/v1", "token-value"));
    expect(config.enabled_providers).toEqual(["cultura-builder"]);
    expect(JSON.stringify(config.provider)).toContain("token-value");
  });
});

describe("the Cultura Builder models", () => {
  it("declare a window that OpenCode compacts in, not the 1M that the gateway accepts", () => {
    const provider = overlay(culturaBuilderConfigEnv("https://hub.example/v1", null)).provider;
    const models = JSON.parse(JSON.stringify(provider))["cultura-builder"].models;
    for (const id of ["builder-auto", "builder-plan", "builder-code", "builder-fast", "builder-review"]) {
      expect(models[id].limit).toEqual({ context: 262_144, output: 32_768 });
    }
  });

  it("declare the 1M window of the gateway where it has one when the person chose the full context", () => {
    const provider = overlay(culturaBuilderConfigEnv("https://hub.example/v1", null, true)).provider;
    const models = JSON.parse(JSON.stringify(provider))["cultura-builder"].models;
    for (const id of ["builder-auto", "builder-code", "builder-fast"]) {
      expect(models[id].limit).toEqual({ context: 1_048_576, output: 32_768 });
    }
    for (const id of ["builder-plan", "builder-review"]) {
      expect(models[id].limit).toEqual({ context: 262_144, output: 32_768 });
    }
  });
});
