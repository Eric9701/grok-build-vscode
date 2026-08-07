/**
 * Desktop-only authorization for renderer-originated Host actions.
 *
 * Schema validation ({@link parseWebviewMsg}) proves a message is *well-formed*.
 * This module decides whether the operation is *allowed* — the same role
 * {@link remote-policy} plays for AFK Pilot clients. VS Code never loads this
 * file; extension behaviour is unchanged.
 *
 * Applied in {@link ElectronWebview.dispatchMessage} before sidebar handlers
 * see sensitive operations. Containment reuses the file-tree canonical check so
 * chat links cannot bypass the panel's workspace fence. Session-scoped roots
 * (worktree cwd + source git root) are supplied by the host — the message gate
 * alone has no session context.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFileRef } from "../file-ref";
import type { WebviewMsg } from "../protocol";
import {
  findRelPathByBasename,
  isBareFileName,
  isExistingFile,
  resolveTreePath,
  type TreePathFs,
} from "./file-tree";

/** Extensions the OS may launch as code / scripts / installers / launchers. */
const EXECUTABLE_EXTS = new Set([
  // Windows PE / scripts / shortcuts
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".msi",
  ".msp",
  ".scr",
  ".pif",
  ".cpl",
  ".msc",
  ".ps1",
  ".psm1",
  ".psd1",
  ".vbs",
  ".vbe",
  ".jse",
  ".wsf",
  ".wsh",
  ".ws",
  ".lnk",
  ".hta",
  // Unix shells / binaries commonly double-clicked or openPath'd
  ".sh",
  ".bash",
  ".zsh",
  ".csh",
  ".ksh",
  ".run",
  ".app",
  ".command",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  // Desktop entry launchers (Linux) — shell.openPath can invoke them
  ".desktop",
  // Cross-platform script runners that shell.openPath may hand to an interpreter
  ".jar",
  ".apk",
]);

/** POSIX any-execute bits (owner/group/other). */
const POSIX_ANY_EXECUTE = 0o111;

export type DesktopAuthResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Path-bearing open/read authorize result — success carries the path to use. */
export type DesktopOpenPathResult =
  | { ok: true; /** Absolute path that passed containment (link path when still in-tree). */ absPath: string }
  | { ok: false; reason: string };

/**
 * Context for path-bearing desktop operations (openFile / openDiff / dropFile).
 * Prefer {@link allowedRoots} (session cwd + worktree + workspace); {@link workspaceRoot}
 * remains for call sites that only know the active project folder.
 */
export interface DesktopOpenFileContext {
  /** Absolute workspace / project root; used when allowedRoots is empty. */
  workspaceRoot?: string | undefined;
  /**
   * Every root the active session may open files under (workspace root,
   * session cwd / worktree path, worktree source git root). Tried in order.
   */
  allowedRoots?: readonly string[];
  platform?: NodeJS.Platform;
  pathFs?: TreePathFs;
  /**
   * When true, `dropFile` must carry a host-minted `handle` and must not carry
   * a renderer-supplied `path`. Desktop sets this; VS Code never uses this module.
   */
  requireDropFileHandle?: boolean;
  /** Resolve a one-shot selection handle to an absolute filesystem path. */
  resolveDropFileHandle?: (handle: string) => string | null;
}

/** Deduped non-empty absolute roots from the auth context. */
export function desktopAuthRoots(ctx: DesktopOpenFileContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (r: string | undefined) => {
    if (!r || typeof r !== "string") return;
    const t = r.trim();
    if (!t) return;
    const key = process.platform === "win32" ? t.toLowerCase() : t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  if (ctx.allowedRoots) {
    for (const r of ctx.allowedRoots) add(r);
  }
  add(ctx.workspaceRoot);
  return out;
}

/**
 * True when the path's basename extension is one the OS may launch as code
 * (PE, scripts, shortcuts, `.desktop` launchers, packages). Pure — no FS.
 * Prefer {@link isExecutableOpenTarget} when a real path and mode are available.
 */
export function isExecutablePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (!ext) return false;
  return EXECUTABLE_EXTS.has(ext);
}

/**
 * True when handing this path to `shell.openPath` risks launching code:
 * dangerous extension on the path **or** its canonical (realpath) target,
 * a `.desktop` launcher, or (non-Windows) any POSIX execute bit on the
 * canonical file. Symlinks to binaries / `chmod +x` scripts without an
 * extension are refused even when the link name looks safe.
 */
export function isExecutableOpenTarget(
  absPath: string,
  opts?: {
    platform?: NodeJS.Platform;
    pathFs?: Pick<TreePathFs, "realpathSync" | "statSync">;
  },
): boolean {
  if (!absPath || typeof absPath !== "string") return false;
  if (isExecutablePath(absPath)) return true;

  const platform = opts?.platform ?? process.platform;
  const pathFs = opts?.pathFs;
  let real = absPath;
  try {
    real = pathFs ? pathFs.realpathSync(absPath) : fs.realpathSync(absPath);
  } catch {
    // Name check already ran; no FS metadata → not further refuse.
    return false;
  }
  if (real !== absPath && isExecutablePath(real)) return true;

  // Windows PE/scripts are extension-based; mode bits are not a reliable
  // "is this a program" signal (and Node reports them loosely).
  if (platform === "win32") return false;

  try {
    const st = pathFs ? pathFs.statSync(real) : fs.statSync(real);
    if (typeof st.isFile === "function" && !st.isFile()) return false;
    if (typeof st.mode === "number" && (st.mode & POSIX_ANY_EXECUTE) !== 0) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Authorize a chat `openFile` / `openDiff` path: must resolve inside one of the
 * authorized session roots with the same canonical containment as the file tree,
 * and must not be an executable (name, symlink target, or POSIX +x).
 *
 * On success returns the absolute path to use (the resolveTreePath absPath —
 * link path when the link itself is still under the root). Callers that open
 * or read must not trust a path authorized earlier: call
 * {@link revalidateOpenFileForUse} immediately before use.
 *
 * `rawPath` may be absolute or root-relative (and may carry a `#L` / `:line`
 * suffix already stripped by the caller, or still present — we only need the
 * filesystem path portion).
 */
export function authorizeOpenFile(
  rawPath: string,
  ctx: DesktopOpenFileContext,
): DesktopOpenPathResult {
  if (!rawPath || typeof rawPath !== "string") {
    return { ok: false, reason: "empty path" };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "null byte in path" };
  }
  const roots = desktopAuthRoots(ctx);
  if (!roots.length) {
    return { ok: false, reason: "no workspace root" };
  }

  const platform = ctx.platform ?? process.platform;
  for (const root of roots) {
    const resolved = resolveTreePath(root, rawPath, platform, ctx.pathFs);
    if (!resolved.ok) continue;
    if (
      isExecutableOpenTarget(resolved.absPath, {
        platform,
        pathFs: ctx.pathFs,
      })
    ) {
      return { ok: false, reason: "executable path refused" };
    }
    return { ok: true, absPath: resolved.absPath };
  }
  return { ok: false, reason: "path escapes authorized roots" };
}

/**
 * Use-time revalidation for chat open/read (same property as the file-tree
 * panel's final `resolveTreePath` before open/read).
 *
 * Re-runs containment + executable checks immediately before openPath/readFile
 * and returns the path that must be used. A symlink/junction swap between the
 * message-gate authorize and this call (or between the two internal checks)
 * fails closed — the external target is never opened or read.
 *
 * Shared by {@link createElectronHost} `openFsPath` and sidebar `readFileForDiff`.
 */
export function revalidateOpenFileForUse(
  rawPath: string,
  ctx: DesktopOpenFileContext,
): DesktopOpenPathResult {
  const first = authorizeOpenFile(rawPath, ctx);
  if (!first.ok) return first;

  const pathFs = ctx.pathFs;
  const platform = ctx.platform ?? process.platform;
  // Snapshot realpath after the first pass so a swap that keeps the same link
  // path (and would still need a second authorize) is compared explicitly.
  let realAtCheck: string;
  try {
    realAtCheck = pathFs
      ? pathFs.realpathSync(first.absPath)
      : fs.realpathSync(first.absPath);
  } catch {
    realAtCheck = first.absPath;
  }

  const second = authorizeOpenFile(rawPath, ctx);
  if (!second.ok) return second;

  const norm = (p: string) =>
    platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
  if (norm(first.absPath) !== norm(second.absPath)) {
    return { ok: false, reason: "path changed since check" };
  }

  let realNow: string;
  try {
    realNow = pathFs
      ? pathFs.realpathSync(second.absPath)
      : fs.realpathSync(second.absPath);
  } catch {
    realNow = second.absPath;
  }
  if (norm(realAtCheck) !== norm(realNow)) {
    return { ok: false, reason: "path escaped workspace (symlink swap)" };
  }

  // Open/read the path from the final check — never the pre-revalidation string.
  return second;
}

/**
 * Use-time resolution for chat/OS open after containment is proven.
 *
 * 1. Revalidate the raw path (same TOCTOU property as {@link revalidateOpenFileForUse}).
 * 2. If that absolute path exists as a file, open it.
 * 3. If the caller's path is a **bare filename** that is not at the root, search
 *    authorized roots for a matching basename (shallowest hit) and re-authorize
 *    the found relative path — agents often link `product-decisions.md` when
 *    the real file is `docs/product-decisions.md`.
 * 4. Otherwise `{ reason: "file not found" }` — callers must show an **in-app**
 *    message and must **not** hand a missing path to `shell.openPath` (Windows
 *    would raise a shell dialog).
 *
 * Paths that escape authorized roots or look executable still fail closed.
 */
export function resolveAuthorizedFileForOpen(
  rawPath: string,
  ctx: DesktopOpenFileContext,
): DesktopOpenPathResult {
  const check = revalidateOpenFileForUse(rawPath, ctx);
  if (!check.ok) return check;

  const pathFs = ctx.pathFs;
  const exists = (p: string) =>
    pathFs ? isExistingFile(p, pathFs) : isExistingFile(p);
  if (exists(check.absPath)) {
    return check;
  }

  // Workspace basename search only for bare links. Multi-segment misses
  // (e.g. `src/missing.md`) stay "not found" — do not invent alternate paths.
  // Sidebar joins a relative bare name with the session cwd, so openFsPath often
  // sees an absolute path whose relative form under a root is still one segment.
  const bareProbe = parseFileRef(rawPath).path;
  const baseName = path.basename(bareProbe.replace(/\\/g, "/"));
  if (!baseName || baseName === "." || baseName === "..") {
    return { ok: false, reason: "file not found" };
  }
  const platform = ctx.platform ?? process.platform;
  const roots = desktopAuthRoots(ctx);
  let looksBare = isBareFileName(bareProbe);
  if (!looksBare) {
    for (const root of roots) {
      const rel = path.relative(root, check.absPath).split(path.sep).join("/");
      if (rel.includes("..")) continue;
      // Single segment under the root ≡ the chat bare-filename case after join.
      if (rel === baseName || (!rel.includes("/") && path.basename(rel) === baseName)) {
        looksBare = true;
        break;
      }
    }
  }
  if (!looksBare) {
    return { ok: false, reason: "file not found" };
  }

  for (const root of roots) {
    const foundRel = findRelPathByBasename(root, baseName, platform, pathFs);
    if (!foundRel) continue;
    // Re-authorize the discovered relative path (executable + containment).
    const again = revalidateOpenFileForUse(foundRel, {
      ...ctx,
      allowedRoots: [root, ...roots.filter((r) => r !== root)],
      workspaceRoot: root,
    });
    if (again.ok && exists(again.absPath)) {
      return again;
    }
  }
  return { ok: false, reason: "file not found" };
}

/**
 * Authorize `openUrl` / shell.openExternal targets: http(s) only.
 * Blocks file:, javascript:, vscode:, custom handlers, etc.
 */
export function authorizeOpenUrl(url: string): DesktopAuthResult {
  if (!url || typeof url !== "string") {
    return { ok: false, reason: "empty url" };
  }
  const trimmed = url.trim();
  // Reject scheme-relative and whitespace tricks.
  if (/[\r\n\0]/.test(trimmed)) {
    return { ok: false, reason: "invalid url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `scheme "${parsed.protocol}" refused` };
  }
  return { ok: true };
}

/**
 * Authorize `dropFile`. On desktop, only a host-minted handle is accepted; a
 * path string from the renderer is refused. On success the message is rewritten
 * to a path-bearing dropFile for the sidebar (VS Code shape).
 */
export function authorizeDropFile(
  msg: Extract<WebviewMsg, { type: "dropFile" }>,
  ctx: DesktopOpenFileContext,
):
  | { msg: Extract<WebviewMsg, { type: "dropFile" }> }
  | { refused: true; reason: string } {
  if (!ctx.requireDropFileHandle) {
    // Non-desktop callers should not use this gate; pass through if path present.
    if (typeof msg.path === "string" && msg.path.length > 0) {
      return { msg: { type: "dropFile", path: msg.path, shift: msg.shift } };
    }
    return { refused: true, reason: "dropFile path required" };
  }
  // Desktop: never accept a renderer-supplied path (forged arbitrary read).
  if (typeof msg.path === "string" && msg.path.length > 0) {
    return { refused: true, reason: "dropFile path refused; use host handle" };
  }
  if (typeof msg.handle !== "string" || !msg.handle) {
    return { refused: true, reason: "dropFile handle required" };
  }
  const resolve = ctx.resolveDropFileHandle;
  if (!resolve) {
    return { refused: true, reason: "dropFile handle resolver missing" };
  }
  const abs = resolve(msg.handle);
  if (!abs) {
    return { refused: true, reason: "unknown or spent dropFile handle" };
  }
  return { msg: { type: "dropFile", path: abs, shift: msg.shift } };
}

/**
 * Policy gate for a parsed WebviewMsg. Returns the message (possibly rewritten)
 * when allowed, or a refusal when the operation must not reach Host/sidebar.
 *
 * Filtered: openFile, openUrl, openDiff, dropFile. Everything else passes
 * (schema validation already ran).
 */
export function authorizeDesktopWebviewMsg(
  msg: WebviewMsg,
  ctx: DesktopOpenFileContext,
): { msg: WebviewMsg } | { refused: true; reason: string; type: WebviewMsg["type"] } {
  if (msg.type === "openUrl" || msg.type === "openUpdateRelease") {
    const r = authorizeOpenUrl(msg.url);
    if (!r.ok) return { refused: true, reason: r.reason, type: msg.type };
    return { msg };
  }
  if (msg.type === "openFile") {
    // Strip #L / :line suffixes so containment uses the real file path.
    const bare = parseFileRef(msg.path).path;
    const r = authorizeOpenFile(bare, ctx);
    if (!r.ok) return { refused: true, reason: r.reason, type: msg.type };
    return { msg };
  }
  if (msg.type === "openDiff") {
    const bare = parseFileRef(msg.path).path;
    const r = authorizeOpenFile(bare, ctx);
    if (!r.ok) return { refused: true, reason: r.reason, type: msg.type };
    return { msg };
  }
  if (msg.type === "dropFile") {
    const r = authorizeDropFile(msg, ctx);
    if ("refused" in r) return { refused: true, reason: r.reason, type: msg.type };
    return { msg: r.msg };
  }
  return { msg };
}
