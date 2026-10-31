import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { HostManagerOperations } from "../src/main/host-manager";
import { verifyHostDirectory } from "../src/main/host-update-files";

const exec = promisify(execFile);
export const SHARED_APP = "/Applications/OpenBot.app";
const STAGING = "/Applications/.openbot-host-stage";
const SIGNING_REQUIREMENT =
  '=anchor apple generic and identifier "app.openbot.desktop" and certificate leaf[subject.OU] = "ZTRDTUL87R"';

export async function hostCommand(file: string, args: string[], timeout = 60_000): Promise<string> {
  const result = await exec(file, args, {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  return result.stdout.trim();
}
const command = hostCommand;

/** The system Applications directory normally permits administrators (group 80) to install apps. */
export async function verifySharedAppParent(): Promise<void> {
  await verifyHostPath("/");
  const info = await lstat("/Applications");
  if (
    !info.isDirectory() ||
    info.uid !== 0 ||
    (info.mode & 0o002) !== 0 ||
    ((info.mode & 0o020) !== 0 && info.gid !== 80)
  )
    throw new Error("Unsafe Applications directory.");
  await verifyNoWriteAcl("/Applications");
}

export async function verifyNoWriteAcl(path: string): Promise<void> {
  const output = await command("/bin/ls", ["-lde", path]);
  if (
    output
      .split("\n")
      .some((line) =>
        /\d+:.*\ballow\b.*\b(write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)\b/.test(
          line,
        ),
      )
  ) {
    throw new Error("Writable ACL is not permitted on host paths.");
  }
}

export async function verifyHostPath(path: string): Promise<void> {
  if (resolve(path) === "/Applications") return verifySharedAppParent();
  if (resolve(path) === STAGING) {
    await verifySharedAppParent();
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error("Unsafe application staging directory.");
    await verifyNoWriteAcl(path);
    return;
  }
  await runCauseEffect(verifyHostDirectory(path));
  for (let part = resolve(path); ; part = dirname(part)) {
    await verifyNoWriteAcl(part);
    if (dirname(part) === part) break;
  }
}

export async function ensureHostDirectory(path: string, mode: number): Promise<void> {
  await verifyHostPath(dirname(path));
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await verifyHostPath(path);
  await chmod(path, mode);
}

/** Only visits the application bundle. Internal framework symlinks are valid; external links are not. */
export async function verifyBundleTree(root: string, requireRootOwner: boolean): Promise<void> {
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path));
      if (!target.startsWith(`${root}${sep}`)) throw new Error("Bundle contains an external symlink.");
      return;
    }
    if (!info.isFile() && !info.isDirectory()) throw new Error("Unexpected bundle file type.");
    if (info.isFile() && info.nlink !== 1) throw new Error("Bundle contains hard-linked files.");
    if (requireRootOwner && (info.uid !== 0 || (info.mode & 0o022) !== 0))
      throw new Error("Bundle is writable by tenants.");
    if (info.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry));
  };
  if (!(await lstat(root)).isDirectory()) throw new Error("Application must be a real directory.");
  await walk(root);
  // A single recursive listing checks bundle ACLs without launching a process for every file.
  const acl = await command("/bin/ls", ["-leR", root]);
  if (acl.split("\n").some((line) => /^\s*\d+:.*\ballow\b/.test(line)))
    throw new Error("Bundle has access-granting ACLs.");
}

export async function verifySignature(app: string): Promise<void> {
  await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", SIGNING_REQUIREMENT, app]);
  await command("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
}

export async function bundleVersion(app = SHARED_APP): Promise<string> {
  return command("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleShortVersionString",
    join(app, "Contents/Info.plist"),
  ]);
}

export async function bundleProcesses(): Promise<Array<{ uid: number; pid: number; main: boolean }>> {
  // comm reports executable paths, without workspace paths or prompts in command arguments.
  const output = await command("/bin/ps", ["-axo", "pid=,uid=,comm="]);
  if (!output) throw new Error("Process scan returned no processes.");
  const processes: Array<{ uid: number; pid: number; main: boolean }> = [];
  for (const line of output.split("\n")) {
    const [, pid, uid, executable] = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line) ?? [];
    if (executable === undefined) throw new Error("Invalid process scan.");
    if (executable.startsWith(`${SHARED_APP}/`))
      processes.push({
        pid: Number(pid),
        uid: Number(uid),
        main: executable === `${SHARED_APP}/Contents/MacOS/OpenBot`,
      });
  }
  return processes;
}

export async function runningOpenBotProcesses(): Promise<Array<{ uid: number; pid: number }>> {
  return (await bundleProcesses()).filter((process) => process.main).map(({ uid, pid }) => ({ uid, pid }));
}

export function macHostOperations(): HostManagerOperations {
  return {
    runningTenants: runningOpenBotProcesses,
    applicationInUse: async () => (await bundleProcesses()).length !== 0,
    installedVersion: async () => {
      await verifyBundleTree(SHARED_APP, true);
      await verifySignature(SHARED_APP);
      return bundleVersion();
    },
    // The Host Manager came from the upstream app: this step read the upstream OpenBot release and
    // installed its DMG. Builders Bot has no release feed yet (phase 0 of the update design), so the
    // Host Manager finds no release, sends no request and installs nothing. This stays so also when a
    // release feed is allowed: a Builders Bot version of these steps must read the signed Builders Bot
    // feed and check the Builders Bot signature.
    stageLatest: async () => null,
    install: async () => {
      throw new Error("Updates are not available in this version of Builders Bot.");
    },
  };
}

export function isNewerRelease(candidate: string, current: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error("Installed version is not a stable release.");
  const next = candidate.split(".").map(Number);
  const previous = current.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const nextPart = next[index] ?? 0;
    const previousPart = previous[index] ?? 0;
    if (nextPart !== previousPart) return nextPart > previousPart;
  }
  return false;
}

export async function openSharedApplication(): Promise<void> {
  await command("/usr/bin/open", ["-a", SHARED_APP]);
}
