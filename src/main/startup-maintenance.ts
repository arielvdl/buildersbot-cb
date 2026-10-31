import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@openbot/logging";
import type { Session } from "electron";

/**
 * The caches Chromium and the app rebuild on their own, thrown away on a launch so a profile does not
 * keep them for its life. Only directories that hold no user work: no chat, no attachment, no
 * sign-in, no site storage.
 *
 * The Storage settings page clears `caches` and `logs` by hand; this is the part that can happen
 * without asking, and it covers the directories that page does not reach.
 */
const REBUILDABLE_DIRECTORIES = ["GPUCache", "Code Cache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache"];

/** Old rotated logs. The live file of each is kept: only the `.1` a rotation left behind goes. */
const LOG_DIRECTORIES = ["logs/main", "logs/providers", "logs/agents", "logs/remote", "logs/update"];
const STALE_LOG_MS = 7 * 24 * 60 * 60 * 1000;

async function sizeOf(path: string): Promise<number> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) return entry.size;
    let total = 0;
    for (const child of await readdir(path, { withFileTypes: true })) {
      total += await sizeOf(join(path, child.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Runs after the window is up, so nothing here is on the first paint. Never throws: a cache that
 * cannot be removed is worth a log line, not a failed launch.
 */
export async function runStartupMaintenance(userDataPath: string, logger: Logger): Promise<void> {
  let freed = 0;
  for (const name of REBUILDABLE_DIRECTORIES) {
    const path = join(userDataPath, name);
    const bytes = await sizeOf(path);
    if (bytes === 0) continue;
    try {
      await rm(path, { recursive: true, force: true });
      freed += bytes;
    } catch (error) {
      logger.warn(`The ${name} cache could not be removed on launch.`, { error: String(error) });
    }
  }

  const cutoff = Date.now() - STALE_LOG_MS;
  for (const directory of LOG_DIRECTORIES) {
    const path = join(userDataPath, directory);
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch {
      continue;
    }
    for (const name of entries) {
      // A rotated log is named `<file>.1`; the active one has no suffix and is being written.
      if (!/\.\d+$/.test(name)) continue;
      const file = join(path, name);
      try {
        const entry = await stat(file);
        if (entry.mtimeMs > cutoff) continue;
        freed += entry.size;
        await rm(file, { force: true });
      } catch {
        // Gone or unreadable between the listing and the read.
      }
    }
  }

  if (freed > 0) logger.info(`Startup maintenance freed ${Math.round(freed / 1024)} KB of rebuildable files.`);
}

/**
 * The most bytes of one site cache in a browser partition before a launch clears it. The CacheStorage
 * of service workers has no limit but the storage quota of Chromium, and it grew past 130 MB for one
 * site in under two days (#8 of the performance review). The HTTP cache has a limit of its own in
 * Chromium, so it is not cleared here.
 */
const SITE_CACHE_LIMIT_BYTES = 100 * 1024 * 1024;

/** A browser session that keeps site data on disk, as the site cache trim needs it. */
export type SiteCacheSession = Pick<Session, "storagePath" | "clearStorageData" | "clearCodeCaches">;

/**
 * Clears the site caches of each persistent browser session that went past the limit: the CacheStorage
 * with its service workers, and the V8 code cache. Cookies, local storage and IndexedDB stay, so no
 * sign-in goes. A page registers its service worker again on the next visit, and the first load of
 * such a site is slower once. It goes through the session, not the file system, because the session is
 * open. Runs after the window is up and never throws.
 */
export async function trimSiteCaches(
  sessions: readonly SiteCacheSession[],
  logger: Logger,
  limitBytes = SITE_CACHE_LIMIT_BYTES,
): Promise<void> {
  let freed = 0;
  for (const target of sessions) {
    const root = target.storagePath;
    if (!root) continue;
    const cacheStorage = await sizeOf(join(root, "Service Worker", "CacheStorage"));
    if (cacheStorage > limitBytes) {
      try {
        await target.clearStorageData({ storages: ["cachestorage", "serviceworkers"] });
        freed += cacheStorage;
      } catch (error) {
        logger.warn("The site cache of a browser session could not be cleared on launch.", { error: String(error) });
      }
    }
    const codeCache = await sizeOf(join(root, "Code Cache"));
    if (codeCache > limitBytes) {
      try {
        await target.clearCodeCaches({});
        freed += codeCache;
      } catch (error) {
        logger.warn("The code cache of a browser session could not be cleared on launch.", { error: String(error) });
      }
    }
  }
  if (freed > 0) logger.info(`Startup maintenance freed ${Math.round(freed / 1024)} KB of browser site caches.`);
}
