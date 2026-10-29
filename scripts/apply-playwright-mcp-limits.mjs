#!/usr/bin/env node
// Puts the Playwright MCP server of this computer's opencode config on the flags that keep a
// browser session predictable: a fixed viewport and explicit timeouts, instead of the defaults the
// package picks. Idempotent, so it is safe to run again after the config is rewritten by hand or by
// an opencode upgrade, and it backs the file up before the first change.
//
//   node scripts/apply-playwright-mcp-limits.mjs [--check]
//
// The config is not part of the app, so an app update never touches it; this script is here so a
// reset is one command instead of a re-discovery.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG = join(homedir(), ".config", "opencode", "opencode.json");
const REQUIRED = [
  "--viewport-size=1280x800",
  "--timeout-action=5000",
  "--timeout-navigation=30000",
  "--timeout-settle=250",
];
const checkOnly = process.argv.includes("--check");

if (!existsSync(CONFIG)) {
  console.error(`No opencode config at ${CONFIG}.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const server = config.mcp?.playwright;
if (!server || !Array.isArray(server.command)) {
  console.error("The config has no local `playwright` MCP server to adjust.");
  process.exit(1);
}

const missing = REQUIRED.filter((flag) => !server.command.includes(flag));
if (missing.length === 0) {
  console.log("Already on the flags.");
  process.exit(0);
}
if (checkOnly) {
  console.error(`Missing: ${missing.join(" ")}`);
  process.exit(1);
}

copyFileSync(CONFIG, `${CONFIG}.bak-playwright-limits-${Date.now()}`);
// After the executable and its mode flag, before any argument that is not ours.
const anchor = server.command.findIndex((part) => !part.startsWith("--"));
const insertAt = server.command[0]?.includes("playwright-mcp") ? Math.max(1, anchor + 1) : anchor + 1;
server.command.splice(insertAt, 0, ...missing);
writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Added ${missing.join(" ")}. The previous file is beside it, with a .bak- suffix.`);
