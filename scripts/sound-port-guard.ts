// Checks that every sound of the desktop app goes through the sound center, so that the person can
// find, change and silence it in Settings › Notifications › Sounds (`docs/architecture/sounds.md`).
// It needs no build and no network. It checks that:
//
// - no code file in `src/` and `packages/` (except tests and stories) makes a sound outside the two
//   ports: `src/renderer/src/sound-center.ts` (the renderer) and `src/main/sound-port.ts` (main). A
//   sound is `new Audio(...)`, `new AudioContext(...)` or `new webkitAudioContext(...)`, an import of
//   `cuelume`, `speechSynthesis`, `afplay`, a spawn of `say`, `shell.beep()`, an `<audio>` element,
//   or `new Notification(...)` (a macOS notification plays a sound). Only the lines in ALLOWED can,
//   each with its reason;
// - the matcher finds each pattern in `tools/sound-port/fixtures/stray-sounds.ts.txt`, and finds none in
//   `tools/sound-port/fixtures/clean.ts.txt`, so a broken pattern fails here and does not pass in silence.
//
// Usage: bun scripts/sound-port-guard.ts [--files <path>...]
// `--files` checks only the named files, with the same rules, such as a file that you want to try.
// It writes .openbot-build/sound-port-guard/report.json and exits with 1 when a check fails.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = resolve(ROOT, ".openbot-build/sound-port-guard/report.json");
const SCANNED = /^(?:src|packages)\/.+\.(?:ts|tsx)$/u;
const SKIPPED = /(?:\.test\.tsx?$|\.dom\.test\.ts$|\/stories\/|\.stories\.tsx?$|\/fixtures\/|\/node_modules\/)/u;
const STRAY_FIXTURE = "tools/sound-port/fixtures/stray-sounds.ts.txt";
const CLEAN_FIXTURE = "tools/sound-port/fixtures/clean.ts.txt";

/** The patterns that make a sound. Each is matched on a line without its `//` comment. */
export const SOUND_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "new Audio", pattern: /\bnew\s+Audio\s*\(/u },
  { name: "AudioContext", pattern: /\bnew\s+(?:webkit)?AudioContext\s*\(/u },
  { name: "cuelume", pattern: /\bfrom\s+["']cuelume["']|\bimport\s*\(\s*["']cuelume["']\s*\)/u },
  { name: "speechSynthesis", pattern: /\bspeechSynthesis\b/u },
  { name: "afplay", pattern: /["'`][^"'`]*\bafplay\b/u },
  {
    name: "say command",
    pattern: /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\s*\(\s*["'`](?:\/usr\/bin\/)?say\b/u,
  },
  { name: "shell.beep", pattern: /\bshell\.beep\s*\(/u },
  { name: "audio element", pattern: /<audio\b/u },
  { name: "Notification", pattern: /\bnew\s+Notification\s*\(/u },
];

/**
 * The only lines outside the ports that can match. Each names its file, the pattern, and why it is
 * not a sound that the sound center must control.
 */
const ALLOWED: ReadonlyArray<{ file: string; pattern: string; reason: string }> = [
  { file: "src/renderer/src/sound-center.ts", pattern: "*", reason: "the renderer port of the sound center" },
  { file: "src/main/sound-port.ts", pattern: "*", reason: "the main port of the sound center" },
  {
    file: "src/renderer/src/features/speech/speech-playback.ts",
    pattern: "AudioContext",
    reason: "a voice reads a reply; the Voice page controls it and Recent sounds lists each reading",
  },
  {
    file: "src/renderer/src/features/conversation/stores/voice-store.ts",
    pattern: "AudioContext",
    reason: "the microphone meter of a dictation: it reads the microphone and plays nothing",
  },
  {
    file: "src/renderer/src/features/conversation/stores/voice-conversation-store.ts",
    pattern: "AudioContext",
    reason: "the microphone meter of a voice conversation: it reads the microphone and plays nothing",
  },
  {
    file: "src/renderer/src/voice-recording.ts",
    pattern: "AudioContext",
    reason: "decodes a recording to samples for transcription and plays nothing",
  },
  {
    file: "packages/ui/src/features/conversation/MediaFilePreview.tsx",
    pattern: "audio element",
    reason: "an audio file that the person opens and plays with its own controls",
  },
  {
    file: "src/renderer/src/features/web-client/web-notifications.ts",
    pattern: "Notification",
    reason: "a browser notification of the web client: the browser and the system choose its sound",
  },
];

export interface SoundFinding {
  file: string;
  line: number;
  text: string;
  pattern: string;
  allowed: string | null;
}

/** The text of a line without a `//` comment at its end or a `*` comment line. */
function codeOf(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  const comment = line.search(/\s\/\/\s/u);
  return comment === -1 ? line : line.slice(0, comment);
}

export function findSounds(file: string, content: string): SoundFinding[] {
  return content.split("\n").flatMap((text, index) => {
    const code = codeOf(text);
    if (!code) return [];
    return SOUND_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(({ name }) => {
      const allowed = ALLOWED.find((entry) => entry.file === file && (entry.pattern === "*" || entry.pattern === name));
      return { file, line: index + 1, text: text.trim(), pattern: name, allowed: allowed?.reason ?? null };
    });
  });
}

function repositoryFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter(Boolean))].filter(
    (file) => SCANNED.test(file) && !SKIPPED.test(file) && existsSync(resolve(ROOT, file)),
  );
}

interface Check {
  name: string;
  passed: boolean;
  details: unknown;
}

function main(): void {
  const filesArgument = process.argv.indexOf("--files");
  const named = filesArgument === -1 ? null : process.argv.slice(filesArgument + 1);
  const files = named ? named.map((file) => relative(ROOT, resolve(file))) : repositoryFiles();
  const findings = files.flatMap((file) => findSounds(file, readFileSync(resolve(ROOT, file), "utf8")));
  const stray = findings.filter((finding) => finding.allowed === null);
  const checks: Check[] = [
    {
      name: named ? "the named files make no sound outside the ports" : "no code makes a sound outside the ports",
      passed: stray.length === 0,
      details: { scanned: files.length, stray },
    },
  ];
  if (!named) {
    const strayFixture = findSounds(STRAY_FIXTURE, readFileSync(resolve(ROOT, STRAY_FIXTURE), "utf8"));
    const missed = SOUND_PATTERNS.filter(({ name }) => !strayFixture.some((finding) => finding.pattern === name));
    checks.push({
      name: "the matcher finds each pattern in the stray fixture",
      passed: missed.length === 0 && strayFixture.every((finding) => finding.allowed === null),
      details: { found: strayFixture.map((finding) => finding.pattern), missed: missed.map(({ name }) => name) },
    });
    const cleanFixture = findSounds(CLEAN_FIXTURE, readFileSync(resolve(ROOT, CLEAN_FIXTURE), "utf8"));
    checks.push({
      name: "the matcher finds nothing in the clean fixture",
      passed: cleanFixture.length === 0,
      details: cleanFixture,
    });
  }
  const passed = checks.every((check) => check.passed);
  const report = {
    passed,
    checks,
    allowed: findings.filter((finding) => finding.allowed !== null),
    allowList: ALLOWED,
  };
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  for (const check of checks) process.stdout.write(`${check.passed ? "pass" : "FAIL"}  ${check.name}\n`);
  for (const finding of stray)
    process.stdout.write(`  ${finding.file}:${finding.line}  ${finding.pattern}  ${finding.text}\n`);
  process.stdout.write(`Report: ${relative(ROOT, REPORT_PATH)}\n`);
  if (!passed) process.exitCode = 1;
}

if (import.meta.main) main();
