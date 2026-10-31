// Fails when the names that the Linux server image uses do not agree (docs/docker.md#build). The
// image unpacks the Linux AppImage, and the server scripts come from upstream Open Bot: they start
// `/opt/OpenBot/app/openbot` and back up the user data folder of the app. Builders Bot keeps the
// upstream install names and pins the executable name, and its data folders follow its own name. A
// merge from upstream, or scripts/builders-bot-rename.pl, can change one side only. Then the image
// does not start, or a backup does not find the database.
//
//   bun run check:linux-image-names
//
// It reads files only, with the YAML parser of Bun, so it runs before `bun install`.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAML } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const DOCKERFILE = "docker/Dockerfile";
const INSTANCE = "docker/instances/openbot-instance";
const RELEASE = ".github/workflows/release.yml";
const BACKUP_E2E = "scripts/instance-backup-e2e.ts";
/** A name that starts with a capital letter after `/opt/` or `.config/`: an app folder, not a tool folder. */
const APP_FOLDER = "[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*";

const texts = new Map<string, string>();
const problems: string[] = [];

function read(path: string): string {
  let text = texts.get(path);
  if (text === undefined) {
    text = readFileSync(join(ROOT, path), "utf8");
    texts.set(path, text);
  }
  return text;
}

function filesIn(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${directory}/${entry.name}`);
}

/** The fields of a parsed YAML or JSON object. Other values have none. */
function fields(value: unknown): Map<string, unknown> {
  return new Map(typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : []);
}

/** The first group of `pattern` in `path`. Each name must be found, so a missing line is a problem. */
function capture(path: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(read(path))?.[1];
  if (value === undefined) problems.push(`${path}: no line matches ${pattern}. Update this check with the file.`);
  return value;
}

/** The words of a captured shell value with plain double or single quotes, as bash splits them. */
function captureWords(path: string, pattern: RegExp): string[] | undefined {
  const value = capture(path, pattern);
  if (value === undefined) return undefined;
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** The first group of each match of `pattern` (with the `g` flag) in `path`. */
function captures(path: string, pattern: RegExp): string[] {
  return [...read(path).matchAll(pattern)].map((match) => match[1] ?? "");
}

/** `actual` is undefined when its line is missing, which is already a problem. */
function expectSame(what: string, actual: string | undefined, expected: string): void {
  if (actual !== undefined && actual !== expected) {
    problems.push(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`);
  }
}

function expectText(path: string, text: string): void {
  if (!read(path).includes(text)) problems.push(`${path} does not have ${JSON.stringify(text)}.`);
}

function expectEach(what: string, paths: string[], pattern: RegExp, expected: string): void {
  for (const path of paths) {
    for (const value of captures(path, pattern)) expectSame(`${what} in ${path}`, value, expected);
  }
}

function stop(message: string): never {
  process.stderr.write(`${[message, ...problems.map((problem) => `  ${problem}`)].join("\n")}\n`);
  process.exit(1);
}

// The names that electron-builder gives the Linux build. macOS and Windows keep the product name.
const builder = fields(YAML.parse(read("electron-builder.yml")));
const productName = builder.get("productName");
const executable = fields(builder.get("linux")).get("executableName");
if (typeof productName !== "string" || typeof executable !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(executable)) {
  stop(
    "electron-builder.yml must have productName and linux.executableName, the file name that the server scripts start.",
  );
}
expectSame(
  "productName in package.json",
  String(fields(JSON.parse(read("package.json"))).get("productName")),
  productName,
);
for (const section of ["mac", "win"]) {
  if (fields(builder.get(section)).has("executableName")) {
    problems.push(`electron-builder.yml sets ${section}.executableName. Only linux sets it.`);
  }
}
if (builder.has("executableName"))
  problems.push("electron-builder.yml sets executableName for every platform. Only linux sets it.");

// The install folder: the image and the hosted scripts unpack the release there, and main reads its marker.
const install = capture("scripts/hosting/openbot-hosted-update", /^INSTALL=(\/opt\/\S+)$/m);
const appImage = capture(DOCKERFILE, /^COPY (\S+\.AppImage) /m);
if (install === undefined || appImage === undefined) stop("The Linux image names cannot be read:");
const hosting = filesIn("scripts/hosting");
const instances = filesIn("docker/instances");
const installReaders = ["src/main/host-release-service.ts", "src/main/hosted-update-adapter.ts"];
expectEach(
  "The install folder",
  [DOCKERFILE, ...hosting, ...instances, ...installReaders, "apps/auth-api/src/server/boat-client.ts"],
  new RegExp(`(/opt/${APP_FOLDER})`, "g"),
  install,
);
expectText(DOCKERFILE, `COPY --from=release /tmp/squashfs-root ${install}/app\n`);
expectText(DOCKERFILE, `>${install}/hosted/mode`);
expectText(DOCKERFILE, `"${install}/app/resources/hosting/openbot-container"`);
expectText("src/main/host-release-service.ts", `"${install}/hosted/mode"`);
expectText("src/main/hosted-update-adapter.ts", `"${install}/staged.ready"`);

// The executable that the entrypoint, the hosted scripts, their AppArmor profile and the package checks start.
expectText("scripts/hosting/openbot-container", `exec ${install}/app/${executable} `);
expectEach(
  "The executable",
  [DOCKERFILE, ...hosting],
  new RegExp(`(?:/opt/${APP_FOLDER}|\\$INSTALL)/app/([A-Za-z0-9_.-]+)(?![A-Za-z0-9_./-])`, "g"),
  executable,
);
expectEach("The executable", hosting, /-x "\$(?:1|RELEASE)\/([^"/]+)"/g, executable);
expectSame(`The executable of the mount check in ${RELEASE}`, capture(RELEASE, /"\$mountPoint\/([^"/]+)"/), executable);
expectSame(
  `The executable of the AppArmor profile in ${RELEASE}`,
  capture(RELEASE, /-unpacked\/([^"/]+)" flags=/),
  executable,
);
expectSame(
  "The executable in scripts/verify-linux-package.ts",
  capture("scripts/verify-linux-package.ts", /const executablePath = resolve\(appPath, "([^"]+)"\)/),
  executable,
);

// The AppImage file that the Dockerfile copies. The release name has a space, so each copy gives it this name.
expectText(DOCKERFILE, `./${appImage} --appimage-extract`);
expectSame(
  `The AppImage that ${RELEASE} gives the image`,
  captureWords(RELEASE, /^\s*mv release-assets\/\*\.AppImage (.+?)\s*$/m)?.join(" | "),
  `image/${appImage}`,
);
expectText("docs/docker.md", `"image/${appImage}"`);

// A later rename pass must keep the install folder and the AppImage file.
const kept = captureWords("scripts/builders-bot-rename.pl", /^my @kept_paths = \(([^)]*)\);$/m);
if (kept !== undefined) {
  for (const name of [install, appImage]) {
    if (!kept.includes(name)) problems.push(`scripts/builders-bot-rename.pl does not keep ${name} in @kept_paths.`);
  }
}

// The start check of the image reads the product name on the first line of `openbot status`.
expectSame(
  "The status line in scripts/hosting/openbot",
  capture("scripts/hosting/openbot", /^\s*echo "(.+) \$\(value version\)"$/m),
  productName,
);
expectSame(`The start check in ${RELEASE}`, capture(RELEASE, /grep -Fxq "(.+) \$RELEASE_VERSION"/), productName);
expectSame(
  `The image title in ${DOCKERFILE}`,
  captureWords(DOCKERFILE, /org\.opencontainers\.image\.title=("[^"]*"|\S+)/)?.join(" | "),
  productName,
);

// The user data folder is `.config/<app name>` on Linux, and the agents use `~/<home folder>`. One
// app name for every platform: a change moves the data of existing macOS and Windows users.
const appNames = captures("src/main/index.ts", /app\.setName\("([^"]*)"\)/g);
if (appNames.length !== 1) problems.push(`src/main/index.ts has ${appNames.length} app.setName calls, expected 1.`);
const appName = appNames[0] ?? productName;
expectSame("app.setName in src/main/index.ts", appName, productName);
const home = capture("src/backend/agent-store.ts", /openbotRoot = join\(homePath, "([^"]+)"\)/) ?? productName;
const database = `.config/${appName}/openbot.db`;
const sharedDatabase = `${home}/Shared/Data/agent-data.db`;
expectSame(
  `The first REQUIRED_FILES entry in ${INSTANCE}`,
  captureWords(INSTANCE, /^REQUIRED_FILES=\((.*)\)$/m)
    ?.slice(0, 1)
    .join(""),
  database,
);
expectSame(
  `SHARED_DATABASE in ${INSTANCE}`,
  captureWords(INSTANCE, /^SHARED_DATABASE=(.*)$/m)?.join(" | "),
  sharedDatabase,
);
expectSame(`APP_DATABASE in ${BACKUP_E2E}`, capture(BACKUP_E2E, /^const APP_DATABASE = "([^"]+)";$/m), database);
expectSame(
  `SHARED_DATABASE in ${BACKUP_E2E}`,
  capture(BACKUP_E2E, /^const SHARED_DATABASE = "([^"]+)";$/m),
  sharedDatabase,
);
expectEach(
  "The user data folder",
  [DOCKERFILE, ...hosting, ...instances],
  new RegExp(`\\.config/(${APP_FOLDER})`, "g"),
  appName,
);

if (problems.length > 0) stop("The Linux image names do not agree:");
process.stdout.write(
  `The Linux image names agree: executable ${executable}, ${install}/app, ${appImage}, ~/${database}, ~/${sharedDatabase}.\n`,
);
