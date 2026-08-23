#!/usr/bin/env bash
# Install the Grok VS Code extension on macOS / Linux / WSL.
# Usage:  ./scripts/install.sh [path/to/file.vsix] [cli] [--all] [--prod]
#   [cli]  — a code-compatible CLI name or path to install into (e.g. code-insiders,
#            cursor, antigravity-ide, /path/to/code); also settable via CODE_CLI=…
#            Default: auto-detect code → code-insiders → cursor → antigravity-ide → antigravity.
#   --all  — install into EVERY detected known CLI in one run (build once, install N times).
#   --prod — build against the PRODUCTION relay instead of the staging one.
# Picks the first .vsix in the repo root, or builds one if none exists.
# Args are classified by shape, so order doesn't matter: *.vsix → package, --all → all, else → cli.
#
# RELAY: this script exists only to put a build on THIS machine for testing, so
# it builds against the STAGING relay by default — the twin of install.ps1's
# behaviour. A published extension always runs in production mode, which is why
# the GROK_RELAY_URL override that serves the desktop app cannot help here: the
# constant in src/remote-frames.ts has to be swapped for the build and swapped
# back afterwards.
#
# The swap-back runs from a trap, and the script then proves the staging URL is
# gone from the file. Forgetting to restore it by hand is how a staging URL
# reached the PUBLIC repo once already; that is the whole reason this is
# automated rather than written down. The staging URL itself is NOT in this
# file — it comes from the gitignored .env, because this repository is public.
#
# `npm run package` refuses a non-production REMOTE_RELAY_URL. This script sets
# GROK_ALLOW_STAGING_RELAY_VSIX to the required phrase for that one build only —
# a flag or a leftover `=1` will not pass.

set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

known_clis="code code-insiders cursor antigravity-ide antigravity"

vsix=""
cli_override="${CODE_CLI:-}"
all_mode=""
prod_mode=""
for arg in "$@"; do
    case "$arg" in
        *.vsix) vsix="$arg" ;;
        --all) all_mode=1 ;;
        --prod) prod_mode=1 ;;
        *) cli_override="$arg" ;;
    esac
done
if [ -n "$all_mode" ] && [ -n "$cli_override" ]; then
    echo "--all and an explicit cli are mutually exclusive." >&2
    exit 1
fi

# macOS ships no CLI on PATH unless the user ran "Install 'code' command in
# PATH", so a bare `command -v` finds nothing there. Both the single-target and
# --all paths have to consult the app bundles, or --all silently installs into
# NOTHING: it packaged a vsix, found no targets, exited 1, and the IDEs kept
# running the previous build while the run LOOKED like it had done the work.
mac_cli_paths() {
    cat <<'PATHS'
/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders
/Applications/Cursor.app/Contents/Resources/app/bin/cursor
/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide
PATHS
}

# One line per target. Names resolve on PATH; anything else is a full path, so
# callers must read this line-by-line — an app path contains spaces.
find_known_clis() {
    for name in $known_clis; do
        command -v "$name" >/dev/null 2>&1 && echo "$name"
    done
    mac_cli_paths | while IFS= read -r path; do
        [ -x "$path" ] || continue
        # Skip one already found on PATH, so it is not installed into twice.
        name="${path##*/}"
        command -v "$name" >/dev/null 2>&1 || echo "$path"
    done
}

find_code_cli() {
    if [ -n "$cli_override" ]; then
        if command -v "$cli_override" >/dev/null 2>&1; then
            echo "$cli_override"; return 0
        fi
        echo "Requested CLI not found: $cli_override" >&2
        return 1
    fi
    for name in $known_clis; do
        if command -v "$name" >/dev/null 2>&1; then
            echo "$name"; return 0
        fi
    done
    # macOS install paths
    while IFS= read -r path; do
        [ -x "$path" ] && { echo "$path"; return 0; }
    done <<PATHS
$(mac_cli_paths)
PATHS
    echo "Could not find a code-compatible CLI. Install VS Code, or pass one: ./scripts/install.sh <cli-name-or-path>" >&2
    return 1
}

hint_other_clis() {
    others=""
    for name in $known_clis; do
        [ "$name" = "$1" ] && continue
        command -v "$name" >/dev/null 2>&1 && others="$others $name"
    done
    if [ -n "$others" ]; then
        echo "Also detected:$others — to install there instead: ./scripts/install.sh <cli> (or --all for every detected IDE)"
    fi
}

frames_path="$repo_root/src/remote-frames.ts"
prod_relay_line='export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;'
# Must match scripts/check-production-relay.mjs; test/check-production-relay.test.ts
# fails if either side drifts.
allow_staging_env="GROK_ALLOW_STAGING_RELAY_VSIX"
allow_staging_value="I_UNDERSTAND_THIS_VSIX_MUST_NOT_BE_RELEASED"

# Exact substring edits via node — no sed, because the line carries quotes and
# slashes, and node writes UTF-8 with no BOM so a swap-and-restore leaves the
# file byte identical. node is already a hard requirement here (npm runs below).
file_replace_once() {  # path from to; exit 3 when `from` is absent
    node -e '
        const fs = require("fs");
        const [p, from, to] = process.argv.slice(1);
        const s = fs.readFileSync(p, "utf8");
        if (!s.includes(from)) process.exit(3);
        fs.writeFileSync(p, s.split(from).join(to));
    ' "$1" "$2" "$3"
}
file_contains() {  # path needle
    node -e '
        const fs = require("fs");
        process.exit(fs.readFileSync(process.argv[1], "utf8").includes(process.argv[2]) ? 0 : 1);
    ' "$1" "$2"
}

# Same rule as resolveRelayUrl in src/remote-frames.ts: ws(s), an authority, an
# optional base path (a relay may live behind a prefix), and no query, fragment
# or credentials. These two must agree, or desktop-dev would accept a URL a
# staging .vsix build silently refuses.
dev_relay_url() {
    [ -f "$repo_root/.env" ] || return 1
    line=$(grep -m 1 -E '^[[:space:]]*GROK_RELAY_URL[[:space:]]*=' "$repo_root/.env" || true)
    [ -n "$line" ] || return 1
    value=${line#*=}
    value=$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//' -e 's#/*$##')
    printf '%s' "$value" | grep -qE '^wss?://[^/@[:space:]?#]+(/[^[:space:]?#]*)?$' || return 1
    printf '%s' "$value"
}

swapped_relay_line=""
dev_url=""
relay_label="production"

# The restore runs however the script leaves — success, failure or Ctrl-C — and
# swaps OUR line back into the file AS IT STANDS, never a whole-file snapshot: a
# snapshot would silently discard anything else edited during the build (an
# agent, an open editor) and would still look like it succeeded, because it only
# ever proves it rewrote its own copy.
restore_relay_line() {
    [ -n "$swapped_relay_line" ] || return 0
    if file_contains "$frames_path" "$swapped_relay_line"; then
        file_replace_once "$frames_path" "$swapped_relay_line" "$prod_relay_line" || true
    fi
    # Then prove the staging URL is actually gone, against the FILE rather than
    # against our own copy of it. A leak here is the exact thing this automation
    # exists to prevent.
    if file_contains "$frames_path" "$dev_url"; then
        echo "" >&2
        echo "  !! src/remote-frames.ts still names the staging relay." >&2
        echo "     Restore it before committing: $prod_relay_line" >&2
        echo "" >&2
    fi
    swapped_relay_line=""
}
trap restore_relay_line EXIT INT TERM

if [ -z "$vsix" ]; then
    # Always rebuild so the installed extension is never stale
    cd "$repo_root"
    command -v npm >/dev/null 2>&1 || { echo "npm is not on PATH. Install Node.js, then re-run." >&2; exit 1; }
    [ -d node_modules ] || npm install

    if [ -z "$prod_mode" ] && [ ! -f "$repo_root/.env" ]; then
        # No .env at all: an ordinary contributor following docs/INSTALL.md.
        # Build against production rather than refusing the documented command.
        echo "No .env at the repo root - building against PRODUCTION." >&2
        echo "Maintainers testing against staging: add GROK_RELAY_URL=wss://... to .env" >&2
        prod_mode=1
    fi

    if [ -z "$prod_mode" ]; then
        dev_url=$(dev_relay_url) || {
            cat >&2 <<'NOENV'
.env exists but carries no usable staging relay.
Fix the line, or build against production explicitly:
    GROK_RELAY_URL=wss://your-staging-relay.example
    ./scripts/install.sh --prod
NOENV
            exit 1
        }
        file_contains "$frames_path" "$prod_relay_line" || {
            echo "src/remote-frames.ts does not contain the expected production relay line — refusing to swap. Restore it first." >&2
            exit 1
        }
        dev_relay_line="export const REMOTE_RELAY_URL = \"$dev_url\";"
        file_replace_once "$frames_path" "$prod_relay_line" "$dev_relay_line"
        swapped_relay_line="$dev_relay_line"
        relay_label="$dev_url"
    fi

    echo
    echo "  Relay for this build: $relay_label"
    echo
    echo "Building a fresh .vsix from current source..."
    # Fingerprint the newest existing vsix so a build that produced nothing new
    # cannot be installed under a "fresh build" banner. cksum is POSIX; md5sum
    # and `stat` both differ between macOS and Linux.
    before_fp=""
    if ls "$repo_root"/*.vsix >/dev/null 2>&1; then
        before_fp=$(cksum < "$(ls -t "$repo_root"/*.vsix | head -n1)")
    fi
    if [ -n "$swapped_relay_line" ]; then
        env "$allow_staging_env=$allow_staging_value" npm run package
    else
        npm run package   # clears stale grok-vscode-phuryn-*.vsix first, then builds
    fi
    restore_relay_line   # put the file back before anything else can read it
    vsix=$(ls -t "$repo_root"/*.vsix | head -n1)
    [ -n "$vsix" ] || { echo "Build did not produce a .vsix." >&2; exit 1; }
    if [ -n "$before_fp" ] && [ "$before_fp" = "$(cksum < "$vsix")" ]; then
        echo "npm run package did not produce a new .vsix (refusing to install a leftover build)." >&2
        exit 1
    fi
fi
[ -f "$vsix" ] || { echo "vsix not found: $vsix" >&2; exit 1; }

install_to() {
    echo "Installing $vsix via $1"
    # --force so a same-version reinstall actually overwrites the installed files
    "$1" --install-extension "$vsix" --force
}

if [ -n "$all_mode" ]; then
    targets=$(find_known_clis)   # one per line: a name, or a path containing spaces
    [ -n "$targets" ] || { echo "No known code-compatible CLI detected ($known_clis)." >&2; exit 1; }
    while IFS= read -r code; do
        [ -n "$code" ] && install_to "$code"
    done <<TARGETS
$targets
TARGETS
else
    code=$(find_code_cli)        # may be a full path with spaces — keep quoted
    install_to "$code"
fi
echo
echo "Done. Reload the IDE window (Ctrl+Shift+P -> 'Developer: Reload Window') and click the Grok icon."
if [ -z "$cli_override" ] && [ -z "$all_mode" ]; then
    hint_other_clis "$code"
fi
