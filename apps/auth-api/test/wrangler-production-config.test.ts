import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What a production deploy of this Worker must never carry. The main block of wrangler.jsonc is the
// production Worker; the `env` blocks are test and preview copies and are not read here. Each check is
// a mistake that happened or that would be easy to make again.

type Vars = Record<string, string>;

function productionVars(): Vars {
  const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  // Comment lines only: a "//" inside a value, such as https://, stays.
  const json = source.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const config = JSON.parse(json) as { vars?: Vars };
  return config.vars ?? {};
}

describe("the production block of wrangler.jsonc", () => {
  const vars = productionVars();

  it("never returns a sign-in code in the API answer", () => {
    // A true here once let anyone sign in to the account of any email address.
    expect(vars.AUTH_EXPOSE_DEVELOPMENT_CODE).toBe("false");
  });

  it("does not let every account create a remote server", () => {
    expect((vars.HOSTED_SERVERS_ALLOWED_USER_IDS ?? "").split(",").map((entry) => entry.trim())).not.toContain("*");
  });

  it("points the Signal and its webhook at a host that is not the Worker itself", () => {
    // The Worker answers 404 on /v1/signal: a Signal URL on its own host breaks every remote connection.
    for (const name of ["REMOTE_SIGNAL_URL", "REMOTE_AUTH_WEBHOOK_URL"] as const) {
      const value = vars[name];
      expect(value, name).toBeTruthy();
      expect(new URL(value as string).hostname, name).not.toBe("auth-buildersbot.culturabuilder.com");
    }
    expect(vars.REMOTE_SIGNAL_URL?.startsWith("wss://")).toBe(true);
    expect(vars.REMOTE_AUTH_WEBHOOK_URL?.startsWith("https://")).toBe(true);
  });
});
