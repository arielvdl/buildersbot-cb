import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DICTATION_IDLE,
  type DictationPreference,
  type DictationPreferenceChange,
  type DictationResult,
  type DictationState,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { clipboard, globalShortcut } from "electron";
import type { DictationPreferenceStore } from "./dictation-preference-store";

const logger = createBuildersBotLogger("dictation");
const run = promisify(execFile);

/**
 * How long the pasted text waits in the clipboard before the previous clipboard comes back. A paste
 * reads the clipboard when the focused app handles the keystroke, which is after this call returns.
 */
const CLIPBOARD_RESTORE_MS = 600;
/** A keystroke that does not answer in this time is reported, not awaited forever. */
const KEYSTROKE_TIMEOUT_MS = 5_000;
/** How long the overlay says it is done, and how long it holds a failure before it goes. */
const DONE_MS = 700;
const FAILURE_MS = 4_000;

/**
 * Dictation from a global key combination: the recording runs in the window, and this owns the
 * combination, the phase the overlay shows and the paste into the app that had the focus.
 *
 * The combination only starts and stops. Everything that needs a microphone stays in the renderer,
 * which already holds the voice models, so this class never touches audio.
 */
export class DictationService {
  #preference: DictationPreference;
  #registered: string | null = null;
  #state: DictationState = DICTATION_IDLE;
  #restore: ReturnType<typeof setTimeout> | null = null;
  #settle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly preferences: DictationPreferenceStore,
    /** Sends the phase to every window. The overlay draws it. */
    private readonly publish: (state: DictationState) => void,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.#preference = preferences.get();
  }

  get state(): DictationState {
    return this.#state;
  }

  get preference(): DictationPreference {
    return this.#preference;
  }

  /** Registers the saved combination, when the setting is on. Called once the app is ready. */
  apply(): void {
    this.#register();
  }

  /**
   * Saves a change and makes the combination follow it. A combination that another app already
   * holds is refused, and the saved one stays: the user must know it did not take.
   */
  readonly setPreference = async (change: DictationPreferenceChange): Promise<DictationPreference> => {
    const previous = this.#preference;
    this.#preference = await Effect.runPromise(this.preferences.set(change));
    if (!this.#register()) {
      this.#preference = previous;
      await Effect.runPromise(this.preferences.set(previous));
      throw new Error(sourceText("error.dictation.shortcutTaken"));
    }
    return this.#preference;
  };

  /** The combination was pressed: it starts a recording, or ends the one that runs. */
  toggle(): void {
    if (this.#state.phase === "recording") this.stop();
    else if (this.#state.phase === "idle") this.start();
  }

  start(): void {
    if (!this.#preference.enabled || this.#state.phase !== "idle") return;
    this.#set({ phase: "recording", failure: null });
  }

  /** The recording ended: the window reads it and answers `finish`. */
  stop(): void {
    if (this.#state.phase !== "recording") return;
    this.#set({ phase: "transcribing", failure: null });
  }

  cancel(): DictationState {
    if (this.#state.phase === "idle") return this.#state;
    this.#clearSettle();
    this.#set(DICTATION_IDLE);
    return this.#state;
  }

  /**
   * Takes what the window made of the recording. A transcript is written to the clipboard and, in
   * paste mode, typed into the app that had the focus. A failure names its catalog key.
   */
  async finish(result: DictationResult): Promise<DictationState> {
    // A microphone that never opened answers from `recording`, so both are accepted.
    if (this.#state.phase !== "transcribing" && this.#state.phase !== "recording") return this.#state;
    if ("failure" in result) return this.#fail(result.failure);
    const text = result.text.trim();
    if (!text) return this.#fail("error.dictation.empty");
    try {
      await this.#deliver(text);
    } catch (error) {
      logger.warn("The dictation could not be pasted.", { error });
      return this.#fail(this.platform === "darwin" ? "error.dictation.pastePermission" : "error.dictation.paste");
    }
    this.#settleTo({ phase: "done", failure: null }, DONE_MS);
    return this.#state;
  }

  /** The app is quitting, or the setting is off: a registered combination holds the key until then. */
  dispose(): void {
    globalShortcut.unregisterAll();
    this.#registered = null;
    if (this.#restore) clearTimeout(this.#restore);
    this.#clearSettle();
  }

  #register(): boolean {
    if (this.#registered) {
      globalShortcut.unregister(this.#registered);
      this.#registered = null;
    }
    if (!this.#preference.enabled) return true;
    const accelerator = this.#preference.accelerator;
    try {
      const taken = globalShortcut.register(accelerator, () => this.toggle());
      if (!taken) return false;
      this.#registered = accelerator;
      return true;
    } catch (error) {
      logger.warn("The dictation combination could not be registered.", { accelerator, error });
      return false;
    }
  }

  async #deliver(text: string): Promise<void> {
    const previous = await clipboard.readText();
    await clipboard.writeText(text);
    if (this.#preference.mode === "copy") {
      // The clipboard is the delivery: no keystroke, so nothing needs the previous text back.
      return;
    }
    try {
      await this.#paste();
    } finally {
      if (this.#restore) clearTimeout(this.#restore);
      this.#restore = setTimeout(() => void this.#restoreClipboard(previous, text), CLIPBOARD_RESTORE_MS);
    }
  }

  /** Only while the text is still ours: the user may have copied something else meanwhile. */
  async #restoreClipboard(previous: string, ours: string): Promise<void> {
    if ((await clipboard.readText()) === ours) await clipboard.writeText(previous);
  }

  #paste(): Promise<void> {
    if (this.platform === "darwin") {
      return run("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down'], {
        timeout: KEYSTROKE_TIMEOUT_MS,
      }).then(() => undefined);
    }
    if (this.platform === "win32") {
      return run(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$shell = New-Object -ComObject WScript.Shell; $shell.SendKeys('^v')",
        ],
        { timeout: KEYSTROKE_TIMEOUT_MS, windowsHide: true },
      ).then(() => undefined);
    }
    return run("xdotool", ["key", "--clearmodifiers", "ctrl+v"], { timeout: KEYSTROKE_TIMEOUT_MS }).then(
      () => undefined,
    );
  }

  #fail(failure: string): DictationState {
    this.#settleTo({ phase: "failed", failure }, FAILURE_MS);
    return this.#state;
  }

  /** Shows an end state for a moment, then returns to idle, so the next press starts cleanly. */
  #settleTo(state: DictationState, delayMs: number): void {
    this.#clearSettle();
    this.#set(state);
    this.#settle = setTimeout(() => this.#set(DICTATION_IDLE), delayMs);
  }

  #clearSettle(): void {
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = null;
  }

  #set(state: DictationState): void {
    this.#state = state;
    this.publish(state);
  }
}
