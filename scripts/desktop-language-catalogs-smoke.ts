// Checks that the desktop renderer build holds English and Portuguese in the entry of each window,
// and loads every other language on first use. `electron.vite.config.ts` puts
// `packages/i18n/src/desktop-catalogs.ts` in place of the static catalog modules; without it, each
// window holds all thirteen languages again. It reads the build output, starts no app and sends no
// request. It checks that:
//
// - no HTML entry of `out/renderer`, with the chunks that it imports statically, holds a marker text
//   of German, French or Japanese;
// - the entries of the main window, the helper windows and the browser picture-in-picture
//   (`index.html`, `helper.html`, `browser-pip.html`, `browser-pip-controls.html`) hold the marker
//   texts of English and Portuguese;
// - each marker text of German, French and Japanese is in a chunk that no entry imports statically,
//   so the language can still load.
//
// A marker text is a long app catalog text of one language that no other checked language has.
//
// Usage: bun scripts/desktop-language-catalogs-smoke.ts [--build]
// `--build` runs `bun run build` first; without it, the script reads the output of the last build.
// It writes .openbot-build/desktop-language-catalogs-smoke/report.json and exits with 1 when a check
// fails.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import type { PartialTranslation } from "../packages/i18n/src/message";
import { de } from "../packages/i18n/src/messages/de/index";
import { type AppMessages, en } from "../packages/i18n/src/messages/en/index";
import { fr } from "../packages/i18n/src/messages/fr/index";
import { ja } from "../packages/i18n/src/messages/ja/index";
import { pt } from "../packages/i18n/src/messages/pt/index";

const logger = createBuildersBotLogger("desktop-language-catalogs-smoke");
const ROOT = resolve(import.meta.dirname, "..");
const RENDERER = resolve(ROOT, "out/renderer");
const REPORT_PATH = resolve(ROOT, ".openbot-build/desktop-language-catalogs-smoke/report.json");
/** The entries that show interface text, so each must hold the two bundled languages. */
const TEXT_ENTRIES = ["index.html", "helper.html", "browser-pip.html", "browser-pip-controls.html"];
const MARKERS_PER_LANGUAGE = 12;
const MARKER_MIN_LENGTH = 20;
/** Texts with a quote, an escape, a line break or a placeholder can change form in the bundle. */
const PLAIN_TEXT = /^[^"'`\\\n\r{}$<>]+$/u;

/** A plural message is an object; only plain texts are marker texts. */
type Catalog = PartialTranslation<AppMessages>;
const BUNDLED: Record<string, Catalog> = { en, pt };
const LAZY: Record<string, Catalog> = { de, fr, ja };

interface Check {
  name: string;
  passed: boolean;
  details?: unknown;
}

if (process.argv.includes("--build")) execFileSync("bun", ["run", "build"], { cwd: ROOT, stdio: "inherit" });

const checks: Check[] = [];
const markers = markerTexts({ ...BUNDLED, ...LAZY });

if (!existsSync(RENDERER)) {
  checks.push({ name: "the renderer build exists", passed: false, details: "Run `bun run build` first." });
} else {
  const chunks = new Map<string, string>();
  for (const file of listFiles(RENDERER)) if (file.endsWith(".js")) chunks.set(file, readFileSync(file, "utf8"));
  const entries = readdirSync(RENDERER).filter((name) => name.endsWith(".html"));
  const staticChunks = new Set<string>();

  for (const entry of entries) {
    const graph = staticGraph(join(RENDERER, entry), chunks);
    for (const file of graph) staticChunks.add(file);
    const text = [...graph].map((file) => chunks.get(file) ?? "").join("\n");
    for (const locale of Object.keys(LAZY)) {
      const found = (markers[locale] ?? []).filter((marker) => contains(text, marker));
      checks.push({
        name: `${entry} does not hold ${locale}`,
        passed: found.length === 0,
        ...(found.length > 0 ? { details: { found } } : {}),
      });
    }
    if (!TEXT_ENTRIES.includes(entry)) continue;
    for (const locale of Object.keys(BUNDLED)) {
      const missing = (markers[locale] ?? []).filter((marker) => !contains(text, marker));
      checks.push({
        name: `${entry} holds ${locale}`,
        passed: missing.length === 0,
        ...(missing.length > 0 ? { details: { missing } } : {}),
      });
    }
  }
  for (const entry of TEXT_ENTRIES) {
    if (!entries.includes(entry)) checks.push({ name: `${entry} is built`, passed: false });
  }

  const lazyText = [...chunks]
    .filter(([file]) => !staticChunks.has(file))
    .map(([, text]) => text)
    .join("\n");
  for (const locale of Object.keys(LAZY)) {
    const missing = (markers[locale] ?? []).filter((marker) => !contains(lazyText, marker));
    checks.push({
      name: `a chunk that loads on first use holds ${locale}`,
      passed: missing.length === 0,
      ...(missing.length > 0 ? { details: { missing } } : {}),
    });
  }
}

for (const [locale, list] of Object.entries(markers)) {
  checks.push({ name: `${locale} has marker texts`, passed: list.length === MARKERS_PER_LANGUAGE });
}

const passed = checks.every((check) => check.passed);
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(
  REPORT_PATH,
  `${JSON.stringify({ passed, checkedAt: new Date().toISOString(), output: relative(ROOT, RENDERER), markers, checks }, null, 2)}\n`,
);
for (const check of checks) {
  logger.info(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
  if (!check.passed && check.details !== undefined) logger.error(JSON.stringify(check.details));
}
logger.info(`Wrote ${relative(ROOT, REPORT_PATH)}.`);
if (!passed) process.exitCode = 1;

/** For each language, the first long plain texts, by key, that no other of the given languages has. */
function markerTexts(catalogs: Record<string, Catalog>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const others = new Set<string>();
    for (const [other, values] of Object.entries(catalogs)) {
      if (other === locale) continue;
      for (const value of Object.values(values)) if (typeof value === "string") others.add(value);
    }
    const list: string[] = [];
    const byKey = Object.entries(catalog).sort(([left], [right]) => left.localeCompare(right));
    for (const [, value] of byKey) {
      if (typeof value !== "string" || value.length < MARKER_MIN_LENGTH || !PLAIN_TEXT.test(value)) continue;
      if (others.has(value) || [...others].some((other) => other.includes(value))) continue;
      list.push(value);
      if (list.length === MARKERS_PER_LANGUAGE) break;
    }
    result[locale] = list;
  }
  return result;
}

/** The text as the bundle can write it: as is, or with each non-ASCII UTF-16 unit as `\uxxxx`. */
function contains(bundle: string, text: string): boolean {
  if (bundle.includes(text)) return true;
  const escaped = (upper: boolean) =>
    Array.from({ length: text.length }, (_, index) => {
      const unit = text.charCodeAt(index);
      if (unit < 0x80) return text[index];
      const hex = unit.toString(16).padStart(4, "0");
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    }).join("");
  return bundle.includes(escaped(false)) || bundle.includes(escaped(true));
}

/** The scripts of an HTML entry, and every chunk that they import statically, by absolute path. */
function staticGraph(html: string, chunks: ReadonlyMap<string, string>): Set<string> {
  const source = readFileSync(html, "utf8");
  const pending: string[] = [];
  for (const match of source.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/gu))
    pending.push(resolveChunk(dirname(html), match[1] ?? ""));
  for (const match of source.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+\.js)"/gu))
    pending.push(resolveChunk(dirname(html), match[1] ?? ""));
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    const text = chunks.get(file);
    if (text === undefined) continue;
    seen.add(file);
    // `import{a as b}from"./x.js"`, `import"./x.js"` and `export{a}from"./x.js"`; never `import("./x.js")`.
    for (const match of text.matchAll(
      /(?:^|[;}/\s])(?:import|export)\s*(?:[\w$*{}\s,]+?from\s*)?["']([^"']+\.js)["']/gu,
    ))
      pending.push(resolveChunk(dirname(file), match[1] ?? ""));
  }
  return seen;
}

function resolveChunk(from: string, specifier: string): string {
  return specifier.startsWith("/") ? join(RENDERER, specifier) : resolve(from, specifier);
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
