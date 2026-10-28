// Dictation outside the composer: a global key combination starts the recording of the chosen voice
// model, and the transcript goes to the app that had the focus.
//
// The combination and the switch are per computer, like the microphone itself. Off by default,
// because a global combination takes a key from every other app until the user chooses it.

import { isDynamicRecord } from "./runtime-values";

/** What the transcript does: pasted into the focused app, or left on the clipboard to paste later. */
export const DICTATION_MODES = ["paste", "copy"] as const;
export type DictationMode = (typeof DICTATION_MODES)[number];

export interface DictationPreference {
  enabled: boolean;
  /** An Electron accelerator. It always holds a modifier, so it can be a global shortcut. */
  accelerator: string;
  mode: DictationMode;
}

/** The choices to change. A choice that is not given keeps its value. */
export interface DictationPreferenceChange {
  enabled?: boolean;
  accelerator?: string;
  mode?: DictationMode;
}

/**
 * `CommandOrControl` keeps one default on every platform. The combination is unused by macOS,
 * Windows and the desktop environments the app runs on.
 */
export const DEFAULT_DICTATION_PREFERENCE: DictationPreference = {
  enabled: false,
  accelerator: "CommandOrControl+Shift+Space",
  mode: "paste",
};

/** The longest accelerator that is still readable in the settings row. */
export const DICTATION_ACCELERATOR_LIMIT = 64;

const MODIFIERS = new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
]);

const NAMED_KEYS = new Set([
  "space",
  "tab",
  "backspace",
  "delete",
  "insert",
  "return",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "esc",
  "plus",
  "num0",
  "num1",
  "num2",
  "num3",
  "num4",
  "num5",
  "num6",
  "num7",
  "num8",
  "num9",
  "numdec",
  "numadd",
  "numsub",
  "nummult",
  "numdiv",
]);

function oneOf<Value extends string>(values: readonly Value[], value: unknown): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

/**
 * True for a combination Electron can register globally: a modifier, then one key. A bare letter
 * would take that letter from every app, so it is refused.
 */
export function isDictationAccelerator(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DICTATION_ACCELERATOR_LIMIT) return false;
  const parts = trimmed.split("+").filter(Boolean);
  if (parts.length < 2) return false;
  const key = parts.at(-1)?.toLowerCase() ?? "";
  if (MODIFIERS.has(key)) return false;
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (modifiers.some((modifier) => !MODIFIERS.has(modifier))) return false;
  if (!/^[a-z0-9]$/u.test(key) && !/^f([1-9]|1\d|2[0-4])$/u.test(key) && !NAMED_KEYS.has(key)) return false;
  return true;
}

/** A stored combination is kept as typed, without the spaces around its parts. */
export function normalizeDictationAccelerator(value: string): string {
  return value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("+");
}

export function isDictationPreference(value: unknown): value is DictationPreference {
  return (
    isDynamicRecord(value) &&
    typeof value.enabled === "boolean" &&
    isDictationAccelerator(value.accelerator) &&
    oneOf(DICTATION_MODES, value.mode)
  );
}

/** Reads the change a window sends. At least one choice is required. */
export function parseDictationPreferenceChange(input: unknown): DictationPreferenceChange {
  if (!isDynamicRecord(input)) throw new Error("The dictation change is required.");
  const change: DictationPreferenceChange = {};
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") throw new Error("The dictation switch is invalid.");
    change.enabled = input.enabled;
  }
  if ("accelerator" in input) {
    // The field can carry the spaces a person typed around the parts.
    const accelerator = typeof input.accelerator === "string" ? normalizeDictationAccelerator(input.accelerator) : null;
    if (!isDictationAccelerator(accelerator)) throw new Error("The dictation key is invalid.");
    change.accelerator = accelerator;
  }
  if ("mode" in input) {
    if (!oneOf(DICTATION_MODES, input.mode)) throw new Error("The dictation mode is invalid.");
    change.mode = input.mode;
  }
  if (Object.keys(change).length === 0) throw new Error("The dictation change is required.");
  return change;
}

/**
 * Where the dictation of a global combination is: recording, reading the recording, or done.
 * `failed` carries a catalog key for the toast, so main sends no prose.
 */
export const DICTATION_PHASES = ["idle", "recording", "transcribing", "done", "failed"] as const;
export type DictationPhase = (typeof DICTATION_PHASES)[number];

export interface DictationState {
  phase: DictationPhase;
  /** The catalog key of a failure, when `phase` is `failed`. */
  failure: string | null;
}

export const DICTATION_IDLE: DictationState = { phase: "idle", failure: null };

export function isDictationState(value: unknown): value is DictationState {
  return (
    isDynamicRecord(value) &&
    oneOf(DICTATION_PHASES, value.phase) &&
    (value.failure === null || typeof value.failure === "string")
  );
}

/**
 * What the recording window reports back: the transcript, or null when the dictation ended without
 * one. A failure names its catalog key instead.
 */
export type DictationResult = { text: string } | { failure: string };
