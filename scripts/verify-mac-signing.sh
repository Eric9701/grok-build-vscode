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
echo "▸ 0. Quarantine — informational, and narrower than it looks"
# This was a hard gate, on the reasoning that without the flag an unsigned app
# would sail through. That reasoning was wrong twice over:
#
#   • `spctl --assess` evaluates unconditionally. Quarantine drives the
#     LaunchServices path at launch time, not an explicit assessment — so an
#     unsigned bundle is rejected below whether the flag is present or not.
#     codesign and stapler are quarantine-independent by construction too.
#   • The flag does not reach the object under test anyway. It propagates when
#     the app is COPIED out (dragged to /Applications), not when the dmg is
#     mounted, so steps 2-5 always assess an app that never carried it.
#
# It only decides the manual test at the end: whether a real double-click shows
# a Gatekeeper dialog. Reported here so that test can be trusted, never gated —
# a check whose remedy is "set the thing being checked" checks nothing.
if xattr -p com.apple.quarantine "$DMG" >/dev/null 2>&1; then
  ok "dmg is quarantined — dragging the app out will carry the flag with it"
else
  note "· dmg has no quarantine flag (a CLI download; browsers set it)."
  note "  Every check below is unaffected. It matters only for the manual"
  note "  double-click at the end, which needs the flag to mean anything:"
  note "  xattr -w com.apple.quarantine \"0081;00000000;Safari;\" \"$DMG\""
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
  echo "    • drag it from THIS mounted dmg to /Applications, then open it."
  echo "      Expect no dialog of any kind. The drag is what copies quarantine"
  echo "      onto the app, so a dmg without the flag (see step 0) makes this"
  echo "      test vacuous — it would open cleanly even if unsigned."
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
