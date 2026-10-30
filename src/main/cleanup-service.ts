import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CleanupBlocker, CleanupCandidate, CleanupCandidates, CleanupReason } from "@openbot/contracts/ipc";

const run = promisify(execFile);

const DAY_MS = 86_400_000;
/** A worktree whose last commit is newer than this is somebody's work of today and is left out. */
const ACTIVE_DAYS = 2;
/** An unmerged worktree is offered only after this many idle days. */
const STALE_DAYS = 30;
/** A data folder of a development run is offered after this many days without use. */
const PROFILE_STALE_DAYS = 7;
const SCAN_DEPTH = 5;
const SIZE_CONCURRENCY = 3;
const GIT_TIMEOUT_MS = 15_000;
const DEV_PROFILE = /^(Builders Bot|OpenBot) Dev wt-[0-9a-f]{64}$/u;
const SKIPPED_FOLDERS = new Set([
  "node_modules",
  ".git",
  "Library",
  ".Trash",
  ".cache",
  ".next",
  "dist",
  "build",
  ".venv",
  "venv",
]);

interface Found {
  candidate: CleanupCandidate;
  path: string;
  /** The repository that owns a worktree, for `git worktree prune` after the folder is gone. */
  repository: string | null;
}

export interface CleanupServiceOptions {
  /** Folders searched for git worktrees, to a bounded depth. A folder that does not exist is skipped. */
  roots: readonly string[];
  /** This run's data folder: its parent holds the development folders, and it is never offered. */
  userDataPath: string;
  /** Moves a folder to the Trash. Nothing in here deletes for good. */
  trash(path: string): Promise<void>;
  now?: () => number;
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1_048_576,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return { code: 0, out: stdout.trim() };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
        ? error.code
        : -1;
    return { code, out: "" };
  }
}

async function folderBytes(path: string): Promise<number> {
  try {
    const { stdout } = await run("du", ["-sk", path], { timeout: 120_000, maxBuffer: 65_536 });
    return Number.parseInt(stdout, 10) * 1024 || 0;
  } catch {
    return 0;
  }
}

export function candidateId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** The folders under the roots that hold a `.git` file, which is what a linked worktree has and a clone does not. */
export async function findWorktreeFolders(roots: readonly string[], depth = SCAN_DEPTH): Promise<string[]> {
  const found: string[] = [];
  async function walk(folder: string, level: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git" && entry.isFile())) {
      found.push(folder);
      return;
    }
    if (level >= depth) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIPPED_FOLDERS.has(entry.name)) {
        await walk(join(folder, entry.name), level + 1);
      }
    }
  }
  for (const root of roots) await walk(root, 0);
  return found;
}

/** The ids and what the last scan knew, so a removal names what the person saw and nothing else. */
export class CleanupService {
  readonly #options: CleanupServiceOptions;
  #found = new Map<string, Found>();

  constructor(options: CleanupServiceOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  async scan(): Promise<CleanupCandidates> {
    const worktrees = await findWorktreeFolders(this.#options.roots);
    const found: Found[] = [];
    for (const path of worktrees) {
      const entry = await this.#worktree(path);
      if (entry) found.push(entry);
    }
    for (const entry of await this.#devProfiles()) found.push(entry);
    for (let start = 0; start < found.length; start += SIZE_CONCURRENCY) {
      await Promise.all(
        found.slice(start, start + SIZE_CONCURRENCY).map(async (entry) => {
          entry.candidate.bytes = await folderBytes(entry.path);
        }),
      );
    }
    found.sort((left, right) => right.candidate.bytes - left.candidate.bytes);
    this.#found = new Map(found.map((entry) => [entry.candidate.id, entry]));
    return { candidates: found.map((entry) => entry.candidate), scannedAt: this.#now() };
  }

  /** What the last scan found under this id, or undefined. */
  find(id: string): CleanupCandidate | undefined {
    return this.#found.get(id)?.candidate;
  }

  /**
   * Moves a scanned candidate to the Trash after looking at it again: a worktree that has since got
   * changes, or work nobody pushed, stays. The answer is whether it went.
   */
  async remove(id: string): Promise<boolean> {
    const known = this.#found.get(id);
    if (!known) return false;
    const fresh = known.repository === null ? await this.#profileNow(known.path) : await this.#worktree(known.path);
    if (!fresh || fresh.candidate.blocker !== null) return false;
    await this.#options.trash(known.path);
    if (known.repository !== null) await git(known.repository, ["worktree", "prune"]);
    this.#found.delete(id);
    return true;
  }

  async #profileNow(path: string): Promise<Found | null> {
    return (await this.#devProfiles()).find((entry) => entry.path === path) ?? null;
  }

  async #devProfiles(): Promise<Found[]> {
    const parent = dirname(this.#options.userDataPath);
    let names: string[];
    try {
      names = await readdir(parent);
    } catch {
      return [];
    }
    const found: Found[] = [];
    for (const name of names) {
      const path = join(parent, name);
      if (!DEV_PROFILE.test(name) || path === this.#options.userDataPath) continue;
      let modified: number;
      try {
        modified = (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      const idleDays = Math.floor((this.#now() - modified) / DAY_MS);
      if (idleDays < PROFILE_STALE_DAYS) continue;
      found.push({
        path,
        repository: null,
        candidate: {
          id: candidateId(path),
          kind: "dev-profile",
          label: name,
          detail: "",
          bytes: 0,
          reason: "stale",
          idleDays,
          blocker: null,
        },
      });
    }
    return found;
  }

  async #worktree(path: string): Promise<Found | null> {
    const pointer = await readFile(join(path, ".git"), "utf8").catch(() => "");
    if (!/^gitdir:.*[\\/]worktrees[\\/]/u.test(pointer)) return null;
    const list = await git(path, ["worktree", "list", "--porcelain"]);
    if (list.code !== 0) return null;
    const blocks = list.out.split("\n\n");
    const main = blocks[0]?.match(/^worktree (.+)$/mu)?.[1];
    if (!main || main === path) return null;
    const own = blocks.find((block) => block.split("\n")[0] === `worktree ${path}`);
    const committed = Number.parseInt((await git(path, ["log", "-1", "--format=%ct"])).out, 10);
    if (!Number.isFinite(committed)) return null;
    const idleDays = Math.floor((this.#now() - committed * 1000) / DAY_MS);
    if (idleDays < ACTIVE_DAYS) return null;

    const merged = await this.#mergedIntoDefault(main, path);
    const reason: CleanupReason | null = merged ? "merged" : idleDays >= STALE_DAYS ? "stale" : null;
    if (!reason) return null;

    let blocker: CleanupBlocker | null = null;
    if (own?.split("\n").some((line) => line === "locked" || line.startsWith("locked "))) blocker = "locked";
    else if ((await git(path, ["status", "--porcelain"])).out !== "") blocker = "dirty";
    else if (
      !merged &&
      Number.parseInt((await git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).out, 10) > 0
    )
      blocker = "unpushed";

    return {
      path,
      repository: main,
      candidate: {
        id: candidateId(path),
        kind: "worktree",
        label: basename(path),
        detail: (await git(path, ["branch", "--show-current"])).out,
        bytes: 0,
        reason,
        idleDays,
        blocker,
      },
    };
  }

  async #mergedIntoDefault(main: string, worktree: string): Promise<boolean> {
    const head = await git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const candidates = [head.out, "origin/main", "origin/master", "main", "master"].filter((name) => name !== "");
    for (const name of candidates) {
      if ((await git(main, ["rev-parse", "--verify", "--quiet", name])).code !== 0) continue;
      return (await git(worktree, ["merge-base", "--is-ancestor", "HEAD", name])).code === 0;
    }
    return false;
  }
}
