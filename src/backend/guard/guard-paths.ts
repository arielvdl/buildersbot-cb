// The real paths behind the files that an action sends. An upload or an attachment names a path that
// the agent chose; the tool opens the file that path leads to. A path such as `/tmp/../home/.env`,
// `~/./.env` or a harmless name that is a symbolic link to `~/.ssh/id_rsa` must be checked as the file
// that the tool will open, so the Guard checks the path as given and every real path behind it.

import { realpath as fsRealpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { Effect } from "effect";
import { rebaseLegacyWorkspacePath, sharedPathFromInput, workspacePathFromInput } from "../workspace-paths";

export interface GuardPathContext {
  readonly agentId: string;
  /** The agent's workspace, where a relative path starts. Null when the agent is not known. */
  readonly workspaceRoot: string | null;
  /** The shared folder, where a `Shared/` path and the second try of a relative path start. */
  readonly sharedRoot: string | null;
  /** Tests give their own home folder and file system. */
  readonly home?: string;
  readonly realpath?: (path: string) => Promise<string>;
}

export interface GuardPaths {
  /** The paths as given, their normal forms, and the real paths behind them, each once. */
  readonly paths: readonly string[];
  /** False when a real path could not be found for a reason other than a missing file. */
  readonly complete: boolean;
}

/** How many folders up the search for an existing folder goes before it stops. */
const MAX_DEPTH = 256;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * The absolute paths that the attachment code tries for one input, in the same order: an absolute
 * path and its twin under a renamed workspace, or a relative path in the workspace and then in the
 * shared folder. A path that starts with `~` is also tried in the home folder, in case a tool expands it.
 */
export function guardPathCandidates(input: string, context: GuardPathContext): string[] {
  const value = input.trim();
  if (!value) return [];
  const home = context.home ?? homedir();
  const candidates: string[] = [];
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) candidates.push(join(home, value.slice(1)));
  if (isAbsolute(value)) {
    candidates.push(value);
    const rebased = context.workspaceRoot
      ? rebaseLegacyWorkspacePath(context.workspaceRoot, context.agentId, value)
      : null;
    if (rebased) candidates.push(rebased);
  } else {
    if (context.workspaceRoot) candidates.push(workspacePathFromInput(context.workspaceRoot, context.agentId, value));
    if (context.sharedRoot) candidates.push(sharedPathFromInput(context.sharedRoot, value));
  }
  return [...new Set(candidates.filter((candidate) => isAbsolute(candidate)).map((candidate) => normalize(candidate)))];
}

/**
 * The real path of `path`: every symbolic link resolved. For a path that does not exist, the real path
 * of its nearest folder that exists, joined with the rest. Null when a call fails for another
 * reason, such as a folder that this app may not read, or a loop of links.
 */
async function realPathOf(path: string, realpath: (path: string) => Promise<string>): Promise<string | null> {
  let current = path;
  const rest: string[] = [];
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    try {
      const real = await realpath(current);
      return rest.length > 0 ? join(real, ...[...rest].reverse()) : real;
    } catch (error) {
      if (!isMissing(error)) return null;
      const parent = dirname(current);
      if (parent === current) return normalize(path);
      rest.push(basename(current));
      current = parent;
    }
  }
  return null;
}

/**
 * The paths that the Guard checks for files that an action sends: each path as given, its candidates
 * in normal form, and the real path behind each candidate. It never fails: a path that it could not
 * resolve makes the result incomplete, and the person then decides.
 */
export function resolveGuardPaths(inputs: readonly string[], context: GuardPathContext): Effect.Effect<GuardPaths> {
  const realpath = context.realpath ?? fsRealpath;
  return Effect.tryPromise({
    try: async (): Promise<GuardPaths> => {
      const paths = new Set<string>();
      let complete = true;
      for (const input of inputs) {
        paths.add(input);
        for (const candidate of guardPathCandidates(input, context)) {
          paths.add(candidate);
          const real = await realPathOf(candidate, realpath);
          if (real === null) complete = false;
          else paths.add(real);
        }
      }
      return { paths: [...paths], complete };
    },
    catch: () => null,
  }).pipe(Effect.catch(() => Effect.succeed({ paths: [...inputs], complete: false })));
}
