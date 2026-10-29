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

print "  main executable and bundle"
sign --entitlements "$ENTITLEMENTS" "$APP/Contents/MacOS/Builders Bot"
sign --entitlements "$ENTITLEMENTS" "$APP"

codesign --verify --strict "$APP"
print "Signed. Designated requirement:"
codesign -d --requirements - "$APP" 2>&1 | sed 's/^/  /'

if (( INSTALL )); then
  TARGET="/Applications/$(basename "$APP")"
  if [[ "$APP" != "$TARGET" ]]; then
    osascript -e 'tell application "Builders Bot" to quit' >/dev/null 2>&1 || true
    sleep 3
    if [[ -d "$TARGET" ]]; then
      BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
      print "Backing up the installed copy to $BACKUP"
      rm -rf "$BACKUP"
      cp -a "$TARGET" "$BACKUP"
    fi
    rm -rf "$TARGET"
    cp -a "$APP" "$TARGET"
    print "Installed to $TARGET"
  fi
  print "Open the app once, then grant Accessibility and Screen Recording to"
  print "\"Builders Bot\" in System Settings > Privacy & Security. The grant now"
  print "survives later builds signed with the same identity."
fi
