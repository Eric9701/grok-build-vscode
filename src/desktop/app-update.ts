/**
 * Desktop update *notice* helpers — pure, no network, no Electron.
 *
 * Silent auto-update cannot ship: electron-updater uses Squirrel.Mac on macOS,
 * which refuses to replace an unsigned bundle. These builds are unsigned, so
 * the main process only checks GitHub Releases and (when newer) posts an
 * in-app notice; the user downloads and runs the installer themselves.
 */

/** Anchored installer asset suffixes. `.exe.blockmap` must never match. */
export const DESKTOP_INSTALLER_SUFFIXES = [
  "-mac-arm64.dmg",
  "-mac-x64.dmg",
  "-win-x64.exe",
] as const;

export type Semver = { major: number; minor: number; patch: number };

/** Parse `X.Y.Z` (optional leading `v`, optional pre-release suffix after `-`/`+`). */
export function parseSemver(raw: string | null | undefined): Semver | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Take the first three numeric components; drop pre-release/build metadata.
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Numeric compare: negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** True when `a` is strictly newer than `b` (both must parse). */
export function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (!c || !cur) return false;
  return compareSemver(c, cur) > 0;
}

/**
 * True when the asset name is a desktop installer for this product, not a
 * companion file (`.blockmap`) or the vsix / source archive.
 * Anchored end-match so `…-win-x64.exe.blockmap` fails.
 */
export function isDesktopInstallerAsset(name: string | null | undefined): boolean {
  const n = String(name || "");
  if (!n) return false;
  // Refuse anything that has an extra extension after the installer suffix.
  for (const suffix of DESKTOP_INSTALLER_SUFFIXES) {
    if (n.endsWith(suffix)) return true;
  }
  return false;
}

export interface GithubReleaseLike {
  tag_name?: string;
  name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string }[] | null;
}

export interface DesktopReleaseNotice {
  version: string;
  url: string;
}

/**
 * Pick the newest non-draft release that carries at least one desktop
 * installer asset. Ignores unparseable tags. Does not compare to the running
 * version — callers use {@link isNewerVersion}.
 */
export function pickLatestDesktopRelease(
  releases: readonly GithubReleaseLike[] | null | undefined,
): DesktopReleaseNotice | null {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  let best: { version: string; url: string; semver: Semver } | null = null;
  for (const r of releases) {
    if (!r || r.draft) continue;
    // Pre-releases COUNT. Skipping them is the usual default and it was exactly
    // wrong here: the desktop app ships pre-release while it is unsigned, so a
    // stable-only check would never fire for the very users this exists to
    // reach — everyone on the first builds, told about nothing, forever.
    // Drafts stay excluded because their assets 404 for anonymous downloads.
    const assets = Array.isArray(r.assets) ? r.assets : [];
    if (!assets.some((a: { name?: string }) => isDesktopInstallerAsset(a?.name))) continue;
    const tag = r.tag_name || r.name || "";
    const semver = parseSemver(tag);
    if (!semver) continue;
    const version = `${semver.major}.${semver.minor}.${semver.patch}`;
    const url =
      (typeof r.html_url === "string" && r.html_url) ||
      `https://github.com/phuryn/grok-build-vscode/releases/tag/${encodeURIComponent(tag)}`;
    if (!best || compareSemver(semver, best.semver) > 0) {
      best = { version, url, semver };
    }
  }
  return best ? { version: best.version, url: best.url } : null;
}

/**
 * Decide whether to show an update notice. Returns the notice payload, or null
 * when current is already latest / unparseable / no release / not newer.
 */
export function noticeIfUpdateAvailable(
  currentVersion: string | null | undefined,
  releases: readonly GithubReleaseLike[] | null | undefined,
): DesktopReleaseNotice | null {
  const latest = pickLatestDesktopRelease(releases);
  if (!latest) return null;
  if (!isNewerVersion(latest.version, currentVersion)) return null;
  return latest;
}

/**
 * Where the "Update available" button sends people.
 *
 * NOT the GitHub release page, which is a developer artifact: a wall of `.dmg`,
 * `.zip`, `.exe`, `.blockmap` and a `.vsix`, with no indication which one you
 * want. This page detects the platform and offers one button.
 *
 * The URL is deliberately generic and carries only the running version, because
 * it is compiled into every installed copy and can never be changed for builds
 * already in the wild. Everything else the page shows is derived server-side,
 * so its content can be rewritten forever without another release.
 */
export function desktopUpdatePageUrl(currentVersion: string | null | undefined): string {
  const v = String(currentVersion || "").trim();
  const base = "https://afkpilot.com/desktop-update";
  return v ? `${base}?from=${encodeURIComponent(v)}` : base;
}

/** GitHub API URL used by the main process (per_page=100 covers recent history). */
export const DESKTOP_RELEASES_API_URL =
  "https://api.github.com/repos/phuryn/grok-build-vscode/releases?per_page=100";

/** How often a long-running desk re-checks (12 hours). */
export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
