#!/bin/zsh
# Signs a local macOS build with the self-signed "Builder Studio Local Signing"
# identity so macOS keeps the Accessibility and Screen Recording grants across
# rebuilds.
#
# Why this exists: `bun run package` passes `--config.mac.identity=null`, so
# electron-builder leaves the app ad-hoc signed. An ad-hoc signature has no
# stable designated requirement — TCC records the cdhash, every rebuild changes
# it, and the user has to grant Computer Use again (the toggle stays on and the
# app stops appearing in the panes). A certificate gives the app the requirement
# `identifier "app.buildersbot.desktop" and certificate leaf = H"…"`, which a
# rebuild signed with the same certificate still satisfies.
#
# The Computer Use driver (`Contents/Resources/cua-driver`) keeps its own
# Developer ID signature from Cua AI: re-signing it would drop the
# `com.apple.security.automation.apple-events` entitlement it needs.
#
# Usage:
#   ./scripts/sign-local-macos.sh [path/to/Builders Bot.app]
#   ./scripts/sign-local-macos.sh --install   # also install into /Applications
#
# With no argument the app is taken from dist/mac-arm64 or dist/mac.
set -euo pipefail

cd "$(dirname "$0")/.."

IDENTITY="Builder Studio Local Signing"
ENTITLEMENTS="build/entitlements.mac.local.plist"
INHERIT_ENTITLEMENTS="build/entitlements.mac.inherit.local.plist"
INSTALL=0
APP=""

for argument in "$@"; do
  case "$argument" in
    --install) INSTALL=1 ;;
    -*) print -u2 "Unknown option: $argument"; exit 2 ;;
    *) APP="$argument" ;;
  esac
done

if [[ -z "$APP" ]]; then
  for candidate in "dist/mac-arm64/Builders Bot.app" "dist/mac/Builders Bot.app"; do
    [[ -d "$candidate" ]] && APP="$candidate" && break
  done
fi

if [[ -z "$APP" || ! -d "$APP" ]]; then
  print -u2 "No app bundle found. Run 'bun run package' first or pass a path."
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  print -u2 "The identity \"$IDENTITY\" is not in the login keychain."
  exit 1
fi

sign() {
  codesign --force --sign "$IDENTITY" "$@"
}

print "Signing $APP"
print "  nested code"
# Deepest first: every Mach-O inside Frameworks, then the bundles that hold them.
while IFS= read -r -d '' binary; do
  sign --entitlements "$INHERIT_ENTITLEMENTS" "$binary" 2>/dev/null || true
done < <(find "$APP/Contents/Frameworks" -type f -perm -u+x -print0)

for bundle in "$APP"/Contents/Frameworks/*.framework "$APP"/Contents/Frameworks/*.app; do
  [[ -e "$bundle" ]] || continue
  sign --entitlements "$INHERIT_ENTITLEMENTS" "$bundle"
done

print "  main executable"
sign --entitlements "$ENTITLEMENTS" "$APP/Contents/MacOS/Builders Bot"

# The Chrome host for this certificate (channel `local`, docs/architecture/browser.md). The app and the
# host check each other against it: the host takes only an app with this designated requirement, and
# the app takes only a host named `app.buildersbot.chrome-host-local` with the same certificate, started
# by Google Chrome. The host is built here, not by electron-builder, because the requirement names the
# certificate. A build with no `chrome-peer` addon (from `bun run prepare:chrome-bridge`) gets no host,
# and the app keeps "Let agents use my Chrome" off.
PEER="$APP/Contents/Resources/chrome-peer/chrome-peer.node"
if [[ -f "$PEER" ]]; then
  print "  Chrome host and chrome-peer addon"
  sign "$PEER"
  DESIGNATED="$(codesign -d -r- "$APP/Contents/MacOS/Builders Bot" 2>&1 | sed -n 's/^designated => //p')"
  CERTIFICATE="$(print -r -- "$DESIGNATED" | sed -nE 's/^identifier "app\.buildersbot\.desktop" and certificate leaf = H"([0-9a-f]{40})"$/\1/p')"
  if [[ -z "$CERTIFICATE" ]]; then
    print -u2 "The app's designated requirement does not name one certificate: $DESIGNATED"
    exit 1
  fi
  case "$(lipo -archs "$APP/Contents/MacOS/Builders Bot")" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) print -u2 "The Chrome host is built for one architecture: arm64 or x86_64."; exit 1 ;;
  esac
  HOST_BUILD=".buildersbot-build/chrome-host/local/$ARCH"
  bun scripts/build-chrome-host.ts --channel local --arch "$ARCH" --out "$HOST_BUILD" \
    --app-requirement "$DESIGNATED" --sign-identity "$IDENTITY" >/dev/null
  HOST_FOLDER="$APP/Contents/Resources/chrome-host/darwin/$ARCH"
  mkdir -p "$HOST_FOLDER"
  cp "$HOST_BUILD/buildersbot-chrome-host" "$HOST_FOLDER/buildersbot-chrome-host"
  codesign --verify --strict \
    -R="identifier \"app.buildersbot.chrome-host-local\" and certificate leaf = H\"$CERTIFICATE\"" \
    "$HOST_FOLDER/buildersbot-chrome-host"
else
  print "  no chrome-peer addon: the app gets no Chrome host"
fi

print "  bundle"
sign --entitlements "$ENTITLEMENTS" "$APP"

codesign --verify --strict "$APP"
print "Signed. Designated requirement:"
codesign -d --requirements - "$APP" 2>&1 | sed 's/^/  /'

# Moves one item to the user's Trash, where it stays until the user empties it. The macOS `trash`
# tool (macOS 15 and later) keeps "Put Back". On an older macOS the item is renamed into ~/.Trash.
# BUILDERS_BOT_TRASH_COMMAND replaces the tool, for the install smoke test only.
move_to_trash() {
  local item="$1"
  local tool="${BUILDERS_BOT_TRASH_COMMAND:-/usr/bin/trash}"
  if [[ -x "$tool" ]]; then
    "$tool" "$item"
  else
    mkdir -p "$HOME/.Trash"
    mv "$item" "$HOME/.Trash/${item:t:r} $(date +%Y%m%d-%H%M%S).${item:e}"
  fi
  [[ ! -e "$item" ]] || { print -u2 "Could not move $item to the Trash."; exit 1; }
}

if (( INSTALL )); then
  # BUILDERS_BOT_INSTALL_ROOT replaces /Applications, for the install smoke test only.
  TARGET="${BUILDERS_BOT_INSTALL_ROOT:-/Applications}/$(basename "$APP")"
  if [[ "$TARGET" != *.app ]]; then
    print -u2 "The install target $TARGET is not an app bundle."
    exit 1
  fi
  if [[ "$APP" != "$TARGET" ]]; then
    osascript -e 'tell application "Builders Bot" to quit' >/dev/null 2>&1 || true
    sleep "${BUILDERS_BOT_QUIT_WAIT_SECONDS:-3}"
    # The previous copy goes to the Trash, not to a backup beside the new one: a backup in
    # /Applications was a second full app (about 1 GB) after each install, and no step removed it.
    # This step touches only the app bundle. The data folder (openbot.db, agents, settings) is
    # outside it and stays as it is.
    if [[ -e "$TARGET" ]]; then
      print "Moving the installed copy to the Trash"
      move_to_trash "$TARGET"
    fi
    # `-c` clones the files on APFS (clonefile), so the installed copy shares its blocks with the
    # build output and uses no new disk space while dist/ exists. On a volume without clones, cp
    # makes a usual copy.
    cp -c -a "$APP" "$TARGET"
    print "Installed to $TARGET"
  fi
  # Earlier versions of this script left dated backups. They are listed, never removed here.
  for old_backup in "$TARGET".bak-*(N); do
    print "An older backup is still at $old_backup. Move it to the Trash when you do not need it."
  done
  print "Open the app once, then grant Accessibility and Screen Recording to"
  print "\"Builders Bot\" in System Settings > Privacy & Security. The grant now"
  print "survives later builds signed with the same identity."
fi
