// The root safety service of the lid-closed mode on battery. Every script here is a constant: the
// renderer and the user give no text that reaches a root shell. See docs/architecture/lid-awake.md.

import { SERVICE_MAX_CLOSED_HOURS } from "./lid-awake-policy";

export const LID_AWAKE_LABEL = "app.buildersbot.lid-awake";
export const LID_AWAKE_TOOL_PATH = "/Library/PrivilegedHelperTools/app.buildersbot.lid-awake.sh";
export const LID_AWAKE_PLIST_PATH = "/Library/LaunchDaemons/app.buildersbot.lid-awake.plist";
export const LID_AWAKE_BASE = "/Library/Application Support/BuildersBot/LidAwake";
/** Owned by the user who installed the service. The app keeps its grant file here. */
export const LID_AWAKE_GRANT_DIR = `${LID_AWAKE_BASE}/grant`;
/** Owned by root. The service touches it at each check. */
export const LID_AWAKE_ALIVE_PATH = `${LID_AWAKE_BASE}/alive`;
/** The service looks for a process with this path. A development run cannot use the `battery` mode. */
export const LID_AWAKE_APP_EXECUTABLE = "/Applications/Builders Bot.app/Contents/MacOS/Builders Bot";
export const OSASCRIPT_PATH = "/usr/bin/osascript";

/**
 * The service, run by launchd as root. It reads the owner and the change time of the grant file,
 * never its content, so a file that the user controls cannot give it text to parse. Each check
 * fails closed: a missing or unexpected value turns `disablesleep` off.
 *
 * Any process of the user can renew the grant and take the name of the app, so the service does
 * not trust the app: its own limits (battery, heat, time) are the safety rules.
 */
export const LID_AWAKE_TOOL_SCRIPT = `#!/bin/sh
# Builders Bot lid-awake safety service, version 2.
#
# launchd runs this script as root (${LID_AWAKE_LABEL}). It turns "pmset disablesleep" on only
# while all of these are true, and off in all other cases:
# - a grant file in the grant folder is owned by the user who installed the service, and it changed
#   in the last 90 seconds (Builders Bot renews it each 30 seconds);
# - a process of that user has the path of Builders Bot in /Applications. Any process can take this
#   name, so this is not a proof of the app. The limits below are the safety rules;
# - the computer charges on its power adapter, or the battery is at or above the floor in the name
#   of the grant file, and never below 20 percent;
# - the thermal pressure of macOS is nominal or moderate, and macOS reports no thermal warning;
# - on battery, the lid is closed for less than ${SERVICE_MAX_CLOSED_HOURS} hours.
# It reads only the owner and the change time of the grant file, never its content.
# With sleep off, macOS refuses the lid sleep, and it does not ask again when sleep comes back on.
# So when the service turns sleep on with the lid closed and no external display, it asks macOS to
# sleep now. At start and when it stops, it turns "disablesleep" off, because pmset keeps the
# setting after a restart. It touches "alive" at each check. When Builders Bot is not in
# /Applications for 2 minutes, the service removes itself.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL
LABEL=${LID_AWAKE_LABEL}
TOOL='${LID_AWAKE_TOOL_PATH}'
PLIST='${LID_AWAKE_PLIST_PATH}'
PARENT='/Library/Application Support/BuildersBot'
BASE='${LID_AWAKE_BASE}'
APP='${LID_AWAKE_APP_EXECUTABLE}'
MIN_FLOOR=20
MAX_AGE=90
MAX_CLOSED_ON_BATTERY=${SERVICE_MAX_CLOSED_HOURS * 3600}
GONE_TICKS=8
TICK=15
SETTLE=1

allow_sleep() {
  /usr/bin/pmset -a disablesleep 0 >/dev/null 2>&1
}

block_sleep() {
  /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1
}

read_domain() {
  DOMAIN=$(/usr/sbin/ioreg -r -c IOPMrootDomain -d 1 2>/dev/null)
}

# True when the last read of IOPMrootDomain shows the key $1 as Yes.
domain_yes() {
  printf '%s\\n' "$DOMAIN" | /usr/bin/grep -q "\\"$1\\" = Yes"
}

# Turns sleep on. Then, with the lid closed and no external display, it asks macOS to sleep, after
# macOS shows that sleep is on. When sleep stays off, the next check tries again.
release() {
  allow_sleep
  tries=0
  read_domain
  while domain_yes SleepDisabled && [ "$tries" -lt 10 ]; do
    tries=$((tries + 1))
    /bin/sleep "$SETTLE"
    read_domain
  done
  domain_yes SleepDisabled && return 0
  domain_yes AppleClamshellState && domain_yes AppleClamshellCausesSleep || return 0
  /bin/sleep "$SETTLE"
  /usr/bin/pmset sleepnow >/dev/null 2>&1
}

# Builders Bot is gone, so the service has no use: it turns sleep on, removes its files and stops.
remove_self() {
  allow_sleep
  /bin/rm -f "$PLIST" "$TOOL" "$BASE/owner" "$BASE/alive" "$BASE/closed-since"
  for name in active-20 active-30 active-50; do /bin/rm -f "$BASE/grant/$name"; done
  /bin/rmdir "$BASE/grant" "$BASE" "$PARENT" >/dev/null 2>&1
  /bin/launchctl bootout "system/$LABEL" >/dev/null 2>&1
  exit 0
}

owner_uid() {
  value=$(/usr/bin/head -c 12 "$BASE/owner" 2>/dev/null | /usr/bin/tr -d '\\n')
  case "$value" in ''|*[!0-9]*) return 1;; esac
  printf '%s' "$value"
}

# Prints the highest floor of a fresh grant of the owner.
grant_floor() {
  now=$(/bin/date +%s)
  for floor in 50 30 20; do
    file="$BASE/grant/active-$floor"
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    meta=$(/usr/bin/stat -f '%u %m' "$file" 2>/dev/null) || continue
    set -f
    set -- $meta
    set +f
    [ "$#" -eq 2 ] && [ "$1" = "$OWNER" ] || continue
    case "$2" in ''|*[!0-9]*) continue;; esac
    [ "$2" -le $((now + 5)) ] && [ $((now - $2)) -le "$MAX_AGE" ] || continue
    printf '%s' "$floor"
    return 0
  done
  return 1
}

app_running() {
  /bin/ps -axo uid=,comm= | /usr/bin/sed 's/^ *//' | /usr/bin/grep -Fqx "$OWNER $APP"
}

# True on the power adapter while the battery charges or is full, or with the battery at or above
# the floor $1. "AC Power" alone is not enough: macOS can stop the charge (for heat, or with a weak
# adapter) while the battery discharges. Sets ON_BATTERY.
power_ok() {
  ON_BATTERY=1
  batt=$(/usr/bin/pmset -g batt 2>/dev/null) || return 1
  first=$(printf '%s\\n' "$batt" | /usr/bin/head -n 1)
  line=$(printf '%s\\n' "$batt" | /usr/bin/grep 'InternalBattery' | /usr/bin/head -n 1)
  case "$first" in
    "Now drawing from 'AC Power'") ON_BATTERY=0;;
    "Now drawing from 'Battery Power'") ;;
    *) return 1;;
  esac
  if [ "$ON_BATTERY" = 0 ]; then
    case "$line" in *'%; charging;'*|*'%; charged;'*|*'%; finishing charge;'*) return 0;; esac
  fi
  percent=$(printf '%s\\n' "$line" | /usr/bin/sed -n 's/^.*[[:space:]]\\([0-9][0-9]*\\)%;.*$/\\1/p')
  case "$percent" in ''|*[!0-9]*) return 1;; esac
  [ "\${#percent}" -le 3 ] && [ "$percent" -ge "$1" ]
}

# The thermal pressure of macOS: 0 nominal, 1 moderate, 2 heavy and more. Apple silicon reports
# heat only here. Any other text fails closed. Intel Macs also report a thermal warning level.
cool() {
  pressure=$(/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel 2>/dev/null) || return 1
  case "$pressure" in
    'com.apple.system.thermalpressurelevel 0'|'com.apple.system.thermalpressurelevel 1') ;;
    *) return 1;;
  esac
  therm=$(/usr/bin/pmset -g therm 2>/dev/null) || return 1
  case "$therm" in *Error*) return 1;; esac
  level=$(printf '%s\\n' "$therm" | /usr/bin/sed -n 's/^.*Thermal Warning Level = \\([0-9][0-9]*\\).*$/\\1/p' | /usr/bin/head -n 1)
  [ -z "$level" ] || [ "$level" = 0 ]
}

# The time limit of the service. The lid closed at the time in the root file "closed-since". The
# loop removes the file when the lid is open.
closed_time_ok() {
  domain_yes AppleClamshellState || return 0
  now=$(/bin/date +%s)
  since=$(/usr/bin/head -c 12 "$BASE/closed-since" 2>/dev/null | /usr/bin/tr -d '\\n')
  case "$since" in
    ''|*[!0-9]*) since=$now; printf '%s\\n' "$now" > "$BASE/closed-since";;
  esac
  [ "$ON_BATTERY" = 0 ] || [ $((now - since)) -lt "$MAX_CLOSED_ON_BATTERY" ]
}

want_block() {
  [ -n "$DOMAIN" ] || return 1
  OWNER=$(owner_uid) || return 1
  floor=$(grant_floor) || return 1
  [ "$floor" -ge "$MIN_FLOOR" ] || floor=$MIN_FLOOR
  app_running && power_ok "$floor" && cool && closed_time_ok
}

trap 'allow_sleep; exit 0' TERM INT HUP
allow_sleep
gone=0
while :; do
  /usr/bin/touch "$BASE/alive"
  read_domain
  # A failed read of ioreg is unknown: it turns sleep on, and it keeps the closed time.
  [ -z "$DOMAIN" ] || domain_yes AppleClamshellState || /bin/rm -f "$BASE/closed-since"
  if [ -e "$APP" ]; then gone=0; else gone=$((gone + 1)); fi
  [ "$gone" -lt "$GONE_TICKS" ] || remove_self
  if want_block; then
    domain_yes SleepDisabled || block_sleep
  elif [ -z "$DOMAIN" ] || domain_yes SleepDisabled; then
    release
  fi
  /bin/sleep "$TICK" &
  wait $!
done
`;

export const LID_AWAKE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LID_AWAKE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>${LID_AWAKE_TOOL_PATH}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

const PATHS = `PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL
LABEL=${LID_AWAKE_LABEL}
TOOL=${LID_AWAKE_TOOL_PATH}
PLIST=${LID_AWAKE_PLIST_PATH}
PARENT='/Library/Application Support/BuildersBot'
BASE='${LID_AWAKE_BASE}'`;

/**
 * Runs as root after the administrator password. The user at the console owns the grant folder: that
 * is the user who typed the password for this app. The tool and the property list are written from
 * base64 constants, so no file that the user can change is copied into a root folder.
 */
export const LID_AWAKE_INSTALL_SCRIPT = `set -eu
${PATHS}
umask 022
owner=$(/usr/bin/stat -f %u /dev/console)
case "$owner" in ''|*[!0-9]*) exit 1;; esac
[ "$owner" -ge 501 ] || exit 1
/bin/launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
for dir in /Library/PrivilegedHelperTools "$PARENT" "$BASE"; do
  [ ! -L "$dir" ] || exit 1
  [ -d "$dir" ] || /bin/mkdir -m 755 "$dir"
done
/usr/sbin/chown root:wheel "$PARENT" "$BASE"
/bin/chmod 755 "$PARENT" "$BASE"
[ ! -L "$BASE/grant" ] || exit 1
[ -d "$BASE/grant" ] || /bin/mkdir -m 700 "$BASE/grant"
/usr/sbin/chown "$owner" "$BASE/grant"
/bin/chmod 700 "$BASE/grant"
printf '%s\\n' "$owner" > "$BASE/owner.new"
/bin/chmod 644 "$BASE/owner.new"
/bin/mv -f "$BASE/owner.new" "$BASE/owner"
printf '%s' '${base64(LID_AWAKE_TOOL_SCRIPT)}' | /usr/bin/base64 -D > "$TOOL.new"
/usr/sbin/chown root:wheel "$TOOL.new"
/bin/chmod 755 "$TOOL.new"
/bin/mv -f "$TOOL.new" "$TOOL"
printf '%s' '${base64(LID_AWAKE_PLIST)}' | /usr/bin/base64 -D > "$PLIST.new"
/usr/sbin/chown root:wheel "$PLIST.new"
/bin/chmod 644 "$PLIST.new"
/bin/mv -f "$PLIST.new" "$PLIST"
/bin/launchctl bootstrap system "$PLIST"
`;

/**
 * Runs as root. It stops and removes the service, and turns `disablesleep` off also when the service
 * was never installed, so it is the way back from any state.
 */
export const LID_AWAKE_REMOVE_SCRIPT = `set -u
${PATHS}
/bin/launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
/usr/bin/pmset -a disablesleep 0
/bin/rm -f "$PLIST" "$TOOL" "$BASE/owner" "$BASE/alive" "$BASE/closed-since"
for name in active-20 active-30 active-50; do /bin/rm -f "$BASE/grant/$name"; done
/bin/rmdir "$BASE/grant" "$BASE" "$PARENT" >/dev/null 2>&1 || true
`;

export type LidAwakeAdminScript = "install" | "remove";

const ADMIN_SCRIPTS: Record<LidAwakeAdminScript, string> = {
  install: LID_AWAKE_INSTALL_SCRIPT,
  remove: LID_AWAKE_REMOVE_SCRIPT,
};

/**
 * The `osascript` arguments that make macOS ask for an administrator password and then run one of
 * the constant scripts. The script and the prompt are arguments of the run handler, so AppleScript
 * reads them as text, not as code. The prompt is translated text that the app supplies.
 */
export function adminScriptArgs(script: LidAwakeAdminScript, prompt: string): string[] {
  return [
    "-e",
    "on run argv",
    "-e",
    "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges",
    "-e",
    "end run",
    ADMIN_SCRIPTS[script],
    prompt,
  ];
}

/** `osascript` writes `User canceled. (-128)` when the user closes the password prompt. */
export function isUserCancel(stderr: string): boolean {
  return /\(-128\)/.test(stderr);
}
