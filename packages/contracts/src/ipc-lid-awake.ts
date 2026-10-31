// Keep a Mac laptop on with its lid closed. The keep-awake switch stops only the idle sleep: macOS
// still sleeps when the lid closes. See docs/architecture/lid-awake.md.

import { isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * `plugged` holds a system sleep assertion, which macOS obeys only on the power adapter. `battery`
 * also asks the root safety service to turn off all sleep, which needs an administrator password.
 */
export const LID_AWAKE_MODES = ["off", "plugged", "battery"] as const;
export type LidAwakeMode = (typeof LID_AWAKE_MODES)[number];

/** On battery, the mode stops below this percent. The safety service never accepts less than 20. */
export const LID_AWAKE_BATTERY_FLOORS = [20, 30, 50] as const;
export type LidAwakeBatteryFloor = (typeof LID_AWAKE_BATTERY_FLOORS)[number];

/** Hours with the lid closed before the mode stops. 0 is no limit. */
export const LID_AWAKE_TIME_LIMITS = [1, 4, 8, 0] as const;
export type LidAwakeTimeLimit = (typeof LID_AWAKE_TIME_LIMITS)[number];

export interface LidAwakePreference {
  mode: LidAwakeMode;
  batteryFloor: LidAwakeBatteryFloor;
  timeLimitHours: LidAwakeTimeLimit;
}

export const DEFAULT_LID_AWAKE_PREFERENCE: LidAwakePreference = { mode: "off", batteryFloor: 30, timeLimitHours: 8 };

/** The choices to change. A choice that is not given keeps its value. */
export type LidAwakePreferenceChange = Partial<LidAwakePreference>;

/**
 * What the mode does now.
 *
 * - `active-plugged`: a system sleep assertion holds. macOS obeys it only on the power adapter.
 * - `active-battery`: the safety service turned off all sleep, on battery too. `ioreg` shows it, or
 *   the service has not had its next check yet.
 * - `paused-helper-not-confirmed`: on battery, the app asks the service, but `ioreg` does not show
 *   sleep off after the next check of the service. The Mac sleeps when the lid closes.
 * - `paused-*`: the mode is on, but Builders Bot holds nothing, so the Mac sleeps when the lid closes.
 * - `failed`: the assertion could not start.
 */
export const LID_AWAKE_STATES = [
  "off",
  "active-plugged",
  "active-battery",
  "paused-on-battery",
  "paused-battery-low",
  "paused-too-hot",
  "paused-time-limit",
  "paused-helper-missing",
  "paused-helper-not-confirmed",
  "failed",
] as const;
export type LidAwakeState = (typeof LID_AWAKE_STATES)[number];

/**
 * The root safety service that the `battery` mode needs. `outdated` is a different version.
 * `stopped`: the files are there, but the service did not run its check in the last 45 seconds, for
 * example because macOS turned off its background item.
 */
export const LID_AWAKE_HELPER_STATES = ["installed", "missing", "outdated", "stopped"] as const;
export type LidAwakeHelperState = (typeof LID_AWAKE_HELPER_STATES)[number];

export const LID_AWAKE_TEST_VERDICTS = ["running", "stayed-awake", "slept", "lid-not-closed"] as const;
export type LidAwakeTestVerdict = (typeof LID_AWAKE_TEST_VERDICTS)[number];

/** The test with the lid closed. The numbers are whole seconds. */
export interface LidAwakeTestResult {
  verdict: LidAwakeTestVerdict;
  startedAt: string;
  endedAt: string | null;
  /** The time with the lid closed while the Mac was on. */
  closedSeconds: number;
  /**
   * The time between records in which the Mac slept (the kernel recorded a sleep) or the app did not
   * run (a gap of more than 15 seconds).
   */
  sleptSeconds: number;
  /** The longest time between two records of the test. */
  longestGapSeconds: number;
}

export interface LidAwakeStatus {
  /**
   * False where Builders Bot cannot keep the computer on with its lid closed: on a computer with no
   * lid, on Windows and Linux, and on a server. The other fields then have their defaults.
   */
  supported: boolean;
  preference: LidAwakePreference;
  state: LidAwakeState;
  onPowerAdapter: boolean;
  /** Null when the battery level is not known. */
  batteryPercent: number | null;
  lidClosed: boolean;
  helper: LidAwakeHelperState;
  /** macOS has all sleep off (`pmset disablesleep 1`), and Builders Bot did not ask for it. */
  sleepDisabledWithoutGrant: boolean;
  /** The test that runs now, or the last one. */
  test: LidAwakeTestResult | null;
}

export function isLidAwakePreference(value: unknown): value is LidAwakePreference {
  return (
    isDynamicRecord(value) &&
    isOneOf(LID_AWAKE_MODES, value.mode) &&
    isOneOf(LID_AWAKE_BATTERY_FLOORS, value.batteryFloor) &&
    isOneOf(LID_AWAKE_TIME_LIMITS, value.timeLimitHours)
  );
}

/** What the renderer sends: at least one choice, each from its fixed list. A choice that is not given keeps its value. */
export function parseLidAwakePreferenceChange(value: unknown): LidAwakePreferenceChange {
  if (!isDynamicRecord(value)) throw new Error("The change is required.");
  const change: LidAwakePreferenceChange = {};
  if (value.mode !== undefined) {
    if (!isOneOf(LID_AWAKE_MODES, value.mode)) throw new Error("Invalid mode.");
    change.mode = value.mode;
  }
  if (value.batteryFloor !== undefined) {
    if (!isOneOf(LID_AWAKE_BATTERY_FLOORS, value.batteryFloor)) throw new Error("Invalid battery floor.");
    change.batteryFloor = value.batteryFloor;
  }
  if (value.timeLimitHours !== undefined) {
    if (!isOneOf(LID_AWAKE_TIME_LIMITS, value.timeLimitHours)) throw new Error("Invalid time limit.");
    change.timeLimitHours = value.timeLimitHours;
  }
  if (Object.keys(change).length === 0) throw new Error("The change is required.");
  return change;
}
