import { type ChildProcess, execFile, spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { readFile, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_LID_AWAKE_PREFERENCE,
  isLidAwakePreference,
  LID_AWAKE_TEST_VERDICTS,
  type LidAwakeHelperState,
  type LidAwakePreference,
  type LidAwakePreferenceChange,
  type LidAwakeState,
  type LidAwakeStatus,
  type LidAwakeTestResult,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import type { AppTranslate } from "@openbot/i18n";
import { sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger, toLogValue } from "@openbot/logging";
import { Effect, Option, Schema } from "effect";
import { causeHelpers } from "../backend/effect-boundary";
import { isMissingFileError } from "../backend/file-errors";
import {
  adminScriptArgs,
  isUserCancel,
  LID_AWAKE_GRANT_DIR,
  LID_AWAKE_PLIST_PATH,
  LID_AWAKE_TOOL_PATH,
  LID_AWAKE_TOOL_SCRIPT,
  type LidAwakeAdminScript,
  OSASCRIPT_PATH,
} from "./lid-awake-helper";
import {
  CAFFEINATE_PATH,
  caffeinateArgs,
  decideLidAwake,
  GRANT_FILE_NAMES,
  GRANT_RENEW_MS,
  grantFileName,
  IOREG_PATH,
  IOREG_ROOT_DOMAIN_ARGS,
  isActive,
  LID_TEST_BEAT_MS,
  type LidTestProgress,
  type LidTestSample,
  lidTestDone,
  lidTestResult,
  PMSET_BATTERY_ARGS,
  PMSET_PATH,
  PMSET_SLEEP_NOW_ARGS,
  parsePowerSource,
  parseRootDomain,
  parseSleepWakeTimes,
  recordLidTestSample,
  SLEEP_WAKE_TIME_ARGS,
  type SleepWakeTimes,
  SYSCTL_PATH,
  safetyStop,
  startLidTest,
  type ThermalState,
} from "./lid-awake-policy";
import { PreferenceStore, readPreferenceFile, writePreferenceFile } from "./preference-file";

const logger = createBuildersBotLogger("lid-awake");

class LidAwakeFailure extends Schema.TaggedError<LidAwakeFailure>()("LidAwakeFailure", {
  cause: Schema.Defect(),
}) {}

const { io } = causeHelpers(LidAwakeFailure);

const COMMAND_TIMEOUT_MS = 5_000;
/** The user types the administrator password in this time. */
const ADMIN_TIMEOUT_MS = 5 * 60_000;
/** While the mode is on, the lid, the battery and the service are read this often. */
const POLL_MS = 30_000;
/** A hold process that stops this often in this time is not started again. */
const HOLD_RESTART_LIMIT = 3;
const HOLD_RESTART_WINDOW_MS = 60_000;
/** After the grant stops, the service turns sleep on again in its next 15-second check. */
const GRANT_RELEASE_GRACE_MS = 60_000;
/** After a safety stop with the lid closed, macOS must show sleep on in this time. */
const SLEEP_REQUEST_TRIES = 15;
const SLEEP_REQUEST_STEP_MS = 2_000;

export interface LidAwakeServiceOptions {
  /** False on Windows and Linux, on a server, and in the local server process. */
  offered: boolean;
  userDataPath: string;
  pid: number;
  /** Electron `powerMonitor.isOnBatteryPower()`, when `pmset` does not say. */
  isOnBattery: () => boolean;
  /** Electron `powerMonitor.getCurrentThermalState()`. */
  thermalState: () => ThermalState;
  translate: AppTranslate;
  /** Shows a desktop notification. */
  notify: (body: string) => void;
}

function run(file: string, args: readonly string[], timeout = COMMAND_TIMEOUT_MS) {
  return io(
    (signal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          file,
          args,
          { encoding: "utf8", timeout, signal, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) reject(Object.assign(error, { stderr }));
            else resolve(stdout);
          },
        );
      }),
  );
}

function decodeTestFile(parsed: unknown): LidAwakeTestResult | null {
  if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isDynamicRecord(parsed.result)) return null;
  const result = parsed.result;
  const seconds = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  const closedSeconds = seconds(result.closedSeconds);
  const sleptSeconds = seconds(result.sleptSeconds);
  const longestGapSeconds = seconds(result.longestGapSeconds);
  if (
    !isOneOf(LID_AWAKE_TEST_VERDICTS, result.verdict) ||
    result.verdict === "running" ||
    typeof result.startedAt !== "string" ||
    typeof result.endedAt !== "string" ||
    closedSeconds === null ||
    sleptSeconds === null ||
    longestGapSeconds === null
  )
    return null;
  return {
    verdict: result.verdict,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    closedSeconds,
    sleptSeconds,
    longestGapSeconds,
  };
}

async function removeGrantFile(name: string): Promise<void> {
  await unlink(join(LID_AWAKE_GRANT_DIR, name)).catch((error: unknown) => {
    if (!isMissingFileError(error)) throw error;
  });
}

/** When macOS last went to sleep and woke (`kern.sleeptime`, `kern.waketime`). A failure reads as unknown. */
export function readSleepWakeTimes(): Effect.Effect<SleepWakeTimes> {
  return run(SYSCTL_PATH, SLEEP_WAKE_TIME_ARGS).pipe(
    Effect.map(parseSleepWakeTimes),
    Effect.orElseSucceed(() => ({ lastSleepMs: null, lastWakeMs: null })),
  );
}

/**
 * Keeps a Mac laptop on with its lid closed, while the user chose it and the safety rules allow it.
 *
 * `plugged` runs `caffeinate`, which holds a system sleep assertion for the app. macOS still starts
 * to sleep when the lid closes, but it stops in dark wake: the processor and the network stay on,
 * and the display stays off. macOS obeys the assertion only on the power adapter. `battery` also
 * keeps the grant file of the root safety service fresh, and the service then runs
 * `pmset disablesleep 1`, which macOS obeys on battery too. See docs/architecture/lid-awake.md.
 *
 * Each decision comes from `decideLidAwake`. This class only reads the computer and applies it.
 */
export class LidAwakeService {
  readonly #options: LidAwakeServiceOptions;
  readonly #preference: PreferenceStore<LidAwakePreference>;
  readonly #testPath: string;
  readonly #listeners = new Set<(status: LidAwakeStatus) => void>();
  /** `ioreg` answered once, so `#supported` is known. */
  #probed = false;
  #supported = false;
  #onPowerAdapter = true;
  #batteryPercent: number | null = null;
  #charging = false;
  #lidClosed = false;
  #lidClosedSince: number | null = null;
  #sleepDisabled = false;
  #helper: LidAwakeHelperState = "missing";
  #state: LidAwakeState = "off";
  #hold: ChildProcess | null = null;
  #holdWanted = false;
  #holdExits: number[] = [];
  #holdFailed = false;
  #grantActive = false;
  #grantStoppedAt = 0;
  #grantTimer: NodeJS.Timeout | null = null;
  #grantWrites: Promise<void> = Promise.resolve();
  #pollTimer: NodeJS.Timeout | null = null;
  #test: LidTestProgress | null = null;
  #testTimer: NodeJS.Timeout | null = null;
  #lastTest: LidAwakeTestResult | null = null;
  #lastSent = "";
  #disposed = false;
  /** A request to sleep after a safety stop runs. */
  #sleepRequest = false;

  constructor(options: LidAwakeServiceOptions) {
    this.#options = options;
    this.#preference = new PreferenceStore({
      path: join(options.userDataPath, "lid-awake.json"),
      defaultValue: DEFAULT_LID_AWAKE_PREFERENCE,
      // A file of another version, or with a value that is not offered, reads as off.
      decode: (parsed) =>
        isDynamicRecord(parsed) && parsed.version === 1 && isLidAwakePreference(parsed)
          ? { mode: parsed.mode, batteryFloor: parsed.batteryFloor, timeLimitHours: parsed.timeLimitHours }
          : null,
    });
    this.#testPath = join(options.userDataPath, "lid-awake-test.json");
  }

  /** Reads the saved choice and the last test. A missing or unreadable file reads as off. */
  load(): Effect.Effect<void, LidAwakeFailure> {
    if (!this.#options.offered) return Effect.void;
    return Effect.gen({ self: this }, function* () {
      yield* this.#preference.load().pipe(Effect.mapError(({ cause }) => new LidAwakeFailure({ cause })));
      // The last test is only shown, so a file that cannot be read shows no test.
      this.#lastTest = yield* readPreferenceFile(this.#testPath, decodeTestFile).pipe(Effect.orElseSucceed(() => null));
    });
  }

  /**
   * Reads the lid, the power source and the service the first time. A Mac with no lid, such as a Mac
   * mini, does not offer the mode. Call after the app is ready: the thermal state comes from Electron.
   */
  readonly start = Effect.fn("LidAwake.start")(function* (this: LidAwakeService) {
    yield* this.refresh();
  });

  /** True while the Mac stays on with its lid closed: routines can run in dark wake. */
  get holdsThroughLidClose(): boolean {
    return isActive(this.#state);
  }

  status(): LidAwakeStatus {
    const preference = this.#preference.get();
    if (!this.#supported)
      return {
        supported: false,
        preference: DEFAULT_LID_AWAKE_PREFERENCE,
        state: "off",
        onPowerAdapter: true,
        batteryPercent: null,
        lidClosed: false,
        helper: "missing",
        sleepDisabledWithoutGrant: false,
        test: null,
      };
    const grantRecent = this.#grantActive || Date.now() - this.#grantStoppedAt < GRANT_RELEASE_GRACE_MS;
    return {
      supported: true,
      preference,
      state: this.#state,
      onPowerAdapter: this.#onPowerAdapter,
      batteryPercent: this.#batteryPercent,
      lidClosed: this.#lidClosed,
      helper: this.#helper,
      sleepDisabledWithoutGrant: this.#sleepDisabled && !(grantRecent && this.#helper === "installed"),
      test: this.#test ? lidTestResult(this.#test, false) : this.#lastTest,
    };
  }

  /** Reads the power source, the lid, the sleep setting and the service, then applies the rules. */
  readonly refresh = Effect.fn("LidAwake.refresh")(function* (this: LidAwakeService) {
    if (!this.#options.offered || this.#disposed || (this.#probed && !this.#supported)) return this.status();
    const [battery, rootDomain, helper] = yield* Effect.all(
      [
        run(PMSET_PATH, PMSET_BATTERY_ARGS).pipe(Effect.map(parsePowerSource), Effect.option),
        run(IOREG_PATH, IOREG_ROOT_DOMAIN_ARGS).pipe(Effect.map(parseRootDomain), Effect.option),
        this.#readHelper(),
      ],
      { concurrency: "unbounded" },
    );
    // The first answer of `ioreg` tells if this Mac has a lid. A Mac mini never offers the mode.
    if (!this.#probed) {
      if (Option.isNone(rootDomain)) return this.status();
      this.#probed = true;
      this.#supported = rootDomain.value.hasLid;
      if (!this.#supported) return this.status();
    }
    const power = Option.getOrNull(battery);
    this.#onPowerAdapter = power?.onPowerAdapter ?? !this.#options.isOnBattery();
    // An unknown level fails closed: `decideLidAwake` stops the battery mode on battery.
    this.#batteryPercent = power?.batteryPercent ?? null;
    this.#charging = power?.charging ?? false;
    if (Option.isSome(rootDomain)) {
      this.#lidClosed = rootDomain.value.lidClosed;
      this.#sleepDisabled = rootDomain.value.sleepDisabled;
    }
    this.#helper = helper;
    this.#apply();
    return this.status();
  });

  /** For a change that Electron reports: the power source, the heat, a sleep or a wake. */
  changed(): void {
    if (!this.#options.offered || (this.#probed && !this.#supported)) return;
    void Effect.runPromise(this.refresh()).catch((error) =>
      logger.warn("The lid-closed mode could not read this computer.", toLogValue(error)),
    );
  }

  readonly setPreference = Effect.fn("LidAwake.setPreference")(function* (
    this: LidAwakeService,
    change: LidAwakePreferenceChange,
  ) {
    if (!this.#supported) return this.status();
    const next = { ...this.#preference.get(), ...change };
    yield* this.#preference.set(next).pipe(Effect.mapError(({ cause }) => new LidAwakeFailure({ cause })));
    this.#holdFailed = false;
    this.#holdExits = [];
    return yield* this.refresh();
  });

  /** Asks for the administrator password and installs, or updates, the safety service. */
  readonly installHelper = Effect.fn("LidAwake.installHelper")(function* (this: LidAwakeService) {
    if (!this.#supported) return this.status();
    yield* this.#runAdmin("install", "settings.lidAwake.helper.prompt");
    logger.info("The lid-closed safety service was installed.");
    return yield* this.refresh();
  });

  /**
   * Asks for the administrator password, removes the safety service and turns all sleep on again.
   * It also works when the service was never installed. The `battery` mode becomes `plugged`.
   */
  readonly restoreNormalSleep = Effect.fn("LidAwake.restoreNormalSleep")(function* (this: LidAwakeService) {
    if (!this.#supported) return this.status();
    yield* this.#runAdmin("remove", "settings.lidAwake.restore.prompt");
    logger.info("Normal sleep was restored and the lid-closed safety service was removed.");
    if (this.#preference.get().mode === "battery")
      yield* this.#preference
        .set({ ...this.#preference.get(), mode: "plugged" })
        .pipe(Effect.mapError(({ cause }) => new LidAwakeFailure({ cause })));
    return yield* this.refresh();
  });

  /**
   * Starts the test with the lid closed. It records the wall clock, the last sleep of the kernel and
   * the lid each 5 seconds, and it stops by itself when the lid opens after the test has its result,
   * or after 10 minutes.
   */
  readonly startTest = Effect.fn("LidAwake.startTest")(function* (this: LidAwakeService) {
    if (!this.#supported) return this.status();
    this.#stopTestTimer();
    const sample = yield* this.#sample();
    this.#test = startLidTest(sample);
    logger.info("Lid-closed test started.");
    this.#scheduleBeat();
    this.#emit();
    return this.status();
  });

  readonly finishTest = Effect.fn("LidAwake.finishTest")(function* (this: LidAwakeService) {
    if (!this.#test) return this.status();
    this.#test = recordLidTestSample(this.#test, yield* this.#sample());
    yield* this.#endTest();
    return this.status();
  });

  subscribe(listener: (status: LidAwakeStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** At quit: the hold and the grant end now, not after their timeouts. */
  dispose(): void {
    this.#disposed = true;
    this.#stopTestTimer();
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
    this.#stopHold();
    this.#stopGrant(true);
  }

  #apply(): void {
    if (this.#disposed) return;
    const preference = this.#preference.get();
    const now = Date.now();
    if (preference.mode === "off" || !this.#lidClosed) this.#lidClosedSince = null;
    else this.#lidClosedSince ??= now;
    const decide = () =>
      decideLidAwake({
        preference,
        onPowerAdapter: this.#onPowerAdapter,
        batteryPercent: this.#batteryPercent,
        charging: this.#charging,
        thermal: this.#options.thermalState(),
        lidClosedSince: this.#lidClosedSince,
        now,
        helper: this.#helper,
        holdFailed: this.#holdFailed,
      });
    let decision = decide();
    if (decision.assertion) this.#startHold();
    // A spawn that throws sets the failure now, so the state must say so now.
    if (decision.assertion && this.#holdFailed) decision = decide();
    if (!decision.assertion) this.#stopHold();
    if (decision.grant) this.#renewGrant();
    else this.#stopGrant();
    const previous = this.#state;
    this.#state = decision.state;
    if (previous !== decision.state) {
      logger.info(`Lid-closed hold: ${decision.state}.`);
      const stop = isActive(previous) ? safetyStop(decision.state) : null;
      if (stop) this.#options.notify(this.#stopNotice(stop));
      if (stop && this.#lidClosed) this.#requestSleep();
    }
    this.#schedulePoll(preference.mode !== "off");
    this.#emit();
  }

  /**
   * A safety stop with the lid closed must make the Mac sleep. With `pmset disablesleep 1`, macOS
   * refused the lid sleep, and it does not ask again when sleep comes back on. So, when macOS shows
   * sleep on again, this asks it to sleep. The safety service does the same when it turns sleep on.
   */
  #requestSleep(): void {
    if (this.#sleepRequest) return;
    this.#sleepRequest = true;
    void Effect.runPromise(this.#sleepWhenAllowed())
      .catch((error) => logger.warn("The lid-closed mode could not ask macOS to sleep.", toLogValue(error)))
      .finally(() => {
        this.#sleepRequest = false;
      });
  }

  #sleepWhenAllowed(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (let attempt = 0; attempt < SLEEP_REQUEST_TRIES; attempt++) {
        if (this.#disposed || isActive(this.#state)) return;
        const read = yield* run(IOREG_PATH, IOREG_ROOT_DOMAIN_ARGS).pipe(Effect.map(parseRootDomain), Effect.option);
        if (Option.isSome(read)) {
          // An open lid or an external display keeps the Mac on as the user wants.
          if (!read.value.lidClosed || !read.value.clamshellCausesSleep) return;
          if (!read.value.sleepDisabled) {
            logger.info("The lid-closed mode stopped with the lid closed. Asking macOS to sleep.");
            yield* run(PMSET_PATH, PMSET_SLEEP_NOW_ARGS).pipe(
              Effect.catch((error) => Effect.sync(() => logger.warn("pmset sleepnow failed.", toLogValue(error)))),
            );
            return;
          }
        }
        yield* Effect.sleep(SLEEP_REQUEST_STEP_MS);
      }
      logger.warn("Sleep stayed off after the lid-closed mode stopped.");
    });
  }

  #stopNotice(stop: "battery-low" | "too-hot" | "time-limit"): string {
    const { translate } = this.#options;
    if (stop === "battery-low") return translate("notification.lidAwakeBatteryLow");
    if (stop === "too-hot") return translate("notification.lidAwakeTooHot");
    return translate("notification.lidAwakeTimeLimit");
  }

  #emit(): void {
    const status = this.status();
    const text = JSON.stringify(status);
    if (text === this.#lastSent) return;
    this.#lastSent = text;
    for (const listener of this.#listeners) listener(status);
  }

  #schedulePoll(on: boolean): void {
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
    if (!on || this.#disposed) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      this.changed();
    }, POLL_MS);
    this.#pollTimer.unref?.();
  }

  #startHold(): void {
    this.#holdWanted = true;
    if (this.#hold) return;
    let child: ChildProcess;
    try {
      child = spawn(CAFFEINATE_PATH, caffeinateArgs(this.#options.pid), { stdio: "ignore" });
    } catch (error) {
      logger.warn("The lid-closed assertion could not start.", toLogValue(error));
      this.#holdFailed = true;
      this.#holdWanted = false;
      return;
    }
    this.#hold = child;
    let ended = false;
    // A spawn that fails sends `error` and can also send `exit`: count it once.
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      if (this.#hold === child) this.#hold = null;
      if (!this.#holdWanted || this.#disposed) return;
      logger.warn(`The lid-closed assertion stopped (${reason}).`);
      const now = Date.now();
      this.#holdExits = [...this.#holdExits.filter((at) => now - at < HOLD_RESTART_WINDOW_MS), now];
      if (this.#holdExits.length >= HOLD_RESTART_LIMIT) this.#holdFailed = true;
      this.#apply();
    };
    child.once("error", (error) => end(error.message));
    child.once("exit", (code, signal) => end(`code ${code}, signal ${signal}`));
  }

  #stopHold(): void {
    this.#holdWanted = false;
    const child = this.#hold;
    this.#hold = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  #renewGrant(): void {
    const name = grantFileName(this.#preference.get().batteryFloor);
    this.#grantActive = true;
    // One write at a time, so a renewal never lands after the removal that `#stopGrant` queued.
    this.#grantWrites = this.#grantWrites
      .then(async () => {
        if (!this.#grantActive) return;
        const path = join(LID_AWAKE_GRANT_DIR, name);
        await writeFile(path, "", { flag: "a", mode: 0o600 });
        const now = new Date();
        await utimes(path, now, now);
        for (const other of GRANT_FILE_NAMES) if (other !== name) await removeGrantFile(other);
      })
      .catch((error) => logger.warn("The lid-closed grant could not be renewed.", toLogValue(error)));
    if (this.#grantTimer) return;
    this.#grantTimer = setInterval(() => {
      if (this.#grantActive) this.#renewGrant();
    }, GRANT_RENEW_MS);
    this.#grantTimer.unref?.();
  }

  /** At quit, the files go before the process ends, so the service turns sleep on in its next check. */
  #stopGrant(atQuit = false): void {
    if (this.#grantTimer) clearInterval(this.#grantTimer);
    this.#grantTimer = null;
    if (!this.#grantActive) return;
    this.#grantActive = false;
    this.#grantStoppedAt = Date.now();
    if (atQuit) {
      for (const name of GRANT_FILE_NAMES)
        try {
          unlinkSync(join(LID_AWAKE_GRANT_DIR, name));
        } catch {
          // A missing file is the goal. Any other failure ends in 90 seconds, when the grant is old.
        }
      return;
    }
    this.#grantWrites = this.#grantWrites
      .then(async () => {
        for (const name of GRANT_FILE_NAMES) await removeGrantFile(name);
      })
      .catch((error) => logger.warn("The lid-closed grant could not be removed.", toLogValue(error)));
  }

  #readHelper(): Effect.Effect<LidAwakeHelperState> {
    return Effect.promise(async () => {
      try {
        const [tool] = await Promise.all([
          readFile(LID_AWAKE_TOOL_PATH, "utf8"),
          readFile(LID_AWAKE_PLIST_PATH, "utf8"),
        ]);
        return tool === LID_AWAKE_TOOL_SCRIPT ? "installed" : "outdated";
      } catch {
        return "missing";
      }
    });
  }

  #runAdmin(
    script: LidAwakeAdminScript,
    promptKey: "settings.lidAwake.helper.prompt" | "settings.lidAwake.restore.prompt",
  ) {
    return run(OSASCRIPT_PATH, adminScriptArgs(script, this.#options.translate(promptKey)), ADMIN_TIMEOUT_MS).pipe(
      Effect.mapError((failure) => {
        const stderr =
          isDynamicRecord(failure.cause) && typeof failure.cause.stderr === "string" ? failure.cause.stderr : "";
        if (isUserCancel(stderr))
          return new LidAwakeFailure({ cause: new Error(sourceText("error.app.lidAwakeCanceled")) });
        logger.warn(`The lid-closed safety service script "${script}" failed.`, toLogValue(failure.cause));
        return new LidAwakeFailure({ cause: new Error(sourceText("error.app.lidAwakeHelperFailed")) });
      }),
    );
  }

  #sample(): Effect.Effect<LidTestSample> {
    return Effect.all(
      [
        run(IOREG_PATH, IOREG_ROOT_DOMAIN_ARGS).pipe(
          Effect.map((text) => parseRootDomain(text).lidClosed),
          Effect.orElseSucceed(() => this.#lidClosed),
        ),
        readSleepWakeTimes(),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([lidClosed, times]) => {
        this.#lidClosed = lidClosed;
        return { wallMs: Date.now(), lastSleepMs: times.lastSleepMs, lidClosed };
      }),
    );
  }

  #scheduleBeat(): void {
    this.#testTimer = setTimeout(() => {
      this.#testTimer = null;
      void Effect.runPromise(this.#beat()).catch((error) =>
        logger.warn("The lid-closed test could not record.", toLogValue(error)),
      );
    }, LID_TEST_BEAT_MS);
  }

  #beat(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!this.#test || this.#disposed) return;
      this.#test = recordLidTestSample(this.#test, yield* this.#sample());
      if (lidTestDone(this.#test)) {
        yield* this.#endTest();
        return;
      }
      this.#scheduleBeat();
      this.#emit();
    });
  }

  #endTest(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.#stopTestTimer();
      if (!this.#test) return;
      const result = lidTestResult(this.#test, true);
      this.#test = null;
      this.#lastTest = result;
      logger.info(
        `Lid-closed test: ${result.verdict}, lid closed ${result.closedSeconds} s, slept ${result.sleptSeconds} s, longest gap ${result.longestGapSeconds} s.`,
      );
      yield* writePreferenceFile(this.#testPath, { version: 1, result }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => logger.warn("The lid-closed test could not be saved.", toLogValue(error))),
        ),
      );
      this.#emit();
      // The lid and the battery can have changed while the test ran.
      this.changed();
    });
  }

  #stopTestTimer(): void {
    if (this.#testTimer) clearTimeout(this.#testTimer);
    this.#testTimer = null;
  }
}
