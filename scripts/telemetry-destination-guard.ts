// Checks that no build of Builders Bot can send analytics or telemetry to a host of the upstream
// OpenBot project, which Builders Bot does not control (phase 0 of
// .openbot-build/bug-reports/DESIGN.md). It needs no network and sends no request. It checks that:
//
// - no file of the repository names an upstream analytics destination or an OpenPanel client: the
//   hosts, the client ID of the upstream project, the SDK default host, the SDK class and the SDK
//   packages (`scripts/telemetry-destinations.ts` lists them). Only the lines in ALLOWED_MENTIONS
//   can, and a Markdown paragraph that names the destination as the upstream project's;
// - no code, configuration or workflow names an upstream service host, except the lines in
//   ALLOWED_MENTIONS. Tests, stories and preview data send no request, so this search skips them;
// - no interface text or served page promises an analytics service or switch that does not exist;
// - the app deletes the queue files that an earlier version would send;
// - the matcher ignores case, and a Markdown paragraph that does not name the upstream project fails;
// - with `--build-output`, the built app (`out/main`, `out/preload`, `out/renderer`) has none of the
//   analytics strings. `check:desktop:static` and the package scripts pass it right after `bun run build`;
// - with `--package [<path>]`, the packaged app (`app.asar` and `app.asar.unpacked`) has none of
//   them. The path is the app, its resources folder or its `app.asar`; without one, it is the macOS
//   app that `bun run package` makes for this computer.
//
// Usage: bun scripts/telemetry-destination-guard.ts [--build-output] [--package [<path>]]
// It writes .openbot-build/telemetry-destination-guard/report.json and exits with 1 when a check fails.
import { execFileSync } from "node:child_process";
import {
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
import { basename, dirname, join, relative, resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { removeStaleTelemetryQueues, STALE_TELEMETRY_QUEUE_FILES } from "../src/main/stale-telemetry-queues";
import { readBuilderIdentity } from "./builders-bot-package";
import {
  BLOCKED_ANALYTICS_STRINGS,
  BLOCKED_UPSTREAM_HOSTS,
  FALSE_ANALYTICS_CLAIMS,
  findBlockedStringsInPackage,
  findPatterns,
} from "./telemetry-destinations";

const logger = createBuildersBotLogger("telemetry-destination-guard");
const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = resolve(ROOT, ".openbot-build/telemetry-destination-guard/report.json");
const BUILD_OUTPUT = ["out/main", "out/preload", "out/renderer"];
const GUARD_FILE = "scripts/telemetry-destination-guard.ts";

const UPSTREAM_OPEN_ITEM =
  "an upstream service host, not telemetry: an open item outside phase 0 (incident record, section 8)";

/**
 * The only lines that can name a blocked string. Each names its file and the text of its line.
 * Nothing here sends data to an analytics service. The upstream service hosts that stay are not
 * telemetry; the incident record lists them as open items, and a new one fails this guard.
 */
const ALLOWED_MENTIONS: ReadonlyArray<{ file: string | RegExp; line: RegExp; reason: string }> = [
  {
    file: "scripts/telemetry-destinations.ts",
    line: /^(?: {2}"[^"]+",|export const BLOCKED_[A-Z_]+ = \[.*\] as const;)$/u,
    reason: "the list of blocked destinations and texts that the guard and the package checks read",
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
  {
    file: "apps/auth-api/src/lib/site-metadata.ts",
    line: /^const OPENBOT_PRODUCTION_HOSTS = new Set\(\["openbot\.run", "api\.openbot\.run"\]\);$/u,
    reason: `compares the request host and sends nothing; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: "apps/auth-api/src/server/avatar-storage.ts",
    line: /^\s*const url = new URL\(avatarUrl, "https:\/\/api\.openbot\.run"\);$/u,
    reason: `base to read a relative avatar address, with no request; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: "apps/auth-api/src/server/canonical-redirect.ts",
    line: /^ \* The page that a Slack or Discord install returns to\. The callback runs on `api\.openbot\.run`, and the$/u,
    reason: `comment; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: /^apps\/slack-app\/(?:development|production)\/manifest\.json$/u,
    line: /^\s*"redirect_urls": \["https:\/\/(?:openbot-auth-api-test\.internal9671\.workers\.dev|api\.openbot\.run)\/v2\/slack\/callback"\],$/u,
    reason: `Slack install callback of the upstream Slack app; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: "apps/status/scripts/update.ts",
    line: /^\s*api: "https:\/\/api\.openbot\.run",$/u,
    reason: `status page probe of the upstream health route, with no user data; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: /^remote\/\.env\.(?:example|production)$/u,
    line: /^REMOTE_(?:TICKET_JWKS|CONTROL_PLANE)_URL=https:\/\/api\.openbot\.run(?:\/\.well-known\/jwks\.json)?$/u,
    reason: `Signal reads the account keys of the upstream API; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: "scripts/publish-production-catalog.ts",
    line: /^const productionApiUrl = "https:\/\/api\.openbot\.run";$/u,
    reason: `catalog publish tool of the upstream production; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: "scripts/hosting/release-boat-template.sh",
    line: /^\s*--auth-api-url=https:\/\/api\.openbot\.run$/u,
    reason: `hosted server template release of the upstream; ${UPSTREAM_OPEN_ITEM}`,
  },
  {
    file: ".github/workflows/ci.yml",
    line: /^\s*curl --fail --silent --show-error --retry 5 --retry-all-errors https:\/\/api\.openbot\.run\/health\/(?:live|ready) >\/dev\/null$/u,
    reason: `deploy smoke check of the upstream health routes (ci.yml runs only for main); ${UPSTREAM_OPEN_ITEM}`,
  },
];

const MARKDOWN_UPSTREAM_REASON = "documentation that names the destination as one of the upstream project";

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

async function check(name: string, run: () => unknown): Promise<void> {
  try {
    checks.push({ name, passed: true, details: (await run()) ?? null });
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

/** The lines around `index` up to the nearest blank lines: the paragraph, list item or table. */
function paragraphOf(lines: readonly string[], index: number): string {
  let start = index;
  let end = index;
  while (start > 0 && lines[start - 1]?.trim()) start -= 1;
  while (end < lines.length - 1 && lines[end + 1]?.trim()) end += 1;
  return lines.slice(start, end + 1).join("\n");
}

function allowedReason(file: string, lines: readonly string[], index: number): string | null {
  const text = lines[index] ?? "";
  const entry = ALLOWED_MENTIONS.find(
    (allowed) =>
      (typeof allowed.file === "string" ? allowed.file === file : allowed.file.test(file)) && allowed.line.test(text),
  );
  if (entry) return entry.reason;
  return MARKDOWN_FILE.test(file) && /upstream/iu.test(paragraphOf(lines, index)) ? MARKDOWN_UPSTREAM_REASON : null;
}

/** Each line of a file's text that holds one of `patterns`, in any case, with its allow-list reason or null. */
function findMentionsInText(file: string, content: string, patterns: readonly string[]): Mention[] {
  if (findPatterns(content, patterns).length === 0) return [];
  const lines = content.split("\n");
  return lines.flatMap((text, index) =>
    findPatterns(text, patterns).map((pattern) => ({
      file,
      line: index + 1,
      // The report is a CI artifact: a line of an environment file can hold a secret next to the host.
      text: ENVIRONMENT_FILE.test(file) ? "(a line of an environment file, not recorded)" : text.trim(),
      pattern,
      allowed: allowedReason(file, lines, index),
    })),
  );
}

function findMentions(files: readonly string[], patterns: readonly string[]): Mention[] {
  return files.flatMap((file) => {
    let content: string;
    try {
      content = readFileSync(resolve(ROOT, file), "utf8");
    } catch {
      return [];
    }
    return findMentionsInText(file, content, patterns);
  });
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

// Binary files. The lockfile is searched: it names each package that an install adds.
const BINARY_FILE =
  /\.(?:png|jpe?g|gif|webp|ico|icns|car|svg|woff2?|ttf|otf|mp3|wav|webm|mp4|zip|gz|tgz|pdf|node|wasm)$/iu;
const MARKDOWN_FILE = /\.mdx?$/iu;
const ENVIRONMENT_FILE = /(?:^|\/)\.env(?:\.[^/]*)?$/u;
const TEST_FILE = /\.(?:test|spec)\.tsx?$|(?:^|\/)stories\/|\.stories\.tsx?$|(?:^|\/)fixtures\//u;

const files = repositoryFiles().filter((file) => !BINARY_FILE.test(file) && file !== GUARD_FILE);
const codeFiles = files.filter(
  (file) => !MARKDOWN_FILE.test(file) && !TEST_FILE.test(file) && !file.startsWith("src/renderer/src/preview/"),
);

await check("no file names an upstream analytics destination or an OpenPanel client", () => {
  const allowed = refuseUnallowed(findMentions(files, BLOCKED_ANALYTICS_STRINGS), "Analytics destinations");
  return { searched: files.length, allowed };
});

await check("no code, configuration or workflow names an upstream service host", () => {
  const allowed = refuseUnallowed(findMentions(codeFiles, BLOCKED_UPSTREAM_HOSTS), "Upstream service hosts");
  return { searched: codeFiles.length, allowed };
});

await check("no interface text or served page promises an analytics service or switch that does not exist", () => {
  const allowed = refuseUnallowed(findMentions(codeFiles, FALSE_ANALYTICS_CLAIMS), "Analytics claims");
  return { searched: codeFiles.length, allowed };
});

await check("the matcher ignores case and refuses a Markdown paragraph that does not name the upstream project", () => {
  const capitals = findMentionsInText(
    "src/sample.ts",
    'const url = "https://Analytics.OpenBot.Run/api";',
    BLOCKED_ANALYTICS_STRINGS,
  );
  if (capitals.length !== 1 || capitals[0]?.allowed !== null) fail("A host in capital letters was not refused.");
  const table = findMentionsInText(
    "docs/sample.md",
    "| Host | Use |\n| --- | --- |\n| `*.openbot.run` | Sites, and `analytics.openbot.run` |\n",
    BLOCKED_ANALYTICS_STRINGS,
  );
  if (table.length !== 1 || table[0]?.allowed !== null) fail("A Markdown table that allows the host was not refused.");
  const history = findMentionsInText(
    "docs/sample.md",
    "Earlier versions sent events to the upstream\nproject (`analytics.openbot.run`).\n",
    BLOCKED_ANALYTICS_STRINGS,
  );
  if (history.length !== 1 || history[0]?.allowed !== MARKDOWN_UPSTREAM_REASON) {
    fail("A Markdown paragraph that names the upstream project was refused.");
  }
  return { capitals: capitals.length, table: table.length, history: history.length };
});

await check("the app deletes the queue files that an earlier version would send", async () => {
  const userData = mkdtempSync(join(tmpdir(), "telemetry-queues-"));
  try {
    const kept = "openbot-analytics-preference-v1.json";
    for (const file of [...STALE_TELEMETRY_QUEUE_FILES, kept]) writeFileSync(join(userData, file), "{}");
    await Effect.runPromise(removeStaleTelemetryQueues(userData));
    // A second start finds no file and still ends.
    await Effect.runPromise(removeStaleTelemetryQueues(userData));
    const left = readdirSync(userData);
    if (left.join() !== kept) fail(`Expected only ${kept} after the start, found: ${left.join(", ") || "nothing"}.`);
    return { deleted: STALE_TELEMETRY_QUEUE_FILES, kept };
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

if (process.argv.includes("--build-output")) {
  await check("the built app has no upstream analytics destination or OpenPanel client", () => {
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

/** The resources folder of the packaged app that `--package` names, or of the default macOS app. */
function packageResources(): string {
  const value = process.argv[process.argv.indexOf("--package") + 1];
  if (value && !value.startsWith("--")) {
    const path = resolve(value);
    if (basename(path) === "app.asar") return dirname(path);
    // A macOS app bundle, also one renamed as a backup.
    if (existsSync(join(path, "Contents", "Resources", "app.asar"))) return join(path, "Contents", "Resources");
    return path;
  }
  const { productName } = readBuilderIdentity();
  return resolve(
    ROOT,
    process.arch === "arm64" ? "dist/mac-arm64" : "dist/mac",
    `${productName}.app`,
    "Contents/Resources",
  );
}

if (process.argv.includes("--package")) {
  await check("the packaged app has no upstream analytics destination or OpenPanel client", async () => {
    const resources = packageResources();
    if (!existsSync(join(resources, "app.asar")) || !statSync(join(resources, "app.asar")).isFile()) {
      fail(`No app.asar in ${resources}. Package the app first, or name the app with --package <path>.`);
    }
    const found = await findBlockedStringsInPackage(resources);
    if (found.length > 0) {
      fail(
        `Analytics destinations in the packaged app ${resources}:\n${found.map((mention) => `${mention.file}: ${mention.pattern}`).join("\n")}`,
      );
    }
    return { resources };
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
