import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@openbot/logging";

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
