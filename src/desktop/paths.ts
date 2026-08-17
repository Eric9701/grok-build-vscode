/**
 * Path helpers for the desktop Electron app. Resolves the extension/repo root
 * (where `media/` and `resources/` live) relative to the compiled main process.
 *
 * Layouts:
 *   Dev compile tree:  <root>/out/desktop/main.js  → root has media/
 *   Packaged (asar):   <…>/resources/app.asar/out/desktop/main.js
 *                      media/ is at app.asar root (electron-builder `files`)
 *   Packaged (dir):    <…>/resources/app/out/desktop/main.js  (same relative layout)
 *   Extra-resources:   media next to asar under process.resourcesPath (fallback)
 *
 * Pure resolvers (`isExtensionRoot`, `resolveExtensionRootFrom`, profile path
 * helpers) do not import Electron so unit tests can load them without a
 * BrowserWindow.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Branded profile directory under the OS app-data root (e.g.
 * `%AppData%/GrokBuildDesktop`, `~/Library/Application Support/GrokBuildDesktop`).
 * Must be set as Electron `userData` *before* anything reads that path.
 */
export const DESKTOP_PROFILE_DIRNAME = "GrokBuildDesktop";

/** Sibling staging dir while a legacy profile is being copied (never a final path). */
export const DESKTOP_PROFILE_STAGING_SUFFIX = ".migrating";

/** Files that prove a directory is our desktop profile (not an empty shell). */
export const DESKTOP_PROFILE_MARKERS = [
  "config.json",
  "globalState.json",
  "secrets.enc.json",
  "sensitive.enc.json",
] as const;

export interface ProfileFs {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  readdirSync(p: string): string[];
  renameSync(from: string, to: string): void;
  /** Node 16.7+; optional so tests can omit when only rename is exercised. */
  cpSync?(from: string, to: string, opts?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean }): void;
  rmSync?(p: string, opts?: { recursive?: boolean; force?: boolean }): void;
  rmdirSync?(p: string): void;
}

/** Branded userData path under the OS app-data directory. */
export function brandedDesktopProfilePath(appData: string): string {
  return path.join(appData, DESKTOP_PROFILE_DIRNAME);
}

/** Temporary sibling used only during atomic migration. */
export function brandedDesktopProfileStagingPath(appData: string): string {
  return path.join(appData, DESKTOP_PROFILE_DIRNAME + DESKTOP_PROFILE_STAGING_SUFFIX);
}

/**
 * Pre-branding profile locations. Early builds called `app.setName` too late,
 * so Electron defaulted to the generic `Electron` folder and we nested prefs
 * under `grok-desktop`.
 */
export function legacyDesktopProfilePaths(appData: string): string[] {
  return [path.join(appData, "Electron", "grok-desktop")];
}

/** True when `dir` holds at least one of our profile marker files. */
export function desktopProfileLooksOccupied(
  dir: string,
  profileFs: Pick<ProfileFs, "existsSync"> = fs,
): boolean {
  if (!dir) return false;
  return DESKTOP_PROFILE_MARKERS.some((m) => profileFs.existsSync(path.join(dir, m)));
}

/**
 * Recursively assert every path under `source` exists under `dest` with the
 * same relative layout. Used after a staging copy so a half-written tree is
 * never promoted.
 */
export function profileTreeFullyCopied(
  source: string,
  dest: string,
  profileFs: Pick<ProfileFs, "existsSync" | "readdirSync"> = fs,
): boolean {
  if (!profileFs.existsSync(source) || !profileFs.existsSync(dest)) return false;
  let names: string[];
  try {
    names = profileFs.readdirSync(source);
  } catch {
    // Source is a file — dest must exist (caller already checked).
    return true;
  }
  for (const name of names) {
    const from = path.join(source, name);
    const to = path.join(dest, name);
    if (!profileFs.existsSync(to)) return false;
    // Directory → recurse. readdir on a file throws; treat as leaf.
    try {
      profileFs.readdirSync(from);
    } catch {
      continue;
    }
    if (!profileTreeFullyCopied(from, to, profileFs)) return false;
  }
  return true;
}

function safeRm(profileFs: ProfileFs, p: string): void {
  try {
    profileFs.rmSync?.(p, { recursive: true, force: true });
  } catch {
    try {
      profileFs.rmdirSync?.(p);
    } catch {
      /* leave husk */
    }
  }
}

/**
 * Build a complete target tree under `staging` (legacy + any non-colliding
 * branded shell files), verify it, then atomically promote to `branded`.
 *
 * Markers never land under `branded` until the whole tree is ready — a crash
 * mid-copy leaves only the staging sibling (cleaned on the next launch).
 */
function migrateViaStaging(opts: {
  legacy: string;
  branded: string;
  staging: string;
  profileFs: ProfileFs;
}): boolean {
  const { legacy, branded, staging, profileFs } = opts;
  if (!profileFs.cpSync) return false;

  safeRm(profileFs, staging);
  profileFs.mkdirSync(path.dirname(staging), { recursive: true });

  try {
    // Start from any existing branded shell (non-marker junk we must keep), then
    // overlay the full legacy tree. Caller already refused name collisions.
    if (profileFs.existsSync(branded)) {
      profileFs.cpSync(branded, staging, { recursive: true, force: true });
    } else {
      profileFs.mkdirSync(staging, { recursive: true });
    }
    for (const name of profileFs.readdirSync(legacy)) {
      profileFs.cpSync(path.join(legacy, name), path.join(staging, name), {
        recursive: true,
        force: true,
      });
    }

    if (!profileTreeFullyCopied(legacy, staging, profileFs)) {
      safeRm(profileFs, staging);
      return false;
    }

    // Atomic promote: never rename individual files into branded (a single marker
    // would make the next launch treat a partial tree as complete).
    const backup = branded + ".pre-migrate";
    if (profileFs.existsSync(backup)) safeRm(profileFs, backup);

    if (!profileFs.existsSync(branded)) {
      profileFs.renameSync(staging, branded);
    } else {
      // Empty shell or non-marker junk: move branded aside, then put staging in place.
      let brandedNames: string[] = [];
      try {
        brandedNames = profileFs.readdirSync(branded);
      } catch {
        brandedNames = ["."];
      }
      if (brandedNames.length === 0) {
        safeRm(profileFs, branded);
        profileFs.renameSync(staging, branded);
      } else {
        profileFs.renameSync(branded, backup);
        try {
          profileFs.renameSync(staging, branded);
        } catch {
          // Restore previous shell so the user is not left without either tree.
          try {
            profileFs.renameSync(backup, branded);
          } catch {
            /* both paths may exist; operator recovers from legacy + backup */
          }
          safeRm(profileFs, staging);
          return false;
        }
        safeRm(profileFs, backup);
      }
    }

    safeRm(profileFs, legacy);
    return true;
  } catch {
    // Crash mid-copy must not leave a marker-bearing staging tree that the
    // next launch could mistake for anything authoritative.
    safeRm(profileFs, staging);
    return false;
  }
}

/**
 * Resolve the desktop profile directory and migrate a legacy Electron profile
 * when the branded path is still empty.
 *
 * Strategy:
 * - Explicit `override` (--user-data-dir / test harness) wins; no migration.
 * - Prefer the branded path when it already has our files.
 * - Else rename (same volume) or copy-via-staging the first occupied legacy path
 *   into the branded location so config / memento / secrets are not abandoned.
 * - Never overwrite a branded profile that already has marker data.
 * - Copy always goes into a temporary sibling, is verified recursively, then
 *   atomically promoted — a half-migration is never mistakable for complete.
 * - Never delete a legacy profile unless the promote succeeded.
 */
export function resolveDesktopProfileDir(opts: {
  appData: string;
  override?: string;
  fs?: ProfileFs;
}): { userData: string; migratedFrom?: string } {
  const profileFs = opts.fs ?? fs;
  if (opts.override) {
    const ud = path.resolve(opts.override);
    profileFs.mkdirSync(ud, { recursive: true });
    return { userData: ud };
  }

  const branded = brandedDesktopProfilePath(opts.appData);
  const staging = brandedDesktopProfileStagingPath(opts.appData);
  // Stale staging from a crashed previous launch must never look like a profile.
  if (profileFs.existsSync(staging)) safeRm(profileFs, staging);

  if (desktopProfileLooksOccupied(branded, profileFs)) {
    return { userData: branded };
  }

  for (const legacy of legacyDesktopProfilePaths(opts.appData)) {
    if (!desktopProfileLooksOccupied(legacy, profileFs)) continue;
    try {
      profileFs.mkdirSync(path.dirname(branded), { recursive: true });
      if (!profileFs.existsSync(branded)) {
        // Same-volume rename is already atomic and needs no staging.
        try {
          profileFs.renameSync(legacy, branded);
          return { userData: branded, migratedFrom: legacy };
        } catch {
          // Cross-device or busy — fall through to staging copy.
        }
      } else {
        // Branded path exists but has no markers (empty shell or non-marker junk).
        // Refuse when any top-level name collides — force-merge would skip those
        // entries and lose data if we then removed legacy.
        const legacyNames = profileFs.readdirSync(legacy);
        const conflicts = legacyNames.filter((name) =>
          profileFs.existsSync(path.join(branded, name)),
        );
        if (conflicts.length > 0) {
          break;
        }
      }

      if (migrateViaStaging({ legacy, branded, staging, profileFs })) {
        return { userData: branded, migratedFrom: legacy };
      }
      // Incomplete / failed promote — keep legacy; start on branded shell if any.
      break;
    } catch {
      // Migration failed — still use branded (fresh) rather than stay on
      // the unbranded path; legacy is left intact for manual recovery.
      break;
    }
  }

  profileFs.mkdirSync(branded, { recursive: true });
  return { userData: branded };
}

/** True when this directory looks like the install/repo root (has chat assets). */
export function isExtensionRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, "media", "chat.js"));
}

/**
 * Pure resolver — unit-testable without a live Electron app.
 * `moduleDir` is the directory of the compiled main script (usually `__dirname`).
 */
export function resolveExtensionRootFrom(
  moduleDir: string,
  opts?: {
    /** `app.getAppPath()` — asar path or resources/app when unpacked. */
    appPath?: string;
    /** `process.resourcesPath` — directory that contains app.asar / app/. */
    resourcesPath?: string;
  },
): string {
  // out/desktop/main.js → ../../  (dev tree and packaged asar/dir layout)
  const fromOut = path.resolve(moduleDir, "..", "..");
  if (isExtensionRoot(fromOut)) return fromOut;

  if (opts?.appPath && isExtensionRoot(opts.appPath)) return opts.appPath;

  // media shipped as extraResource next to asar (not the default layout).
  if (opts?.resourcesPath) {
    const nextToAsar = path.join(opts.resourcesPath, "app");
    if (isExtensionRoot(nextToAsar)) return nextToAsar;
    if (isExtensionRoot(opts.resourcesPath)) return opts.resourcesPath;
  }

  return fromOut;
}

/**
 * Visible first-run project folder, created directly in the user's home
 * directory. On macOS this is not TCC-protected (unlike Desktop / Documents /
 * Downloads), so creating it does not raise a consent dialog, and it is
 * findable in Finder for a knowledge-work user.
 */
export const DEFAULT_PROJECT_DIRNAME = "Grok Build";

/**
 * The user's home directory the way the desktop app should create folders in
 * it: USERPROFILE on Windows (HOME is often a git-bash overlay), HOME
 * elsewhere, then `os.homedir()`. Not GROK_HOME — that is the CLI store.
 */
export function desktopUserHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = () => os.homedir(),
): string {
  const fromEnv = platform === "win32" ? env.USERPROFILE : env.HOME;
  const trimmed = typeof fromEnv === "string" ? fromEnv.trim() : "";
  return trimmed || homedir();
}

/** Preferred first-run project: `<home>/Grok Build`. */
export function preferredDefaultProjectPath(homeDir: string): string {
  return path.join(homeDir, DEFAULT_PROJECT_DIRNAME);
}

/**
 * Last-resort first-run project: a CHILD of the profile directory, never the
 * profile directory itself. The parent is writable under a sandbox that cannot
 * create folders in $HOME, which is why the fallback lives here — but handing
 * the agent the profile ROOT would authorize a workspace containing
 * `config.json`, globalStorage and the encrypted device-token secrets, so a
 * prompt (or a linked remote's file API) could read or overwrite credentials.
 * A default project must never be a directory that holds secrets.
 */
export function fallbackDefaultProjectPath(userDataDir: string): string {
  return path.join(userDataDir, DEFAULT_PROJECT_DIRNAME);
}

export interface DefaultProjectFs {
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  existsSync(p: string): boolean;
  statSync?(p: string): { isDirectory(): boolean };
}

function isUsableDirectory(p: string, io: DefaultProjectFs): boolean {
  if (!p) return false;
  try {
    if (!io.existsSync(p)) return false;
    return io.statSync ? io.statSync(p).isDirectory() : true;
  } catch {
    return false;
  }
}

/**
 * Create the first-run default project folder. Prefer `~/Grok Build`. Any
 * failure — permissions, sandbox, the name already exists as a file —
 * silently uses `userData` instead. Never throws: a first-run error dialog
 * would be worse than landing in the profile directory.
 *
 * A project is just a folder. No git init.
 */
export function provisionDefaultProjectDir(opts: {
  homeDir: string;
  userDataDir: string;
  fs?: DefaultProjectFs;
}): { dir: string; usedFallback: boolean } | null {
  const io = opts.fs ?? fs;
  const preferred = preferredDefaultProjectPath(opts.homeDir);
  const fallback = fallbackDefaultProjectPath(opts.userDataDir);
  try {
    if (!isUsableDirectory(preferred, io)) {
      io.mkdirSync(preferred, { recursive: true });
    }
    if (isUsableDirectory(preferred, io)) {
      return { dir: path.resolve(preferred), usedFallback: false };
    }
  } catch {
    /* fall through */
  }
  try {
    if (!isUsableDirectory(fallback, io)) {
      io.mkdirSync(fallback, { recursive: true });
    }
    if (isUsableDirectory(fallback, io)) {
      return { dir: path.resolve(fallback), usedFallback: true };
    }
  } catch {
    /* fall through to no default at all */
  }
  // Neither location worked. Return nothing rather than naming a directory we
  // failed to create: the caller leaves the open set empty and the user gets
  // the empty-project state, which is honest. The alternative — falling back to
  // some directory that merely exists — is how the profile root became an
  // authorized workspace.
  return null;
}

/** Repo / install root: parent of `out/` when running from a compile tree. */
export function resolveExtensionRoot(): string {
  // Lazy require so pure helpers stay loadable outside Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  let appPath: string | undefined;
  try {
    appPath = app.getAppPath();
  } catch {
    /* app not ready */
  }
  return resolveExtensionRootFrom(__dirname, {
    appPath,
    resourcesPath:
      typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
  });
}

/**
 * Directory for config / memento / secrets. Production main sets Electron
 * `userData` early to the branded profile (or a test `--user-data-dir`
 * override); that path *is* the profile root.
 */
export function resolveUserDataDir(override?: string): string {
  if (override) return path.resolve(override);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  return app.getPath("userData");
}
