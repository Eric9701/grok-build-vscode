/**
 * Pure workspace file-tree helpers for the desktop shell panel.
 * No Electron — path containment + directory listing for unit tests and IPC.
 *
 * Containment is **canonical**, not merely lexical: after the path is resolved
 * under the workspace root we `realpath` both the root and the candidate and
 * reject anything whose real path leaves the real root. That closes symlink
 * and Windows-junction escapes (a link whose own path is inside the workspace
 * but whose target is not). Symlinks that stay inside the workspace remain
 * usable — the boundary is "cannot read outside", not "no links".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isFsPathInWorkspace } from "../host";

/** Cap per directory so a huge folder cannot freeze the panel. */
export const FILE_TREE_MAX_ENTRIES = 2000;

export type TreeEntryKind = "file" | "dir";

export interface TreeEntry {
  name: string;
  kind: TreeEntryKind;
  /** Workspace-relative POSIX path ("" for root children is just the name). */
  relPath: string;
}

export type ResolveTreePathResult =
  | { ok: true; absPath: string; relPath: string }
  | { ok: false; reason: string };

export type ListTreeResult =
  | { ok: true; entries: TreeEntry[]; truncated: boolean }
  | { ok: false; reason: string };

/** Injectable FS surface so tests can simulate symlink realpath without OS privileges. */
export interface TreePathFs {
  realpathSync(p: string): string;
  existsSync(p: string): boolean;
  statSync(p: string): fs.Stats;
  readdirSync(p: string, opts: { withFileTypes: true }): fs.Dirent[];
}

const defaultTreeFs: TreePathFs = {
  realpathSync: (p) => fs.realpathSync(p),
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  readdirSync: (p, opts) => fs.readdirSync(p, opts),
};

/**
 * Best-effort real path. When the path does not exist, walk up to the nearest
 * existing ancestor and rejoin the missing tail (so a not-yet-created path is
 * still checked against the real root of its parent).
 */
export function canonicalPath(absPath: string, pathFs: TreePathFs = defaultTreeFs): string {
  try {
    return pathFs.realpathSync(absPath);
  } catch {
    /* fall through */
  }
  let current = absPath;
  const missing: string[] = [];
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    try {
      return path.join(pathFs.realpathSync(parent), ...missing);
    } catch {
      current = parent;
    }
  }
  return absPath;
}

/**
 * True when the real path of `absPath` stays inside the real path of `root`.
 * Lexical containment alone is not enough (symlink / junction escape).
 */
export function isCanonicallyInsideRoot(
  root: string,
  absPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
): boolean {
  const realRoot = canonicalPath(root, pathFs);
  const realAbs = canonicalPath(absPath, pathFs);
  return isFsPathInWorkspace(realAbs, [realRoot], platform);
}

/**
 * Resolve a workspace-relative path to an absolute path under `root`.
 * Rejects traversal (`..`), absolute inputs that leave the root, null bytes,
 * empty/invalid roots, and paths whose **real** target escapes the real root.
 * The workspace root itself is allowed (`relPath` "").
 */
export function resolveTreePath(
  root: string,
  relPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
): ResolveTreePathResult {
  if (!root || typeof root !== "string") {
    return { ok: false, reason: "no workspace root" };
  }
  if (typeof relPath !== "string") {
    return { ok: false, reason: "invalid path" };
  }
  if (relPath.includes("\0")) {
    return { ok: false, reason: "null byte in path" };
  }

  const pathMod = platform === "win32" ? path.win32 : path.posix;
  // Also accept the host path module for mixed separators on Windows when
  // platform === process.platform; for pure tests callers pass explicit platform.
  const hostPath = platform === process.platform ? path : pathMod;

  const rootAbs = hostPath.resolve(root);
  const trimmed = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

  // Empty → workspace root (allowed for listing).
  if (!trimmed || trimmed === ".") {
    return { ok: true, absPath: rootAbs, relPath: "" };
  }

  let absPath: string;

  // Reject absolute inputs early (Unix /foo, Windows C:\foo, //server/share).
  if (pathMod.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith("\\\\")) {
    // Absolute only accepted if it still lands inside the workspace.
    const absCandidate = hostPath.resolve(relPath);
    if (!isFsPathInWorkspace(absCandidate, [rootAbs], platform)) {
      return { ok: false, reason: "path escapes workspace" };
    }
    absPath = absCandidate;
  } else {
    // Segment-wise reject `..` so we never resolve out then back in via tricks.
    const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
    if (segments.some((s) => s === "..")) {
      return { ok: false, reason: "path escapes workspace" };
    }

    absPath = hostPath.resolve(rootAbs, ...segments);
    if (!isFsPathInWorkspace(absPath, [rootAbs], platform)) {
      return { ok: false, reason: "path escapes workspace" };
    }
  }

  // Canonical check: symlink / junction targets must stay inside the real root.
  if (!isCanonicallyInsideRoot(rootAbs, absPath, platform, pathFs)) {
    return { ok: false, reason: "path escapes workspace (symlink)" };
  }

  const rel = hostPath.relative(rootAbs, absPath).split(hostPath.sep).join("/");
  // Open/list operate on the caller's path (the link path when it is a link);
  // containment was already decided on the real target. Using the link path
  // keeps relative labels stable under the workspace root.
  return { ok: true, absPath, relPath: rel };
}

function entrySort(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * List one directory under the workspace. Directories first, then files,
 * case-insensitive name order. Caps at {@link FILE_TREE_MAX_ENTRIES}.
 * Entries whose real path leaves the workspace (outbound symlink/junction)
 * are omitted — they must not be expandable or openable.
 */
export function listTreeDir(
  root: string,
  relPath: string,
  maxEntries: number = FILE_TREE_MAX_ENTRIES,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
): ListTreeResult {
  const resolved = resolveTreePath(root, relPath, platform, pathFs);
  if (!resolved.ok) return resolved;

  let stat: fs.Stats;
  try {
    // lstat-first so a symlink-to-dir at this path is still a directory listing
    // only when the *canonical* target is inside the root (already checked).
    stat = pathFs.statSync(resolved.absPath);
  } catch {
    return { ok: false, reason: "not found" };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: "not a directory" };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = pathFs.readdirSync(resolved.absPath, { withFileTypes: true });
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "unreadable" };
  }

  const hostPath = platform === process.platform ? path : platform === "win32" ? path.win32 : path.posix;
  const entries: TreeEntry[] = [];
  let truncated = false;
  for (const ent of dirents) {
    const childAbs = hostPath.join(resolved.absPath, ent.name);
    // Drop anything whose real target leaves the workspace before classifying.
    if (!isCanonicallyInsideRoot(root, childAbs, platform, pathFs)) {
      continue;
    }

    let kind: TreeEntryKind | null = null;
    if (ent.isDirectory()) kind = "dir";
    else if (ent.isFile()) kind = "file";
    else if (ent.isSymbolicLink()) {
      try {
        const s = pathFs.statSync(childAbs);
        if (s.isDirectory()) kind = "dir";
        else if (s.isFile()) kind = "file";
      } catch {
        kind = null;
      }
    }
    if (!kind) continue;

    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const childRel = resolved.relPath
      ? `${resolved.relPath}/${ent.name}`
      : ent.name;
    entries.push({ name: ent.name, kind, relPath: childRel });
  }

  entries.sort(entrySort);
  return { ok: true, entries, truncated };
}
