// The decisions of the lid-closed mode, with no I/O. `lid-awake-service.ts` reads the computer and
// applies them. See docs/architecture/lid-awake.md.

import {
  LID_AWAKE_BATTERY_FLOORS,
  type LidAwakeBatteryFloor,
  type LidAwakeHelperState,
  type LidAwakePreference,
  type LidAwakeState,
  type LidAwakeTestResult,
  type LidAwakeTestVerdict,
} from "@openbot/contracts/ipc";

/** Electron `powerMonitor.getCurrentThermalState()`. */
export type ThermalState = "unknown" | "nominal" | "fair" | "serious" | "critical";

export const CAFFEINATE_PATH = "/usr/bin/caffeinate";
export const PMSET_PATH = "/usr/bin/pmset";
export const IOREG_PATH = "/usr/sbin/ioreg";
export const PMSET_BATTERY_ARGS = ["-g", "batt"] as const;
/** Asks macOS to sleep now. It needs no administrator. */
export const PMSET_SLEEP_NOW_ARGS = ["sleepnow"] as const;
export const IOREG_ROOT_DOMAIN_ARGS = ["-r", "-c", "IOPMrootDomain", "-d", "1"] as const;
/** The safety service keeps sleep off on battery with the lid closed for this long at most. */
export const SERVICE_MAX_CLOSED_HOURS = 8;

/**
 * `-s` stops system sleep, which macOS obeys only on the power adapter. `-i` stops idle sleep, on
 * battery too, and keeps App Nap from slowing the timers of the app. `-w` ends caffeinate, and its
 * assertions, when the app process ends, also after a crash. The arguments are constants and one
 * whole number: nothing goes through a shell.
 */
export function caffeinateArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The process id must be a positive whole number.");
  return ["-i", "-s", "-w", String(pid)];
}

export interface LidAwakeInput {
  preference: LidAwakePreference;
  onPowerAdapter: boolean;
  batteryPercent: number | null;
  /** On the power adapter, the battery charges or is full. */
  charging: boolean;
  thermal: ThermalState;
  /** When the lid closed while the mode was on, or null while it is open. */
  lidClosedSince: number | null;
  now: number;
  helper: LidAwakeHelperState;
  /** The assertion process could not start again after it stopped. */
  holdFailed: boolean;
}

export interface LidAwakeDecision {
  state: LidAwakeState;
  /** Run caffeinate. */
  assertion: boolean;
  /** Keep the grant file of the safety service fresh. */
  grant: boolean;
}

const NONE = { assertion: false, grant: false } as const;

/** Hot enough that macOS slows the computer. The safety service also stops at a thermal warning. */
export function isTooHot(thermal: ThermalState): boolean {
  return thermal === "serious" || thermal === "critical";
}

export function timeLimitReached(lidClosedSince: number | null, now: number, hours: number): boolean {
  return hours > 0 && lidClosedSince !== null && now - lidClosedSince >= hours * 3_600_000;
}

/**
 * The hours with the lid closed before the mode stops. On battery, the `battery` mode also has the
 * limit of the safety service, so the app stops when the service stops.
 */
export function effectiveTimeLimitHours(preference: LidAwakePreference, onPowerAdapter: boolean): number {
  if (preference.mode !== "battery" || onPowerAdapter) return preference.timeLimitHours;
  return preference.timeLimitHours === 0
    ? SERVICE_MAX_CLOSED_HOURS
    : Math.min(preference.timeLimitHours, SERVICE_MAX_CLOSED_HOURS);
}

/**
 * The order is the order of the safety rules: heat first, then the time limit, then the power
 * source. An unknown battery level stops the `battery` mode: the rule fails closed. With the
 * service, `pmset disablesleep 1` also stops the sleep for low battery, so the floor applies on the
 * power adapter too, except while the battery charges.
 */
export function decideLidAwake(input: LidAwakeInput): LidAwakeDecision {
  const { preference } = input;
  if (preference.mode === "off") return { state: "off", ...NONE };
  if (isTooHot(input.thermal)) return { state: "paused-too-hot", ...NONE };
  if (timeLimitReached(input.lidClosedSince, input.now, effectiveTimeLimitHours(preference, input.onPowerAdapter)))
    return { state: "paused-time-limit", ...NONE };
  const helperReady = preference.mode === "battery" && input.helper === "installed";
  if (!helperReady) {
    if (!input.onPowerAdapter)
      return { state: preference.mode === "battery" ? "paused-helper-missing" : "paused-on-battery", ...NONE };
    if (input.holdFailed) return { state: "failed", ...NONE };
    return { state: "active-plugged", assertion: true, grant: false };
  }
  const aboveFloor = input.batteryPercent !== null && input.batteryPercent >= preference.batteryFloor;
  if (!aboveFloor && !(input.onPowerAdapter && input.charging)) return { state: "paused-battery-low", ...NONE };
  // The assertion also keeps App Nap off, so the grant stays fresh with the lid closed.
  return { state: "active-battery", assertion: !input.holdFailed, grant: true };
}

/** The states that a safety rule caused. A change into one of them tells the user. */
export function safetyStop(state: LidAwakeState): "battery-low" | "too-hot" | "time-limit" | null {
  if (state === "paused-battery-low") return "battery-low";
  if (state === "paused-too-hot") return "too-hot";
  if (state === "paused-time-limit") return "time-limit";
  return null;
}

export function isActive(state: LidAwakeState): boolean {
  return state === "active-plugged" || state === "active-battery";
}

export interface PowerSource {
  onPowerAdapter: boolean | null;
  batteryPercent: number | null;
  /** The battery charges or is full. `AC attached; not charging` is false. */
  charging: boolean;
}

const CHARGING_STATES = new Set(["charging", "charged", "finishing charge"]);

/**
 * `pmset -g batt`, for example:
 *
 *     Now drawing from 'AC Power'
 *      -InternalBattery-0 (id=22085731)	54%; charging; 1:30 remaining present: true
 *
 * Only whole numbers from 0 to 100 are read. Another form reads as unknown.
 */
export function parsePowerSource(text: string): PowerSource {
  const lines = text.split("\n");
  const source = /^Now drawing from '([^']+)'$/.exec(lines[0]?.trim() ?? "")?.[1];
  let batteryPercent: number | null = null;
  let charging = false;
  for (const line of lines.slice(1)) {
    if (!line.trimStart().startsWith("-InternalBattery")) continue;
    const match = /\t(\d{1,3})%; ([^;]+);/.exec(line);
    const percent = match ? Number(match[1]) : Number.NaN;
    batteryPercent = Number.isInteger(percent) && percent <= 100 ? percent : null;
    charging = batteryPercent !== null && CHARGING_STATES.has(match?.[2] ?? "");
    break;
  }
  return {
    onPowerAdapter: source === "AC Power" ? true : source === "Battery Power" ? false : null,
    batteryPercent,
    charging,
  };
}

export interface RootDomainState {
  /** A desktop Mac has no `AppleClamshellState`. */
  hasLid: boolean;
  lidClosed: boolean;
  /** False with an external display on the power adapter: then the lid does not sleep the Mac. */
  clamshellCausesSleep: boolean;
  /** `pmset disablesleep 1` is in effect. */
  sleepDisabled: boolean;
}

/** `ioreg -r -c IOPMrootDomain -d 1`. */
export function parseRootDomain(text: string): RootDomainState {
  const value = (key: string) => new RegExp(`^\\s*"${key}" = (Yes|No)\\s*$`, "m").exec(text)?.[1] ?? null;
  const lid = value("AppleClamshellState");
  return {
    hasLid: lid !== null,
    lidClosed: lid === "Yes",
    clamshellCausesSleep: value("AppleClamshellCausesSleep") === "Yes",
    sleepDisabled: value("SleepDisabled") === "Yes",
  };
}

/**
 * The grant of the safety service is the change time of one empty file, named for the battery floor.
 * The service reads only the owner and the change time of the file, never its content.
 */
export function grantFileName(floor: LidAwakeBatteryFloor): string {
  return `active-${floor}`;
}

export const GRANT_FILE_NAMES = LID_AWAKE_BATTERY_FLOORS.map(grantFileName);

/** The service accepts a grant changed in the last 90 seconds. The app renews it each 30 seconds. */
export const GRANT_RENEW_MS = 30_000;
export const GRANT_MAX_AGE_SECONDS = 90;

export const SYSCTL_PATH = "/usr/sbin/sysctl";
export const SLEEP_WAKE_TIME_ARGS = ["-n", "kern.sleeptime", "kern.waketime"] as const;

/** When macOS last went to sleep and last woke, on the wall clock. An unknown value is null. */
export interface SleepWakeTimes {
  lastSleepMs: number | null;
  lastWakeMs: number | null;
}

/**
 * `sysctl -n kern.sleeptime kern.waketime`, for example:
 *
 *     { sec = 1793415051, usec = 999147 } Sat Oct 31 02:50:51 2026
 *     { sec = 1793415052, usec = 547433 } Sat Oct 31 02:50:52 2026
 *
 * The kernel writes `kern.sleeptime` each time the Mac goes to sleep, also from a maintenance wake.
 * `process.hrtime` cannot show sleep: on macOS, libuv reads `mach_continuous_time`, which also counts
 * the time in sleep.
 */
export function parseSleepWakeTimes(text: string): SleepWakeTimes {
  const lines = text.split("\n");
  const time = (line: string | undefined) => {
    const match = /^\{ sec = (\d{1,12}), usec = (\d{1,6}) \}/.exec(line?.trim() ?? "");
    return match ? Number(match[1]) * 1_000 + Math.floor(Number(match[2]) / 1_000) : null;
  };
  return { lastSleepMs: time(lines[0]), lastWakeMs: time(lines[1]) };
}

/** `kern.sleeptime` and `Date.now()` read the same clock. This covers their rounding. */
const SLEEP_CLOCK_SKEW_MS = 1_000;

/** The kernel recorded a sleep at or after this time on the wall clock. An unknown time is no proof. */
export function sleptSince(lastSleepMs: number | null, wallMs: number): boolean {
  return lastSleepMs !== null && lastSleepMs >= wallMs - SLEEP_CLOCK_SKEW_MS;
}

/** One record of the test: the wall clock, the last sleep that the kernel recorded, and the lid. */
export interface LidTestSample {
  wallMs: number;
  /** `kern.sleeptime`, or null when it could not be read. */
  lastSleepMs: number | null;
  lidClosed: boolean;
}

export interface LidTestProgress {
  startedAtMs: number;
  last: LidTestSample;
  closedMs: number;
  sleptMs: number;
  longestGapMs: number;
}

/** The lid must be closed this long while the Mac is on, for a test to pass. */
export const LID_TEST_MIN_CLOSED_MS = 120_000;
export const LID_TEST_MAX_MS = 10 * 60_000;
export const LID_TEST_BEAT_MS = 5_000;
/**
 * A gap between two records that is longer than this shows that the app did not run: the Mac slept,
 * or the app stopped. Either way, the Mac was not proven on in that time.
 */
export const LID_TEST_GAP_LIMIT_MS = 3 * LID_TEST_BEAT_MS;

export function startLidTest(sample: LidTestSample): LidTestProgress {
  return { startedAtMs: sample.wallMs, last: sample, closedMs: 0, sleptMs: 0, longestGapMs: 0 };
}

/**
 * The time between two records counts as sleep when the kernel recorded a sleep after the first
 * record, or when the gap is longer than `LID_TEST_GAP_LIMIT_MS`. A short wake for maintenance can
 * run one record with the lid closed, so a record does not prove that the Mac stayed on: only
 * records with no sleep between them do.
 */
export function recordLidTestSample(progress: LidTestProgress, sample: LidTestSample): LidTestProgress {
  const wall = Math.max(0, sample.wallMs - progress.last.wallMs);
  const slept = sleptSince(sample.lastSleepMs, progress.last.wallMs) || wall > LID_TEST_GAP_LIMIT_MS ? wall : 0;
  const awake = wall - slept;
  const closed =
    progress.last.lidClosed && sample.lidClosed ? awake : progress.last.lidClosed || sample.lidClosed ? awake / 2 : 0;
  return {
    startedAtMs: progress.startedAtMs,
    last: sample,
    closedMs: progress.closedMs + closed,
    sleptMs: progress.sleptMs + slept,
    longestGapMs: Math.max(progress.longestGapMs, wall),
  };
}

/** The test can stop by itself: the lid opened after it was closed long enough, or time is up. */
export function lidTestDone(progress: LidTestProgress): boolean {
  if (progress.last.wallMs - progress.startedAtMs >= LID_TEST_MAX_MS) return true;
  return !progress.last.lidClosed && (progress.closedMs >= LID_TEST_MIN_CLOSED_MS || progress.sleptMs > 0);
}

/** Any sleep fails the test, also a short one: a record in a maintenance wake is not a pass. */
export function lidTestVerdict(progress: LidTestProgress, finished: boolean): LidAwakeTestVerdict {
  if (!finished) return "running";
  if (progress.sleptMs > 0) return "slept";
  return progress.closedMs >= LID_TEST_MIN_CLOSED_MS ? "stayed-awake" : "lid-not-closed";
}

export function lidTestResult(progress: LidTestProgress, finished: boolean): LidAwakeTestResult {
  return {
    verdict: lidTestVerdict(progress, finished),
    startedAt: new Date(progress.startedAtMs).toISOString(),
    endedAt: finished ? new Date(progress.last.wallMs).toISOString() : null,
    closedSeconds: Math.round(progress.closedMs / 1_000),
    sleptSeconds: Math.round(progress.sleptMs / 1_000),
    longestGapSeconds: Math.round(progress.longestGapMs / 1_000),
  };
}
