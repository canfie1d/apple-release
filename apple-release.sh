#!/bin/bash
# apple-release: archive an Expo app and upload it to App Store Connect (iOS, and Mac Catalyst when the app has it).
# Runs on the Mac. Reads everything it needs from the app's app.json, so a new project is one line in apps.txt.
#
# Usage:
#   apple-release.sh <app-dir> [options]      app-dir is the folder holding app.json (the Expo app)
#   apple-release.sh --all [options]          every app listed in apps.txt
#
# Options:
#   --ios-only | --mac-only   build one platform
#   --no-upload               archive only, do not send to App Store Connect
#   --prebuild                regenerate ios/ with `expo prebuild --clean` first (default: only when ios/ is missing)
#   --no-asc                  skip the TestFlight step after upload
#   --metadata                also push store metadata and attach the build to the App Store version (see appstore/)
#   --dry-run                 print the commands, run nothing
#
# Auth: by default Xcode's signed-in Apple account is used (same as a manual Archive). For unattended runs set
#   ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (an App Store Connect API key .p8) and they are passed to xcodebuild.
#
# After an upload it runs asc.mjs: waits for processing, sets the TestFlight release notes, adds the build to the
# TestFlight groups in <app>/appstore/testflight.json. Credentials are also read from ~/.config/apple-release/env.
#
# Build numbers: the export uses manageAppVersionAndBuildNumber, so App Store Connect assigns the next build number.
# The marketing version comes from app.json "version".

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLATFORMS="ios mac"; UPLOAD=1; PREBUILD=0; DRY=0; ALL=0; APP_DIR=""; ASC_STEP=1; META=0
[ -f "$HOME/.config/apple-release/env" ] && { set -a; . "$HOME/.config/apple-release/env"; set +a; }

while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1 ;;
    --ios-only) PLATFORMS="ios" ;;
    --mac-only) PLATFORMS="mac" ;;
    --no-upload) UPLOAD=0 ;;
    --prebuild) PREBUILD=1 ;;
    --no-asc) ASC_STEP=0 ;;
    --metadata) META=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) APP_DIR="$1" ;;
  esac
  shift
done

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

if [ "$ALL" = 1 ]; then
  rc=0
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | sed 's/^ *//;s/ *$//')"
    [ -z "$line" ] && continue
    dir="${line/#\~/$HOME}"
    echo; echo "######## $dir"
    args=(); [ "$PLATFORMS" = "ios" ] && args+=(--ios-only); [ "$PLATFORMS" = "mac" ] && args+=(--mac-only)
    [ "$UPLOAD" = 0 ] && args+=(--no-upload); [ "$PREBUILD" = 1 ] && args+=(--prebuild); [ "$DRY" = 1 ] && args+=(--dry-run); [ "$ASC_STEP" = 0 ] && args+=(--no-asc); [ "$META" = 1 ] && args+=(--metadata)
    "$0" "$dir" ${args[@]+"${args[@]}"} || { echo "FAILED: $dir" >&2; rc=1; }
  done < "$HERE/apps.txt"
  exit $rc
fi

[ -n "$APP_DIR" ] || { echo "Give an app dir or --all" >&2; exit 2; }
APP_DIR="$(cd "${APP_DIR/#\~/$HOME}" && pwd)"
[ -f "$APP_DIR/app.json" ] || { echo "No app.json in $APP_DIR" >&2; exit 2; }
command -v xcodebuild >/dev/null || { echo "xcodebuild not found. Install Xcode." >&2; exit 2; }
command -v node >/dev/null || { echo "node not found." >&2; exit 2; }

cfg() { node -e 'const c=require(process.argv[1]).expo;const g=(p)=>p.split(".").reduce((o,k)=>o&&o[k],c);const v=g(process.argv[2]);process.stdout.write(v===undefined?"":String(v))' "$APP_DIR/app.json" "$1"; }
NAME="$(cfg name)"; BUNDLE="$(cfg ios.bundleIdentifier)"; TEAM="$(cfg ios.appleTeamId)"; VERSION="$(cfg version)"
HAS_MAC="$(node -e 'const p=require(process.argv[1]).expo.plugins||[];console.log(p.some(x=>String(Array.isArray(x)?x[0]:x).includes("with-mac-catalyst"))?1:0)' "$APP_DIR/app.json")"
[ -n "$BUNDLE" ] && [ -n "$TEAM" ] || { echo "app.json needs ios.bundleIdentifier and ios.appleTeamId" >&2; exit 2; }
[ "$HAS_MAC" = 1 ] || PLATFORMS="${PLATFORMS//mac/}"

cd "$APP_DIR"
echo "== $NAME  $BUNDLE  v$VERSION  team $TEAM  platforms:${PLATFORMS}"

# Generated native project. ios/ is gitignored, so rebuild it when absent or when asked.
if [ "$PREBUILD" = 1 ] || [ ! -d ios ] || ! ls ios/*.xcworkspace >/dev/null 2>&1; then
  [ -d node_modules ] || run npm ci
  run npx expo prebuild --platform ios --clean --no-install
  run bash -c 'cd ios && pod install'
fi
WS="$(ls -d ios/*.xcworkspace 2>/dev/null | head -1 || true)"
[ -n "$WS" ] || { [ "$DRY" = 1 ] && WS="ios/App.xcworkspace" || { echo "No xcworkspace in ios/" >&2; exit 1; }; }
SCHEME="$(basename "$WS" .xcworkspace)"

mkdir -p build
STAMP="$(date +%Y%m%d-%H%M%S)"; START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
AUTH=()
if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ]; then
  AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  echo "Auth: App Store Connect API key $ASC_KEY_ID"
else
  echo "Auth: Xcode's signed-in Apple account"
fi

PLIST="build/export-options.plist"
DEST="upload"; [ "$UPLOAD" = 1 ] || DEST="export"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>$DEST</string>
<key>teamID</key><string>$TEAM</string>
<key>signingStyle</key><string>automatic</string>
<key>testFlightInternalTestingOnly</key><false/>
<key>manageAppVersionAndBuildNumber</key><true/>
<key>uploadSymbols</key><false/>
</dict></plist>
PL

for P in $PLATFORMS; do
  if [ "$P" = ios ]; then DESTINATION="generic/platform=iOS"; LABEL="iOS"
  else DESTINATION="generic/platform=macOS,variant=Mac Catalyst"; LABEL="Mac"; fi
  ARCHIVE="build/$SCHEME-$LABEL.xcarchive"
  echo; echo "-- $LABEL archive"
  run rm -rf "$ARCHIVE"
  if [ "$DRY" = 1 ]; then
    echo "+ xcodebuild -workspace $WS -scheme $SCHEME -configuration Release -destination '$DESTINATION' -archivePath $ARCHIVE -allowProvisioningUpdates archive"
  else
    xcodebuild -workspace "$WS" -scheme "$SCHEME" -configuration Release -destination "$DESTINATION" \
      -archivePath "$ARCHIVE" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} archive > "build/archive-$LABEL-$STAMP.log" 2>&1 \
      || { echo "Archive failed. Errors:"; grep -E "error:|\*\* ARCHIVE FAILED" "build/archive-$LABEL-$STAMP.log" | head -20; exit 1; }
    echo "Archive ok: $ARCHIVE"
  fi
  if [ "$UPLOAD" = 1 ]; then echo "-- $LABEL upload to App Store Connect"; else echo "-- $LABEL export (no upload)"; fi
  if [ "$DRY" = 1 ]; then
    echo "+ xcodebuild -exportArchive -archivePath $ARCHIVE -exportOptionsPlist $PLIST -exportPath build/export-$LABEL -allowProvisioningUpdates"
  else
    xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$PLIST" -exportPath "build/export-$LABEL" \
      -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} > "build/upload-$LABEL-$STAMP.log" 2>&1 \
      || { echo "Export/upload failed. Errors:"; grep -E "error:|EXPORT FAILED" "build/upload-$LABEL-$STAMP.log" | head -20; exit 1; }
    grep -E "Upload succeeded|EXPORT SUCCEEDED" "build/upload-$LABEL-$STAMP.log" || true
  fi
done
echo
# TestFlight groups, release notes, optional store metadata. Needs an App Store Connect API key.
if [ "$UPLOAD" = 1 ] && [ "$ASC_STEP" = 1 ]; then
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ]; then
    PLIST_PLATFORMS=""; for P in $PLATFORMS; do [ "$P" = ios ] && PLIST_PLATFORMS="${PLIST_PLATFORMS}IOS,"; [ "$P" = mac ] && PLIST_PLATFORMS="${PLIST_PLATFORMS}MAC_OS,"; done
    PLIST_PLATFORMS="${PLIST_PLATFORMS%,}"
    DRYARG=(); [ "$DRY" = 1 ] && DRYARG=(--dry-run)
    echo "-- TestFlight"
    node "$HERE/asc.mjs" testflight "$APP_DIR" --since "$START" --platforms "$PLIST_PLATFORMS" ${DRYARG[@]+"${DRYARG[@]}"}
    if [ "$META" = 1 ]; then echo "-- Store metadata"; node "$HERE/asc.mjs" metadata "$APP_DIR" --platforms "$PLIST_PLATFORMS" --attach-build ${DRYARG[@]+"${DRYARG[@]}"}; fi
  else
    echo "-- TestFlight/metadata skipped: set ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (or ~/.config/apple-release/env)"
  fi
fi
# Marks what shipped; the next release's TestFlight notes list commits since this tag.
if [ "$UPLOAD" = 1 ] && [ "$DRY" = 0 ] && git rev-parse --git-dir >/dev/null 2>&1; then
  git tag -a "apple-v$VERSION-$STAMP" -m "$NAME $VERSION uploaded to App Store Connect" 2>/dev/null && echo "Tagged apple-v$VERSION-$STAMP" || true
fi
echo "== $NAME done"
