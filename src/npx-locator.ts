/**
 * Find `npx` the way the other locators find ffmpeg / Claude: PATH first, then
 * the directories a GUI-launched app's PATH routinely misses — and hand the
 * child a PATH in which `npx` itself can run.
 *
 * Grok Build Desktop does not resolve the login shell's environment, so
 * `spawn("npx")` is ENOENT on a machine where `which npx` answers
 * `/opt/homebrew/bin/npx`. That is the same incident `ffmpeg-locate.ts` opens
 * with. The difference: ffmpeg is a self-contained executable; npx is a
 * `#!/usr/bin/env node` script. Resolving the path is not enough — the child
 * (and the `node` grandchild npx starts for `mcp-remote`) must see the
 * directory on `PATH`. `npxChildPath` prepends the resolved directory and the
 * well-known list; we do not hardcode a node interpreter. Windows npm shims
 * are `.cmd` and need a shell; there is no conventional well-known directory
 * worth guessing on win32.
 */
import { statSync } from "node:fs";

/**
 * Directories package managers use that a GUI process's PATH routinely misses.
 * Ordered by how likely they are to be the one that matters. Same list as
 * `FFMPEG_WELL_KNOWN_DIRS` — same machines, same hole.
 */
export const NPX_WELL_KNOWN_DIRS: Readonly<Record<string, readonly string[]>> = {
  // Apple silicon Homebrew, then Intel Homebrew, then MacPorts.
  darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"],
  linux: ["/usr/local/bin", "/usr/bin", "/snap/bin", "/var/lib/flatpak/exports/bin"],
  // Windows installs land on PATH via the Node installer; guessing wrong is
  // worse than not. `npxSpawnPlan` still uses `npx.cmd` + `shell: true`.
  win32: [],
};

export interface NpxEnv {
  platform: NodeJS.Platform;
  /** `process.env.PATH` — split on the platform's delimiter. */
  pathEnv: string | undefined;
  /** Exists AND is a regular file. A directory must answer false. */
  isFile(candidate: string): boolean;
}

export type NpxResolution = {
  command: string;
  shell: boolean;
  source: "path" | "well-known" | "missing";
  /** Directory that contains npx when we found it. Prepended onto the child's PATH. */
  dir?: string;
};

const BINARY = (platform: NodeJS.Platform) => (platform === "win32" ? "npx.cmd" : "npx");

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function defaultIsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate npx for a fabricated PATH + filesystem. Windows always shells the
 * `.cmd` shim. A PATH hit stays bare so spawn resolves it the same way; a
 * well-known hit is the absolute path a stripped GUI PATH cannot see. Missing
 * still returns the platform command — `spawn` ENOENT is `npx-missing`.
 */
export function resolveNpx(env: NpxEnv): NpxResolution {
  const binary = BINARY(env.platform);
  const shell = env.platform === "win32";
  const missing: NpxResolution = { command: binary, shell, source: "missing" };

  const dirs = (env.pathEnv || "")
    .split(env.platform === "win32" ? ";" : ":")
    .map((d) => d.trim())
    .filter(Boolean);

  for (const dir of dirs) {
    if (env.isFile(join(dir, binary))) {
      return { command: binary, shell, source: "path", dir };
    }
  }

  for (const dir of NPX_WELL_KNOWN_DIRS[env.platform] || []) {
    const candidate = join(dir, binary);
    if (env.isFile(candidate)) {
      return { command: candidate, shell, source: "well-known", dir };
    }
  }

  return missing;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

/**
 * PATH the mcp-remote child (and npx's `node` grandchild) actually receive.
 * Resolved directory first so `env node` finds the interpreter sitting next
 * to npx, then the well-known list, then the parent's PATH. Deduped, first
 * occurrence wins. Does not name node.
 */
export function npxChildPath(
  platform: NodeJS.Platform,
  resolvedDir: string | undefined,
  pathEnv: string | undefined,
): string {
  const delim = pathDelimiter(platform);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    out.push(dir);
  };
  if (resolvedDir) add(resolvedDir);
  for (const dir of NPX_WELL_KNOWN_DIRS[platform] || []) add(dir);
  for (const dir of (pathEnv || "").split(delim).map((d) => d.trim()).filter(Boolean)) add(dir);
  return out.join(delim);
}

/** Clone `processEnv`, replacing PATH so shebang/`env node` resolution works. */
export function withNpxChildEnv(
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  resolvedDir: string | undefined,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(processEnv).find((key) => key.toUpperCase() === "PATH");
  const pathEnv = pathKey ? processEnv[pathKey] : undefined;
  const next: NodeJS.ProcessEnv = { ...processEnv };
  if (pathKey && pathKey !== "PATH") delete next[pathKey];
  next.PATH = npxChildPath(platform, resolvedDir, pathEnv);
  return next;
}

/** Spawn plan for `authorizeMcpRemote`. Inject PATH/`isFile`/env in tests. */
export function npxSpawnPlan(
  platform: NodeJS.Platform = process.platform,
  env: {
    pathEnv?: string;
    isFile?: (candidate: string) => boolean;
    processEnv?: NodeJS.ProcessEnv;
  } = {},
): { command: string; shell: boolean; env: NodeJS.ProcessEnv } {
  const processEnv = env.processEnv ?? process.env;
  const resolved = resolveNpx({
    platform,
    pathEnv: env.pathEnv ?? processEnv.PATH ?? processEnv.Path,
    isFile: env.isFile ?? defaultIsFile,
  });
  return {
    command: resolved.command,
    shell: resolved.shell,
    env: withNpxChildEnv(processEnv, platform, resolved.dir),
  };
}
