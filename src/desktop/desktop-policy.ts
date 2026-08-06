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
import * as path from "node:path";
import { parseFileRef } from "../file-ref";
import type { WebviewMsg } from "../protocol";
import { resolveTreePath, type TreePathFs } from "./file-tree";

/** Extensions the OS may launch as code / scripts / installers. */
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
  // Cross-platform script runners that shell.openPath may hand to an interpreter
  ".jar",
  ".apk",
]);

export type DesktopAuthResult =
  | { ok: true }
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
 * True when the path's extension is one the OS may execute/launch as code.
 * Pure extension check — intentional; we do not inspect the executable bit
 * (chat-open is about deliberate document references, not "is this marked +x").
 */
export function isExecutablePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (!ext) return false;
  return EXECUTABLE_EXTS.has(ext);
}

/**
 * Authorize a chat `openFile` / `openDiff` path: must resolve inside one of the
 * authorized session roots with the same canonical containment as the file tree,
 * and must not be an executable.
 *
 * `rawPath` may be absolute or root-relative (and may carry a `#L` / `:line`
 * suffix already stripped by the caller, or still present — we only need the
 * filesystem path portion).
 */
export function authorizeOpenFile(
  rawPath: string,
  ctx: DesktopOpenFileContext,
): DesktopAuthResult {
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
    if (isExecutablePath(resolved.absPath)) {
      return { ok: false, reason: "executable path refused" };
    }
    return { ok: true };
  }
  return { ok: false, reason: "path escapes authorized roots" };
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
  if (msg.type === "openUrl") {
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
