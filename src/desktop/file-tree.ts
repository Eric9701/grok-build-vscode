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

/**
 * Walk ancestors of `dir` until an existing directory is found (or the root).
 * Used by the bound file watcher so a missing custom Grok home can still be
 * supervised via the nearest living parent.
 */
export function nearestExistingAncestor(
  dir: string,
  existsSync: (p: string) => boolean = (p) => fs.existsSync(p),
  isDirectory: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
): string | undefined {
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try {
      if (existsSync(current) && isDirectory(current)) {
        return current;
      }
    } catch {
      /* continue walking */
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

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

/** In-panel preview kinds (read-only). Everything else hands off to the OS. */
export type FilePreviewKind = "markdown" | "json" | "image" | "text" | "external";

const PREVIEW_IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const PREVIEW_TEXT_EXT = new Set([
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".htm",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".csv",
  ".log",
  ".env",
  ".sh",
  ".ps1",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".jsonc",
  ".mdx",
  ".svg",
]);

/** Cap for in-panel text/json previews (bytes). */
export const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Cap for in-panel image previews (bytes). */
export const FILE_PREVIEW_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Classify a workspace-relative path for the desktop file panel viewer.
 * `.md` → markdown, `.json` → json, images → image, common source/text → text,
 * everything else → external (OS open).
 */
export function classifyFilePreview(relOrName: string): FilePreviewKind {
  const ext = path.extname(relOrName).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".json") return "json";
  if (PREVIEW_IMAGE_EXT.has(ext)) return "image";
  if (PREVIEW_TEXT_EXT.has(ext)) return "text";
  // Dotfiles like `.env` have ext "" when basename is `.env` — treat as text.
  if (ext === "" || /^\./.test(path.basename(relOrName))) return "text";
  return "external";
}

export type ReadTreeFileResult =
  | {
      ok: true;
      kind: Exclude<FilePreviewKind, "external">;
      relPath: string;
      absPath: string;
      /** UTF-8 text for markdown/json/text; empty for image. */
      text?: string;
      /** data: URL for images. */
      dataUrl?: string;
      /** Pretty-printed when kind is json. */
      pretty?: boolean;
    }
  | { ok: false; reason: string; openExternal?: boolean };

/**
 * Re-resolve immediately before a read so a symlink swap between the first
 * containment check and the open cannot escape the workspace (same property
 * as the open-path TOCTOU rechecks in file-tree-ipc).
 */
function recheckTreePathForRead(
  root: string,
  relPath: string,
  expectedAbs: string,
  expectedReal: string,
  platform: NodeJS.Platform,
  pathFs: TreePathFs,
): ResolveTreePathResult {
  const again = resolveTreePath(root, relPath, platform, pathFs);
  if (!again.ok) return again;
  if (again.absPath !== expectedAbs) {
    return { ok: false, reason: "path changed since check" };
  }
  const realNow = canonicalPath(again.absPath, pathFs);
  const a = platform === "win32" ? realNow.toLowerCase() : realNow;
  const b = platform === "win32" ? expectedReal.toLowerCase() : expectedReal;
  if (a !== b) {
    return { ok: false, reason: "path escaped workspace (symlink swap)" };
  }
  if (!isCanonicallyInsideRoot(root, again.absPath, platform, pathFs)) {
    return { ok: false, reason: "path escapes workspace (symlink)" };
  }
  return again;
}

/**
 * Read a workspace file for the in-panel viewer. Containment matches
 * {@link resolveTreePath}. Oversized or binary-looking files return
 * `{ openExternal: true }` so the panel can hand off to the OS.
 */
export function readTreeFile(
  root: string,
  relPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
  readFileSync: (p: string) => Buffer = (p) => fs.readFileSync(p),
): ReadTreeFileResult {
  const resolved = resolveTreePath(root, relPath, platform, pathFs);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const realAtCheck = canonicalPath(resolved.absPath, pathFs);

  let st: fs.Stats;
  try {
    st = pathFs.statSync(resolved.absPath);
  } catch {
    return { ok: false, reason: "not found" };
  }
  if (!st.isFile()) {
    return { ok: false, reason: "not a file" };
  }

  const kind = classifyFilePreview(resolved.relPath || path.basename(resolved.absPath));
  if (kind === "external") {
    return { ok: false, reason: "open externally", openExternal: true };
  }

  if (kind === "image") {
    if (st.size > FILE_PREVIEW_MAX_IMAGE_BYTES) {
      return { ok: false, reason: "image too large", openExternal: true };
    }
    const rechecked = recheckTreePathForRead(
      root,
      relPath,
      resolved.absPath,
      realAtCheck,
      platform,
      pathFs,
    );
    if (!rechecked.ok) return { ok: false, reason: rechecked.reason };
    let buf: Buffer;
    try {
      buf = readFileSync(rechecked.absPath);
    } catch (e) {
      return { ok: false, reason: (e as Error).message || "unreadable" };
    }
    const ext = path.extname(rechecked.absPath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".svg"
              ? "image/svg+xml"
              : ext === ".bmp"
                ? "image/bmp"
                : "image/jpeg";
    return {
      ok: true,
      kind: "image",
      relPath: rechecked.relPath,
      absPath: rechecked.absPath,
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
    };
  }

  if (st.size > FILE_PREVIEW_MAX_BYTES) {
    return { ok: false, reason: "file too large", openExternal: true };
  }

  const rechecked = recheckTreePathForRead(
    root,
    relPath,
    resolved.absPath,
    realAtCheck,
    platform,
    pathFs,
  );
  if (!rechecked.ok) return { ok: false, reason: rechecked.reason };

  let buf: Buffer;
  try {
    buf = readFileSync(rechecked.absPath);
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "unreadable" };
  }
  // Reject obvious binary (NUL in first 8k).
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) {
    return { ok: false, reason: "binary file", openExternal: true };
  }

  let text = buf.toString("utf8");
  let pretty = false;
  if (kind === "json") {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
      pretty = true;
    } catch {
      /* show raw */
    }
  }

  return {
    ok: true,
    kind,
    relPath: rechecked.relPath,
    absPath: rechecked.absPath,
    text,
    pretty,
  };
}

/**
 * Breadcrumb segments for a workspace-relative path.
 * Root is always the first segment with relPath "".
 */
export function breadcrumbSegments(
  relPath: string,
  rootLabel: string,
): { label: string; relPath: string }[] {
  const segs: { label: string; relPath: string }[] = [
    { label: rootLabel || "Files", relPath: "" },
  ];
  const trimmed = (relPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return segs;
  const parts = trimmed.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    segs.push({ label: part, relPath: acc });
  }
  return segs;
}

/**
 * True when `p` is a single filename with no directory components (and not an
 * absolute Windows/Unix path). Chat agents often emit bare basenames like
 * `product-decisions.md` for files that actually live under `docs/`.
 */
export function isBareFileName(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (p.includes("\0")) return false;
  const t = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!t || t === "." || t === "..") return false;
  if (t.includes("/")) return false;
  // Absolute Windows drive or UNC.
  if (/^[A-Za-z]:/.test(p) || p.startsWith("\\\\")) return false;
  return true;
}

/** Directory basenames skipped while searching for a bare filename. */
export const FIND_BASENAME_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".grok",
  ".hg",
  ".svn",
  "dist",
  "out",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
]);

/** Cap visits so a huge monorepo cannot freeze open-from-chat. */
export const FIND_BASENAME_MAX_VISITS = 8000;

/**
 * Bounded search under `root` for a file whose basename matches (case-sensitive
 * on POSIX, case-insensitive on win32). Prefers the shallowest hit, then
 * lexical order. Skips bulky/generated dirs. Returns a workspace-relative
 * POSIX path or null.
 */
export function findRelPathByBasename(
  root: string,
  basename: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
  opts?: { maxVisits?: number; skipDirs?: ReadonlySet<string> },
): string | null {
  if (!root || !basename || basename.includes("/") || basename.includes("\\")) {
    return null;
  }
  if (basename === "." || basename === ".." || basename.includes("\0")) return null;

  const maxVisits = opts?.maxVisits ?? FIND_BASENAME_MAX_VISITS;
  const skip = opts?.skipDirs ?? FIND_BASENAME_SKIP_DIRS;
  const win = platform === "win32";
  const want = win ? basename.toLowerCase() : basename;

  type Hit = { rel: string; depth: number };
  const hits: Hit[] = [];
  let visits = 0;

  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (visits >= maxVisits) return;
    let ents: fs.Dirent[];
    try {
      ents = pathFs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (visits >= maxVisits) return;
      visits++;
      const name = ent.name;
      if (!name || name === "." || name === "..") continue;
      const childRel = relDir ? `${relDir}/${name}` : name;
      const childAbs = path.join(absDir, name);

      let isDir = false;
      let isFile = false;
      try {
        if (typeof ent.isDirectory === "function" && ent.isDirectory()) isDir = true;
        else if (typeof ent.isFile === "function" && ent.isFile()) isFile = true;
        else if (typeof ent.isSymbolicLink === "function" && ent.isSymbolicLink()) {
          const st = pathFs.statSync(childAbs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        }
      } catch {
        continue;
      }

      if (isDir) {
        if (skip.has(name) || (win && skip.has(name.toLowerCase()))) continue;
        // Stay inside the root (refuse outbound links).
        if (!isCanonicallyInsideRoot(root, childAbs, platform, pathFs)) continue;
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!isFile) continue;
      const got = win ? name.toLowerCase() : name;
      if (got === want) {
        if (!isCanonicallyInsideRoot(root, childAbs, platform, pathFs)) continue;
        hits.push({ rel: childRel, depth });
      }
    }
  };

  walk(path.resolve(root), "", 0);
  if (!hits.length) return null;
  hits.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  return hits[0]!.rel;
}

/** True when `absPath` exists and is a regular file. */
export function isExistingFile(
  absPath: string,
  pathFs: TreePathFs = defaultTreeFs,
): boolean {
  try {
    return pathFs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}
