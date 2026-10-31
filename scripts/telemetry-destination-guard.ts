// Checks that no build of Builders Bot can send analytics or telemetry to a host of the upstream
// OpenBot project, which Builders Bot does not control (phase 0 of
// .openbot-build/bug-reports/DESIGN.md). It needs no network and sends no request. It checks that:
//
// - no product, server, build or development file names an upstream analytics destination or an
//   OpenPanel client: the hosts, the client ID of the upstream project, the SDK default host, the SDK
//   class and the SDK packages (`scripts/telemetry-destinations.ts` lists them). The search covers
//   `src`, `packages`, `apps`, `remote`, `scripts`, `tools`, `.github` and the root files, except
//   Markdown and the lines in ALLOWED_MENTIONS;
// - the desktop app (`src`, `packages/*/src`) and its development stack (`scripts/dev-services.ts`)
//   name no upstream service host, except the lines in ALLOWED_MENTIONS. Tests, stories and preview
//   data send no request, so the host search skips them;
// - with `--build-output`, the built app (`out/main`, `out/preload`, `out/renderer`) has none of the
//   analytics strings. `check:desktop:static` passes it right after `bun run build`.
//
// Usage: bun scripts/telemetry-destination-guard.ts [--build-output]
// It writes .openbot-build/telemetry-destination-guard/report.json and exits with 1 when a check fails.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { BLOCKED_ANALYTICS_STRINGS, BLOCKED_UPSTREAM_HOSTS } from "./telemetry-destinations";

const logger = createBuildersBotLogger("telemetry-destination-guard");
const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = resolve(ROOT, ".openbot-build/telemetry-destination-guard/report.json");
const BUILD_OUTPUT = ["out/main", "out/preload", "out/renderer"];

/**
 * The only lines that can name a blocked string: the list itself, this guard, and documentation of
 * the account host that the desktop app still accepts in an invitation. Each names its file and the
 * text of its line. Nothing here sends data to an analytics service.
 */
const ALLOWED_MENTIONS: ReadonlyArray<{ file: string; line: RegExp; reason: string }> = [
  {
    file: "scripts/telemetry-destinations.ts",
    line: /^(?: {2}"[^"]+",|export const BLOCKED_[A-Z_]+ = \[.*\] as const;)$/u,
    reason: "the list of blocked destinations that the guard and the E2E scripts read",
  },
  {
    // The production account API of the upstream project. An invitation link can still name it, and
    // the desktop and mobile apps accept it as an account service: that is sign-in and invitations,
    // not telemetry, and it is outside phase 0. The design and the incident record list it as open.
    file: "packages/contracts/src/invite-links.ts",
    line: /^export const OPENBOT_CONTROL_PLANE_ORIGIN = "https:\/\/api\.openbot\.run";$/u,
    reason: "upstream account host in invitations (not telemetry; open item outside phase 0)",
  },
  {
    file: "packages/team-client/src/remote-directory.ts",
    line: /^\s*\* `api\.openbot\.run`, but an invitation must name `api\.openbot\.run`: the desktop and mobile apps$/u,
    reason: "comment about the same account host",
  },
];

interface Mention {
  file: string;
  line: number;
  text: string;
  pattern: string;
  allowed: string | null;
}

interface CheckResult {
  name: string;
  passed: boolean;
  details: unknown;
}

const checks: CheckResult[] = [];
const mentions: Mention[] = [];

function check(name: string, run: () => unknown): void {
  try {
    checks.push({ name, passed: true, details: run() ?? null });
  } catch (error) {
    checks.push({ name, passed: false, details: error instanceof Error ? error.message : String(error) });
  }
}

function fail(message: string): never {
  throw new Error(message);
}

/** The tracked and the new (not ignored) files of the repository, relative to its root. */
function repositoryFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter(Boolean))].filter((file) => existsSync(resolve(ROOT, file)));
}

/** Each line of `files` that holds one of `patterns`, with its allow-list reason or null. */
function findMentions(files: readonly string[], patterns: readonly string[]): Mention[] {
  const found: Mention[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(resolve(ROOT, file), "utf8");
    } catch {
      continue;
    }
    if (!patterns.some((pattern) => content.includes(pattern))) continue;
    for (const [index, text] of content.split("\n").entries()) {
      for (const pattern of patterns) {
        if (!text.includes(pattern)) continue;
        const allowed = ALLOWED_MENTIONS.find((entry) => entry.file === file && entry.line.test(text));
        found.push({ file, line: index + 1, text: text.trim(), pattern, allowed: allowed?.reason ?? null });
      }
    }
  }
  return found;
}

/** Records the mentions and fails when one is not allowed. Returns the count of allowed mentions. */
function refuseUnallowed(found: readonly Mention[], label: string): number {
  mentions.push(...found);
  const refused = found.filter((mention) => mention.allowed === null);
  if (refused.length > 0) {
    fail(
      `${label} outside the allow-list:\n${refused.map((mention) => `${mention.file}:${mention.line} ${mention.pattern}: ${mention.text}`).join("\n")}`,
    );
  }
  return found.length;
}

const SCANNED_ROOTS = ["src/", "packages/", "apps/", "remote/", "scripts/", "tools/", ".github/"];
// Markdown and binary files. The lockfile is searched: it names each package that an install adds.
const SKIPPED_FILE = /\.(?:md|png|jpe?g|gif|webp|ico|icns|svg|woff2?|ttf|otf|mp3|wav|webm|mp4|zip|gz|pdf)$/u;
const TEST_FILE = /\.(?:test|spec)\.tsx?$|(?:^|\/)stories\/|\.stories\.tsx?$|(?:^|\/)fixtures\//u;

const files = repositoryFiles();

check("no file names an upstream analytics destination or an OpenPanel client", () => {
  const scanned = files.filter(
    (file) =>
      !SKIPPED_FILE.test(file) &&
      (SCANNED_ROOTS.some((root) => file.startsWith(root)) || !file.includes("/")) &&
      file !== "scripts/telemetry-destination-guard.ts",
  );
  const allowed = refuseUnallowed(findMentions(scanned, BLOCKED_ANALYTICS_STRINGS), "Analytics destinations");
  return { searched: scanned.length, allowed };
});

check("the desktop app and its development stack name no upstream service host", () => {
  const scanned = files.filter(
    (file) =>
      (file.startsWith("src/") ||
        /^packages\/[^/]+\/src\//u.test(file) ||
        file === "scripts/dev-services.ts" ||
        file === "scripts/telemetry-destinations.ts") &&
      !SKIPPED_FILE.test(file) &&
      !TEST_FILE.test(file) &&
      !file.startsWith("src/renderer/src/preview/"),
  );
  const allowed = refuseUnallowed(findMentions(scanned, BLOCKED_UPSTREAM_HOSTS), "Upstream service hosts");
  return { searched: scanned.length, allowed };
});

if (process.argv.includes("--build-output")) {
  check("the built app has no upstream analytics destination or OpenPanel client", () => {
    const missing = BUILD_OUTPUT.filter((directory) => !existsSync(resolve(ROOT, directory)));
    if (missing.length > 0) fail(`Run \`bun run build\` first. Missing: ${missing.join(", ")}`);
    const built = BUILD_OUTPUT.flatMap((directory) =>
      readdirSync(resolve(ROOT, directory), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(?:m?js|cjs|html|css|json)$/u.test(entry.name))
        .map((entry) => relative(ROOT, join(entry.parentPath, entry.name))),
    );
    // The build output has no allowed line: a match is always a failure.
    const found = findMentions(built, BLOCKED_ANALYTICS_STRINGS).map((mention) => ({ ...mention, allowed: null }));
    const allowed = refuseUnallowed(found, "Analytics destinations in the build output");
    return { searched: built.length, allowed };
  });
}

const passed = checks.every((entry) => entry.passed);
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(
  REPORT_PATH,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), phase: 0, passed, checks, mentions }, null, 2)}\n`,
);
for (const entry of checks) {
  logger.info(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}`);
  if (!entry.passed) logger.error(String(entry.details));
}
logger.info(`Wrote ${relative(ROOT, REPORT_PATH)}.`);
if (!passed) process.exitCode = 1;
