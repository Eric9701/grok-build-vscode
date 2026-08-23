#!/usr/bin/env bash
# Install the Grok VS Code extension on macOS / Linux / WSL.
# Usage:  ./scripts/install.sh [path/to/file.vsix] [cli] [--all]
#   [cli] — a code-compatible CLI name or path to install into (e.g. code-insiders,
#           cursor, antigravity-ide, /path/to/code); also settable via CODE_CLI=…
#           Default: auto-detect code → code-insiders → cursor → antigravity-ide → antigravity.
#   --all — install into EVERY detected known CLI in one run (build once, install N times).
# Picks the first .vsix in the repo root, or builds one if none exists.
# Args are classified by shape, so order doesn't matter: *.vsix → package, --all → all, else → cli.

set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

known_clis="code code-insiders cursor antigravity-ide antigravity"

vsix=""
cli_override="${CODE_CLI:-}"
all_mode=""
for arg in "$@"; do
    case "$arg" in
        *.vsix) vsix="$arg" ;;
        --all) all_mode=1 ;;
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

if [ -z "$vsix" ]; then
    # Always rebuild so the installed extension is never stale
    cd "$repo_root"
    [ -d node_modules ] || npm install
    npm run package
    vsix=$(ls -t "$repo_root"/*.vsix | head -n1)
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
