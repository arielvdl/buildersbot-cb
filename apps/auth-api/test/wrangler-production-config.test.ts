import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What a deploy of this Worker must never carry. The main block of wrangler.jsonc is the production
// Worker; the `env` blocks are the test and preview Workers, which are deployed to public hosts too.
// Each check is a mistake that happened or that would be easy to make again.

type Vars = Record<string, string>;

/** The `vars` of the main block ("production") and of each `env` block ("env.<name>"), in file order. */
function deployedVars(): Map<string, Vars> {
  const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  // Comment lines only: a "//" inside a value, such as https://, stays.
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  const blocks = new Map<string, Vars>([["production", varsOf(config)]]);
  if (typeof config === "object" && config !== null && "env" in config) {
    const environments = config.env;
    if (typeof environments === "object" && environments !== null) {
      for (const [name, block] of Object.entries(environments)) blocks.set(`env.${name}`, varsOf(block));
    }
  }
  return blocks;
}

function varsOf(block: unknown): Vars {
  const vars: Vars = {};
  if (typeof block === "object" && block !== null && "vars" in block) {
    const values = block.vars;
    if (typeof values === "object" && values !== null) {
      for (const [name, value] of Object.entries(values)) {
        if (typeof value === "string") vars[name] = value;
      }
    }
  }
  return vars;
}

const blocks = deployedVars();

describe("each deployed block of wrangler.jsonc", () => {
  it("is the production, preview or test Worker", () => {
    expect([...blocks.keys()]).toEqual(["production", "env.preview", "env.test"]);
  });

  it.each([...blocks])("%s never returns a sign-in code in the API answer", (_name, vars) => {
    // A true here once let anyone sign in to the account of any email address (31 October 2026).
    // Local development turns it on through the development state, never through this file.
    expect(vars.AUTH_EXPOSE_DEVELOPMENT_CODE).toBe("false");
  });
});

describe("the production block of wrangler.jsonc", () => {
  const vars = blocks.get("production") ?? {};

  it("does not let every account create a remote server", () => {
    expect((vars.HOSTED_SERVERS_ALLOWED_USER_IDS ?? "").split(",").map((entry) => entry.trim())).not.toContain("*");
  });

  it("points the Signal and its webhook at a host that is not the Worker itself", () => {
    // The Worker answers 404 on /v1/signal: a Signal URL on its own host breaks every remote connection.
    for (const name of ["REMOTE_SIGNAL_URL", "REMOTE_AUTH_WEBHOOK_URL"] as const) {
      const value = vars[name];
      if (!value) throw new Error(`${name} is missing in the production block of wrangler.jsonc.`);
      expect(new URL(value).hostname, name).not.toBe("auth-buildersbot.culturabuilder.com");
    }
    expect(vars.REMOTE_SIGNAL_URL?.startsWith("wss://")).toBe(true);
    expect(vars.REMOTE_AUTH_WEBHOOK_URL?.startsWith("https://")).toBe(true);
  });
});
