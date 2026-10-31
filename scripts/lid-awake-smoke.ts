// Checks the lid-closed mode without a Mac that sleeps. See docs/architecture/lid-awake.md.
//
// 1. The decisions, the parsers and the test arithmetic of `lid-awake-policy.ts`, with fixed inputs.
// 2. The command arguments: constants and one whole number, and the prompt as a separate argument.
// 3. The root safety service script, run as this user with stub `pmset`, `ioreg` and `ps` commands
//    and a temporary folder. The script text must not keep a real `pmset` or `/Library` path.
// 4. On the power adapter only: the real `caffeinate` assertion for a test process. It must show in
//    `pmset -g assertions`, and it must go when the test process ends.
// 5. `LidAwakeRoutines`: routines run again in dark wake, and are held again when the hold ends.
//
// It never runs `pmset -a`, never asks for a password and never makes the Mac sleep.
// It writes `.openbot-build/lid-awake-smoke.json`.
//
// bun scripts/lid-awake-smoke.ts

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_LID_AWAKE_PREFERENCE, type LidAwakePreference } from "@openbot/contracts/ipc";
import {
  adminScriptArgs,
  isUserCancel,
  LID_AWAKE_APP_EXECUTABLE,
  LID_AWAKE_BASE,
  LID_AWAKE_INSTALL_SCRIPT,
  LID_AWAKE_PLIST,
  LID_AWAKE_REMOVE_SCRIPT,
  LID_AWAKE_TOOL_SCRIPT,
} from "../src/main/lid-awake-helper";
import {
  CAFFEINATE_PATH,
  caffeinateArgs,
  decideLidAwake,
  type LidAwakeInput,
  type LidTestProgress,
  lidTestDone,
  lidTestResult,
  parsePowerSource,
  parseRootDomain,
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
    thermal: "nominal",
    lidClosedSince: null,
    now: 10 * HOUR,
    helper: "missing",
    holdFailed: false,
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
  "battery mode on AC grants at any level",
  decide({ preference: { mode: "battery" }, helper: "installed", onPowerAdapter: true, batteryPercent: 5 }).state,
  "active-battery",
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

// Parsers, with the text of `pmset` and `ioreg` on a MacBook Pro with macOS 26.4.1.

equal(
  "pmset batt on AC",
  parsePowerSource(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=22085731)\t54%; charging; 1:30 remaining present: true\n",
  ),
  { onPowerAdapter: true, batteryPercent: 54 },
);
equal(
  "pmset batt on battery",
  parsePowerSource(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22085731)\t7%; discharging; 0:10 remaining present: true\n",
  ),
  { onPowerAdapter: false, batteryPercent: 7 },
);
equal(
  "pmset batt full",
  parsePowerSource(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true",
  ),
  {
    onPowerAdapter: true,
    batteryPercent: 100,
  },
);
equal("pmset batt with no battery", parsePowerSource("Now drawing from 'AC Power'\n"), {
  onPowerAdapter: true,
  batteryPercent: null,
});
equal(
  "pmset batt over 100 is unknown",
  parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t999%; x"),
  {
    onPowerAdapter: false,
    batteryPercent: null,
  },
);
equal("pmset batt in an unknown form", parsePowerSource("Drawing from UPS\nsomething"), {
  onPowerAdapter: null,
  batteryPercent: null,
});
const ioreg = (lid: string | null, disabled: string) =>
  `+-o IOPMrootDomain\n    {\n      "AppleClamshellCausesSleep" = Yes\n${lid === null ? "" : `      "AppleClamshellState" = ${lid}\n`}      "SleepDisabled" = ${disabled}\n    }\n`;
equal("ioreg lid open", parseRootDomain(ioreg("No", "No")), { hasLid: true, lidClosed: false, sleepDisabled: false });
equal("ioreg lid closed and sleep off", parseRootDomain(ioreg("Yes", "Yes")), {
  hasLid: true,
  lidClosed: true,
  sleepDisabled: true,
});
equal("ioreg of a Mac with no lid", parseRootDomain(ioreg(null, "No")), {
  hasLid: false,
  lidClosed: false,
  sleepDisabled: false,
});

// The test arithmetic. The monotonic clock stops while the Mac sleeps.

function simulate(beats: { gap: number; slept?: number; lid: boolean }[]): {
  progress: LidTestProgress;
  done: boolean;
} {
  let wall = 1_000_000;
  let mono = 50_000;
  let progress = startLidTest({ wallMs: wall, monoMs: mono, lidClosed: false });
  let done = false;
  for (const beat of beats) {
    wall += beat.gap;
    mono += beat.gap - (beat.slept ?? 0);
    progress = recordLidTestSample(progress, { wallMs: wall, monoMs: mono, lidClosed: beat.lid });
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
  { gap: 300_000, slept: 295_000, lid: true },
  { gap: 5_000, lid: false },
]);
equal("a sleep of 295 s fails", lidTestResult(slept.progress, true).verdict, "slept");
equal("the sleep is measured", lidTestResult(slept.progress, true).sleptSeconds, 295);
equal("the test stops when the lid opens after a sleep", slept.done, true);
const maintenance = simulate([...closedBeats(2), { gap: 600_000, slept: 590_000, lid: true }, ...closedBeats(30)]);
equal("a record in a maintenance wake does not pass", lidTestResult(maintenance.progress, true).verdict, "slept");
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
  "the tool script runs only the two fixed pmset changes",
  [...LID_AWAKE_TOOL_SCRIPT.matchAll(/\/usr\/bin\/pmset -a [^\n]*/g)]
    .map((match) => match[0])
    .sort()
    .join("|") === "/usr/bin/pmset -a disablesleep 0 >/dev/null 2>&1|/usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1",
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

  // 3. The safety service, one check, with stub commands.

  const stub = join(root, "stub");
  const base = join(root, "base");
  await mkdir(stub);
  const stubScript = (body: string) => `#!/bin/sh\n${body}\n`;
  await writeFile(
    join(stub, "pmset"),
    stubScript(`if [ "$1" = -a ]; then echo "$2 $3" >> "${stub}/changes"; exit 0; fi
if [ "$2" = batt ]; then cat "${stub}/batt"; exit 0; fi
if [ "$2" = therm ]; then cat "${stub}/therm"; exit 0; fi
exit 1`),
  );
  await writeFile(
    join(stub, "ioreg"),
    stubScript(`printf '      "SleepDisabled" = %s\\n' "$(cat "${stub}/disabled")"`),
  );
  await writeFile(join(stub, "ps"), stubScript(`cat "${stub}/ps.out"`));
  for (const name of ["pmset", "ioreg", "ps"]) await chmod(join(stub, name), 0o755);
  const uid = process.getuid?.() ?? 501;
  const testScript = LID_AWAKE_TOOL_SCRIPT.replaceAll("/usr/bin/pmset", `${stub}/pmset`)
    .replaceAll("/usr/sbin/ioreg", `${stub}/ioreg`)
    .replaceAll("/bin/ps", `${stub}/ps`)
    .replace(`BASE='${LID_AWAKE_BASE}'`, `BASE='${base}'`)
    .replace("TICK=15", "TICK=0")
    .replace("while :; do", "for once in 1; do");
  check(
    "the test copy of the service has no real pmset and no /Library path",
    !testScript.includes("/usr/bin/pmset") &&
      !testScript.includes("/Library/") &&
      testScript.includes("for once in 1; do"),
  );
  const servicePath = join(root, "service-under-test.sh");
  await writeFile(servicePath, testScript);

  const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t54%; charging; 1:30 remaining present: true\n";
  const battery = (percent: number) =>
    `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t${percent}%; discharging; 2:00 remaining present: true\n`;
  const COOL =
    "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n";
  const appLine = `  ${uid} ${LID_AWAKE_APP_EXECUTABLE}\n  ${uid} /usr/bin/caffeinate\n`;

  interface Case {
    name: string;
    owner?: string;
    grant?: { floor: number; ageSeconds: number } | "symlink" | null;
    batt?: string;
    therm?: string;
    ps?: string;
    disabled?: "Yes" | "No";
    expected: string[];
  }
  const cases: Case[] = [
    { name: "fresh grant on AC blocks sleep", expected: ["disablesleep 0", "disablesleep 1"] },
    { name: "fresh grant with sleep already off keeps it", disabled: "Yes", expected: ["disablesleep 0"] },
    { name: "no grant allows sleep", grant: null, disabled: "Yes", expected: ["disablesleep 0", "disablesleep 0"] },
    {
      name: "a grant of 120 s allows sleep",
      grant: { floor: 30, ageSeconds: 120 },
      disabled: "Yes",
      expected: ["disablesleep 0", "disablesleep 0"],
    },
    {
      name: "a grant from the future allows sleep",
      grant: { floor: 30, ageSeconds: -60 },
      expected: ["disablesleep 0"],
    },
    { name: "a grant link allows sleep", grant: "symlink", expected: ["disablesleep 0"] },
    { name: "another owner allows sleep", owner: "0", expected: ["disablesleep 0"] },
    { name: "an owner file with text allows sleep", owner: "501; rm", expected: ["disablesleep 0"] },
    {
      name: "app not running allows sleep",
      ps: `  ${uid} /Applications/Other.app/Contents/MacOS/Other\n`,
      expected: ["disablesleep 0"],
    },
    { name: "app of another user allows sleep", ps: `  0 ${LID_AWAKE_APP_EXECUTABLE}\n`, expected: ["disablesleep 0"] },
    { name: "battery above the floor blocks sleep", batt: battery(35), expected: ["disablesleep 0", "disablesleep 1"] },
    { name: "battery at the floor blocks sleep", batt: battery(30), expected: ["disablesleep 0", "disablesleep 1"] },
    { name: "battery below the floor allows sleep", batt: battery(29), expected: ["disablesleep 0"] },
    {
      name: "a 50 floor stops at 49",
      grant: { floor: 50, ageSeconds: 5 },
      batt: battery(49),
      expected: ["disablesleep 0"],
    },
    {
      name: "a 20 floor holds at 20",
      grant: { floor: 20, ageSeconds: 5 },
      batt: battery(20),
      expected: ["disablesleep 0", "disablesleep 1"],
    },
    { name: "unknown battery text allows sleep", batt: "Now drawing from 'UPS Power'\n", expected: ["disablesleep 0"] },
    {
      name: "a thermal warning allows sleep",
      therm: "2026-10-31 14:00:00 +0000 Thermal Warning Level = 2\n",
      expected: ["disablesleep 0"],
    },
    {
      name: "thermal level 0 blocks sleep",
      therm: "2026-10-31 14:00:00 +0000 Thermal Warning Level = 0\n",
      expected: ["disablesleep 0", "disablesleep 1"],
    },
    {
      name: "a thermal error allows sleep",
      therm: "Error:Failed to get thermal warning level with error code 0x1\n",
      expected: ["disablesleep 0"],
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
    await writeFile(join(stub, "batt"), testCase.batt ?? AC);
    await writeFile(join(stub, "therm"), testCase.therm ?? COOL);
    await writeFile(join(stub, "ps.out"), testCase.ps ?? appLine);
    await writeFile(join(stub, "disabled"), testCase.disabled ?? "No");
    await writeFile(join(stub, "changes"), "");
    await run("/bin/sh", [servicePath], { timeout: 10_000 });
    const changes = (await readFile(join(stub, "changes"), "utf8")).split("\n").filter(Boolean);
    equal(`service: ${testCase.name}`, changes, testCase.expected);
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
const routines = new LidAwakeRoutines({
  routineWake: { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") },
  holds: () => holding,
  log: () => undefined,
  checkMs: 50,
});
routines.suspend();
check("dark wake: routines run again when the Mac did not sleep", await waitFor(() => calls.length === 2));
equal("dark wake: hold first, then run", calls, ["suspend", "resume"]);
holding = false;
routines.holdMayEnd();
equal("the end of the hold in dark wake holds the routines again", calls, ["suspend", "resume", "suspend"]);
routines.holdMayEnd();
equal("a second end changes nothing", calls.length, 3);
routines.resume();
routines.suspend();
check("with no hold, a suspend keeps the routines held", !(await waitFor(() => calls.length > 5, 300)));
equal("with no hold: resume, then suspend only", calls.slice(3), ["resume", "suspend"]);
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
