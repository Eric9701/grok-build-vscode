import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

const IS_WIN = process.platform === "win32";

function candidateNames(): string[] {
  return IS_WIN ? ["grok.cmd", "grok.exe", "grok.bat", "grok"] : ["grok"];
}

function effectiveHome(): string {
  // Respect env overrides first so tests + users can redirect the home lookup.
  const fromEnv = IS_WIN ? process.env.USERPROFILE : process.env.HOME;
  return fromEnv || homedir();
}

export function locateGrokCli(configuredPath: string): string | undefined {
  if (configuredPath) {
    return existsSync(configuredPath) ? configuredPath : undefined;
  }
  const homeBin = path.join(effectiveHome(), ".grok", "bin");
  for (const name of candidateNames()) {
    const candidate = path.join(homeBin, name);
    if (existsSync(candidate)) return candidate;
  }
  try {
    const cmd = IS_WIN ? "where grok" : "command -v grok";
    const out = execSync(cmd, { encoding: "utf8" }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && existsSync(first)) return first;
  } catch {
    // ignore — not on PATH
  }
  return undefined;
}

/** Whether this activation follows a previously-recorded extension version. */
export function extensionWasUpgraded(lastSeen: string | undefined, current: string): boolean {
  return !!lastSeen && !!current && lastSeen !== current;
}

/**
 * Oldest grok CLI whose ACP behavior this extension supports. Native
 * exit_plan_mode verdicts are part of this contract, so every platform must
 * meet this floor. It is also the Windows-verified reactive recovery target.
 */
export const GROK_REQUIRED_VERSION = "0.2.117";

// Reactive Windows stdio recovery lands on the same fully-supported baseline.
export const GROK_STDIO_DOWNGRADE_TARGET = GROK_REQUIRED_VERSION;

/**
 * Parse a grok `--version` banner ("grok 0.2.64 (9a9ac25b10) [stable]") into a
 * `[major, minor, patch]` tuple, or undefined when no `X.Y.Z` is present. Pure.
 */
export function parseGrokVersion(versionOutput: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput ?? "");
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two `[major, minor, patch]` tuples: <0, 0, or >0. Pure. */
export function compareVersionTuple(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Windows grok 0.2.61-0.2.70 can hang before ACP startup completes. */
export function isStdioBrokenGrokVersion(versionOutput: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const version = parseGrokVersion(versionOutput);
  if (!version) return false;
  const [major, minor, patch] = version;
  return major === 0 && minor === 2 && patch >= 61 && patch <= 70;
}

/** Whether a parseable installed CLI is older than the behavior baseline. */
export function isGrokVersionBelowRequired(versionOutput: string): boolean {
  const installed = parseGrokVersion(versionOutput);
  const required = parseGrokVersion(GROK_REQUIRED_VERSION)!;
  return !!installed && compareVersionTuple(installed, required) < 0;
}

/**
 * Decision for "Update Grok Build CLI" (manual and extension-upgrade updates),
 * given the installed version + platform.
 *
 * The #22 Windows update pause is **lifted** now that 0.2.71 fixes the regression —
 * updates proceed normally on every platform (to `latest`). The behavior floor
 * handles old builds; reactive recovery handles a newer Windows build that
 * actually exhibits the stdio failure.
 */
export interface GrokUpdatePolicy {
  /** May the update run at all? */
  allow: boolean;
  /** When allowed, pin to this exact version instead of `latest` (undefined ⇒ latest). */
  target?: string;
  /** When blocked, the reason to surface in the menu / log. */
  note?: string;
}

export function grokUpdatePolicy(_versionOutput: string, _platform: NodeJS.Platform): GrokUpdatePolicy {
  // Updates are no longer gated for #22 (fixed in 0.2.71). Always allow, to latest.
  return { allow: true };
}

/**
 * Should the host REACTIVELY downgrade the CLI after an *observed* `agent stdio`
 * init failure (handshake timeout / "exited code null")?
 *
 * The proactive bounded-range pin covers known-broken Windows builds before
 * spawning. This is the evidence-driven backstop for a future still-broken build
 * above the Windows-verified target. It fires on the real failure (`initialize` or
 * `session/new`), not a version guess, and restores the supported baseline.
 *
 * Windows-only (the regression is). A build at/below the target is never
 * reactively replaced; that is the loop guard once recovery lands. A later
 * manual upgrade above the target re-arms recovery. Unparseable version means
 * leave it alone. Pure.
 */
export function shouldReactivelyDowngrade(versionOutput: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const v = parseGrokVersion(versionOutput);
  if (!v) return false;
  const target = parseGrokVersion(GROK_STDIO_DOWNGRADE_TARGET)!;
  return compareVersionTuple(v, target) > 0;
}

/**
 * Does a failed `grok update` error mean the binary was still locked? On Windows
 * `grok update` renames `grok.exe` in place, which fails while any grok process
 * (or a backgrounded subagent child) still holds it open — the OS releases the
 * lock a beat after the process is killed, so a too-eager update races it. grok
 * reports this as *"cannot rename locked executable … Access is denied. (os error
 * 5)"*. Used to decide whether a retry is worth it (the lock clears on its own);
 * any other failure is real and shouldn't be retried. Pure.
 */
export function isLockedBinaryError(message: string): boolean {
  return /locked executable|os error 5|access is denied/i.test(message);
}
