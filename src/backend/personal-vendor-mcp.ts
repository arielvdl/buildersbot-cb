// A person's own treg setup on this computer (the treg design, §3.13 and decision D14).
//
// treg's installer writes a treg token in plain text into the MCP config files of other agent apps:
// `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.cursor/mcp.json` and the Claude
// Code user config `~/.claude.json`. A Builders Bot agent whose provider loads such a file reaches
// treg directly: with no Hub cap, no Guard and no cost line. This module finds those entries, read
// only, so that the provider drivers can turn them off inside Builders Bot agents and Settings can
// tell the person. It keeps server names, file paths and URL hosts only: it never reads, keeps,
// logs or returns a header, a token or another value of an entry.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersonalVendorMcpFile, PersonalVendorMcpNotice } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

/**
 * The organization policy for a person's own vendor connections (D14). "hub-only": Builders Bot
 * agents use the Cultura Builder connection, and the person's own treg entries are off inside them.
 * "allowed": an organization lets its people use their own vendor account (the design's option C,
 * not offered in this build). The Hub sends no policy yet, so every organization is "hub-only".
 */
export type PersonalVendorMcpPolicy = "hub-only" | "allowed";

/** The policy of this build. */
export const PERSONAL_VENDOR_MCP_POLICY: PersonalVendorMcpPolicy = "hub-only";

/** The name that treg's installer gives its MCP entry. */
export const TREG_SERVER_NAME = "treg";

/** The installer's names that a provider layer always turns off under the policy, also with no file read. */
export function vendorNamesOff(policy: PersonalVendorMcpPolicy = PERSONAL_VENDOR_MCP_POLICY): string[] {
  return policy === "hub-only" ? [TREG_SERVER_NAME] : [];
}

/** The largest config file that is read; a larger one is not an MCP config that a person keeps by hand. */
const FILE_LIMIT = 4 * 1024 * 1024;

/** Whether a host is treg's: `treg.to` or a sub-domain of it. */
export function isTregHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/u, "");
  return name === "treg.to" || name.endsWith(".treg.to");
}

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>,;)}\]]{1,2048}/giu;

function textHasTregHost(text: string): boolean {
  for (const match of text.matchAll(URL_IN_TEXT)) {
    try {
      if (isTregHost(new URL(match[0]).hostname)) return true;
    } catch {
      // Not a URL that a provider could open.
    }
  }
  // A bare host, such as an argument `--url treg.to/mcp`.
  return /(?:^|[\s"'=/@])(?:[a-z0-9-]{1,63}\.)*treg\.to(?:[/:\s"']|$)/iu.test(text);
}

/** The program name of a command, with no folder and no extension. */
function programName(command: string): string {
  const base = command.trim().split(/[\\/]/u).at(-1) ?? "";
  return base.replace(/\.(?:exe|cmd|bat|sh)$/iu, "").toLowerCase();
}

/**
 * Whether one MCP entry is a treg connection: the installer's name, a URL whose host is treg's, or
 * a command of treg's own CLI. Only the address fields are read: `url`, `httpUrl`, `serverUrl`,
 * `command` and `args`. Headers and environment values are never read.
 */
export function isTregEntry(name: string, entry: unknown): boolean {
  if (name.trim().toLowerCase() === TREG_SERVER_NAME) return true;
  if (!isDynamicRecord(entry)) return false;
  const addresses: string[] = [];
  for (const key of ["url", "httpUrl", "serverUrl", "uri"]) {
    const value = entry[key];
    if (isString(value)) addresses.push(value);
  }
  const command = entry.command;
  const commands = isString(command) ? [command] : Array.isArray(command) ? command.filter(isString) : [];
  const args = Array.isArray(entry.args) ? entry.args.filter(isString) : [];
  if (commands[0] !== undefined && programName(commands[0]) === TREG_SERVER_NAME) return true;
  return [...addresses, ...commands, ...args].some(textHasTregHost);
}

/**
 * The object of a JSON file with comments and trailing commas, as OpenCode reads `opencode.jsonc`.
 * Comments are taken out outside strings only; a text that still does not parse, or that holds no
 * object, gives null.
 */
function parseJsoncRecord(text: string): DynamicRecord | null {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end - 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else out += char;
  }
  try {
    const value = JSON.parse(out.replace(/,(\s*[}\]])/gu, "$1"));
    return isDynamicRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The names of the treg entries in one record of MCP servers, keyed by name. */
function tregNamesIn(servers: unknown): string[] {
  if (!isDynamicRecord(servers)) return [];
  return Object.entries(servers)
    .filter(([name, entry]) => isTregEntry(name, entry))
    .map(([name]) => name);
}

/**
 * The treg entries of a Claude Code user file: `mcpServers` of the user scope, and `mcpServers` of
 * each project (the local scope).
 */
function claudeTregNames(config: unknown): string[] {
  if (!isDynamicRecord(config)) return [];
  const names = tregNamesIn(config.mcpServers);
  if (isDynamicRecord(config.projects))
    for (const project of Object.values(config.projects))
      if (isDynamicRecord(project)) names.push(...tregNamesIn(project.mcpServers));
  return [...new Set(names)];
}

/** A TOML string or bare key, unquoted. */
function tomlKey(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    return trimmed.slice(1, -1);
  return trimmed;
}

/** The first key of a dotted TOML key, such as `treg` of `treg.http_headers` or `"my tools"`. */
function firstTomlKey(dotted: string): string {
  const text = dotted.trim();
  const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')/u.exec(text);
  if (quoted?.[1]) return tomlKey(quoted[1]);
  return tomlKey(text.split(".")[0] ?? "");
}

/**
 * The MCP servers of a Codex `config.toml`, by name, with the text of each entry: its table, its
 * sub-tables (`[mcp_servers.treg.http_headers]`), an inline table under `[mcp_servers]`, and dotted
 * keys (`mcp_servers.treg.url = …`). A small line reader, not a TOML parser: it reads only what it
 * needs to find a name, a URL and a command, and each entry text is read by `isTregEntry`'s rules.
 */
export function codexTomlServers(text: string): Map<string, string> {
  const servers = new Map<string, string>();
  const add = (name: string, line: string) => {
    if (!name) return;
    servers.set(name, `${servers.get(name) ?? ""}\n${line}`);
  };
  let current: string | null = null;
  let inServersTable = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\s*([^\][]+?)\s*\]$/u.exec(line);
    if (header?.[1]) {
      const path = header[1];
      const server = /^mcp_servers\s*\.\s*(.+)$/u.exec(path);
      current = server?.[1] ? firstTomlKey(server[1]) : null;
      inServersTable = path === "mcp_servers";
      if (current) add(current, "");
      continue;
    }
    if (/^\[\[/u.test(line)) {
      current = null;
      inServersTable = false;
      continue;
    }
    const dotted = /^mcp_servers\s*\.\s*(.+?)\s*=/u.exec(line);
    if (!current && !inServersTable && dotted?.[1]) {
      add(firstTomlKey(dotted[1]), line);
      continue;
    }
    if (inServersTable) {
      const inline = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))\s*(?:\.|=)/u.exec(line);
      if (inline?.[1]) add(tomlKey(inline[1]), line);
      continue;
    }
    if (current) add(current, line);
  }
  return servers;
}

/** Whether the text of one Codex entry is a treg connection, from its name, its URL or its command. */
function isTregTomlEntry(name: string, entry: string): boolean {
  if (name.trim().toLowerCase() === TREG_SERVER_NAME) return true;
  // Only the address lines: a header value is never read.
  const addresses = entry
    .split("\n")
    .filter((line) => /^\s*(?:url|command|args)\s*=|(?:^|[\s{,])(?:url|command|args)\s*=/u.test(line))
    .map((line) => line.replace(/http_headers\s*=\s*\{[^}]*\}/gu, "").replace(/env\s*=\s*\{[^}]*\}/gu, ""));
  const command = /(?:^|[\s{,])command\s*=\s*["']([^"']+)["']/u.exec(addresses.join("\n"))?.[1];
  if (command && programName(command) === TREG_SERVER_NAME) return true;
  return addresses.some(textHasTregHost);
}

/** The transport of one Codex entry, from its text: `url` is http, `command` is stdio. */
function codexTransport(entry: string): "http" | "stdio" | null {
  if (/(?:^|[\s{,])url\s*=/mu.test(entry)) return "http";
  if (/(?:^|[\s{,])command\s*=/mu.test(entry)) return "stdio";
  return null;
}

/** One file that treg's installer writes, where a provider of Builders Bot reads MCP servers. */
interface VendorFile {
  readonly kind: PersonalVendorMcpFile["kind"];
  readonly path: string;
  readonly names: (text: string) => string[];
}

function configHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
}

/** The Codex user file that the default Codex account reads. */
export function codexConfigFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.CODEX_HOME?.trim() || join(home, ".codex"), "config.toml");
}

/** The global OpenCode files: `OPENCODE_CONFIG`, then `opencode.json`, `opencode.jsonc` and `config.json`. */
export function openCodeConfigFiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const folder = join(configHome(env, home), "opencode");
  const own = env.OPENCODE_CONFIG?.trim();
  return [
    ...(own ? [own] : []),
    join(folder, "opencode.json"),
    join(folder, "opencode.jsonc"),
    join(folder, "config.json"),
  ];
}

const openCodeNames = (text: string): string[] => {
  const config = parseJsoncRecord(text);
  return config ? tregNamesIn(config.mcp) : [];
};

const codexNames = (text: string): string[] =>
  [...codexTomlServers(text)].filter(([name, entry]) => isTregTomlEntry(name, entry)).map(([name]) => name);

function vendorFiles(env: NodeJS.ProcessEnv, home: string): VendorFile[] {
  const cursorConfig = env.CURSOR_CONFIG_DIR?.trim() || join(home, ".cursor");
  const claudeConfig = env.CLAUDE_CONFIG_DIR?.trim();
  return [
    { kind: "codex", path: codexConfigFile(env, home), names: codexNames },
    ...openCodeConfigFiles(env, home).map((path): VendorFile => ({ kind: "opencode", path, names: openCodeNames })),
    {
      kind: "cursor",
      path: join(cursorConfig, "mcp.json"),
      names: (text) => {
        const config = parseJsoncRecord(text);
        return config ? tregNamesIn(config.mcpServers) : [];
      },
    },
    {
      kind: "claude",
      path: claudeConfig ? join(claudeConfig, ".claude.json") : join(home, ".claude.json"),
      names: (text) => claudeTregNames(parseJsoncRecord(text)),
    },
  ];
}

/** A file's text, or null when it is missing, unreadable, not a file or too large. */
function readSmallFile(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** One file with treg entries: its kind, its path and the names of the entries. */
export interface TregSetupFile {
  readonly kind: PersonalVendorMcpFile["kind"];
  readonly path: string;
  readonly names: readonly string[];
}

/** The files of this computer that hold a treg entry, read now. A file that cannot be read is left out. */
export function findTregSetup(env: NodeJS.ProcessEnv = process.env, home = homedir()): TregSetupFile[] {
  const found: TregSetupFile[] = [];
  for (const file of vendorFiles(env, home)) {
    const text = readSmallFile(file.path);
    if (text === null) continue;
    const names = file.names(text);
    if (names.length > 0) found.push({ kind: file.kind, path: file.path, names });
  }
  return found;
}

/**
 * The names that an OpenCode layer of Builders Bot turns off: the installer's name always, and each
 * treg entry of the person's global OpenCode files. Empty when the policy allows the person's own.
 */
export function openCodeTregNames(
  policy: PersonalVendorMcpPolicy = PERSONAL_VENDOR_MCP_POLICY,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  if (policy !== "hub-only") return [];
  const names = new Set([TREG_SERVER_NAME]);
  for (const path of openCodeConfigFiles(env, home)) {
    const text = readSmallFile(path);
    if (text !== null) for (const name of openCodeNames(text)) names.add(name);
  }
  return [...names];
}

/**
 * The servers of the person's Codex file, read from disk, for a thread whose `config/read` failed:
 * each name with its transport. Null when the file cannot be read.
 */
export function codexFileServers(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Map<string, "http" | "stdio" | null> | null {
  const text = readSmallFile(codexConfigFile(env, home));
  if (text === null) return null;
  return new Map([...codexTomlServers(text)].map(([name, entry]) => [name, codexTransport(entry)]));
}

/**
 * Which providers of Builders Bot read each file and cannot have its entries turned off by the app.
 * Codex, OpenCode and Claude Code are covered: Codex turns off every name of its own files in the
 * thread, OpenCode gets a layer that turns the treg names off, and Claude Code runs with
 * `strictMcpConfig`. Grok also loads `~/.claude.json` and `~/.cursor/mcp.json`, Cursor loads
 * `~/.cursor/mcp.json`, and a custom ACP agent reads what its own CLI reads: the app does not
 * control what those load.
 */
const UNCOVERED_READERS: Readonly<
  Record<PersonalVendorMcpFile["kind"], readonly PersonalVendorMcpNotice["uncovered"][number][]>
> = {
  codex: [],
  opencode: [],
  cursor: ["cursor", "grok", "acp"],
  claude: ["grok", "acp"],
};

/**
 * What Settings shows about the person's own treg setup: each file with a treg entry, as a path
 * under the home folder written with `~`, and the providers whose agents can still use it. Never a
 * value of an entry.
 */
export function personalVendorMcpNotice(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): PersonalVendorMcpNotice {
  const files = findTregSetup(env, home);
  const uncovered = new Set(files.flatMap((file) => UNCOVERED_READERS[file.kind]));
  return {
    files: files.map((file) => ({
      kind: file.kind,
      path: file.path.startsWith(`${home}/`) ? `~/${file.path.slice(home.length + 1)}` : file.path,
    })),
    uncovered: [...uncovered],
  };
}
