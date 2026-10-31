import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Who can create a remote server comes from two settings (docs/architecture/server-creation-permission.md).
// `wrangler.jsonc` must not let each account create again, and must not hold the administrators.

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

/** The lines of the file with the `//` comments removed. A `//` in a string value is not in this file. */
const settings = config
  .split("\n")
  .map((line) => line.replace(/^\s*\/\/.*$/u, "").replace(/\s\/\/.*$/u, ""))
  .join("\n");

describe("the server creation settings in wrangler.jsonc", () => {
  it("lets no Worker allow each account with `*`", () => {
    const values = [...settings.matchAll(/"HOSTED_SERVERS_ALLOWED_USER_IDS"\s*:\s*"([^"]*)"/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.split(",").map((entry) => entry.trim())).not.toContain("*");
    }
  });

  it("keeps ADMIN_USER_IDS out of the vars, so a deploy with --keep-vars cannot overwrite it", () => {
    // A var is a key with a value. The name may appear in a list of required secrets.
    expect(settings).not.toMatch(/"ADMIN_USER_IDS"\s*:/u);
  });

  it("reads the comments out, so a setting in a comment is not counted", () => {
    expect(settings).not.toContain("--keep-vars");
    expect(config).toContain("--keep-vars");
  });
});
