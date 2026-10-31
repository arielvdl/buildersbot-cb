// @vitest-environment node
import { describe, expect, it } from "vitest";
import { culturaBuilderConfigEnv, openCodeConfigEnv } from "./opencode-config";

const NO_PROVIDERS = () => [];

interface Overlay {
  mcp?: { playwright?: { type?: string; command?: string[]; enabled?: boolean } };
  enabled_providers?: string[];
  provider?: object;
}

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
    expect(turnsPlaywrightOff(config)).toBe(true);
  });

  it("is turned off for a Cultura Builder agent too", () => {
    const config = overlay(culturaBuilderConfigEnv("https://hub.example/v1", "token-value"));
    expect(turnsPlaywrightOff(config)).toBe(true);
  });

  it("is turned off for a profile run", () => {
    const config = overlay(openCodeConfigEnv({ enabled_providers: ["opencode"] }, NO_PROVIDERS, null));
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

  it("keeps the provider layer that was there, and the key of the person", () => {
    const config = overlay(culturaBuilderConfigEnv("https://hub.example/v1", "token-value"));
    expect(config.enabled_providers).toEqual(["cultura-builder"]);
    expect(JSON.stringify(config.provider)).toContain("token-value");
  });
});
