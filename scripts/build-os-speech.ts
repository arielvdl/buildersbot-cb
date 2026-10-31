import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";

// The system dictation of macOS, built into the voice folder the app reads at run time:
// `.openbot-build/voice/os-speech/darwin/os-speech`.
//
// The binary carries its own Info.plist section, so the Speech framework finds the usage sentence
// even when macOS attributes the permission to the binary instead of the app. It is signed ad hoc
// here and re-signed with the app when electron-builder packs it.
//
// The Windows engine needs no build: it runs a PowerShell script that main carries as text.

const logger = createBuildersBotLogger("build-os-speech");

const source = resolve("resources/os-speech/darwin/os-speech.swift");
const plist = resolve("resources/os-speech/darwin/info.plist");
const output = resolve(".openbot-build/voice/os-speech/darwin/os-speech");

if (process.platform !== "darwin") {
  logger.info("The system dictation is built on macOS only; nothing to do.");
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.new`;
rmSync(temporary, { force: true });
execFileSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-O",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13`,
    source,
    "-o",
    temporary,
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    plist,
  ],
  { stdio: "inherit" },
);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", temporary], { stdio: "inherit" });
chmodSync(temporary, 0o755);
renameSync(temporary, output);
copyFileSync(plist, resolve(dirname(output), "info.plist"));
logger.info("The system dictation is built.", { output });
