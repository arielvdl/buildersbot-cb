// The system dictation of this computer: a finished WAV recording in, its transcript out.
//
// macOS runs a small Swift binary that the build puts beside the voice runtime; it uses the Speech
// framework, on device when the language has its asset and on the server of the system otherwise.
// Windows runs the speech recognition of .NET, which needs the language pack of the language.
//
// Nothing here touches the microphone: the window records, as it does for every dictation. The
// engine is a preference, and `auto` uses this one only when it can work, then falls back to the
// voice model.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type DictationEngineStatus,
  type DictationSystemReason,
  VOICE_AUDIO_LIMITS,
  type VoiceLanguage,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger } from "@openbot/logging";
import { WINDOWS_SPEECH_SCRIPT } from "./os-dictation-windows-script";

const logger = createBuildersBotLogger("os-dictation");
const run = promisify(execFile);

const STATUS_TIMEOUT_MS = 8_000;
const TRANSCRIBE_TIMEOUT_MS = 150_000;
const STATUS_CACHE_MS = 30_000;
/** The helper answers a failure on stderr as `code: message`; the code is what is mapped. */
const FAILURE_CODE = /^([a-z-]+):/u;

/** One process run. Narrow, so a test can answer without the overloads of `execFile`. */
export type OsDictationRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

/** A failure the engine named. The category is known; the message stays in the log. */
export class OsDictationFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface OsDictationOptions {
  /** The voice folder: `.openbot-build/voice` in development, `Resources/voice` when packed. */
  resourcesRoot: string;
  /** The language of the voice settings, read at each call. */
  language: () => VoiceLanguage;
  platform?: NodeJS.Platform;
  /** The process runner, for a test. */
  run?: OsDictationRunner;
}

interface Status {
  available: boolean;
  reason: DictationSystemReason | null;
}

/**
 * Which failure a helper exit means. The overlay shows the catalog key, so the categories of the
 * helper become the keys of the settings row.
 */
function reasonOf(code: string): DictationSystemReason {
  if (code === "permission") return "error.dictation.system.permission";
  if (code === "language") return "error.dictation.system.language";
  return "error.dictation.system.missing";
}

export class OsDictationService {
  readonly #resourcesRoot: string;
  readonly #language: () => VoiceLanguage;
  readonly #platform: NodeJS.Platform;
  readonly #run: OsDictationRunner;
  #status: { at: number; value: Status } | null = null;

  constructor(options: OsDictationOptions) {
    this.#resourcesRoot = options.resourcesRoot;
    this.#language = options.language;
    this.#platform = options.platform ?? process.platform;
    this.#run = options.run ?? run;
  }

  /** The helper of this build, when the platform has one. */
  get #helper(): string | null {
    if (this.#platform !== "darwin") return null;
    const path = join(this.#resourcesRoot, "os-speech", "darwin", "os-speech");
    return existsSync(path) ? path : null;
  }

  /**
   * Whether the engine can run here. It is cached for a moment: the settings row asks, and the
   * overlay asks again on each dictation.
   */
  async status(): Promise<Status> {
    const cached = this.#status;
    if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.value;
    const value = await this.#probe();
    this.#status = { at: Date.now(), value };
    return value;
  }

  /** What the saved preference resolves to, and why the system engine is out when it is. */
  async engineStatus(engine: "auto" | "system" | "voice"): Promise<DictationEngineStatus> {
    const status = await this.status();
    return {
      resolved: engine === "system" ? "system" : engine === "voice" || !status.available ? "voice" : "system",
      system: status,
    };
  }

  /**
   * Reads the recording with the system recognition. The transcript is what was said; a failure
   * carries the category of the helper.
   */
  async transcribe(wav: Uint8Array): Promise<string> {
    if (wav.byteLength > VOICE_AUDIO_LIMITS.maximumWavBytes) throw new OsDictationFailure("too-long");
    const directory = await mkdtemp(join(tmpdir(), "buildersbot-dictation-"));
    const file = join(directory, "recording.wav");
    try {
      await writeFile(file, wav, { mode: 0o600 });
      const text =
        this.#platform === "darwin" ? await this.#transcribeDarwin(file) : await this.#transcribeWindows(file);
      const transcript = text.trim();
      if (!transcript) throw new OsDictationFailure("empty");
      return transcript;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #probe(): Promise<Status> {
    if (this.#platform === "win32") return this.#probeWindows();
    if (this.#platform !== "darwin") return { available: false, reason: "error.dictation.system.platform" };
    const helper = this.#helper;
    if (!helper) return { available: false, reason: "error.dictation.system.missing" };
    try {
      await this.#run(helper, ["--status"], { timeout: STATUS_TIMEOUT_MS });
      return { available: true, reason: null };
    } catch (error) {
      const code = failureCode(error);
      // A Mac that never granted the permission is usable: the first dictation asks for it.
      if (code === "permission" && /not granted/u.test(stderrOf(error))) return { available: true, reason: null };
      return { available: false, reason: reasonOf(code) };
    }
  }

  async #probeWindows(): Promise<Status> {
    try {
      const { stdout } = await this.#run("powershell", windowsArguments({ check: true }), {
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout);
      const recognizers = isDynamicRecord(parsed) && typeof parsed.recognizers === "number" ? parsed.recognizers : 0;
      return recognizers > 0
        ? { available: true, reason: null }
        : { available: false, reason: "error.dictation.system.missing" };
    } catch (error) {
      logger.warn("The Windows speech recognition could not be asked.", { error });
      return { available: false, reason: "error.dictation.system.missing" };
    }
  }

  async #transcribeDarwin(file: string): Promise<string> {
    const helper = this.#helper;
    if (!helper) throw new OsDictationFailure("missing");
    const { stdout } = await this.#run(helper, ["--language", this.#language(), "--file", file], {
      timeout: TRANSCRIBE_TIMEOUT_MS,
      maxBuffer: 1_048_576,
    });
    return stdout;
  }

  async #transcribeWindows(file: string): Promise<string> {
    const { stdout } = await this.#run("powershell", windowsArguments({ file, language: this.#language() }), {
      timeout: TRANSCRIBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1_048_576,
    });
    const parsed = JSON.parse(stdout);
    if (!isDynamicRecord(parsed)) throw new OsDictationFailure("recognize");
    if (typeof parsed.error === "string") {
      logger.info("The Windows speech recognition failed.", {
        error: parsed.error,
        message: typeof parsed.message === "string" ? parsed.message : "",
      });
      throw new OsDictationFailure(parsed.error);
    }
    return typeof parsed.text === "string" ? parsed.text : "";
  }
}

/**
 * The PowerShell arguments of one call. The values go in front of the script as assignments:
 * `-Command` takes one string, and trailing arguments are not bound to named parameters reliably.
 */
function windowsArguments(input: { check: true } | { file: string; language: VoiceLanguage }): string[] {
  const prelude =
    "check" in input
      ? "$File = ''\n$Language = 'automatic'\n$Check = $true\n"
      : `$File = '${input.file.replaceAll("'", "''")}'\n$Language = '${input.language.replaceAll("'", "''")}'\n$Check = $false\n`;
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", prelude + WINDOWS_SPEECH_SCRIPT];
}

/** The `code:` prefix of the helper's stderr, or `unknown`. */
function failureCode(error: unknown): string {
  return FAILURE_CODE.exec(stderrOf(error))?.[1] ?? "unknown";
}

function stderrOf(error: unknown): string {
  if (!isDynamicRecord(error)) return String(error);
  return typeof error.stderr === "string" ? error.stderr : "";
}

/** The catalog key of a failure, for the overlay and for `finish`. */
export function dictationFailureKey(error: unknown): string {
  if (!(error instanceof OsDictationFailure)) return "error.dictation.failed";
  if (error.code === "empty") return "error.dictation.empty";
  if (error.code === "too-long") return "error.dictation.tooLong";
  return reasonOf(error.code);
}

/** Reads the file of a test recording. */
export async function readRecording(path: string): Promise<Uint8Array> {
  return readFile(path);
}
