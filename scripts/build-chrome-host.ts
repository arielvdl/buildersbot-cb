/**
 * Builds the Native Messaging host of the Chrome extension (`native/chrome-host/main.swift`) for one
 * channel and one architecture, and signs it.
 *
 *   bun scripts/build-chrome-host.ts --channel e2e --app-requirement 'cdhash H"…"'
 *   bun scripts/build-chrome-host.ts --channel dev
 *   bun scripts/build-chrome-host.ts --channel store --sign-identity "Developer ID Application: … (ZTRDTUL87R)"
 *   bun scripts/build-chrome-host.ts --channel local --sign-identity "Builder Studio Local Signing" \
 *     --app-requirement 'identifier "app.buildersbot.desktop" and certificate leaf = H"…"'
 *
 * Each channel compiles its own constants into the binary (`config.swift` is written for each build):
 * the one extension origin it accepts, its socket, whether it checks the app's signature, and whether it
 * writes diagnostics. Nothing comes from the environment at run time.
 *
 * - `store`: needs the store extension ID (`EXTENSION_IDS.store`) and a Developer ID identity. It is
 *   signed with the hardened runtime and a timestamp, as `app.buildersbot.chrome-host`, and checks that
 *   the app on the socket is Builders Bot of team ZTRDTUL87R. The app's notarization then covers it.
 * - `local`: the local extension ID (`EXTENSION_IDS.local`), for an app that its owner signed with their
 *   own certificate (`scripts/sign-local-macos.sh`, which builds it). `--app-requirement` is the
 *   designated requirement of that signed app: its identifier and the hash of the certificate. It is
 *   signed with the same certificate and the hardened runtime, with no timestamp, as
 *   `app.buildersbot.chrome-host-local`; socket `b-local.sock` in the app's folder; no diagnostics.
 * - `dev`: the development extension ID; ad-hoc signature unless `--sign-identity` is given; no check
 *   of the app's signature (a development app is not signed); socket `b-dev.sock`.
 * - `e2e`: the E2E extension ID; ad-hoc signature; the app requirement comes from `--app-requirement`
 *   (the E2E pins the code hash of the process that plays the app); socket in the user's temporary
 *   folder, never in the app's folder; diagnostics in that private folder.
 *
 * The output (default `.buildersbot-build/chrome-host/<channel>/<arch>/buildersbot-chrome-host`) and a
 * `build.json` with its code hash go to the same folder.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch as hostArch } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import {
  type ChromeBridgeChannel,
  EXTENSION_IDS,
  extensionOrigin,
} from "../packages/contracts/src/chrome-bridge/extension-ids";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = join(ROOT, "native/chrome-host/main.swift");
const APP_TEAM = "ZTRDTUL87R";
const APP_IDENTIFIER = "app.buildersbot.desktop";
const STORE_APP_REQUIREMENT = `anchor apple generic and certificate leaf[subject.OU] = "${APP_TEAM}" and identifier "${APP_IDENTIFIER}"`;
export const CHROME_HOST_SIGNING_IDENTIFIER = "app.buildersbot.chrome-host";
/** What `codesign` makes the designated requirement of an app signed with a certificate of its own. */
const LOCAL_APP_REQUIREMENT = /^identifier "app\.buildersbot\.desktop" and certificate leaf = H"[0-9a-f]{40}"$/u;

export interface ChromeHostBuild {
  channel: ChromeBridgeChannel;
  arch: "arm64" | "x64";
  binary: string;
  identifier: string;
  cdhash: string;
  signature: "developer-id" | "certificate" | "ad-hoc";
  appRequirement: string | null;
  origin: string;
  version: string;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const swiftString = (value: string) => JSON.stringify(value);

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The code directory hash of a signed binary. `codesign -d` prints its details on standard error. */
export function codeHash(binary: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", binary], { encoding: "utf8" });
  return /^CDHash=([0-9a-f]{40})$/mu.exec(`${result.stdout}${result.stderr}`)?.[1] ?? "";
}

const PackageVersion = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/u)),
});

function packageVersion(): string {
  return Schema.decodeUnknownSync(PackageVersion)(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))).version;
}

export function buildChromeHost(options: {
  channel: ChromeBridgeChannel;
  arch?: "arm64" | "x64";
  out?: string;
  appRequirement?: string | null;
  signIdentity?: string;
  keychain?: string;
}): ChromeHostBuild {
  if (process.platform !== "darwin") throw new Error("The Chrome host is built on macOS only (DESIGN §16 item 4).");
  const { channel } = options;
  const arch = options.arch ?? (hostArch() === "arm64" ? "arm64" : "x64");
  const extensionId = EXTENSION_IDS[channel];
  if (!extensionId)
    throw new Error(`No extension ID for the ${channel} channel yet: the store ID exists only after the first upload.`);
  if (channel === "store" && !options.signIdentity)
    throw new Error("A store host needs --sign-identity with the Developer ID Application certificate of the team.");
  if (channel === "local" && !options.signIdentity)
    throw new Error("A local host needs --sign-identity with the certificate that signs the app.");
  const appRequirement =
    channel === "store"
      ? STORE_APP_REQUIREMENT
      : channel === "e2e" || channel === "local"
        ? (options.appRequirement ?? null)
        : null;
  if (channel === "e2e" && !appRequirement)
    throw new Error("An E2E host needs --app-requirement: the requirement of the process that plays the app.");
  if (channel === "local" && !(appRequirement && LOCAL_APP_REQUIREMENT.test(appRequirement)))
    throw new Error(
      `A local host needs --app-requirement with the designated requirement of the signed app: identifier "${APP_IDENTIFIER}" and certificate leaf = H"<SHA-1>".`,
    );
  const version = packageVersion();
  const origin = extensionOrigin(extensionId);
  const folder = resolve(options.out ?? join(ROOT, ".buildersbot-build/chrome-host", channel, arch));
  mkdirSync(folder, { recursive: true });
  const config = join(folder, "config.swift");
  writeFileSync(
    config,
    [
      "// Written by scripts/build-chrome-host.ts for one build. Do not edit.",
      "enum HostConfig {",
      `  static let channel = ${swiftString(channel)}`,
      `  static let allowedOrigin = ${swiftString(origin)}`,
      `  static let hostVersion = ${swiftString(version)}`,
      `  static let socketName = ${swiftString(channel === "store" ? "b.sock" : `b-${channel}.sock`)}`,
      `  static let socketInTempDir = ${channel === "e2e"}`,
      `  static let tempFolderName = ${swiftString("bb-e2e")}`,
      `  static let appRequirement: String? = ${appRequirement === null ? "nil" : swiftString(appRequirement)}`,
      `  static let diagnostics = ${channel === "dev" || channel === "e2e"}`,
      "}",
      "",
    ].join("\n"),
  );
  const binary = join(folder, "buildersbot-chrome-host");
  run("/usr/bin/xcrun", [
    "swiftc",
    "-O",
    "-target",
    `${arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13`,
    "-Xlinker",
    "-dead_strip",
    SOURCE,
    config,
    "-o",
    binary,
  ]);
  const kind = run("/usr/bin/file", [binary]);
  if (!kind.includes(arch === "arm64" ? "Mach-O 64-bit executable arm64" : "Mach-O 64-bit executable x86_64"))
    throw new Error(`The host is not a ${arch} executable: ${kind.trim()}`);
  const identifier =
    channel === "store" ? CHROME_HOST_SIGNING_IDENTIFIER : `${CHROME_HOST_SIGNING_IDENTIFIER}-${channel}`;
  // Apple's timestamp server is for Developer ID signatures; a certificate of the owner's own gets none.
  const sign = options.signIdentity
    ? [
        "--force",
        "--sign",
        options.signIdentity,
        ...(options.keychain ? ["--keychain", options.keychain] : []),
        ...(channel === "store" ? ["--timestamp"] : []),
        "--options",
        "runtime",
        "--identifier",
        identifier,
        binary,
      ]
    : ["--force", "--sign", "-", "--identifier", identifier, binary];
  run("/usr/bin/codesign", sign);
  run("/usr/bin/codesign", ["--verify", "--strict", binary]);
  const build: ChromeHostBuild = {
    channel,
    arch,
    binary,
    identifier,
    cdhash: codeHash(binary),
    signature: !options.signIdentity ? "ad-hoc" : channel === "store" ? "developer-id" : "certificate",
    appRequirement,
    origin,
    version,
  };
  if (!/^[0-9a-f]{40}$/u.test(build.cdhash)) throw new Error("codesign did not print the code hash of the host.");
  writeFileSync(join(folder, "build.json"), `${JSON.stringify(build, null, 2)}\n`);
  return build;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const channel = option(argv, "--channel");
  if (channel !== "store" && channel !== "local" && channel !== "dev" && channel !== "e2e")
    throw new Error("Usage: bun scripts/build-chrome-host.ts --channel store|local|dev|e2e [options]");
  const requirement = option(argv, "--app-requirement");
  const archOption = option(argv, "--arch");
  const build = buildChromeHost({
    channel,
    arch: archOption === "x64" || archOption === "arm64" ? archOption : undefined,
    out: option(argv, "--out"),
    appRequirement: requirement === undefined ? undefined : requirement,
    signIdentity: option(argv, "--sign-identity"),
    keychain: option(argv, "--keychain"),
  });
  process.stdout.write(`${JSON.stringify(build, null, 2)}\n`);
}
