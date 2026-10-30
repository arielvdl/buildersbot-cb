// @vitest-environment node
import { describe, expect, it } from "vitest";
import { culturaBuilderConfigEnv, openCodeConfigEnv } from "./opencode-config";

const NO_PROVIDERS = () => [];

interface Overlay {
  mcp?: { playwright?: { enabled: boolean } };
  enabled_providers?: string[];
  provider?: object;
}

function overlay(env: { [name: string]: string }): Overlay {
  const raw = env.OPENCODE_CONFIG_CONTENT;
  if (raw === undefined) throw new Error("no overlay");
  const parsed: Overlay = JSON.parse(raw);
  return parsed;
}

describe("the Playwright that OpenCode starts by itself", () => {
  it("is turned off for an agent, because the shared browser of Builders Bot is handed to it instead", () => {
    const config = overlay(openCodeConfigEnv({}, NO_PROVIDERS, null));
    expect(config.mcp).toEqual({ playwright: { enabled: false } });
  });

  it("is turned off for a Cultura Builder agent too", () => {
    const config = overlay(culturaBuilderConfigEnv("https://hub.example/v1", "token-value"));
    expect(config.mcp).toEqual({ playwright: { enabled: false } });
  });

  it("is turned off for a profile run", () => {
    const config = overlay(openCodeConfigEnv({ enabled_providers: ["opencode"] }, NO_PROVIDERS, null));
    expect(config.mcp).toEqual({ playwright: { enabled: false } });
    expect(config.enabled_providers).toEqual(["opencode"]);
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
