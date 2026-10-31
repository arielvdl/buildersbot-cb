// Checks the build output (`out/`) for three packaging facts that no type check sees:
//
// - Runtime dependencies: every package that the main, preload and host bundles import at run time,
//   and every package those depend on, stays in app.asar. A package that electron-builder.yml
//   leaves out with a `!node_modules/<name>/**/*` line must not be one of them.
// - Languages: each renderer page (index, helper, picture in picture, team WebRTC) loads English and
//   Portuguese with the page, and each other language only as a chunk of its own on first use.
// - Minification: the renderer JavaScript is minified.
//
// It needs `bun run build` first and no network. It does not package the app: a package that the
// bundles load by a path that is not an import (a file read from node_modules) is out of its view.
//
// Usage: bun scripts/build-output-check.ts
// It writes .openbot-build/build-output/report.json and exits with 1 when a check fails.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger } from "@openbot/logging";
import { parse as parseYaml } from "yaml";

const logger = createBuildersBotLogger("build-output-check");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "out");
const REPORT_PATH = join(ROOT, ".openbot-build/build-output/report.json");
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/u;
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.split("/")[0] ?? name]));

/**
 * Packages that electron-builder.yml leaves out on purpose although a bundle dependency names them:
 * the platform binaries of the Claude Agent SDK, which `verify-macos-package.ts` checks are absent.
 */
const LEFT_OUT_ON_PURPOSE = /^@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-/u;

/** A text that each catalog has: the German, Portuguese and Japanese words for "Settings". */
const LANGUAGE_MARKERS = { de: "Einstellungen", pt: "Configurações", ja: "設定" } as const;

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function packageOf(specifier: string): string | null {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  if (!PACKAGE_NAME.test(name) || NODE_BUILTINS.has(name) || name === "electron") return null;
  return name;
}

/** The packages a bundle imports: static and dynamic imports, `require` and `require.resolve`. */
function importedPackages(source: string): Set<string> {
  const patterns = [
    /^import\s[^;]*?\sfrom\s*"([^"]+)"/gmu,
    /^import\s*"([^"]+)"/gmu,
    /\bimport\(\s*"([^"]+)"\s*\)/gu,
    /\brequire(?:Module\$?\d*)?(?:\.resolve)?\(\s*"([^"]+)"\s*\)/gu,
  ];
  const names = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = packageOf(match[1] ?? "");
      if (name) names.add(name);
    }
  }
  return names;
}

function readPackageJson(name: string): DynamicRecord | null {
  const path = join(ROOT, "node_modules", name, "package.json");
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  return isDynamicRecord(value) ? value : null;
}

function dependencyNames(manifest: DynamicRecord): string[] {
  const names: string[] = [];
  for (const field of ["dependencies", "optionalDependencies"]) {
    const value = manifest[field];
    if (isDynamicRecord(value)) names.push(...Object.keys(value));
  }
  const peers = manifest.peerDependencies;
  const peerMeta = isDynamicRecord(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {};
  if (isDynamicRecord(peers)) {
    for (const name of Object.keys(peers)) {
      const meta = peerMeta[name];
      if (!(isDynamicRecord(meta) && meta.optional === true)) names.push(name);
    }
  }
  return names;
}

/** Each package the roots need at run time, with the first package that pulled it in. */
function runtimeClosure(roots: Iterable<string>): Map<string, string> {
  const needed = new Map<string, string>();
  const queue = [...roots].map((name) => ({ name, via: "bundle" }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || needed.has(next.name)) continue;
    const manifest = readPackageJson(next.name);
    // An optional dependency for another platform is not installed, and is not needed here.
    if (!manifest) continue;
    needed.set(next.name, next.via);
    for (const name of dependencyNames(manifest)) queue.push({ name, via: next.name });
  }
  return needed;
}

/** The `!node_modules/<pattern>/**` lines of electron-builder.yml, as regular expressions. */
function excludedPackagePatterns(): { line: string; pattern: RegExp }[] {
  const config = parseYaml(readFileSync(join(ROOT, "electron-builder.yml"), "utf8"));
  const files = isDynamicRecord(config) && Array.isArray(config.files) ? config.files.filter(isString) : [];
  return files.flatMap((line) => {
    const match = /^!node_modules\/(.+?)\/\*\*(?:\/\*)?$/u.exec(line);
    if (!match?.[1]) return [];
    const glob = match[1]
      .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*\*/gu, ".*")
      .replace(/\*/gu, "[^/]*");
    return [{ line, pattern: new RegExp(`^${glob}$`, "u") }];
  });
}

function checkRuntimeDependencies(): void {
  const bundles = [
    ...readdirSync(join(OUT, "main"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(OUT, "main", name)),
    ...readdirSync(join(OUT, "preload"))
      .filter((name) => name.endsWith(".cjs") || name.endsWith(".js"))
      .map((name) => join(OUT, "preload", name)),
  ];
  const imported = new Set<string>();
  for (const bundle of bundles) for (const name of importedPackages(readFileSync(bundle, "utf8"))) imported.add(name);
  const missing = [...imported].filter((name) => !readPackageJson(name));
  check("each package that a bundle imports is installed", missing.length === 0, missing.join(", "));
  const closure = runtimeClosure(imported);
  const excluded = excludedPackagePatterns();
  const conflicts = [...closure].flatMap(([name, via]) =>
    LEFT_OUT_ON_PURPOSE.test(name)
      ? []
      : excluded
          .filter(({ pattern }) => pattern.test(name))
          .map(({ line }) => `${name} (needed by ${via}) matches ${line}`),
  );
  check(
    "no package that the main, preload or host bundles need is left out of app.asar",
    conflicts.length === 0,
    conflicts.join("; ") || `${imported.size} imported packages, ${closure.size} with dependencies`,
  );
}

/** The JavaScript files that a page loads with it: its entry and the `modulepreload` links. */
function eagerScripts(page: string): string[] {
  const html = readFileSync(join(OUT, "renderer", page), "utf8");
  const files = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/gu)) if (match[1]) files.add(match[1]);
  return [...files].map((file) => join(OUT, "renderer", file));
}

function checkLanguages(): void {
  const pages = readdirSync(join(OUT, "renderer")).filter((name) => name.endsWith(".html"));
  for (const page of pages) {
    const sources = eagerScripts(page).map((file) => readFileSync(file, "utf8"));
    const holds = (marker: string) => sources.some((source) => source.includes(marker));
    check(
      `${page} loads no German or Japanese text with the page`,
      !holds(LANGUAGE_MARKERS.de) && !holds(LANGUAGE_MARKERS.ja),
      "",
    );
    if (page === "team-webrtc.html") continue;
    check(`${page} loads the Portuguese text with the page`, holds(LANGUAGE_MARKERS.pt), "");
  }
  const assets = join(OUT, "renderer", "assets");
  const chunks = readdirSync(assets).filter((name) => name.endsWith(".js"));
  const german = chunks.some((name) => readFileSync(join(assets, name), "utf8").includes(LANGUAGE_MARKERS.de));
  check("German is a chunk that loads on first use", german, "");
}

function checkMinified(): void {
  const assets = join(OUT, "renderer", "assets");
  const entry = readdirSync(assets).find((name) => /^index-.+\.js$/u.test(name));
  if (!entry) {
    check("the renderer entry is minified", false, "No index-*.js in out/renderer/assets.");
    return;
  }
  const source = readFileSync(join(assets, entry), "utf8");
  const averageLine = source.length / Math.max(1, source.split("\n").length);
  check("the renderer entry is minified", averageLine > 1_000, `${Math.round(averageLine)} characters a line`);
}

if (!existsSync(join(OUT, "main")) || !existsSync(join(OUT, "renderer"))) {
  check("the build output exists", false, "Run `bun run build` first.");
} else {
  checkRuntimeDependencies();
  checkLanguages();
  checkMinified();
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
