import { readdir, readFile, rm, stat } from "node:fs/promises";
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
const REBUILDABLE_DIRECTORIES = ["GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache"];

/**
 * `Code Cache` holds the V8 code cache of the app's own bundle (`openbot-app` sets `codeCache`), which
 * saves the compile work of each window from the second launch on, so it stays while it is below this
 * size. Old builds leave entries that nothing reads again, and the limit removes them.
 */
const CODE_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;

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
export async function runStartupMaintenance(
  userDataPath: string,
  logger: Logger,
  codeCacheLimitBytes = CODE_CACHE_LIMIT_BYTES,
): Promise<void> {
  let freed = 0;
  const removable = [
    ...REBUILDABLE_DIRECTORIES.map((name) => ({ name, limitBytes: 0 })),
    { name: "Code Cache", limitBytes: codeCacheLimitBytes },
  ];
  for (const { name, limitBytes } of removable) {
    const path = join(userDataPath, name);
    const bytes = await sizeOf(path);
    if (bytes <= limitBytes) continue;
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
 * The most bytes of one site cache before a launch clears it: the CacheStorage of one origin, or the
 * code cache of one browser partition. The CacheStorage of service workers has no limit but the storage
 * quota of Chromium, and it grew past 130 MB for one site in under two days (#8 of the performance
 * review). The HTTP cache has a limit of its own in Chromium, so it is not cleared here.
 */
const SITE_CACHE_LIMIT_BYTES = 100 * 1024 * 1024;

/** A browser session that keeps site data on disk, as the site cache trim needs it. */
export type SiteCacheSession = Pick<Session, "storagePath" | "clearStorageData" | "clearCodeCaches">;

/**
 * Reads the origin from the `index.txt` of one CacheStorage folder. Chromium writes that file as the
 * protobuf `CacheStorageIndex`: field 1 holds each cache (its name can hold any URL), and field 2 holds
 * the origin as text, as `https://x.com/`. Only the top level is read, so the name of a cache never
 * gives the origin. Returns null for a file that is not that shape or for an origin that is not HTTP.
 */
export function cacheStorageIndexOrigin(bytes: Uint8Array): string | null {
  let offset = 0;
  const varint = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset];
      if (byte === undefined) return null;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return null;
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (tag === null) return null;
    const wireType = tag % 8;
    if (wireType === 0) {
      if (varint() === null) return null;
    } else if (wireType === 1) offset += 8;
    else if (wireType === 5) offset += 4;
    else if (wireType === 2) {
      const length = varint();
      if (length === null || offset + length > bytes.length) return null;
      if (Math.floor(tag / 8) === 2) {
        const text = new TextDecoder().decode(bytes.subarray(offset, offset + length));
        if (!URL.canParse(text)) return null;
        const url = new URL(text);
        return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
      }
      offset += length;
    } else return null;
  }
  return null;
}

/**
 * Clears the site caches that went past the limit in each persistent browser session. For each origin
 * whose CacheStorage is past the limit, it clears the CacheStorage and the service workers of that
 * origin only; the other origins keep theirs. When the code cache of the session is past the limit, it
 * clears the code cache of all the sites of the session. Cookies, local storage and IndexedDB stay, so
 * no sign-in goes. A page registers its service worker again on the next visit, and the first load of
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
    const cacheStorage = join(root, "Service Worker", "CacheStorage");
    const folders = await readdir(cacheStorage, { withFileTypes: true }).catch(() => []);
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const path = join(cacheStorage, folder.name);
      const bytes = await sizeOf(path);
      if (bytes <= limitBytes) continue;
      const origin = await readFile(join(path, "index.txt")).then(cacheStorageIndexOrigin, () => null);
      // The origin is a visited site, so it does not go in the log.
      if (!origin) {
        logger.warn("A site cache of a browser session has no origin that can be read, so it stays.");
        continue;
      }
      try {
        await target.clearStorageData({ origin, storages: ["cachestorage", "serviceworkers"] });
        freed += bytes;
      } catch (error) {
        logger.warn("A site cache of a browser session could not be cleared on launch.", { error: String(error) });
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
