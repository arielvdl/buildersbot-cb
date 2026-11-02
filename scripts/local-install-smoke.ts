// Runs `scripts/sign-local-macos.sh --install` against a fake app bundle and a fake /Applications,
// and checks the install step:
//
// - after each install, the install folder holds one copy of the app (the new one) and no new
//   `.bak-*` copy;
// - the copy that was installed before goes to the Trash, with the macOS `trash` tool or, when that
//   tool is missing, with a rename into ~/.Trash;
// - a dated backup that an earlier version of the script left is listed and kept;
// - the data folder (~/Library/Application Support/Builders Bot) is not changed;
// - a build with no `chrome-peer` addon gets no Chrome host (the protocol smoke, section D, checks the
//   host that a build with the addon gets).
//
// It needs no build, no signing identity and no network. `security`, `codesign`, `osascript` and
// `trash` are stubs on PATH, so the test never signs, quits or opens the real app and never moves a
// file into the real Trash. macOS only, because the script uses `cp -c` (clonefile).
//
// Usage: bun scripts/local-install-smoke.ts
// It writes .openbot-build/local-install/report.json and exits with 1 when a check fails.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";

const logger = createBuildersBotLogger("local-install-smoke");

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts/sign-local-macos.sh");
const REPORT_PATH = join(ROOT, ".openbot-build/local-install/report.json");
const APP_NAME = "Builders Bot.app";
const OLD_BACKUP = `${APP_NAME}.bak-20261031-012928`;

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function makeApp(path: string, marker: string): void {
  // The signing step expects at least one framework and one helper app, as a real build has.
  mkdirSync(join(path, "Contents/Frameworks/Electron Framework.framework"), { recursive: true });
  mkdirSync(join(path, "Contents/Frameworks/Builders Bot Helper.app"), { recursive: true });
  mkdirSync(join(path, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(path, "Contents/MacOS/Builders Bot"), "binary");
  writeFileSync(join(path, "Contents/marker.txt"), marker);
}

function marker(appPath: string): string {
  return readFileSync(join(appPath, "Contents/marker.txt"), "utf8");
}

if (process.platform !== "darwin") {
  logger.info("The local install smoke test runs on macOS only. Skipped.");
  process.exit(0);
}

const workRoot = mkdtempSync(join(tmpdir(), "builders-bot-local-install-"));
try {
  const stubs = join(workRoot, "bin");
  const installRoot = join(workRoot, "Applications");
  const home = join(workRoot, "home");
  const trashTool = join(stubs, "trash");
  const toolTrash = join(workRoot, "tool-trash");
  const quitLog = join(workRoot, "osascript.log");
  const dataFolder = join(home, "Library/Application Support/Builders Bot");
  const database = join(dataFolder, "openbot.db");
  for (const folder of [stubs, installRoot, toolTrash, dataFolder]) mkdirSync(folder, { recursive: true });

  writeExecutable(join(stubs, "security"), `echo '  1) 0123456789ABCDEF "Builder Studio Local Signing"'`);
  writeExecutable(join(stubs, "codesign"), `echo 'designated => identifier "app.buildersbot.desktop"' >&2`);
  writeExecutable(join(stubs, "osascript"), `echo "$@" >> '${quitLog}'`);
  // Moves each argument into the tool's own folder, with a unique name, as the macOS tool does.
  writeExecutable(
    trashTool,
    `for item in "$@"; do mv "$item" '${toolTrash}'/"$(basename "$item")-$$-$(date +%s%N)"; done`,
  );

  writeFileSync(database, "user data");
  const databaseBefore = statSync(database).mtimeMs;
  makeApp(join(installRoot, APP_NAME), "installed-before");
  makeApp(join(installRoot, OLD_BACKUP), "old-backup");

  const install = (marker: string, trashCommand: string) => {
    const build = join(workRoot, `dist-${marker}`, APP_NAME);
    makeApp(build, marker);
    return spawnSync("zsh", [SCRIPT, "--install", build], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        BUILDERS_BOT_INSTALL_ROOT: installRoot,
        BUILDERS_BOT_TRASH_COMMAND: trashCommand,
        BUILDERS_BOT_QUIT_WAIT_SECONDS: "0",
      },
    });
  };

  const first = install("build-1", trashTool);
  check("first install exits with 0", first.status === 0, first.stderr.trim() || `status ${first.status}`);
  // The fake build has no `chrome-peer` addon, as a build made without `prepare:chrome-bridge`.
  check(
    "a build with no chrome-peer addon is signed and gets no Chrome host",
    first.stdout.includes("no chrome-peer addon") &&
      !existsSync(join(installRoot, APP_NAME, "Contents/Resources/chrome-host")),
    first.stdout.trim(),
  );
  check(
    "first install leaves only the new app and the old backup in the install folder",
    JSON.stringify(readdirSync(installRoot).sort()) === JSON.stringify([APP_NAME, OLD_BACKUP]),
    readdirSync(installRoot).join(", "),
  );
  check("the install folder holds the new build", marker(join(installRoot, APP_NAME)) === "build-1", "");
  const trashed = readdirSync(toolTrash);
  check(
    "the previous copy is in the Trash",
    trashed.length === 1 && marker(join(toolTrash, trashed[0] ?? "")) === "installed-before",
    trashed.join(", "),
  );
  check("the old backup is kept", marker(join(installRoot, OLD_BACKUP)) === "old-backup", "");
  check("the old backup is listed", first.stdout.includes(`An older backup is still at`), first.stdout.trim());
  check(
    "the script asked the running app to quit",
    existsSync(quitLog) && readFileSync(quitLog, "utf8").includes("quit"),
    "",
  );

  // Without the macOS tool, the previous copy is renamed into ~/.Trash.
  const second = install("build-2", join(workRoot, "missing-trash-tool"));
  check("second install exits with 0", second.status === 0, second.stderr.trim() || `status ${second.status}`);
  check(
    "second install still leaves one app copy",
    JSON.stringify(readdirSync(installRoot).sort()) === JSON.stringify([APP_NAME, OLD_BACKUP]),
    readdirSync(installRoot).join(", "),
  );
  check("the install folder holds the second build", marker(join(installRoot, APP_NAME)) === "build-2", "");
  const homeTrash = join(home, ".Trash");
  const renamed = readdirSync(homeTrash);
  check(
    "without the tool, the previous copy is renamed into ~/.Trash",
    renamed.length === 1 && renamed[0]?.endsWith(".app") === true && marker(join(homeTrash, renamed[0])) === "build-1",
    renamed.join(", "),
  );

  check(
    "the data folder is not changed",
    readFileSync(database, "utf8") === "user data" &&
      statSync(database).mtimeMs === databaseBefore &&
      JSON.stringify(readdirSync(dataFolder)) === JSON.stringify(["openbot.db"]),
    readdirSync(dataFolder).join(", "),
  );
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.passed);
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify({ passed: failed.length === 0, checks }, null, 2)}\n`);
for (const entry of checks) {
  logger.info(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}`);
  if (!entry.passed) logger.error(entry.detail);
}
logger.info(`Report: ${REPORT_PATH}`);
if (failed.length > 0) process.exitCode = 1;
