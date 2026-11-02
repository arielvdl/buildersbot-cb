/**
 * Builds the `chrome-peer` Node-API addon (`native/chrome-peer/peer.c`): the app asks it who is on the
 * other side of a Chrome host connection before it reads a byte (DESIGN §6.1).
 *
 *   bun scripts/build-chrome-peer.ts [--arch arm64|x64] [--out <folder>] [--sign-identity "<identity>"]
 *
 * It needs no Node or Electron headers: the addon declares the stable Node-API functions it uses, and
 * they resolve when Node, Bun or Electron loads it. Without an identity it is signed ad hoc; a packaged
 * app signs it with the app identity, like its other native addons.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { arch as hostArch } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

export function buildChromePeer(options: { arch?: "arm64" | "x64"; out?: string; signIdentity?: string } = {}) {
  if (process.platform !== "darwin") throw new Error("The chrome-peer addon is built on macOS only.");
  const arch = options.arch ?? (hostArch() === "arm64" ? "arm64" : "x64");
  const folder = resolve(options.out ?? join(ROOT, ".buildersbot-build/chrome-peer", arch));
  mkdirSync(folder, { recursive: true });
  const addon = join(folder, "chrome-peer.node");
  execFileSync(
    "/usr/bin/xcrun",
    [
      "clang",
      "-O2",
      "-Wall",
      "-Werror",
      "-shared",
      "-fvisibility=hidden",
      "-arch",
      arch === "arm64" ? "arm64" : "x86_64",
      "-mmacosx-version-min=13.0",
      "-undefined",
      "dynamic_lookup",
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      "-lbsm",
      join(ROOT, "native/chrome-peer/peer.c"),
      "-o",
      addon,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  execFileSync(
    "/usr/bin/codesign",
    options.signIdentity
      ? ["--force", "--sign", options.signIdentity, "--timestamp", "--options", "runtime", addon]
      : ["--force", "--sign", "-", addon],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return { arch, addon };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const archOption = value("--arch");
  const build = buildChromePeer({
    arch: archOption === "x64" || archOption === "arm64" ? archOption : undefined,
    out: value("--out"),
    signIdentity: value("--sign-identity"),
  });
  process.stdout.write(`${JSON.stringify(build, null, 2)}\n`);
}
