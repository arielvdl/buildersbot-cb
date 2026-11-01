import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { isMissingFileError } from "./file-errors";
import { cursorDataHome } from "./process-confinement";

/**
 * Cursor 2026.10.22-27dcf5f does not load a server whose name is in the project's
 * `mcp-disabled.json`, also a server that an ACP session gives it, and does not report it (#3058).
 * The list has names only, so an `openbot` entry from the user's own Cursor CLI takes Builders Bot's
 * tools from each agent in that project. This removes Builders Bot's names, adds the names in `off`
 * (the person's own treg entries of `~/.cursor/mcp.json`, which the agent must not load), and keeps
 * the other entries.
 */
export function enableCursorMcpServers(cwd: string, names: readonly string[], off: readonly string[] = []): void {
  const file = cursorDisabledFile(cwd);
  let disabled: unknown = [];
  try {
    disabled = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  if (!Array.isArray(disabled)) return;
  const kept = disabled.filter((name) => !names.includes(name));
  const added = off.filter((name) => !names.includes(name) && !kept.includes(name));
  if (kept.length === disabled.length && added.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...kept, ...added], null, 2));
}

/** The project's `mcp-disabled.json` of the Cursor CLI for a workspace. */
export function cursorDisabledFile(cwd: string): string {
  return join(cursorDataHome(), "projects", cursorProjectSlug(cursorProjectRoot(cwd)), "mcp-disabled.json");
}

/** Cursor's project: the nearest folder of the workspace that has `.git`, up to below the root, or the workspace. */
function cursorProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  const { root } = parse(start);
  let folder = start;
  while (true) {
    if (existsSync(join(folder, ".git"))) return folder;
    const parent = dirname(folder);
    if (parent === folder || parent === root) return start;
    folder = parent;
  }
}

/** The folder name that Cursor gives a project in `projects`. */
function cursorProjectSlug(path: string): string {
  return path
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
