// @vitest-environment node
// Launch maintenance: the rebuildable caches go, the rotated logs older than a week go, and nothing
// that holds work does. Failure modes: a cache left behind; a live log deleted; a missing directory
// stopping the rest. The site caches of a browser session go through the session only past a limit,
// and a session that refuses does not stop the next one.
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import { runStartupMaintenance, type SiteCacheSession, trimSiteCaches } from "./startup-maintenance";

const roots: string[] = [];

function logger() {
  return createBuildersBotLogger("startup-maintenance-test", () => undefined, "warn");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function profile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "startup-maintenance-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("runStartupMaintenance", () => {
  it("removes the rebuildable caches and keeps the rest of the profile", async () => {
    const root = await profile();
    await mkdir(join(root, "GPUCache", "nested"), { recursive: true });
    await writeFile(join(root, "GPUCache", "nested", "blob"), "x".repeat(2048));
    await writeFile(join(root, "openbot.db"), "database");
    await writeFile(join(root, "Local State"), "{}");

    await runStartupMaintenance(root, logger());

    expect(await exists(join(root, "GPUCache"))).toBe(false);
    expect(await exists(join(root, "openbot.db"))).toBe(true);
    expect(await exists(join(root, "Local State"))).toBe(true);
  });

  it("removes a stale rotated log and keeps the live one", async () => {
    const root = await profile();
    await mkdir(join(root, "logs", "main"), { recursive: true });
    await writeFile(join(root, "logs", "main", "main.log"), "live");
    await writeFile(join(root, "logs", "main", "main.log.1"), "rotated");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await (await import("node:fs/promises")).utimes(join(root, "logs", "main", "main.log.1"), old, old);

    await runStartupMaintenance(root, logger());

    expect(await exists(join(root, "logs", "main", "main.log"))).toBe(true);
    expect(await exists(join(root, "logs", "main", "main.log.1"))).toBe(false);
  });

  it("keeps a rotated log that is still recent", async () => {
    const root = await profile();
    await mkdir(join(root, "logs", "providers"), { recursive: true });
    await writeFile(join(root, "logs", "providers", "providers.log.1"), "rotated");

    await runStartupMaintenance(root, logger());

    expect(await exists(join(root, "logs", "providers", "providers.log.1"))).toBe(true);
  });

  it("survives a profile with no cache and no log directory", async () => {
    const root = await profile();
    await expect(runStartupMaintenance(root, logger())).resolves.toBeUndefined();
  });
});

describe("trimSiteCaches", () => {
  const LIMIT = 1024;

  /** A browser partition on disk, with a CacheStorage and a code cache of the given sizes. */
  async function partition(cacheStorageBytes: number, codeCacheBytes: number): Promise<string> {
    const root = await profile();
    await mkdir(join(root, "Service Worker", "CacheStorage", "origin"), { recursive: true });
    await writeFile(join(root, "Service Worker", "CacheStorage", "origin", "entry"), "x".repeat(cacheStorageBytes));
    await mkdir(join(root, "Code Cache", "js"), { recursive: true });
    await writeFile(join(root, "Code Cache", "js", "entry"), "x".repeat(codeCacheBytes));
    await writeFile(join(root, "Cookies"), "sign-in");
    return root;
  }

  function session(storagePath: string | null, fail = false) {
    const cleared: string[][] = [];
    let codeCaches = 0;
    const target: SiteCacheSession = {
      storagePath,
      clearStorageData: async (options) => {
        if (fail) throw new Error("refused");
        cleared.push([...(options?.storages ?? [])]);
      },
      clearCodeCaches: async () => {
        if (fail) throw new Error("refused");
        codeCaches += 1;
      },
    };
    return { target, cleared, codeCaches: () => codeCaches };
  }

  it("clears the CacheStorage, its service workers and the code cache of a session past the limit", async () => {
    const root = await partition(2 * LIMIT, 2 * LIMIT);
    const { target, cleared, codeCaches } = session(root);

    await trimSiteCaches([target], logger(), LIMIT);

    expect(cleared).toEqual([["cachestorage", "serviceworkers"]]);
    expect(codeCaches()).toBe(1);
    expect(await exists(join(root, "Cookies"))).toBe(true);
  });

  it("leaves a session under the limit as it is", async () => {
    const root = await partition(LIMIT / 2, LIMIT / 2);
    const { target, cleared, codeCaches } = session(root);

    await trimSiteCaches([target], logger(), LIMIT);

    expect(cleared).toEqual([]);
    expect(codeCaches()).toBe(0);
  });

  it("clears only the cache that went past the limit", async () => {
    const root = await partition(LIMIT / 2, 2 * LIMIT);
    const { target, cleared, codeCaches } = session(root);

    await trimSiteCaches([target], logger(), LIMIT);

    expect(cleared).toEqual([]);
    expect(codeCaches()).toBe(1);
  });

  it("skips a session with no folder, and goes on after a session that refuses", async () => {
    const memoryOnly = session(null);
    const refusing = session(await partition(2 * LIMIT, 2 * LIMIT), true);
    const next = session(await partition(2 * LIMIT, LIMIT / 2));

    await expect(
      trimSiteCaches([memoryOnly.target, refusing.target, next.target], logger(), LIMIT),
    ).resolves.toBeUndefined();

    expect(memoryOnly.cleared).toEqual([]);
    expect(next.cleared).toEqual([["cachestorage", "serviceworkers"]]);
  });
});
