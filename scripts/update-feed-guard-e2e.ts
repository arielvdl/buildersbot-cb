// Checks that no build of Builders Bot can read or install a release of the upstream OpenBot app
// (phase 0 of .openbot-build/update-system/DESIGN.md). It needs no build and no network, and it
// sends no request. It checks that:
//
// - the effective `publish` setting of each electron-builder config is `null`, for each platform and
//   target, with the precedence of electron-builder (target, platform, root, then the package.json
//   `repository`), or a `generic` feed that the update feed policy allows;
// - `nightly-labs` is not in the build configs, the package.json `repository`, `bugs` and
//   `homepage`, `src/main`, `scripts/hosting`, `scripts/install-server.sh`, the macOS Host Manager
//   and the download pages, except the lines in ALLOWED_MENTIONS (tests are not part of a build);
// - the real `decideUpdateFeed` refuses the upstream app-update.yml, an HTTP feed and a feed on
//   another origin, and allows a listed origin only when the list is not empty;
// - the application decides the feed before it imports electron-updater, and the hosted installer,
//   the Servers panel, the root update script, the server install script and the macOS Host Manager
//   send no request;
// - the updater cache folder, the Squirrel.Mac folder and the Windows installer use Builders Bot names.
//
// Usage: bun scripts/update-feed-guard-e2e.ts
// It writes .openbot-build/update-system/feed-guard-report.json and exits with 1 when a check fails.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fetchLatestLinuxRelease, HostReleaseService, type ReleaseRequest } from "../src/main/host-release-service";
import { HostedUpdateAdapter } from "../src/main/hosted-update-adapter";
import {
  ALLOWED_UPDATE_FEED_ORIGINS,
  decideReleaseFeed,
  decideUpdateFeed,
  RELEASE_FEED_BASE_URL,
  SHIPIT_DIRECTORY_NAME,
  UPDATER_CACHE_DIRECTORY_NAME,
} from "../src/main/update-feed-policy";
import { readBuilderIdentity } from "./builders-bot-package";

const logger = createBuildersBotLogger("update-feed-guard-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = resolve(ROOT, ".openbot-build/update-system/feed-guard-report.json");
const UPSTREAM = /nightly-labs/iu;

/**
 * The only mentions of the upstream project that can stay: documentation links and comments, which
 * send no request and install nothing. Each one names its file and the text of its line.
 */
const ALLOWED_MENTIONS: ReadonlyArray<{ file: string; line: RegExp; reason: string }> = [
  {
    file: "src/main/ipc/app-handlers.ts",
    line: /"https:\/\/github\.com\/nightly-labs\/openbot\/blob\/main\/docs\/[\w./-]+"/u,
    reason: "documentation link",
  },
  { file: "src/main/github-connector-config.ts", line: /^\s*\/\*\*/u, reason: "comment" },
  { file: "src/main/update-feed-policy.ts", line: /^\s*\*.*Never add the upstream OpenBot feed/u, reason: "comment" },
  {
    file: "scripts/hosting/openbot",
    line: /See https:\/\/github\.com\/nightly-labs\/openbot\/blob\/main\/docs\/docker\.md"$/u,
    reason: "documentation link",
  },
  {
    file: "scripts/hosting/openbot-container",
    line: /See https:\/\/github\.com\/nightly-labs\/openbot\/blob\/main\/docs\/docker\.md"$/u,
    reason: "documentation link",
  },
  {
    // A list of provider CLI versions to avoid, not an app release. Section 7.5 of the design moves it.
    file: "src/main/provider-runtime-releases.ts",
    line: /"https:\/\/raw\.githubusercontent\.com\/nightly-labs\/openbot\/main\/provider-runtime-blocklist\.json";$/u,
    reason: "provider runtime blocklist, until section 7.5 of the design",
  },
];

interface CheckResult {
  name: string;
  passed: boolean;
  details: unknown;
}

const checks: CheckResult[] = [];

async function check(name: string, run: () => unknown): Promise<void> {
  try {
    const details = await run();
    checks.push({ name, passed: true, details: details ?? null });
  } catch (error) {
    checks.push({ name, passed: false, details: error instanceof Error ? error.message : String(error) });
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function readText(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** Every file under `directory`, as a path relative to the repository. */
function filesUnder(directory: string): string[] {
  return readdirSync(resolve(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

/**
 * The files of one electron-builder config: the file first, then the file that it `extends`. A key
 * of the first file that sets it wins, as when electron-builder merges them.
 */
function configLayers(path: string): DynamicRecord[] {
  const config = parseYaml(readText(path));
  if (!isDynamicRecord(config)) fail(`${path} is not a YAML map.`);
  if (config.extends === undefined || config.extends === null) return [config];
  if (!isString(config.extends)) fail(`${path} has an "extends" that is not a path.`);
  return [config, ...configLayers(relative(ROOT, resolve(dirname(resolve(ROOT, path)), config.extends)))];
}

/** The option key of a target: electron-builder reads `appImage` for the `AppImage` target. */
function targetOptionKey(target: string): string {
  return target === "AppImage" ? "appImage" : target;
}

/** The targets of a platform section (`mac`, `win`, `linux`), from the first file that sets them. */
function platformTargets(layers: readonly DynamicRecord[], platformKey: string): string[] {
  for (const layer of layers) {
    const platform = layer[platformKey];
    if (!isDynamicRecord(platform) || platform.target === undefined) continue;
    const targets = Array.isArray(platform.target) ? platform.target : [platform.target];
    return targets.flatMap((target) => {
      if (isString(target)) return [target];
      if (isDynamicRecord(target) && isString(target.target)) return [target.target];
      return [];
    });
  }
  return [];
}

interface PublishSetting {
  /** The key that sets the value, or the fallback that electron-builder uses. */
  readonly source: string;
  readonly value: string;
  /** Null, or `generic` feeds that the update feed policy allows. */
  readonly allowed: boolean;
}

function judgePublish(source: string, value: unknown): PublishSetting {
  const feeds = Array.isArray(value) ? value : [value];
  const allowed =
    value === null ||
    feeds.every(
      (feed) =>
        isDynamicRecord(feed) &&
        feed.provider === "generic" &&
        isString(feed.url) &&
        decideUpdateFeed(stringifyYaml({ provider: "generic", url: feed.url })).allowed,
    );
  return { source, value: JSON.stringify(value), allowed };
}

/**
 * The `publish` value that electron-builder uses for one target (`getPublishConfigs` in
 * app-builder-lib/out/publish/PublishManager.js): the first level that sets it (target options,
 * platform, root), where `null` stops the search. With no level, electron-builder makes a GitHub feed
 * from the package.json `repository`.
 */
function effectivePublish(layers: readonly DynamicRecord[], platformKey: string, target: string): PublishSetting {
  const levels: Array<string | null> = [targetOptionKey(target), platformKey, null];
  for (const section of levels) {
    for (const layer of layers) {
      const owner = section === null ? layer : layer[section];
      if (!isDynamicRecord(owner) || owner.publish === undefined) continue;
      return judgePublish(section === null ? "publish" : `${section}.publish`, owner.publish);
    }
  }
  return { source: "package.json repository", value: "github (fallback)", allowed: false };
}

/** A fetch that records each address and fails the request. */
function recordingFetch() {
  const urls: string[] = [];
  const request: ReleaseRequest = async (url) => {
    urls.push(url);
    throw new Error("A request was sent.");
  };
  return { request, urls };
}

await check("each electron-builder config publishes no update feed", () => {
  const configs = readdirSync(ROOT).filter((name) => /^electron-builder.*\.ya?ml$/u.test(name));
  if (configs.length === 0) fail("No electron-builder config was found.");
  const resolved = configs.flatMap((file) => {
    const layers = configLayers(file);
    return ["mac", "win", "linux"].flatMap((platformKey) =>
      platformTargets(layers, platformKey).map((target) => ({
        file,
        platform: platformKey,
        target,
        ...effectivePublish(layers, platformKey, target),
      })),
    );
  });
  const refused = resolved.filter((entry) => !entry.allowed);
  if (resolved.length === 0) fail("No platform target was found.");
  if (refused.length > 0) fail(`These targets name an update feed: ${JSON.stringify(refused)}`);
  return resolved;
});

const mentions: Array<{ file: string; line: number; text: string; allowed: string | null }> = [];
await check("nightly-labs appears only in documentation links and comments", () => {
  const packageJson = JSON.parse(readText("package.json"));
  if (!isDynamicRecord(packageJson)) fail("package.json is not an object.");
  for (const field of ["repository", "bugs", "homepage"]) {
    const value = JSON.stringify(packageJson[field] ?? null);
    if (UPSTREAM.test(value)) mentions.push({ file: `package.json#${field}`, line: 0, text: value, allowed: null });
  }
  const files = [
    ...readdirSync(ROOT).filter((name) => /^electron-builder.*\.ya?ml$/u.test(name)),
    ...filesUnder("src/main").filter((file) => !/\.test\.tsx?$/u.test(file)),
    ...filesUnder("scripts/hosting"),
    "scripts/install-server.sh",
    "scripts/host-manager.ts",
    "scripts/host-manager-macos.ts",
    "scripts/openbot-host-macos.ts",
    "apps/auth-api/src/lib/download-pages.ts",
  ];
  for (const file of files) {
    for (const [index, text] of readText(file).split("\n").entries()) {
      if (!UPSTREAM.test(text)) continue;
      const allowed = ALLOWED_MENTIONS.find((entry) => entry.file === file && entry.line.test(text));
      mentions.push({ file, line: index + 1, text: text.trim(), allowed: allowed?.reason ?? null });
    }
  }
  const refused = mentions.filter((mention) => mention.allowed === null);
  if (refused.length > 0) fail(`nightly-labs outside the allow-list: ${JSON.stringify(refused)}`);
  return { searchedFiles: files.length, allowedMentions: mentions.length };
});

await check("decideUpdateFeed refuses the upstream feed and every feed while the list is empty", () => {
  const listed = "https://updates.example.test";
  const cases = [
    {
      name: "upstream app-update.yml",
      metadata: "owner: nightly-labs\nrepo: openbot\nprovider: github\nupdaterCacheDirName: openbot-updater\n",
      origins: ["https://github.com"],
      allowed: false,
    },
    {
      name: "generic over HTTP",
      metadata: "provider: generic\nurl: http://updates.example.test/feed\n",
      origins: ["http://updates.example.test"],
      allowed: false,
    },
    {
      name: "generic on another origin",
      metadata: "provider: generic\nurl: https://other.example.test/feed\n",
      origins: [listed],
      allowed: false,
    },
    {
      name: "generic on a listed origin, default list",
      metadata: `provider: generic\nurl: ${listed}/feed\n`,
      origins: ALLOWED_UPDATE_FEED_ORIGINS,
      allowed: ALLOWED_UPDATE_FEED_ORIGINS.includes(listed),
    },
    {
      name: "generic on a listed origin",
      metadata: `provider: generic\nurl: ${listed}/feed\n`,
      origins: [listed],
      allowed: true,
    },
    { name: "no app-update.yml", metadata: null, origins: [listed], allowed: false },
  ];
  const results = cases.map((entry) => ({
    name: entry.name,
    expected: entry.allowed,
    decision: decideUpdateFeed(entry.metadata, entry.origins),
  }));
  const wrong = results.filter((result) => result.decision.allowed !== result.expected);
  if (wrong.length > 0) fail(`Wrong decisions: ${JSON.stringify(wrong)}`);
  if (ALLOWED_UPDATE_FEED_ORIGINS.length !== 0) fail("Phase 0 allows no update feed origin.");
  if (RELEASE_FEED_BASE_URL !== null) fail("Phase 0 has no release feed.");
  return results;
});

await check("the application decides the feed before electron-updater loads", () => {
  const source = readText("src/main/application-services.ts");
  const updaterImport = source.indexOf('import("electron-updater")');
  const desktopDecision = source.indexOf("decideUpdateFeed(");
  const hostedDecision = source.indexOf("decideReleaseFeed(");
  if (updaterImport < 0) fail("The electron-updater import was not found.");
  if (desktopDecision < 0 || desktopDecision > updaterImport) fail("decideUpdateFeed does not run before the import.");
  if (hostedDecision < 0 || hostedDecision > updaterImport) fail("decideReleaseFeed does not run before the import.");
  if (!/const updatesEnabled =[^;]*updateFeed\.allowed;/u.test(source))
    fail("updatesEnabled does not need an allowed feed.");
  if (!source.includes("if (updatesEnabled && hostedInstaller) {"))
    fail("The hosted installer does not need updatesEnabled.");
  return { updaterImport, desktopDecision, hostedDecision };
});

await check("the hosted installer and the Servers panel send no request", async () => {
  const hosted = recordingFetch();
  const adapter = new HostedUpdateAdapter({ currentVersion: "0.56.0", arch: "x64", fetch: hosted.request });
  const hostedResult = await adapter.checkForUpdates().then(
    () => "found a release",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const linux = recordingFetch();
  const linuxResult = await fetchLatestLinuxRelease("arm64", linux.request, AbortSignal.timeout(5_000)).then(
    () => "found a release",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const panel = recordingFetch();
  const release = new HostReleaseService({
    currentVersion: "0.56.0",
    packaged: true,
    platform: "linux",
    arch: "x64",
    environment: { OPENBOT_HOSTED_SERVER: "1" },
    installationMode: "self",
    updateStatus: () => ({ phase: "unsupported" }),
    fetch: panel.request,
  });
  const panelStatus = await Effect.runPromise(release.check());
  const requests = [...hosted.urls, ...linux.urls, ...panel.urls];
  if (requests.length > 0) fail(`Requests were sent: ${requests.join(", ")}`);
  if (hostedResult === "found a release" || linuxResult === "found a release") fail("A release was found.");
  if (panelStatus.phase !== "unavailable") fail(`The Servers panel phase is ${panelStatus.phase}.`);
  return { decision: decideReleaseFeed(), hostedResult, linuxResult, panelStatus };
});

// The Host Manager came from the upstream app and has no Builders Bot release feed. It must find no
// release and install nothing, also when a release feed is allowed.
await check("the macOS Host Manager stages and installs no release and sends no request", async () => {
  const { macHostOperations } = await import("./host-manager-macos");
  const recorder = recordingFetch();
  const realFetch = globalThis.fetch;
  Reflect.set(globalThis, "fetch", recorder.request);
  let install: string;
  try {
    const operations = macHostOperations();
    const staged = await operations.stageLatest();
    if (staged !== null) fail(`The Host Manager staged ${staged}.`);
    install = await operations.install("99.0.0").then(
      () => "installed",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    Reflect.set(globalThis, "fetch", realFetch);
  }
  if (recorder.urls.length > 0) fail(`Requests were sent: ${recorder.urls.join(", ")}`);
  if (!install.includes("not available")) fail(`The Host Manager install gave: ${install}`);
  return { staged: null, install };
});

await check("the root update script and the server install download nothing", () => {
  if (process.platform === "win32") return "skipped: needs bash";
  const fake = mkdtempSync(join(tmpdir(), "update-feed-guard-"));
  try {
    const log = join(fake, "network.log");
    writeFileSync(log, "");
    for (const tool of ["curl", "wget"]) {
      writeFileSync(join(fake, tool), `#!/bin/sh\necho "${tool} $*" >>"${log}"\nexit 1\n`);
      chmodSync(join(fake, tool), 0o755);
    }
    const environment = { ...process.env, PATH: `${fake}:${process.env.PATH ?? ""}` };
    const stage = spawnSync("bash", ["-c", 'source "$1"; stage', "guard", "scripts/hosting/openbot-hosted-update"], {
      cwd: ROOT,
      env: environment,
      encoding: "utf8",
    });
    const install = spawnSync("bash", ["scripts/install-server.sh"], { cwd: ROOT, env: environment, encoding: "utf8" });
    const network = readFileSync(log, "utf8").trim();
    const result = {
      stage: { status: stage.status, stderr: stage.stderr.trim() },
      install: { status: install.status, stderr: install.stderr.trim() },
      network,
    };
    if (network !== "") fail(`A download tool ran: ${network}`);
    if (stage.status !== 0 || !stage.stderr.includes("not available")) fail(`stage: ${JSON.stringify(result.stage)}`);
    if (install.status === 0 || !install.stderr.includes("not available"))
      fail(`install: ${JSON.stringify(result.install)}`);
    return result;
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

await check("the updater folders and the Windows installer use Builders Bot names", () => {
  const { productName, appId } = readBuilderIdentity();
  const packageJson = JSON.parse(readText("package.json"));
  if (!isDynamicRecord(packageJson) || !isString(packageJson.name)) fail("package.json has no name.");
  // electron-builder writes `<package name>-updater` as `updaterCacheDirName`.
  if (UPDATER_CACHE_DIRECTORY_NAME !== `${packageJson.name}-updater`) fail("The updater cache folder name is wrong.");
  // Squirrel.Mac names its folder `<bundle id>.ShipIt`.
  if (SHIPIT_DIRECTORY_NAME !== `${appId}.ShipIt`) fail("The Squirrel.Mac folder name is wrong.");
  const mainSources = filesUnder("src/main").filter((file) => !/\.test\.tsx?$/u.test(file));
  const upstreamFolders = mainSources.filter((file) =>
    /openbot-updater|app\.openbot\.desktop\.ShipIt/u.test(readText(file)),
  );
  if (upstreamFolders.length > 0) fail(`The upstream updater folders are named in: ${upstreamFolders.join(", ")}`);
  const installer = readText("build/installer.nsh");
  // The workspace folder and the user data folder, by product name (`$PROFILE` and `$APPDATA`).
  const protectedFolders = [
    /!insertmacro openBotHolds \$\{PATH\} "\$PROFILE\\\$\{PRODUCT_NAME\}" \$\{OUT\}/u,
    /!insertmacro openBotHolds \$\{PATH\} "\$APPDATA\\\$\{PRODUCT_NAME\}" \$\{OUT\}/u,
  ];
  if (!protectedFolders.every((folder) => folder.test(installer))) {
    fail("build/installer.nsh does not protect the Builders Bot folders by product name.");
  }
  return { productName, appId, cacheDirectory: UPDATER_CACHE_DIRECTORY_NAME, shipItDirectory: SHIPIT_DIRECTORY_NAME };
});

const passed = checks.every((entry) => entry.passed);
const report = {
  generatedAt: new Date().toISOString(),
  phase: 0,
  passed,
  checks,
  mentions,
};
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
for (const entry of checks) {
  logger.info(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}`);
  if (!entry.passed) logger.error(String(entry.details));
}
logger.info(`Wrote ${relative(ROOT, REPORT_PATH)}.`);
if (!passed) process.exitCode = 1;
