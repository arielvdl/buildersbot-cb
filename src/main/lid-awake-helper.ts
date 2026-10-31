// The root safety service of the lid-closed mode on battery. Every script here is a constant: the
// renderer and the user give no text that reaches a root shell. See docs/architecture/lid-awake.md.

export const LID_AWAKE_LABEL = "app.buildersbot.lid-awake";
export const LID_AWAKE_TOOL_PATH = "/Library/PrivilegedHelperTools/app.buildersbot.lid-awake.sh";
export const LID_AWAKE_PLIST_PATH = "/Library/LaunchDaemons/app.buildersbot.lid-awake.plist";
export const LID_AWAKE_BASE = "/Library/Application Support/BuildersBot/LidAwake";
/** Owned by the user who installed the service. The app keeps its grant file here. */
export const LID_AWAKE_GRANT_DIR = `${LID_AWAKE_BASE}/grant`;
/** The service keeps sleep off only for this executable. A development run cannot use the `battery` mode. */
export const LID_AWAKE_APP_EXECUTABLE = "/Applications/Builders Bot.app/Contents/MacOS/Builders Bot";
export const OSASCRIPT_PATH = "/usr/bin/osascript";

/**
 * The service, run by launchd as root. It reads the owner and the change time of the grant file,
 * never its content, so a file that the user controls cannot give it text to parse. Each check
 * fails closed: a missing or unexpected value turns `disablesleep` off.
 */
export const LID_AWAKE_TOOL_SCRIPT = `#!/bin/sh
# Builders Bot lid-awake safety service, version 1.
#
# launchd runs this script as root (${LID_AWAKE_LABEL}). It turns "pmset disablesleep" on only
# while all of these are true, and off in all other cases:
# - a grant file in the grant folder is owned by the user who installed the service, and it changed
#   in the last 90 seconds (Builders Bot renews it each 30 seconds);
# - Builders Bot runs from /Applications as that user;
# - the computer is on its power adapter, or the battery is at or above the floor in the name of the
#   grant file, and never below 20 percent;
# - macOS reports no thermal warning.
# It reads only the owner and the change time of the grant file, never its content. At start and
# when it stops, it turns "disablesleep" off, because pmset keeps the setting after a restart.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL
BASE='${LID_AWAKE_BASE}'
APP='${LID_AWAKE_APP_EXECUTABLE}'
MIN_FLOOR=20
MAX_AGE=90
TICK=15

allow_sleep() {
  /usr/bin/pmset -a disablesleep 0 >/dev/null 2>&1
}

block_sleep() {
  /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1
}

sleep_blocked() {
  /usr/sbin/ioreg -r -c IOPMrootDomain -d 1 | /usr/bin/grep -q '"SleepDisabled" = Yes'
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

power_ok() {
  batt=$(/usr/bin/pmset -g batt 2>/dev/null) || return 1
  first=$(printf '%s\\n' "$batt" | /usr/bin/head -n 1)
  [ "$first" = "Now drawing from 'AC Power'" ] && return 0
  percent=$(printf '%s\\n' "$batt" | /usr/bin/sed -n 's/^.*InternalBattery.*[[:space:]]\\([0-9][0-9]*\\)%;.*$/\\1/p' | /usr/bin/head -n 1)
  case "$percent" in ''|*[!0-9]*) return 1;; esac
  [ "\${#percent}" -le 3 ] && [ "$percent" -ge "$1" ]
}

cool() {
  therm=$(/usr/bin/pmset -g therm 2>/dev/null) || return 1
  case "$therm" in *Error*) return 1;; esac
  level=$(printf '%s\\n' "$therm" | /usr/bin/sed -n 's/^.*Thermal Warning Level = \\([0-9][0-9]*\\).*$/\\1/p' | /usr/bin/head -n 1)
  [ -z "$level" ] || [ "$level" = 0 ]
}

want_block() {
  OWNER=$(owner_uid) || return 1
  floor=$(grant_floor) || return 1
  [ "$floor" -ge "$MIN_FLOOR" ] || floor=$MIN_FLOOR
  app_running && power_ok "$floor" && cool
}

trap 'allow_sleep; exit 0' TERM INT HUP
allow_sleep
while :; do
  if want_block; then
    sleep_blocked || block_sleep
  elif sleep_blocked; then
    allow_sleep
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
/bin/rm -f "$PLIST" "$TOOL" "$BASE/owner"
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
