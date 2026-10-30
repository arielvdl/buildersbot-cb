import { accessSync, constants, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { BrokerIdentityStore } from "./playwright-broker";

/** Where a program can be: the directories a packaged app does not have on its own `PATH`. */
export const COMMON_PROGRAM_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/**
 * The path of an executable called `name` in the first of `directories` that has one. A name with a
 * path in it is refused: it could reach outside the directories.
 */
export function findProgram(name: string, directories: readonly string[]): string | null {
  if (name.includes("/") || name.includes("\\") || name === "" || name === "." || name === "..") return null;
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable.
    }
  }
  return null;
}

/**
 * The environment of the Playwright process: the named variables of the app, then the ones the row
 * sets itself. Nothing else of the app's environment reaches it, and a provider key is in that rest.
 */
export function brokerEnvironment(
  app: NodeJS.ProcessEnv,
  upstream: { env: Record<string, string>; passthrough: readonly string[] },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of upstream.passthrough) {
    const value = app[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...upstream.env };
}

/** The shortest secret that is read back. A shorter one was not made by the broker. */
const MIN_SECRET_LENGTH = 20;

/**
 * The port and the bearer of the broker, in a file that only its owner reads. They stay the same across
 * restarts so a provider session that was resumed finds the address it was given. A file that is
 * missing, damaged or of another shape reads as empty, and the broker makes a new pair.
 */
export class BrokerIdentityFile implements BrokerIdentityStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  read(): { port: number; secret: string } | null {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8"));
      if (
        !isDynamicRecord(parsed) ||
        parsed.version !== 1 ||
        !isNumber(parsed.port) ||
        !Number.isInteger(parsed.port) ||
        parsed.port < 1 ||
        parsed.port > 65_535 ||
        !isString(parsed.secret) ||
        parsed.secret.length < MIN_SECRET_LENGTH
      )
        return null;
      return { port: parsed.port, secret: parsed.secret };
    } catch {
      return null;
    }
  }

  /** Writes to a file beside it and renames, so a stop in the middle leaves the old pair or the new one. */
  write(identity: { port: number; secret: string }): void {
    const temporary = join(dirname(this.#path), `.${process.pid}.broker.tmp`);
    writeFileSync(temporary, JSON.stringify({ version: 1, ...identity }), { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

const EXTENSION_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";
/** Where the OpenCode tool of the person keeps the token that its Playwright server was approved with. */
export const OPENCODE_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");
/** What the extension shows as a token: letters, digits, `_` and `-`, of a sane length. */
const EXTENSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,200}$/u;

/**
 * The token of the Playwright extension, for the child, when the app has none of its own. The first
 * approval in Chrome gives the extension a token, and a server that starts with it needs no click
 * again. A person who set it up for OpenCode has it in that tool's configuration, so it is read from
 * there: read only, never logged, and passed to the Playwright process alone. A file that is missing,
 * damaged or of another shape, or a value that is not a token, gives nothing, and Chrome then asks.
 */
export function extensionTokenEnvironment(app: NodeJS.ProcessEnv, configPath: string): Record<string, string> {
  if (app[EXTENSION_TOKEN_ENV]) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const mcp = isDynamicRecord(parsed) ? parsed.mcp : undefined;
    const playwright = isDynamicRecord(mcp) ? mcp.playwright : undefined;
    const environment = isDynamicRecord(playwright) ? playwright.environment : undefined;
    const value = isDynamicRecord(environment) ? environment[EXTENSION_TOKEN_ENV] : undefined;
    return isString(value) && EXTENSION_TOKEN_PATTERN.test(value) ? { [EXTENSION_TOKEN_ENV]: value } : {};
  } catch {
    return {};
  }
}

/**
 * A message without the secrets the Playwright server prints: the `token=` of its connect URL, and
 * any `values` given. The server writes the connect URL when the extension does not answer, and that
 * text can reach an agent through an error.
 */
export function maskSecrets(text: string, values: readonly string[] = []): string {
  let masked = text.replace(/(token=)[A-Za-z0-9_-]+/giu, "$1***");
  for (const value of values) if (value.length >= 8) masked = masked.split(value).join("***");
  return masked;
}
