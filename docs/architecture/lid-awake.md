# Keep the Mac on with the lid closed

Settings › General has two separate settings for sleep.

| Setting | What it stops | What it does not stop |
| --- | --- | --- |
| **Keep this computer awake** (`keep-awake.ts`) | Idle sleep. It holds `powerSaveBlocker.start("prevent-app-suspension")`, which is `PreventUserIdleSystemSleep`. | Sleep when the lid closes, sleep from the Apple menu, and sleep at low battery. Apple documents this in `IOPMLib.h`. |
| **With the lid closed** (`lid-awake-service.ts`) | Sleep when the lid closes, as the table below says. | Nothing in the `battery` mode, except the stops of the safety rules. |

macOS decides the lid sleep in `IOPMrootDomain::shouldSleepOnClamshellClosed` (xnu). That function
does not read power assertions. Only an assertion with a private Apple entitlement, an external
display on the power adapter, or `pmset disablesleep 1` changes the decision. The `ioreg` key
`AppleClamshellCausesSleep = Yes` shows the normal state.

## Modes

The mode is off by default. A Mac with no `AppleClamshellState` in `IOPMrootDomain`, such as a Mac
mini, does not show it. Windows, Linux, a server and the local server process do not offer it.

| Mode | How | Needs | Limits |
| --- | --- | --- | --- |
| `off` | Nothing. | | |
| `plugged` | `/usr/bin/caffeinate -i -s -w <app pid>`. `-s` holds `PreventSystemSleep`. | No password. | macOS obeys `PreventSystemSleep` only on the power adapter. When the lid closes, macOS starts to sleep and stops in dark wake: the processor and the network stay on, the display and the GPU stay off. |
| `battery` | The `plugged` assertion, and the root safety service runs `pmset -a disablesleep 1` while the app keeps a grant fresh. | The administrator password, one time, to install the service. | `disablesleep` also stops the sleep at low battery and the sleep for heat. The safety rules below replace those stops. |

`caffeinate -w` ends when the app process ends, also after a crash. powerd also releases the
assertions of a process that ended. So the `plugged` mode cannot stay on after the app.

`PreventSystemSleep` is marked "deprecated" in `IOPMLib.h`, but powerd obeys it on macOS 26. A
macOS update can change this. The test with the lid closed (below) shows the change.

## Safety rules

`decideLidAwake` in `lid-awake-policy.ts` applies the rules in this order. Each rule fails closed.

1. Thermal state `serious` or `critical` (Electron `powerMonitor`): stop.
2. The time limit (1, 4 or 8 hours, or no limit) with the lid closed: stop.
3. `plugged`, or `battery` with no installed service: hold only on the power adapter.
4. `battery` on battery: stop below the floor (20, 30 or 50 percent), and stop when the level is not
   known.

A stop from rule 1, 2 or 4 while the mode was active shows a desktop notification. The app reads
`pmset -g batt` and `ioreg` each 30 seconds while the mode is on, and at each power or thermal event.

## Root safety service

The `battery` mode needs root, because only root can set `disablesleep`. The app has an ad hoc
signature (no Team ID), so `SMAppService` cannot register a daemon. The app installs one with
`osascript ... with administrator privileges`, and macOS asks for the password.

| Path | Owner | Content |
| --- | --- | --- |
| `/Library/LaunchDaemons/app.buildersbot.lid-awake.plist` | root | `RunAtLoad`, `KeepAlive`. |
| `/Library/PrivilegedHelperTools/app.buildersbot.lid-awake.sh` | root | The service script. |
| `/Library/Application Support/BuildersBot/LidAwake/owner` | root | The uid of the user at the console during the install. |
| `/Library/Application Support/BuildersBot/LidAwake/grant/` | that user, `0700` | The grant files. |

The scripts are constants in `lid-awake-helper.ts`. The install script writes the service script and
the property list from base64 constants, so no file that a user can change goes into a root folder.
The renderer can start only the fixed install and remove actions; it gives no text to a root shell.
The password prompt text is an argument of the AppleScript `run` handler, so AppleScript reads it as
text.

The service script runs a check each 15 seconds. It turns `disablesleep` on only when all of these
are true, and off in all other cases:

- A file `grant/active-<floor>` is owned by the uid in `owner`, and its change time is less than 90
  seconds old. The app renews it each 30 seconds while the `battery` mode is active. The service
  reads only the owner and the change time, never the content.
- `/Applications/Builders Bot.app/Contents/MacOS/Builders Bot` runs as that uid.
- The Mac is on the power adapter, or the battery is at or above the floor in the file name. The
  service never accepts a floor below 20.
- `pmset -g therm` shows no thermal warning.

At its start the service turns `disablesleep` off, because `pmset` writes the setting to disk and
keeps it after a restart. On `SIGTERM` it turns it off too. So after a crash of the app or a quit,
normal sleep comes back in 90 to 105 seconds. After a restart, it comes back when launchd starts the
service.

**Restore normal sleep** in Settings runs the remove script. It works also when the service is not
installed: it stops the service, runs `pmset -a disablesleep 0`, and removes the files. Settings
shows a red warning with this button when `ioreg` shows `SleepDisabled = Yes` and the app has no
fresh grant.

Any process of the same user can renew the grant while the app runs. The effect stays inside the
rules of the service: the Mac stays on, within the battery floor and the thermal check.

## Routines in dark wake

When the lid closes, macOS tells apps that the system "will sleep" at the change from full wake to
dark wake (`IOPMrootDomain.cpp`, "Legacy apps were already told in the full->dark transition").
Chromium sends this as the `suspend` event. `LidAwakeRoutines` (`lid-awake-routines.ts`) holds the
routines on `suspend`, as for every sleep. While `LidAwakeService.holdsThroughLidClose` is true, it
starts the routines again 30 seconds later (they wait for the network first, as after a wake) only
when all of these are true:

- A chain of 5-second timers came on time, so the app ran all the time.
- `sysctl -n kern.sleeptime` shows no sleep after `suspend`. The kernel writes this time each time
  the Mac goes to sleep (`IOPMrootDomain::powerChangeDone`, `SLEEP_STATE`).
- A new read of the computer (`LidAwakeService.refresh`) shows that the mode keeps the Mac on.

Node timers and `process.hrtime` count the time in sleep: on macOS, libuv reads
`mach_continuous_time`. So a timer can come in a short maintenance wake after a real sleep, and a
clock difference cannot show the sleep. The first two checks find that case. At a real wake,
`resume` starts the routines as before. The local server process does not do this: its routines
stay held until the lid opens.

When the hold ends while the lid stays closed, for example because the power adapter is removed in
the `plugged` mode, macOS goes from dark wake to sleep and sends no new `suspend` event.
`LidAwakeRoutines.holdMayEnd` holds the routines again at `on-battery` and at each status change
that ends the hold; when the hold continues (the `battery` mode), the 30-second check starts them
again. macOS can sleep before the app reads the change, so a routine that is due in that moment can
still wait for the next wake. This is not verified on a device.

The display, the GPU and window capture are off in dark wake. Work that needs a window or the
screen, such as screen sharing, can stop with the lid closed. This is not verified.

## Test with the lid closed

**Test with the lid closed** in Settings records the wall clock, `kern.sleeptime` and the lid state
each 5 seconds, for up to 10 minutes. The time between two records counts as sleep when the kernel
recorded a sleep after the first record, or when the gap is longer than 15 seconds (the app did not
run). The result is "stayed on" only when the lid was closed for 2 minutes or more and no time
counts as sleep. A short maintenance wake can record one sample with the lid closed, so a sample
alone is not a pass. The last result is in `userData/lid-awake-test.json`, and `logs/main/main.log`
has one line for it.

To check by hand: `pmset -g log | grep -E "Clamshell|DarkWake|Wake from" | tail`.

## Checks

`bun scripts/lid-awake-smoke.ts` checks the decisions, the parsers, the command arguments and the
service script with stub commands. On the power adapter it also starts the `plugged` assertion for
a test process, reads `pmset -g assertions`, ends the process and checks that the assertion is gone.
It never runs `pmset` with `-a` and never makes the Mac sleep. It writes
`.openbot-build/lid-awake-smoke.json`.
