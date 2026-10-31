// Checks the lid-closed mode without a Mac that sleeps. See docs/architecture/lid-awake.md.
//
// 1. The decisions, the parsers and the test arithmetic of `lid-awake-policy.ts`, with fixed inputs.
// 2. The command arguments: constants and one whole number, and the prompt as a separate argument.
// 3. The root safety service script, run as this user with stub `pmset`, `ioreg` and `ps` commands
//    and a temporary folder. The script text must not keep a real `pmset` or `/Library` path.
// 4. On the power adapter only: the real `caffeinate` assertion for a test process. It must show in
//    `pmset -g assertions`, and it must go when the test process ends.
// 5. `LidAwakeRoutines`: routines run again in dark wake, and are held again when the hold ends.
//    A sleep that the kernel recorded, a late timer or an unconfirmed hold keeps them held.
//
// It never runs `pmset -a`, never asks for a password and never makes the Mac sleep.
// It writes `.openbot-build/lid-awake-smoke.json`.
//
// bun scripts/lid-awake-smoke.ts

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_LID_AWAKE_PREFERENCE, type LidAwakePreference } from "@openbot/contracts/ipc";
import {
  adminScriptArgs,
  isUserCancel,
  LID_AWAKE_INSTALL_SCRIPT,
  LID_AWAKE_PLIST,
  LID_AWAKE_REMOVE_SCRIPT,
  LID_AWAKE_TOOL_SCRIPT,
} from "../src/main/lid-awake-helper";
import {
  CAFFEINATE_PATH,
  caffeinateArgs,
  decideLidAwake,
  helperState,
  type LidAwakeInput,
  type LidTestProgress,
  lidTestDone,
  lidTestResult,
  parsePowerSource,
  parseRootDomain,
  parseSleepWakeTimes,
  recordLidTestSample,
  startLidTest,
} from "../src/main/lid-awake-policy";
import { LidAwakeRoutines } from "../src/main/lid-awake-routines";

const run = promisify(execFile);
const report: { check: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  report.push({ check: name, ok, ...(ok || detail === undefined ? {} : { detail: JSON.stringify(detail) }) });
  if (!ok) process.stderr.write(`FAIL ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}\n`);
}

function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// 1. Decisions.

const HOUR = 3_600_000;
function decide(change: Partial<Omit<LidAwakeInput, "preference">> & { preference?: Partial<LidAwakePreference> }) {
  const input: LidAwakeInput = {
    onPowerAdapter: true,
    batteryPercent: 80,
    charging: false,
    thermal: "nominal",
    lidClosedSince: null,
    now: 10 * HOUR,
    helper: "missing",
    holdFailed: false,
    sleepDisabled: true,
    grantPending: false,
    ...change,
    preference: { ...DEFAULT_LID_AWAKE_PREFERENCE, mode: "plugged", ...change.preference },
  };
  const { state, assertion, grant } = decideLidAwake(input);
  return { state, assertion, grant };
}

equal("off holds nothing", decide({ preference: { mode: "off" } }), { state: "off", assertion: false, grant: false });
equal("plugged on AC holds the assertion", decide({}), { state: "active-plugged", assertion: true, grant: false });
equal("plugged on battery pauses", decide({ onPowerAdapter: false }), {
  state: "paused-on-battery",
  assertion: false,
  grant: false,
});
equal("serious heat stops", decide({ thermal: "serious" }), {
  state: "paused-too-hot",
  assertion: false,
  grant: false,
});
equal(
  "critical heat stops the battery mode",
  decide({ thermal: "critical", preference: { mode: "battery" }, helper: "installed" }),
  {
    state: "paused-too-hot",
    assertion: false,
    grant: false,
  },
);
equal("fair heat keeps the hold", decide({ thermal: "fair" }).state, "active-plugged");
equal(
  "the time limit stops after 8 hours with the lid closed",
  decide({ lidClosedSince: 2 * HOUR, now: 10 * HOUR }).state,
  "paused-time-limit",
);
equal(
  "the time limit is not reached before 8 hours",
  decide({ lidClosedSince: 2 * HOUR + 1, now: 10 * HOUR }).state,
  "active-plugged",
);
equal(
  "no time limit never stops",
  decide({ lidClosedSince: 0, now: 100 * HOUR, preference: { timeLimitHours: 0 } }).state,
  "active-plugged",
);
equal("an open lid has no time limit", decide({ lidClosedSince: null, now: 100 * HOUR }).state, "active-plugged");
equal("a hold that failed shows failed", decide({ holdFailed: true }).state, "failed");
equal("battery mode with no service on AC uses the assertion", decide({ preference: { mode: "battery" } }), {
  state: "active-plugged",
  assertion: true,
  grant: false,
});
equal(
  "battery mode with no service on battery pauses",
  decide({ preference: { mode: "battery" }, onPowerAdapter: false }).state,
  "paused-helper-missing",
);
equal(
  "battery mode with an outdated service on battery pauses",
  decide({ preference: { mode: "battery" }, onPowerAdapter: false, helper: "outdated" }).state,
  "paused-helper-missing",
);
equal(
  "battery mode above the floor grants",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: false, batteryPercent: 30 }),
  {
    state: "active-battery",
    assertion: true,
    grant: true,
  },
);
equal(
  "battery mode below the floor stops",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: false, batteryPercent: 29 }),
  {
    state: "paused-battery-low",
    assertion: false,
    grant: false,
  },
);
equal(
  "battery mode with an unknown level stops",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: false, batteryPercent: null }).state,
  "paused-battery-low",
);
equal(
  "battery mode on AC above the floor grants",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: true, batteryPercent: 30 }).state,
  "active-battery",
);
// "AC Power" with a battery that does not charge (heat, a weak adapter) still discharges, and
// `disablesleep 1` also stops the sleep for low battery.
equal(
  "battery mode on AC below the floor stops while the battery does not charge",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: true, batteryPercent: 15 }),
  { state: "paused-battery-low", assertion: false, grant: false },
);
equal(
  "battery mode on AC below the floor grants while the battery charges",
  decide({
    preference: { mode: "battery" },
    helper: "installed",
    onPowerAdapter: true,
    batteryPercent: 15,
    charging: true,
  }).state,
  "active-battery",
);
equal(
  "battery mode on AC with an unknown level stops while the battery does not charge",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: true, batteryPercent: null }).state,
  "paused-battery-low",
);
equal(
  "battery mode with no limit stops after 8 hours on battery, as the service does",
  decide({
    preference: { mode: "battery", timeLimitHours: 0 },
    helper: "installed",
    onPowerAdapter: false,
    lidClosedSince: 2 * HOUR,
    now: 10 * HOUR,
  }).state,
  "paused-time-limit",
);
equal(
  "battery mode with a limit of 1 hour keeps it on battery",
  decide({
    preference: { mode: "battery", timeLimitHours: 1 },
    helper: "installed",
    onPowerAdapter: false,
    lidClosedSince: 9 * HOUR,
    now: 10 * HOUR,
  }).state,
  "paused-time-limit",
);
equal(
  "battery mode with no limit on AC never stops",
  decide({
    preference: { mode: "battery", timeLimitHours: 0 },
    helper: "installed",
    onPowerAdapter: true,
    charging: true,
    lidClosedSince: 0,
    now: 100 * HOUR,
  }).state,
  "active-battery",
);
// The service can refuse, so `active-battery` needs `SleepDisabled = Yes` after its next check.
equal(
  "battery mode with a new grant is active before the next check of the service",
  decide({
    preference: { mode: "battery" },
    helper: "installed",
    onPowerAdapter: false,
    sleepDisabled: false,
    grantPending: true,
  }).state,
  "active-battery",
);
equal(
  "battery mode on battery with no sleep off after the check pauses and keeps the grant",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: false, sleepDisabled: false }),
  { state: "paused-helper-not-confirmed", assertion: false, grant: true },
);
equal(
  "battery mode on AC with no sleep off after the check holds as plugged and keeps the grant",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: true, sleepDisabled: false }),
  { state: "active-plugged", assertion: true, grant: true },
);
equal(
  "battery mode with a service that does not run pauses on battery",
  decide({ preference: { mode: "battery" }, helper: "stopped", onPowerAdapter: false }).state,
  "paused-helper-missing",
);
equal(
  "battery mode keeps the grant when the assertion failed",
  decide({ preference: { mode: "battery" }, helper: "installed", holdFailed: true }),
  {
    state: "active-battery",
    assertion: false,
    grant: true,
  },
);

// The state of the service: its files, and when it last touched `alive`.
const NOW = 10 * HOUR;
equal("service files missing", helperState("missing", NOW, null, NOW), "missing");
equal("service files of another version", helperState("outdated", NOW, null, NOW), "outdated");
equal("service alive 10 s ago runs", helperState("installed", NOW - 10_000, null, NOW), "installed");
equal("service alive 60 s ago is stopped", helperState("installed", NOW - 60_000, null, NOW), "stopped");
equal("service never alive is stopped", helperState("installed", null, null, NOW), "stopped");
equal(
  "service alive 10 minutes ago, and a wake 20 s ago, runs",
  helperState("installed", NOW - 600_000, NOW - 20_000, NOW),
  "installed",
);
equal(
  "service alive 10 minutes ago, and a wake 60 s ago, is stopped",
  helperState("installed", NOW - 600_000, NOW - 60_000, NOW),
  "stopped",
);

// Parsers, with the text of `pmset` and `ioreg` on a MacBook Pro with macOS 26.4.1.

equal(
  "pmset batt on AC",
  parsePowerSource(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=22085731)\t54%; charging; 1:30 remaining present: true\n",
  ),
  { onPowerAdapter: true, batteryPercent: 54, charging: true },
);
equal(
  "pmset batt on battery",
  parsePowerSource(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22085731)\t7%; discharging; 0:10 remaining present: true\n",
  ),
  { onPowerAdapter: false, batteryPercent: 7, charging: false },
);
equal(
  "pmset batt full",
  parsePowerSource(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true",
  ),
  {
    onPowerAdapter: true,
    batteryPercent: 100,
    charging: true,
  },
);
equal(
  "pmset batt finishing charge",
  parsePowerSource(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=22085731)\t99%; finishing charge; 0:10 remaining present: true\n",
  ),
  { onPowerAdapter: true, batteryPercent: 99, charging: true },
);
equal(
  "pmset batt on AC with no charge",
  parsePowerSource(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=22085731)\t18%; AC attached; not charging present: true\n",
  ),
  { onPowerAdapter: true, batteryPercent: 18, charging: false },
);
equal("pmset batt with no battery", parsePowerSource("Now drawing from 'AC Power'\n"), {
  onPowerAdapter: true,
  batteryPercent: null,
  charging: false,
});
equal(
  "pmset batt over 100 is unknown",
  parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t999%; x"),
  {
    onPowerAdapter: false,
    batteryPercent: null,
    charging: false,
  },
);
equal("pmset batt in an unknown form", parsePowerSource("Drawing from UPS\nsomething"), {
  onPowerAdapter: null,
  batteryPercent: null,
  charging: false,
});
const ioreg = (lid: string | null, disabled: string, causesSleep = "Yes") =>
  `+-o IOPMrootDomain\n    {\n      "AppleClamshellCausesSleep" = ${causesSleep}\n${lid === null ? "" : `      "AppleClamshellState" = ${lid}\n`}      "SleepDisabled" = ${disabled}\n    }\n`;
equal("ioreg lid open", parseRootDomain(ioreg("No", "No")), {
  hasLid: true,
  lidClosed: false,
  clamshellCausesSleep: true,
  sleepDisabled: false,
});
equal("ioreg lid closed and sleep off", parseRootDomain(ioreg("Yes", "Yes")), {
  hasLid: true,
  lidClosed: true,
  clamshellCausesSleep: true,
  sleepDisabled: true,
});
equal(
  "ioreg lid closed with an external display",
  parseRootDomain(ioreg("Yes", "No", "No")).clamshellCausesSleep,
  false,
);
equal("ioreg of a Mac with no lid", parseRootDomain(ioreg(null, "No")), {
  hasLid: false,
  lidClosed: false,
  clamshellCausesSleep: true,
  sleepDisabled: false,
});

equal(
  "sysctl sleep and wake times",
  parseSleepWakeTimes(
    "{ sec = 1793415051, usec = 999147 } Sat Oct 31 02:50:51 2026\n{ sec = 1793415052, usec = 547433 } Sat Oct 31 02:50:52 2026\n",
  ),
  { lastSleepMs: 1_793_415_051_999, lastWakeMs: 1_793_415_052_547 },
);
equal("sysctl in an unknown form", parseSleepWakeTimes("kern.sleeptime: unknown\n"), {
  lastSleepMs: null,
  lastWakeMs: null,
});
const realTimes = parseSleepWakeTimes(
  (await run("/usr/sbin/sysctl", ["-n", "kern.sleeptime", "kern.waketime"])).stdout,
);
check(
  "this Mac gives kern.sleeptime and kern.waketime",
  realTimes.lastSleepMs !== null && realTimes.lastWakeMs !== null && realTimes.lastSleepMs <= Date.now(),
  realTimes,
);
// The premise of the first version was wrong: `process.hrtime` counts the time in sleep on macOS.
// This shows it on each run, so no code comes back to it. It needs a Mac that slept since it started.
const boot = /sec = (\d+)/.exec((await run("/usr/sbin/sysctl", ["-n", "kern.boottime"])).stdout)?.[1];
// `CLOCK_UPTIME_RAW` stops in sleep. Python gives it; with no Python, the check is skipped.
const uptime = await run("/usr/bin/python3", ["-c", "import time; print(time.clock_gettime(time.CLOCK_UPTIME_RAW))"])
  .then(({ stdout }) => Number(stdout))
  .catch(() => Number.NaN);
const sinceBootSeconds = Date.now() / 1_000 - Number(boot);
// The app runs in Electron, so the clock comes from Electron as Node. Bun starts its own clock at 0.
const electron = resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const hrtimeSeconds = await run(electron, ["-e", "console.log(Number(process.hrtime.bigint() / 1000000n) / 1000)"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
})
  .then(({ stdout }) => Number(stdout))
  .catch(() => Number.NaN);
const awakeSeconds = uptime;
if (sinceBootSeconds - awakeSeconds > 60 && Number.isFinite(hrtimeSeconds))
  check(
    "process.hrtime counts sleep, so the lid-closed code does not use it",
    Math.abs(hrtimeSeconds - sinceBootSeconds) < Math.abs(hrtimeSeconds - awakeSeconds),
    { hrtimeSeconds, sinceBootSeconds, awakeSeconds },
  );
else report.push({ check: "process.hrtime and sleep (skipped: this Mac did not sleep since it started)", ok: true });

// The test arithmetic. The wall clock counts the time in sleep, and so does `process.hrtime`. Only
// `kern.sleeptime` and a late record show a sleep.

function simulate(
  beats: { gap: number; sleptAt?: number; lid: boolean }[],
  knownSleep = true,
): {
  progress: LidTestProgress;
  done: boolean;
} {
  let wall = 1_000_000;
  let lastSleepMs: number | null = knownSleep ? 400_000 : null;
  let progress = startLidTest({ wallMs: wall, lastSleepMs, lidClosed: false });
  let done = false;
  for (const beat of beats) {
    // `sleptAt` is the time after the last record when the Mac went to sleep.
    if (beat.sleptAt !== undefined && knownSleep) lastSleepMs = wall + beat.sleptAt;
    wall += beat.gap;
    progress = recordLidTestSample(progress, { wallMs: wall, lastSleepMs, lidClosed: beat.lid });
    if (lidTestDone(progress)) {
      done = true;
      break;
    }
  }
  return { progress, done };
}
const closedBeats = (count: number) => Array.from({ length: count }, () => ({ gap: 5_000, lid: true }));
const stayed = simulate([{ gap: 5_000, lid: false }, ...closedBeats(30), { gap: 5_000, lid: false }]);
equal(
  "a closed lid for 150 s with no sleep passes",
  { done: stayed.done, ...lidTestResult(stayed.progress, true) },
  {
    done: true,
    ...lidTestResult(stayed.progress, true),
    verdict: "stayed-awake",
  },
);
check("the closed time counts about 150 s", Math.abs(lidTestResult(stayed.progress, true).closedSeconds - 150) <= 5);
const slept = simulate([
  { gap: 5_000, lid: true },
  { gap: 300_000, sleptAt: 2_000, lid: true },
  { gap: 5_000, lid: false },
]);
equal("a sleep of 300 s fails", lidTestResult(slept.progress, true).verdict, "slept");
equal("the time of the sleep counts as slept", lidTestResult(slept.progress, true).sleptSeconds, 300);
equal("the test stops when the lid opens after a sleep", slept.done, true);
const maintenance = simulate([...closedBeats(2), { gap: 600_000, sleptAt: 1_000, lid: true }, ...closedBeats(30)]);
equal("a record in a maintenance wake does not pass", lidTestResult(maintenance.progress, true).verdict, "slept");
// The reviewer's case: the Mac slept 300 s and a record came in the dark wake that follows.
const darkWakeRecord = simulate([
  { gap: 5_000, lid: false },
  ...closedBeats(2),
  { gap: 300_000, sleptAt: 3_000, lid: true },
  ...closedBeats(26),
  { gap: 5_000, lid: false },
]);
equal(
  "a sleep with records after it in dark wake fails",
  lidTestResult(darkWakeRecord.progress, true).verdict,
  "slept",
);
const shortSleep = simulate([...closedBeats(10), { gap: 5_000, sleptAt: 1_000, lid: true }, ...closedBeats(30)]);
equal(
  "a sleep that the kernel recorded fails also when the gap is short",
  lidTestResult(shortSleep.progress, true).verdict,
  "slept",
);
const unknownSleep = simulate([...closedBeats(2), { gap: 300_000, lid: true }, ...closedBeats(30)], false);
equal("with no kern.sleeptime, a long gap fails the test", lidTestResult(unknownSleep.progress, true).verdict, "slept");
const lateBeat = simulate([
  ...closedBeats(10),
  { gap: 16_000, lid: true },
  ...closedBeats(30),
  { gap: 5_000, lid: false },
]);
equal("a record 16 s late fails the test", lidTestResult(lateBeat.progress, true).verdict, "slept");
const open = simulate([
  { gap: 5_000, lid: false },
  { gap: 5_000, lid: false },
]);
equal("an open lid gives lid-not-closed", lidTestResult(open.progress, true).verdict, "lid-not-closed");
equal("a running test shows running", lidTestResult(open.progress, false).verdict, "running");
const long = simulate(Array.from({ length: 130 }, () => ({ gap: 5_000, lid: false })));
equal("the test stops after 10 minutes", long.done, true);

// 2. Command arguments.

equal("caffeinate arguments", caffeinateArgs(4242), ["-i", "-s", "-w", "4242"]);
for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_VALUE]) {
  let threw = false;
  try {
    caffeinateArgs(pid);
  } catch {
    threw = true;
  }
  check(`caffeinate refuses the process id ${pid}`, threw);
}
check("caffeinate has an absolute path", CAFFEINATE_PATH === "/usr/bin/caffeinate");
const prompt = 'Text with "quotes" & $(id) `id`';
const installArgs = adminScriptArgs("install", prompt);
equal("install arguments: the handler, then the script and the prompt as data", installArgs.slice(0, 6), [
  "-e",
  "on run argv",
  "-e",
  "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges",
  "-e",
  "end run",
]);
check("install arguments carry the constant script", installArgs[6] === LID_AWAKE_INSTALL_SCRIPT);
check("install arguments carry the prompt unchanged", installArgs[7] === prompt && installArgs.length === 8);
check("remove arguments carry the constant script", adminScriptArgs("remove", prompt)[6] === LID_AWAKE_REMOVE_SCRIPT);
check("a canceled prompt is found", isUserCancel("execution error: User canceled. (-128)"));
check("another failure is not a cancel", !isUserCancel("execution error: something (-60005)"));
const embedded = /'([A-Za-z0-9+/=]+)' \| \/usr\/bin\/base64 -D > "\$TOOL\.new"/.exec(LID_AWAKE_INSTALL_SCRIPT)?.[1];
check(
  "the install script writes the tool script byte for byte",
  embedded !== undefined && Buffer.from(embedded, "base64").toString("utf8") === LID_AWAKE_TOOL_SCRIPT,
);
const plist = /'([A-Za-z0-9+/=]+)' \| \/usr\/bin\/base64 -D > "\$PLIST\.new"/.exec(LID_AWAKE_INSTALL_SCRIPT)?.[1];
check(
  "the install script writes the property list byte for byte",
  plist !== undefined && Buffer.from(plist, "base64").toString("utf8") === LID_AWAKE_PLIST,
);
check("the remove script turns sleep on", LID_AWAKE_REMOVE_SCRIPT.includes("/usr/bin/pmset -a disablesleep 0"));
check(
  "the tool script changes pmset only with the two fixed disablesleep values and sleepnow",
  [...LID_AWAKE_TOOL_SCRIPT.matchAll(/\/usr\/bin\/pmset (?!-g )[^\n]*/g)]
    .map((match) => match[0])
    .sort()
    .join("|") ===
    "/usr/bin/pmset -a disablesleep 0 >/dev/null 2>&1|/usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1|/usr/bin/pmset sleepnow >/dev/null 2>&1",
);
check(
  "the tool script does not ask to sleep when it stops (shut down, restart, removal)",
  /^trap 'allow_sleep; exit 0' TERM INT HUP$/m.test(LID_AWAKE_TOOL_SCRIPT),
);

const root = await mkdtemp(join(tmpdir(), "openbot-lid-awake-smoke-"));
try {
  for (const [name, text] of [
    ["tool.sh", LID_AWAKE_TOOL_SCRIPT],
    ["install.sh", LID_AWAKE_INSTALL_SCRIPT],
    ["remove.sh", LID_AWAKE_REMOVE_SCRIPT],
  ] as const) {
    await writeFile(join(root, name), text);
    const syntax = await run("/bin/sh", ["-n", join(root, name)]).then(
      () => true,
      () => false,
    );
    check(`${name} parses with /bin/sh -n`, syntax);
  }
  await writeFile(join(root, "plist.plist"), LID_AWAKE_PLIST);
  check(
    "the property list is valid",
    await run("/usr/bin/plutil", ["-lint", join(root, "plist.plist")]).then(
      () => true,
      () => false,
    ),
  );

  // 3. The safety service, with stub commands. The stub `pmset -a disablesleep` changes what the
  // stub `ioreg` shows, as macOS does.

  const stub = join(root, "stub");
  const base = join(root, "base");
  const fakeApp = join(root, "Builders Bot.app", "Contents", "MacOS", "Builders Bot");
  const fakeTool = join(root, "installed-tool.sh");
  const fakePlist = join(root, "installed.plist");
  await mkdir(stub);
  await mkdir(join(root, "Builders Bot.app", "Contents", "MacOS"), { recursive: true });
  const stubScript = (body: string) => `#!/bin/sh\n${body}\n`;
  await writeFile(
    join(stub, "pmset"),
    stubScript(`if [ "$1" = -a ]; then
  echo "$2 $3" >> "${stub}/changes"
  if [ "$3" = 1 ]; then echo Yes > "${stub}/disabled"; else echo No > "${stub}/disabled"; fi
  exit 0
fi
if [ "$1" = sleepnow ]; then echo sleepnow >> "${stub}/changes"; exit 0; fi
if [ "$2" = batt ]; then
  n=$(($(cat "${stub}/count") + 1)); echo "$n" > "${stub}/count"
  if [ -f "${stub}/batt.$n" ]; then cat "${stub}/batt.$n"; else cat "${stub}/batt"; fi
  exit 0
fi
if [ "$2" = therm ]; then cat "${stub}/therm"; exit 0; fi
exit 1`),
  );
  await writeFile(
    join(stub, "ioreg"),
    stubScript(
      `[ "$(cat "${stub}/ioreg-mode")" = fail ] && exit 1
printf '      "AppleClamshellCausesSleep" = %s\\n      "AppleClamshellState" = %s\\n      "SleepDisabled" = %s\\n' "$(cat "${stub}/causes")" "$(cat "${stub}/lid")" "$(cat "${stub}/disabled")"`,
    ),
  );
  await writeFile(join(stub, "ps"), stubScript(`cat "${stub}/ps.out"`));
  await writeFile(join(stub, "notifyutil"), stubScript(`cat "${stub}/pressure"`));
  await writeFile(join(stub, "launchctl"), stubScript(`echo "launchctl $*" >> "${stub}/changes"`));
  for (const name of ["pmset", "ioreg", "ps", "notifyutil", "launchctl"]) await chmod(join(stub, name), 0o755);
  const uid = process.getuid?.() ?? 501;
  const serviceCopy = (checks: number, goneTicks: number) =>
    LID_AWAKE_TOOL_SCRIPT.replaceAll("/usr/bin/pmset", `${stub}/pmset`)
      .replaceAll("/usr/sbin/ioreg", `${stub}/ioreg`)
      .replaceAll("/bin/ps", `${stub}/ps`)
      .replaceAll("/usr/bin/notifyutil", `${stub}/notifyutil`)
      .replaceAll("/bin/launchctl", `${stub}/launchctl`)
      .replace(/^TOOL='.*'$/m, `TOOL='${fakeTool}'`)
      .replace(/^PLIST='.*'$/m, `PLIST='${fakePlist}'`)
      .replace(/^PARENT='.*'$/m, `PARENT='${join(root, "no-parent")}'`)
      .replace(/^BASE='.*'$/m, `BASE='${base}'`)
      .replace(/^APP='.*'$/m, `APP='${fakeApp}'`)
      .replace("TICK=15", "TICK=0")
      .replace("SETTLE=1", "SETTLE=0")
      .replace("GONE_TICKS=8", `GONE_TICKS=${goneTicks}`)
      .replace("while :; do", `for check in ${Array.from({ length: checks }, (_, index) => index + 1).join(" ")}; do`);
  const sample = serviceCopy(1, 8);
  check(
    "the test copy of the service has no real pmset, launchctl or /Library path",
    !sample.includes("/usr/bin/pmset") &&
      !sample.includes("/bin/launchctl") &&
      !sample.includes("/Library/") &&
      sample.includes("for check in 1; do"),
  );
  const servicePath = join(root, "service-under-test.sh");
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  const batteryLine = (percent: number, state: string) =>
    ` -InternalBattery-0 (id=1)\t${percent}%; ${state} present: true\n`;
  const ac = (percent: number, state: string) => `Now drawing from 'AC Power'\n${batteryLine(percent, state)}`;
  const AC = ac(54, "charging; 1:30 remaining");
  const battery = (percent: number) =>
    `Now drawing from 'Battery Power'\n${batteryLine(percent, "discharging; 2:00 remaining")}`;
  // `pmset -g therm` on Apple silicon (this Mac, macOS 26.4.1) never shows a level.
  const NO_THERMAL_LEVEL =
    "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n";
  const pressure = (level: string) => `com.apple.system.thermalpressurelevel ${level}\n`;
  const appLine = `  ${uid} ${fakeApp}\n  ${uid} /usr/bin/caffeinate\n`;
  const BLOCK = ["disablesleep 0", "disablesleep 1"];
  const ALLOW = ["disablesleep 0"];
  const HOURS = 3_600;

  interface Case {
    name: string;
    owner?: string;
    grant?: { floor: number; ageSeconds: number } | "symlink" | null;
    /** A list gives the text of each check. */
    batt?: string | string[];
    therm?: string;
    pressure?: string;
    ps?: string;
    lid?: "Yes" | "No";
    causesSleep?: "Yes" | "No";
    /** The lid closed this many seconds ago, in the file of the service. */
    closedSince?: number;
    checks?: number;
    goneTicks?: number;
    noApp?: boolean;
    ioregFails?: boolean;
    expected: string[];
    after?: () => Promise<void>;
  }
  const cases: Case[] = [
    { name: "fresh grant on AC blocks sleep", expected: BLOCK },
    { name: "a second check keeps sleep off", checks: 2, expected: BLOCK },
    { name: "no grant allows sleep", grant: null, expected: ALLOW },
    { name: "a grant of 120 s allows sleep", grant: { floor: 30, ageSeconds: 120 }, expected: ALLOW },
    { name: "a grant from the future allows sleep", grant: { floor: 30, ageSeconds: -60 }, expected: ALLOW },
    { name: "a grant link allows sleep", grant: "symlink", expected: ALLOW },
    { name: "another owner allows sleep", owner: "0", expected: ALLOW },
    { name: "an owner file with text allows sleep", owner: "501; rm", expected: ALLOW },
    {
      name: "app not running allows sleep",
      ps: `  ${uid} /Applications/Other.app/Contents/MacOS/Other\n`,
      expected: ALLOW,
    },
    { name: "app of another user allows sleep", ps: `  0 ${fakeApp}\n`, expected: ALLOW },
    { name: "battery above the floor blocks sleep", batt: battery(35), expected: BLOCK },
    { name: "battery at the floor blocks sleep", batt: battery(30), expected: BLOCK },
    { name: "battery below the floor allows sleep", batt: battery(29), expected: ALLOW },
    { name: "a 50 floor stops at 49", grant: { floor: 50, ageSeconds: 5 }, batt: battery(49), expected: ALLOW },
    { name: "a 20 floor holds at 20", grant: { floor: 20, ageSeconds: 5 }, batt: battery(20), expected: BLOCK },
    { name: "unknown battery text allows sleep", batt: "Now drawing from 'UPS Power'\n", expected: ALLOW },
    // "AC Power" is not enough: the battery must charge, or be at or above the floor.
    { name: "AC with 15% that discharges allows sleep", batt: ac(15, "discharging; 1:00 remaining"), expected: ALLOW },
    { name: "AC with 15% that charges blocks sleep", batt: ac(15, "charging; 2:00 remaining"), expected: BLOCK },
    {
      name: "AC with no charge above the floor blocks sleep",
      batt: ac(80, "AC attached; not charging"),
      expected: BLOCK,
    },
    {
      name: "AC with no charge below the floor allows sleep",
      batt: ac(18, "AC attached; not charging"),
      expected: ALLOW,
    },
    { name: "AC with a full battery blocks sleep", batt: ac(100, "charged; 0:00 remaining"), expected: BLOCK },
    {
      name: "AC that finishes the charge blocks sleep",
      batt: ac(99, "finishing charge; 0:10 remaining"),
      expected: BLOCK,
    },
    { name: "AC with no battery line allows sleep", batt: "Now drawing from 'AC Power'\n", expected: ALLOW },
    // Heat: the thermal pressure, which Apple silicon reports, and the level of Intel Macs.
    { name: "thermal pressure 1 blocks sleep", pressure: pressure("1"), expected: BLOCK },
    { name: "thermal pressure 2 allows sleep", pressure: pressure("2"), expected: ALLOW },
    { name: "an unknown thermal pressure allows sleep", pressure: pressure("x"), expected: ALLOW },
    { name: "no thermal pressure allows sleep", pressure: "", expected: ALLOW },
    {
      name: "a thermal warning allows sleep",
      therm: "2026-10-31 14:00:00 +0000 Thermal Warning Level = 2\n",
      expected: ALLOW,
    },
    {
      name: "thermal level 0 blocks sleep",
      therm: "2026-10-31 14:00:00 +0000 Thermal Warning Level = 0\n",
      expected: BLOCK,
    },
    {
      name: "a thermal error allows sleep",
      therm: "Error:Failed to get thermal warning level with error code 0x1\n",
      expected: ALLOW,
    },
    // The time limit of the service.
    {
      name: "the lid closed for 9 hours on battery allows sleep",
      lid: "Yes",
      closedSince: 9 * HOURS,
      batt: battery(80),
      expected: ALLOW,
    },
    {
      name: "the lid closed for 7 hours on battery blocks sleep",
      lid: "Yes",
      closedSince: 7 * HOURS,
      batt: battery(80),
      expected: BLOCK,
    },
    {
      name: "the lid closed for 9 hours on AC that charges blocks sleep",
      lid: "Yes",
      closedSince: 9 * HOURS,
      expected: BLOCK,
    },
    {
      name: "a closed lid starts the time of the service",
      lid: "Yes",
      batt: battery(80),
      expected: BLOCK,
      after: async () => check("service: the closed time is written", await exists(join(base, "closed-since"))),
    },
    {
      name: "an open lid ends the time of the service",
      lid: "No",
      closedSince: 9 * HOURS,
      batt: battery(80),
      expected: BLOCK,
      after: async () => check("service: the closed time is removed", !(await exists(join(base, "closed-since")))),
    },
    // When sleep comes back on with the lid closed, macOS does not sleep by itself.
    {
      name: "a stop with the lid closed asks macOS to sleep",
      checks: 2,
      lid: "Yes",
      batt: [AC, battery(10)],
      expected: [...BLOCK, "disablesleep 0", "sleepnow"],
    },
    {
      name: "a stop with the lid open does not ask to sleep",
      checks: 2,
      batt: [AC, battery(10)],
      expected: [...BLOCK, "disablesleep 0"],
    },
    {
      name: "a stop with an external display does not ask to sleep",
      checks: 2,
      lid: "Yes",
      causesSleep: "No",
      batt: [AC, battery(10)],
      expected: [...BLOCK, "disablesleep 0"],
    },
    {
      name: "a failed read of ioreg turns sleep on and keeps the closed time",
      ioregFails: true,
      closedSince: 3 * HOURS,
      expected: ["disablesleep 0", "disablesleep 0"],
      after: async () => check("service: the closed time stays", await exists(join(base, "closed-since"))),
    },
    {
      name: "each check touches alive",
      expected: BLOCK,
      after: async () => check("service: alive is written", await exists(join(base, "alive"))),
    },
    {
      name: "the service stays while the app is gone for a short time",
      noApp: true,
      checks: 2,
      expected: BLOCK,
    },
    {
      name: "the service removes itself when the app is gone",
      noApp: true,
      goneTicks: 1,
      expected: ["disablesleep 0", "disablesleep 0", "launchctl bootout system/app.buildersbot.lid-awake"],
      after: async () =>
        check(
          "service: its files are removed",
          !(await exists(fakeTool)) && !(await exists(fakePlist)) && !(await exists(join(base, "owner"))),
        ),
    },
  ];
  for (const testCase of cases) {
    await rm(base, { recursive: true, force: true });
    await mkdir(join(base, "grant"), { recursive: true });
    await writeFile(join(base, "owner"), `${testCase.owner ?? uid}\n`);
    const grant = testCase.grant === undefined ? { floor: 30, ageSeconds: 5 } : testCase.grant;
    if (grant === "symlink") {
      await writeFile(join(root, "elsewhere"), "");
      await symlink(join(root, "elsewhere"), join(base, "grant", "active-30"));
    } else if (grant) {
      const path = join(base, "grant", `active-${grant.floor}`);
      await writeFile(path, "");
      const at = new Date(Date.now() - grant.ageSeconds * 1_000);
      await utimes(path, at, at);
    }
    if (testCase.closedSince !== undefined)
      await writeFile(join(base, "closed-since"), `${Math.floor(Date.now() / 1_000) - testCase.closedSince}\n`);
    const batts = Array.isArray(testCase.batt) ? testCase.batt : [testCase.batt ?? AC];
    for (let index = 1; index <= 4; index++) await rm(join(stub, `batt.${index}`), { force: true });
    for (const [index, text] of batts.entries()) await writeFile(join(stub, `batt.${index + 1}`), text);
    await writeFile(join(stub, "batt"), batts.at(-1) ?? AC);
    await writeFile(join(stub, "count"), "0");
    await writeFile(join(stub, "therm"), testCase.therm ?? NO_THERMAL_LEVEL);
    await writeFile(join(stub, "pressure"), testCase.pressure ?? pressure("0"));
    await writeFile(join(stub, "ps.out"), testCase.ps ?? appLine);
    await writeFile(join(stub, "lid"), testCase.lid ?? "No");
    await writeFile(join(stub, "causes"), testCase.causesSleep ?? "Yes");
    await writeFile(join(stub, "disabled"), "No");
    await writeFile(join(stub, "ioreg-mode"), testCase.ioregFails ? "fail" : "ok");
    await writeFile(join(stub, "changes"), "");
    await writeFile(fakeTool, "");
    await writeFile(fakePlist, "");
    if (testCase.noApp) await rm(fakeApp, { force: true });
    else await writeFile(fakeApp, "");
    await writeFile(servicePath, serviceCopy(testCase.checks ?? 1, testCase.goneTicks ?? 8));
    await run("/bin/sh", [servicePath], { timeout: 20_000 });
    const changes = (await readFile(join(stub, "changes"), "utf8")).split("\n").filter(Boolean);
    equal(`service: ${testCase.name}`, changes, testCase.expected);
    await testCase.after?.();
  }

  // 4. The real assertion, on the power adapter only.

  const power = parsePowerSource((await run("/usr/bin/pmset", ["-g", "batt"])).stdout);
  if (power.onPowerAdapter !== true) {
    report.push({ check: "caffeinate assertion (skipped: not on the power adapter)", ok: true });
  } else {
    const target = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
    const targetPid = target.pid;
    if (targetPid === undefined) throw new Error("The test process did not start.");
    const hold = spawn(CAFFEINATE_PATH, caffeinateArgs(targetPid), { stdio: "ignore" });
    const holdPid = hold.pid;
    const holdExit = new Promise<void>((done) => hold.once("exit", () => done()));
    const assertionOf = async (pid: number | undefined) => {
      const { stdout } = await run("/usr/bin/pmset", ["-g", "assertions"]);
      return stdout
        .split("\n")
        .filter((line) => line.includes(`pid ${pid}(caffeinate)`))
        .map((line) => line.trim());
    };
    let lines: string[] = [];
    for (let attempt = 0; attempt < 50 && !lines.some((line) => line.includes("PreventSystemSleep")); attempt++) {
      lines = await assertionOf(holdPid);
      if (!lines.some((line) => line.includes("PreventSystemSleep")))
        await new Promise((done) => setTimeout(done, 100));
    }
    check(
      "caffeinate holds PreventSystemSleep for the test process",
      lines.some((line) => line.includes("PreventSystemSleep")),
      lines,
    );
    check(
      "caffeinate holds PreventUserIdleSystemSleep",
      lines.some((line) => line.includes("PreventUserIdleSystemSleep")),
      lines,
    );
    target.kill("SIGTERM");
    await Promise.race([holdExit, new Promise((done) => setTimeout(done, 5_000))]);
    check("caffeinate ends when the test process ends", hold.exitCode !== null || hold.signalCode !== null);
    equal("the assertion is gone", await assertionOf(holdPid), []);
    if (hold.exitCode === null && hold.signalCode === null) hold.kill("SIGTERM");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

// 5. Routines in dark wake, with a short check and stub routines.

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 10));
  }
  return true;
}
const calls: string[] = [];
let holding = true;
let confirmed = true;
let confirmations = 0;
let kernelSleep: number | null = 1_000;
let clockJump = 0;
const routines = new LidAwakeRoutines({
  routineWake: { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") },
  holds: () => holding,
  confirmHolds: async () => {
    confirmations += 1;
    return confirmed;
  },
  lastSleep: async () => kernelSleep,
  log: () => undefined,
  checkMs: 100,
  tickMs: 20,
  now: () => Date.now() + clockJump,
});
// Long enough for the check (100 ms) and its reads to end.
const checkEnded = () => new Promise((done) => setTimeout(done, 400));
routines.suspend();
check("dark wake: routines run again when the Mac did not sleep", await waitFor(() => calls.length === 2));
equal("dark wake: hold first, then run", calls, ["suspend", "resume"]);
equal("dark wake: the computer is read again before the routines run", confirmations, 1);
holding = false;
routines.holdMayEnd();
equal("the end of the hold in dark wake holds the routines again", calls, ["suspend", "resume", "suspend"]);
routines.holdMayEnd();
equal("a second end changes nothing", calls.length, 3);
routines.resume();
routines.suspend();
check("with no hold, a suspend keeps the routines held", !(await waitFor(() => calls.length > 5, 300)));
equal("with no hold: resume, then suspend only", calls.slice(3), ["resume", "suspend"]);

// The clock of Node counts the time in sleep, so a timer can come in a maintenance wake after a
// real sleep. Each of these cases must keep the routines held.
const heldAfter = async (name: string, setup: () => void) => {
  holding = true;
  confirmed = true;
  kernelSleep = 1_000;
  clockJump = 0;
  calls.length = 0;
  setup();
  routines.suspend();
  await checkEnded();
  equal(name, calls, ["suspend"]);
};
await heldAfter("the kernel recorded a sleep after suspend: routines stay held", () => {
  kernelSleep = Date.now() + 10;
});
await heldAfter("kern.sleeptime cannot be read: routines stay held", () => {
  kernelSleep = null;
});
await heldAfter("a new read shows no hold: routines stay held", () => {
  confirmed = false;
});
holding = true;
confirmed = true;
kernelSleep = 1_000;
clockJump = 0;
calls.length = 0;
routines.suspend();
// The clock jumps 300 s, as it does when the Mac sleeps and the timer then comes in a dark wake.
setTimeout(() => {
  clockJump = 300_000;
}, 30);
await checkEnded();
equal("a timer that comes late after a jump of the clock keeps the routines held", calls, ["suspend"]);
routines.dispose();

const failed = report.filter((item) => !item.ok);
const output = resolve(".openbot-build/lid-awake-smoke.json");
await mkdir(resolve(".openbot-build"), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify({ ranAt: new Date().toISOString(), passed: report.length - failed.length, failed: failed.length, checks: report }, null, 2)}\n`,
);
process.stdout.write(`${report.length - failed.length}/${report.length} checks passed. Report: ${output}\n`);
if (failed.length > 0) process.exit(1);
