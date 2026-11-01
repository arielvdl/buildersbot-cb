import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";

// The system dictation of macOS, built as a tiny background application in the voice folder the
// app reads at run time:
// `.openbot-build/voice/os-speech/darwin/Builders Bot Dictation.app`.
//
// It is an application and not a plain binary because the speech recognition permission belongs to
// a bundle: opened with `open`, macOS attributes it to this app, whose Info.plist carries the usage
// sentence and `LSUIElement`. A plain child process of the app aborts in TCC.
//
// The bundle is signed ad hoc here and re-signed with the app when electron-builder packs it.
//
// The Windows engine needs no build: it runs a PowerShell script that main carries as text.

const logger = createBuildersBotLogger("build-os-speech");

const source = resolve("resources/os-speech/darwin/os-speech.swift");
const plist = resolve("resources/os-speech/darwin/info.plist");
const output = resolve(".openbot-build/voice/os-speech/darwin/Builders Bot Dictation.app");

if (process.platform !== "darwin") {
  logger.info("The system dictation is built on macOS only; nothing to do.");
  process.exit(0);
}

const temporary = `${output}.new`;
rmSync(temporary, { recursive: true, force: true });
mkdirSync(join(temporary, "Contents", "MacOS"), { recursive: true });
const binary = join(temporary, "Contents", "MacOS", "os-speech");

execFileSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-O",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13`,
    source,
    "-o",
    binary,
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
cpSync(plist, join(temporary, "Contents", "Info.plist"));
chmodSync(binary, 0o755);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", temporary], { stdio: "inherit" });
rmSync(output, { recursive: true, force: true });
renameSync(temporary, output);
// The plain binary and its plist of earlier builds would be packed beside the app.
rmSync(join(dirname(output), "os-speech"), { force: true });
rmSync(join(dirname(output), "info.plist"), { force: true });
logger.info("The system dictation is built.", { output });
