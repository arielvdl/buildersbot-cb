import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CleanupService, findWorktreeFolders } from "./cleanup-service";

const DAY = 86_400_000;
let base: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "bb-cleanup-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function repository(): string {
  const repo = join(base, "work", "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

describe("worktree cleanup", () => {
  it("finds a linked worktree and not a clone", async () => {
    const repo = repository();
    git(repo, "worktree", "add", "-q", "-b", "feature", join(base, "work", "wt-feature"));
    expect(await findWorktreeFolders([join(base, "work")])).toEqual([join(base, "work", "wt-feature")]);
  });

  it("offers a merged worktree that is idle, and a stale unmerged one, and keeps the recent one out", async () => {
    const repo = repository();
    const merged = join(base, "work", "wt-merged");
    const stale = join(base, "work", "wt-stale");
    git(repo, "worktree", "add", "-q", "-b", "done", merged);
    git(repo, "worktree", "add", "-q", "-b", "old", stale);
    writeFileSync(join(stale, "b.txt"), "b");
    git(stale, "add", "-A");
    git(stale, "commit", "-q", "-m", "work");
    const now = Date.now();
    const service = new CleanupService({
      roots: [join(base, "work")],
      userDataPath: join(base, "data", "Builders Bot"),
      trash: async () => undefined,
      now: () => now + 40 * DAY,
    });
    const { candidates } = await service.scan();
    const byLabel = Object.fromEntries(candidates.map((candidate) => [candidate.label, candidate]));
    expect(byLabel["wt-merged"]).toMatchObject({ reason: "merged", detail: "done", blocker: null });
    expect(byLabel["wt-stale"]).toMatchObject({ reason: "stale", detail: "old", blocker: "unpushed" });

    const today = new CleanupService({
      roots: [join(base, "work")],
      userDataPath: join(base, "data", "Builders Bot"),
      trash: async () => undefined,
      now: () => now,
    });
    expect((await today.scan()).candidates).toEqual([]);
  });

  it("refuses to remove a worktree that got changes after the scan", async () => {
    const repo = repository();
    const wt = join(base, "work", "wt-merged");
    git(repo, "worktree", "add", "-q", "-b", "done", wt);
    const trash = vi.fn(async () => undefined);
    const service = new CleanupService({
      roots: [join(base, "work")],
      userDataPath: join(base, "data", "Builders Bot"),
      trash,
      now: () => Date.now() + 40 * DAY,
    });
    const [candidate] = (await service.scan()).candidates;
    expect(candidate?.blocker).toBeNull();
    writeFileSync(join(wt, "dirty.txt"), "x");
    expect(await service.remove(candidate?.id ?? "")).toBe(false);
    expect(trash).not.toHaveBeenCalled();
    rmSync(join(wt, "dirty.txt"));
    expect(await service.remove(candidate?.id ?? "")).toBe(true);
    expect(trash).toHaveBeenCalledWith(wt);
  });

  it("knows no id it did not scan", async () => {
    const service = new CleanupService({ roots: [], userDataPath: join(base, "x"), trash: vi.fn() });
    expect(await service.remove("deadbeef")).toBe(false);
  });

  it("offers an old development data folder, never the one in use", async () => {
    const data = join(base, "Application Support");
    const old = join(data, `Builders Bot Dev wt-${"a".repeat(64)}`);
    const current = join(data, `Builders Bot Dev wt-${"b".repeat(64)}`);
    mkdirSync(old, { recursive: true });
    mkdirSync(current, { recursive: true });
    const longAgo = new Date(Date.now() - 20 * DAY);
    utimesSync(old, longAgo, longAgo);
    utimesSync(current, longAgo, longAgo);
    const service = new CleanupService({ roots: [], userDataPath: current, trash: async () => undefined });
    const { candidates } = await service.scan();
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["dev-profile"]);
    expect(candidates[0]?.label).toBe(`Builders Bot Dev wt-${"a".repeat(64)}`);
  });
});
