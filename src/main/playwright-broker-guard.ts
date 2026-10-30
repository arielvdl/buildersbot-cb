import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The variable that carries the token, and the header that carries it back on each request. */
export const BROKER_TOKEN_ENV = "BB_BROKER_TOKEN";
export const BROKER_TOKEN_HEADER = "x-bb-broker";

/**
 * The code that the Playwright process loads before its own (`node --require`). The Playwright MCP
 * server has no sign-in, and its browser holds the person's logged-in sites, so any program on this
 * computer that finds its port could drive that browser. The guard refuses every HTTP request that
 * does not carry the token that only the broker was given.
 *
 * It fails closed: with no token in the environment it refuses everything, so a lost variable
 * stops the browser instead of opening it. The refusal says nothing about the token. WebSocket
 * upgrades are another event; the extension relay uses only those, and its plain requests end with 404.
 *
 * CommonJS, because `--require` loads it before any module system is ready.
 */
const GUARD_SOURCE = `"use strict";
const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");
const wanted = Buffer.from(process.env.${BROKER_TOKEN_ENV} || "");
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, request, response, ...rest) {
  if (event === "request") {
    const given = Buffer.from(String(request.headers["${BROKER_TOKEN_HEADER}"] || ""));
    const allowed = wanted.length > 0 && given.length === wanted.length && timingSafeEqual(given, wanted);
    if (!allowed) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("Unauthorized");
      return true;
    }
  }
  return emit.call(this, event, request, response, ...rest);
};
`;

/** Writes the guard into `directory`, for its owner only, and returns its path. Safe to call at each start. */
export function installGuard(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "playwright-broker-guard.cjs");
  const temporary = join(directory, `.${process.pid}.guard.tmp`);
  writeFileSync(temporary, GUARD_SOURCE, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

/** `NODE_OPTIONS` with the guard added to what the person already set. */
export function guardNodeOptions(guardPath: string, existing: string | undefined): string {
  const quoted = `"${guardPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return [existing?.trim(), `--require ${quoted}`].filter(Boolean).join(" ");
}
