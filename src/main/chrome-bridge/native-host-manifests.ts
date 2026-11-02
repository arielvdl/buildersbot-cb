/**
 * The Native Messaging manifest that tells Chrome where the host is (DESIGN §8.5). Only the app writes
 * it, and only after the person's click on "Connect Chrome"; it is removed when they turn "My Chrome"
 * off. It names one extension origin, and the real host path of the installed app.
 *
 * Rules that this module enforces, not the caller:
 *
 * - no manifest points into an App Translocation path (a random, read-only copy that disappears);
 * - a build that is not packaged never writes into a real browser's folder (`Google/Chrome`,
 *   `BraveSoftware`, `Microsoft Edge`, `Chromium`), unless the owner set
 *   `OPENBOT_CHROME_BRIDGE_REAL_CHROME=1`. Development and E2E write only in a test profile, whose
 *   Native Messaging folder is `<user-data-dir>/NativeMessagingHosts`;
 * - the file is written whole (a temporary file, then a rename) with mode 0600, never through a link.
 *
 * The app checks the file at each start, at each host connection and, during a pairing window, at each
 * change (`watchNativeHostManifest`): a change cancels the window. The cipher and the person's choice
 * of the words make a replaced host useless anyway (DESIGN §3.4).
 */

import { randomBytes } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extensionOrigin } from "@openbot/contracts/chrome-bridge/extension-ids";

/** The per-user Native Messaging folders of the browsers that the app may write to, under the home folder. */
export const BROWSER_MANIFEST_FOLDERS = {
  "google-chrome": "Library/Application Support/Google/Chrome/NativeMessagingHosts",
  "google-chrome-beta": "Library/Application Support/Google/Chrome Beta/NativeMessagingHosts",
  "google-chrome-dev": "Library/Application Support/Google/Chrome Dev/NativeMessagingHosts",
  "google-chrome-canary": "Library/Application Support/Google/Chrome Canary/NativeMessagingHosts",
} as const;

const REAL_BROWSER_ROOTS = [
  "Library/Application Support/Google",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Chromium",
];

const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/u;

export interface NativeHostManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly string[];
}

export function nativeHostManifest(input: { name: string; hostPath: string; extensionId: string }): NativeHostManifest {
  if (!HOST_NAME.test(input.name)) throw new Error("A Native Messaging host name is lowercase words with dots.");
  if (!isAbsolute(input.hostPath)) throw new Error("The host path must be absolute.");
  if (input.hostPath.includes("/AppTranslocation/"))
    throw new Error("Builders Bot runs from a translocated copy: move it to Applications first.");
  return {
    name: input.name,
    description: "Builders Bot",
    path: input.hostPath,
    type: "stdio",
    allowed_origins: [extensionOrigin(input.extensionId)],
  };
}

function inside(folder: string, root: string): boolean {
  const path = relative(root, folder);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Whether a folder belongs to a real browser of the person, where development builds never write. */
export function isRealBrowserFolder(folder: string, home = homedir()): boolean {
  const target = resolve(folder);
  return REAL_BROWSER_ROOTS.some((root) => inside(target, join(home, root)));
}

export function manifestPath(folder: string, name: string): string {
  return join(folder, `${name}.json`);
}

/**
 * Writes the manifest into `folder`. `packaged` is `app.isPackaged`; `allowRealBrowser` is the owner's
 * explicit `OPENBOT_CHROME_BRIDGE_REAL_CHROME=1`. Returns the file path.
 */
export async function writeNativeHostManifest(input: {
  folder: string;
  manifest: NativeHostManifest;
  packaged: boolean;
  allowRealBrowser: boolean;
  home?: string;
}): Promise<string> {
  const folder = resolve(input.folder);
  if (isRealBrowserFolder(folder, input.home) && !input.packaged && !input.allowRealBrowser)
    throw new Error("A development build does not write into a real browser's folder.");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const target = manifestPath(folder, input.manifest.name);
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isFile()) throw new Error("The Native Messaging manifest path is not a plain file.");
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(input.manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  return target;
}

/** "ok" when the file holds exactly this manifest; "missing" or "changed" otherwise. */
export async function checkNativeHostManifest(
  folder: string,
  manifest: NativeHostManifest,
): Promise<"ok" | "missing" | "changed"> {
  const target = manifestPath(resolve(folder), manifest.name);
  const stats = await lstat(target).catch(() => null);
  if (!stats) return "missing";
  if (!stats.isFile()) return "changed";
  try {
    return JSON.stringify(JSON.parse(await readFile(target, "utf8"))) === JSON.stringify(manifest) ? "ok" : "changed";
  } catch {
    return "changed";
  }
}

export async function removeNativeHostManifest(folder: string, name: string): Promise<void> {
  const target = manifestPath(resolve(folder), name);
  const stats = await lstat(target).catch(() => null);
  if (stats?.isFile()) await rm(target);
}

/**
 * Calls `onChange` when anything in the manifest's folder changes the manifest file, for the length of
 * a pairing window. Returns the function that stops the watch.
 */
export function watchNativeHostManifest(folder: string, name: string, onChange: () => void): () => void {
  const file = `${name}.json`;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(resolve(folder), { persistent: false }, (_event, changed) => {
      if (changed === null || changed === file) onChange();
    });
  } catch {
    onChange();
  }
  return () => watcher?.close();
}
