// @vitest-environment node
// Launch maintenance: the rebuildable caches go, the rotated logs older than a week go, and nothing
// that holds work does. Failure modes: a cache left behind; a live log deleted; a missing directory
// stopping the rest. The site caches of a browser session go through the session only past a limit,
// the CacheStorage only for the origin past it, and a session that refuses does not stop the next one.
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheStorageIndexOrigin,
  runStartupMaintenance,
  type SiteCacheSession,
  trimSiteCaches,
} from "./startup-maintenance";

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

  /** One length-delimited protobuf field. Each value here is shorter than 128 bytes. */
  function field(tag: number, value: Uint8Array): number[] {
    return [tag, value.length, ...value];
  }

  function text(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  }

  /**
   * The `index.txt` that Chromium writes for the CacheStorage of one origin. The name of the cache holds
   * the URL of another site, as a Workbox precache does.
   */
  function indexFile(origin: string): Uint8Array {
    const cache = Uint8Array.from([
      ...field(0x0a, text("workbox-precache-v2-https://other.example/")),
      ...field(0x12, text("3a23d644-9995-4832-81b4-d21f58c08628")),
    ]);
    return Uint8Array.from([
      ...field(0x0a, cache),
      ...field(0x12, text(origin)),
      ...field(0x1a, text(origin)),
      0x20,
      0x02,
      0x28,
      0x01,
    ]);
  }

  /**
   * A browser partition on disk: one CacheStorage folder for each site, of the given size, and a code
   * cache. A site with a null origin has no `index.txt`.
   */
  async function partition(sites: Array<{ origin: string | null; bytes: number }>, codeCacheBytes: number) {
    const root = await profile();
    for (const [index, site] of sites.entries()) {
      const folder = join(root, "Service Worker", "CacheStorage", `origin-${index}`);
      await mkdir(folder, { recursive: true });
      if (site.origin) await writeFile(join(folder, "index.txt"), indexFile(site.origin));
      await writeFile(join(folder, "entry"), "x".repeat(site.bytes));
    }
    await mkdir(join(root, "Code Cache", "js"), { recursive: true });
    await writeFile(join(root, "Code Cache", "js", "entry"), "x".repeat(codeCacheBytes));
    await writeFile(join(root, "Cookies"), "sign-in");
    return root;
  }

  function session(storagePath: string | null, fail = false) {
    const cleared: Array<{ origin: string | undefined; storages: string[] }> = [];
    let codeCaches = 0;
    const target: SiteCacheSession = {
      storagePath,
      clearStorageData: async (options) => {
        if (fail) throw new Error("refused");
        cleared.push({ origin: options?.origin, storages: [...(options?.storages ?? [])] });
      },
      clearCodeCaches: async () => {
        if (fail) throw new Error("refused");
        codeCaches += 1;
      },
    };
    return { target, cleared, codeCaches: () => codeCaches };
  }

  it("clears the CacheStorage and the service workers of the one origin past the limit, and keeps the other origins", async () => {
    const root = await partition(
      [
        { origin: "https://x.com/", bytes: 2 * LIMIT },
        { origin: "https://www.remessaonline.com.br/", bytes: LIMIT / 2 },
      ],
      LIMIT / 2,
    );
    const { target, cleared, codeCaches } = session(root);

    await trimSiteCaches([target], logger(), LIMIT);

    expect(cleared).toEqual([{ origin: "https://x.com", storages: ["cachestorage", "serviceworkers"] }]);
    expect(codeCaches()).toBe(0);
    expect(await exists(join(root, "Cookies"))).toBe(true);
  });

  it("reads the origin from the index, never from the name of a cache", () => {
    expect(cacheStorageIndexOrigin(indexFile("https://x.com/"))).toBe("https://x.com");
    expect(cacheStorageIndexOrigin(indexFile("chrome-extension://abc/"))).toBeNull();
    expect(cacheStorageIndexOrigin(Uint8Array.from([0x12, 0x40, 0x68]))).toBeNull();
    expect(cacheStorageIndexOrigin(new Uint8Array())).toBeNull();
  });

  it("leaves a session under the limit as it is", async () => {
    const root = await partition([{ origin: "https://x.com/", bytes: LIMIT / 2 }], LIMIT / 2);
    const { target, cleared, codeCaches } = session(root);

    await trimSiteCaches([target], logger(), LIMIT);

    expect(cleared).toEqual([]);
    expect(codeCaches()).toBe(0);
  });

  it("clears only the cache that went past the limit", async () => {
    const root = await partition([{ origin: "https://x.com/", bytes: LIMIT / 2 }], 2 * LIMIT);
    const { target, cleared, codeCaches } = session(root);

    await trimSiteCaches([target], logger(), LIMIT);

    expect(cleared).toEqual([]);
    expect(codeCaches()).toBe(1);
  });

  it("keeps a site cache past the limit whose origin cannot be read", async () => {
    const root = await partition([{ origin: null, bytes: 2 * LIMIT }], LIMIT / 2);
    const { target, cleared } = session(root);

    await trimSiteCaches([target], logger(), LIMIT);

    expect(cleared).toEqual([]);
  });

  it("skips a session with no folder, and goes on after a session that refuses", async () => {
    const memoryOnly = session(null);
    const refusing = session(await partition([{ origin: "https://x.com/", bytes: 2 * LIMIT }], 2 * LIMIT), true);
    const next = session(await partition([{ origin: "https://x.com/", bytes: 2 * LIMIT }], LIMIT / 2));

    await expect(
      trimSiteCaches([memoryOnly.target, refusing.target, next.target], logger(), LIMIT),
    ).resolves.toBeUndefined();

    expect(memoryOnly.cleared).toEqual([]);
    expect(next.cleared).toEqual([{ origin: "https://x.com", storages: ["cachestorage", "serviceworkers"] }]);
  });
});
