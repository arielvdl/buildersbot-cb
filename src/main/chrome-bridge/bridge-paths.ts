/**
 * Where the app listens for the Chrome host, computed the way the host computes it
 * (`native/chrome-host/main.swift`, `socketPath`), never from a setting that an agent could change:
 *
 * - store and dev: `~/Library/Application Support/Builders Bot/cb/b.sock` (`b-dev.sock` for dev);
 * - e2e: `<per-user temporary folder>/bb-e2e/b-e2e.sock`, so a test never writes in the app's folder;
 * - a path above 103 bytes (the `sun_path` of macOS holds 104 with its terminator) moves to
 *   `<per-user temporary folder>/bb/`. That folder (`confstr(_CS_DARWIN_USER_TEMP_DIR)`) belongs to the
 *   user and only the user can enter it. Never `/tmp`.
 *
 * The folder must be a real folder of this user that no one else can enter (mode 0700). The app makes
 * it so when it creates it, and refuses to listen in one that is not.
 */

import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChromeBridgeChannel } from "@openbot/contracts/chrome-bridge/extension-ids";

export interface BridgeSocket {
  readonly folder: string;
  readonly path: string;
}

const MAX_SOCKET_PATH_BYTES = 103;

/** The per-user temporary folder of macOS, as `confstr` gives it: not `$TMPDIR`, which a parent can set. */
export function darwinUserTempDir(): string {
  const folder = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  if (!folder.startsWith("/")) throw new Error("getconf gave no per-user temporary folder.");
  return folder.endsWith("/") ? folder.slice(0, -1) : folder;
}

export function bridgeSocket(
  channel: ChromeBridgeChannel,
  locations: { readonly home?: string; readonly tempDir?: () => string } = {},
): BridgeSocket {
  const name = channel === "store" ? "b.sock" : `b-${channel}.sock`;
  const tempDir = locations.tempDir ?? darwinUserTempDir;
  let folder =
    channel === "e2e"
      ? join(tempDir(), "bb-e2e")
      : join(locations.home ?? homedir(), "Library", "Application Support", "Builders Bot", "cb");
  if (Buffer.byteLength(join(folder, name)) > MAX_SOCKET_PATH_BYTES) folder = join(tempDir(), "bb");
  return { folder, path: join(folder, name) };
}

/**
 * Makes the socket folder if it is missing (mode 0700), then checks it: a real folder, not a link,
 * owned by this user, and closed to the group and to others. A folder that fails is never repaired
 * here: another user or program made it, and the app does not listen in it.
 */
export async function preparePrivateFolder(folder: string): Promise<void> {
  await mkdir(dirname(folder), { recursive: true });
  try {
    await mkdir(folder, { mode: 0o700 });
    // The process umask can only remove bits, but `mkdir` may have kept fewer than asked; set them.
    await chmod(folder, 0o700);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stats = await lstat(folder);
  if (!stats.isDirectory()) throw new Error("The Chrome bridge folder is not a folder.");
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error("The Chrome bridge folder belongs to another user.");
  if ((stats.mode & 0o077) !== 0) throw new Error("Other users can open the Chrome bridge folder.");
}
