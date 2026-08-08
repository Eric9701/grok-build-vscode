# Install the Grok VS Code extension on Windows.
# Usage:  pwsh scripts\install.ps1 [-VsixPath path\to.vsix] [-Cli name-or-path] [-All] [-Prod]
#   -Cli  - a code-compatible CLI to install into (e.g. code-insiders, cursor,
#           antigravity, C:\path\to\code.cmd); also settable via $env:CODE_CLI.
#           Default: auto-detect code -> code-insiders -> cursor -> antigravity-ide -> antigravity.
#   -All  - install into EVERY detected known CLI in one run (build once, install N times).
#   -Prod - build against the PRODUCTION relay instead of the staging one.
#
# Always builds a FRESH .vsix from the current source (npm run package clears the
# stale one first) unless an explicit -VsixPath is given - so an install never
# silently ships a leftover build. Uses --force so a same-version reinstall overwrites.
#
# RELAY: this script exists only to put a build on THIS machine for testing, so
# it builds against the STAGING relay by default. A published extension always
# runs in production mode, which is why the GROK_RELAY_URL override that serves
# the desktop app cannot help here - the constant in src\remote-frames.ts has to
# be swapped for the build and swapped back afterwards.
#
# The swap-back is in a finally block, and the script verifies the file is byte
# identical afterwards. Forgetting to restore it by hand is how a staging URL
# reached the PUBLIC repo once already; that is the whole reason this is
# automated rather than written down. The staging URL itself is NOT in this
# file - it comes from the gitignored .env, because this repository is public.

param(
    [string]$VsixPath,
    [string]$Cli,
    [switch]$All,
    [switch]$Prod
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$knownClis = @("code", "code-insiders", "cursor", "antigravity-ide", "antigravity")
if (-not $Cli -and $env:CODE_CLI) { $Cli = $env:CODE_CLI }
if ($All -and $Cli) { throw "-All and -Cli are mutually exclusive." }

$framesPath = Join-Path $repoRoot "src\remote-frames.ts"
$prodRelayLine = 'export const REMOTE_RELAY_URL = "wss://afkpilot.com";'

function Get-DevRelayUrl {
    $envFile = Join-Path $repoRoot ".env"
    if (-not (Test-Path $envFile)) { return $null }
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*GROK_RELAY_URL\s*=' } | Select-Object -First 1
    if (-not $line) { return $null }
    $value = ($line -replace '^\s*GROK_RELAY_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
    if ($value -notmatch '^wss?://[^/\s?#]+$') { return $null }
    return $value
}

function Read-TextFile([string]$path) { return [System.IO.File]::ReadAllText($path) }
function Write-TextFile([string]$path, [string]$text) {
    # UTF-8 with NO BOM, so a swap-and-restore leaves the file byte identical.
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

$originalFrames = $null
$relayLabel = "production"

if (-not $VsixPath) {
    if (-not $Prod) {
        $devUrl = Get-DevRelayUrl
        if (-not $devUrl) {
            throw @"
No usable staging relay found for a test build.
Add a line to the gitignored .env at the repo root:
    GROK_RELAY_URL=wss://your-staging-relay.example
Or build against production explicitly: pwsh scripts\install.ps1 -Prod
"@
        }
        $originalFrames = Read-TextFile $framesPath
        if ($originalFrames -notmatch [regex]::Escape($prodRelayLine)) {
            throw "src\remote-frames.ts does not contain the expected production relay line - refusing to swap. Restore it first."
        }
        $swapped = $originalFrames.Replace(
            $prodRelayLine,
            "export const REMOTE_RELAY_URL = `"$devUrl`";")
        Write-TextFile $framesPath $swapped
        $relayLabel = $devUrl
    }

    Write-Host ""
    Write-Host "  Relay for this build: $relayLabel" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Building a fresh .vsix from current source..."
    Push-Location $repoRoot
    try {
        if (-not (Test-Path "node_modules")) { npm install }
        npm run package   # clears stale grok-vscode-phuryn-*.vsix first, then builds
        $vsix = Get-ChildItem -Path $repoRoot -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    } finally {
        Pop-Location
        if ($originalFrames) {
            # Restore even when the build threw. Then PROVE it, rather than
            # trusting that the write happened - a staging URL left behind here
            # is the exact leak this automation exists to prevent.
            Write-TextFile $framesPath $originalFrames
            if ((Read-TextFile $framesPath) -ne $originalFrames) {
                Write-Host ""
                Write-Host "  !! src\remote-frames.ts was NOT restored. Fix it before committing." -ForegroundColor Red
                Write-Host ""
            }
        }
    }
    if (-not $vsix) { throw "Build did not produce a .vsix." }
    $VsixPath = $vsix.FullName
}

function Find-KnownClis {
    $found = @()
    foreach ($name in $knownClis) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { $found += $cmd.Source }
    }
    return $found
}

function Find-CodeCli {
    if ($Cli) {
        $cmd = Get-Command $Cli -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        if (Test-Path $Cli) { return $Cli }
        throw "Requested CLI not found: $Cli"
    }
    foreach ($name in $knownClis) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    foreach ($fallback in @(
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
        "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
    )) {
        if (Test-Path $fallback) { return $fallback }
    }
    throw "Could not find a code-compatible CLI. Install VS Code, or pass one: pwsh scripts\install.ps1 -Cli <name-or-path>"
}

if ($All) {
    $targets = Find-KnownClis
    if (-not $targets) { throw "No known code-compatible CLI detected ($($knownClis -join ', '))." }
} else {
    $targets = @(Find-CodeCli)
}

# The editor CLIs print a Node deprecation warning to stderr. Under
# $ErrorActionPreference = "Stop" that becomes a TERMINATING error, so -All used
# to install into the first editor and stop - leaving the others silently on the
# previous version while the run looked like it had failed outright. Exit codes
# are the truth here, not stderr.
$installed = @()
$failed = @()
foreach ($code in $targets) {
    Write-Host "Installing $VsixPath via $code"
    $ErrorActionPreference = "Continue"
    & $code --install-extension $VsixPath --force 2>&1 | ForEach-Object { Write-Host "  $_" }
    $exit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($exit -eq 0) { $installed += $code } else { $failed += "$code (exit $exit)" }
}

Write-Host ""
Write-Host "  Relay: $relayLabel" -ForegroundColor Cyan
Write-Host "  Installed into: $($installed -join ', ')" -ForegroundColor Green
if ($failed) { Write-Host "  FAILED: $($failed -join ', ')" -ForegroundColor Red }
Write-Host ""
Write-Host "Reload the IDE window (Ctrl+Shift+P -> 'Developer: Reload Window') and click the Grok icon."

if (-not $Cli -and -not $All) {
    $chosen = [System.IO.Path]::GetFileNameWithoutExtension($targets[0])
    $others = $knownClis | Where-Object { $_ -ne $chosen -and (Get-Command $_ -ErrorAction SilentlyContinue) }
    if ($others) {
        Write-Host "Also detected: $($others -join ', ') - to install there instead: pwsh scripts\install.ps1 -Cli <name> (or -All for every detected IDE)"
    }
}
