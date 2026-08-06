/**
 * Desktop-only authorization for renderer-originated Host actions.
 *
 * Schema validation ({@link parseWebviewMsg}) proves a message is *well-formed*.
 * This module decides whether the operation is *allowed* — the same role
 * {@link remote-policy} plays for AFK Pilot clients. VS Code never loads this
 * file; extension behaviour is unchanged.
 *
 * Applied in {@link ElectronWebview.dispatchMessage} before sidebar handlers
 * see `openFile` / `openUrl`. Containment reuses the file-tree canonical
 * check so chat links cannot bypass the panel's workspace fence.
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

export interface DesktopOpenFileContext {
  /** Absolute workspace root; openFile is refused when missing. */
  workspaceRoot: string | undefined;
  platform?: NodeJS.Platform;
  pathFs?: TreePathFs;
}

/**
 * True when the path's extension is one the OS may execute/launch as code.
 * Pure extension check — intentional; we do not inspect the executable bit
 * (chat-open is about deliberate document references, not "is this marked +x").
 */
export function isExecutablePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const base = path.basename(filePath);
  // Extensionless PE names are rare from chat; still refuse bare "setup" style?
  // Stick to extension policy so normal source files stay openable.
  const ext = path.extname(base).toLowerCase();
  if (!ext) return false;
  return EXECUTABLE_EXTS.has(ext);
}

/**
 * Authorize a chat `openFile` path: must resolve inside the workspace with the
 * same canonical containment as the file tree, and must not be an executable.
 *
 * `rawPath` may be absolute or workspace-relative (and may carry a `#L` / `:line`
 * suffix already stripped by the caller, or still present — we only need the
 * filesystem path portion). Callers typically pass the path after `parseFileRef`.
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
  const root = ctx.workspaceRoot?.trim();
  if (!root) {
    return { ok: false, reason: "no workspace root" };
  }

  // resolveTreePath accepts abs-inside or relative; rejects escape + symlink out.
  const resolved = resolveTreePath(
    root,
    rawPath,
    ctx.platform ?? process.platform,
    ctx.pathFs,
  );
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  if (isExecutablePath(resolved.absPath)) {
    return { ok: false, reason: "executable path refused" };
  }
  return { ok: true };
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
 * Policy gate for a parsed WebviewMsg. Returns the message unchanged when
 * allowed, or null when the operation must not reach Host/sidebar.
 *
 * Only `openFile` and `openUrl` are filtered today; everything else passes
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
  return { msg };
}
