#!/usr/bin/env bash
#
# Verify a Grok Build Desktop .dmg is signed, hardened and notarised — the way a
# user's Mac will judge it, not the way the build machine does.
#
#   ./scripts/verify-mac-signing.sh ~/Downloads/Grok-Build-Desktop-3.2.6-mac-arm64.dmg
#
# Exists because "the workflow was green" and "it opens on someone else's Mac"
# are different claims, and 3.2.2 shipped believing they were the same one.
set -uo pipefail

DMG="${1:-}"
[ -n "$DMG" ] || { echo "usage: $0 <path-to-.dmg>" >&2; exit 2; }
[ -f "$DMG" ] || { echo "no such file: $DMG" >&2; exit 2; }

fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
note(){ printf '      %s\n' "$1"; }

echo
echo "▸ 0. Quarantine — without this the rest proves nothing"
# Gatekeeper only engages on files the browser marked. A curl/gh download has no
# flag, so an unsigned app would sail through and the test would "pass".
if xattr -p com.apple.quarantine "$DMG" >/dev/null 2>&1; then
  ok "dmg carries com.apple.quarantine — Gatekeeper will treat it as a download"
else
  bad "dmg has NO quarantine flag — this test cannot fail, so it means nothing"
  note "This is a CLI download. Reproduce what a browser does, then re-run:"
  note "xattr -w com.apple.quarantine \"0081;00000000;Safari;\" \"$DMG\""
  echo
  exit 1
fi

echo
echo "▸ 1. Mounting"
VOL=$(hdiutil attach -nobrowse -readonly "$DMG" 2>/dev/null | grep -oE '/Volumes/.*$' | tail -1)
if [ -z "${VOL:-}" ]; then bad "could not mount $DMG"; exit 1; fi
trap 'hdiutil detach "$VOL" -quiet 2>/dev/null || true' EXIT
ok "mounted at $VOL"

APP=$(find "$VOL" -maxdepth 1 -name "*.app" -print -quit)
if [ -z "${APP:-}" ]; then bad "no .app inside the dmg"; exit 1; fi
ok "found $(basename "$APP")"

echo
echo "▸ 2. Signature identity and hardened runtime"
DESC=$(codesign -dv --verbose=4 "$APP" 2>&1)
AUTH=$(printf '%s' "$DESC" | grep -m1 '^Authority=' || true)
case "$AUTH" in
  *"Developer ID Application"*) ok "${AUTH#Authority=}" ;;
  "")                           bad "unsigned — no Authority at all" ;;
  *)                            bad "not a Developer ID signature: ${AUTH#Authority=}" ;;
esac
if printf '%s' "$DESC" | grep -q 'flags=.*runtime'; then
  ok "hardened runtime enabled"
else
  bad "hardened runtime NOT enabled — Apple will not notarise this"
fi
if printf '%s' "$DESC" | grep -q '^TeamIdentifier=L6TFKRX6QQ'; then
  ok "TeamIdentifier=L6TFKRX6QQ"
else
  bad "unexpected team: $(printf '%s' "$DESC" | grep -m1 '^TeamIdentifier=' || echo none)"
fi

echo
echo "▸ 3. Structural integrity, through every nested helper"
if codesign --verify --deep --strict --verbose=2 "$APP" >/dev/null 2>&1; then
  ok "all nested code verifies"
else
  bad "verification failed — a helper or framework is unsigned or modified"
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/      /' | head -12
fi

echo
echo "▸ 4. Gatekeeper's own verdict — the one that predicts the user's experience"
SPCTL=$(spctl -a -vvv -t install "$APP" 2>&1)
if printf '%s' "$SPCTL" | grep -q 'accepted'; then
  SRC=$(printf '%s' "$SPCTL" | grep -m1 'source=' || true)
  case "$SRC" in
    *"Notarized Developer ID"*) ok "accepted — $SRC" ;;
    *) bad "accepted but $SRC — signed yet NOT notarised; users still get a prompt" ;;
  esac
else
  bad "REJECTED — this is the dialog a user would see"
  printf '%s\n' "$SPCTL" | sed 's/^/      /'
fi

echo
echo "▸ 5. Stapled ticket — so first launch works offline"
if xcrun stapler validate "$APP" >/dev/null 2>&1; then
  ok "notarisation ticket is stapled to the bundle"
else
  bad "no stapled ticket — first launch needs a round trip to Apple, and fails offline"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m▸ PASS\033[0m — this build opens with no Gatekeeper dialog.\n'
  echo
  echo "  Still to check by hand, because no command can:"
  echo "    • drag it to /Applications, open it — expect NO dialog of any kind"
  echo "    • use voice — hardened runtime is the first thing that can silently"
  echo "      break the microphone, and entitlements are how that shows up"
  echo
  exit 0
fi
printf '\033[31m▸ FAIL\033[0m — do not publish this build.\n'
echo
echo "  If notarisation is the failing part, Apple says exactly why:"
echo "    xcrun notarytool history --key <p8> --key-id <id> --issuer <uuid>"
echo "    xcrun notarytool log <submission-id> --key <p8> --key-id <id> --issuer <uuid>"
echo
exit 1
