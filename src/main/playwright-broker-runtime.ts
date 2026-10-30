import { accessSync, constants, readFileSync, renameSync, writeFileSync } from "node:fs";
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
