/**
 * Pure media-path trust checks shared by the host media forwarder and the
 * desktop resource registry.
 *
 * Generated media from ACP is only legitimate when it lives under Grok's
 * session tree (`…/sessions/…/images|videos/…`) with a media extension.
 * Lexical containment under `~/.grok` is **not** enough: a symlink that
 * starts inside the home and resolves outside must not be served or inlined
 * to remotes.
 *
 * Agent-reported paths outside that provenance may still be inlined as a
 * size-capped data: URI for the authenticated user (postGeneratedMedia) —
 * the agent already has full filesystem access. Renderer-named
 * `app-resource://` paths remain registry-contained.
 */
import * as path from "node:path";

const GENERATED_MEDIA_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
]);

/**
 * Cap for base64-inlining agent media into the DOM (and remote frames).
 * 8 MiB covers charts / screenshots / typical /imagine stills without
 * stuffing multi-dozen-MB videos into a data: string. Trusted session media
 * under grok home prefers asWebviewUri and is not bound by this for streaming.
 */
export const MAX_INLINE_MEDIA_BYTES = 8 * 1024 * 1024;

/** Free refuse: nothing legitimate reports the CLI credential as an image. */
export function isRefusedMediaBasename(fsPath: string): boolean {
  return /(^|[/\\])auth\.json$/i.test(fsPath || "");
}

/** Injectable realpath so tests can simulate symlink targets without OS privileges. */
export type RealpathFn = (p: string) => string;

/**
 * Refuse when the reported path **or** its canonical target is a secret name
 * (e.g. `chart.png` → symlink → `auth.json`). Missing/unresolvable paths fall
 * back to the reported basename only.
 */
export function isRefusedMediaPath(
  fsPath: string,
  realpath: RealpathFn = (p) => path.resolve(p),
): boolean {
  if (!fsPath) return false;
  if (isRefusedMediaBasename(fsPath)) return true;
  try {
    return isRefusedMediaBasename(realpath(fsPath));
  } catch {
    return false;
  }
}

/**
 * Decoded byte length of a base64 payload (padding-aware). Used to gate
 * ACP-inline media before it is emitted into the webview / relay.
 */
export function base64DecodedByteLength(b64: string): number {
  if (!b64 || typeof b64 !== "string") return 0;
  // Strip whitespace the wire sometimes inserts; count only payload chars.
  const s = b64.replace(/\s+/g, "");
  if (!s) return 0;
  let padding = 0;
  if (s.endsWith("==")) padding = 2;
  else if (s.endsWith("=")) padding = 1;
  return Math.floor((s.length * 3) / 4) - padding;
}

/**
 * Generated media path shape under a Grok home / sessions tree.
 * `…/sessions/<anything>/images|videos/<file.ext>`
 */
export function isGeneratedSessionMediaPath(fsPath: string): boolean {
  const n = path.normalize(fsPath).replace(/\\/g, "/");
  const ext = path.extname(n).toLowerCase();
  if (!GENERATED_MEDIA_EXT.has(ext)) return false;
  return /\/sessions\/.+\/(images|videos)\/[^/]+$/i.test(n);
}

/**
 * Segment-boundary containment (same contract as {@link isPathInside}):
 * `p` is strictly inside `root`, never `root` itself.
 */
export function isLexicallyInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * True when `fsPath` is trusted generated media under `mediaRoot`:
 * generated-session shape + media extension + **canonical** containment
 * (realpath of the file stays inside realpath of the root).
 *
 * When the file does not exist yet, falls back to lexical containment of the
 * link path so a race before the write is not a hard refuse of legitimate media.
 */
export function isTrustedGeneratedMediaPath(
  fsPath: string,
  mediaRoot: string,
  realpath: RealpathFn = (p) => path.resolve(p),
): boolean {
  if (!fsPath || !mediaRoot) return false;
  if (isRefusedMediaPath(fsPath, realpath)) return false;
  if (!isGeneratedSessionMediaPath(fsPath)) return false;

  try {
    const realRoot = realpath(mediaRoot);
    let realFile: string;
    try {
      realFile = realpath(fsPath);
    } catch {
      // Not on disk yet — lexical only.
      return isLexicallyInside(mediaRoot, fsPath);
    }
    if (isRefusedMediaBasename(realFile)) return false;
    // Real target must stay under the media root (strictly inside).
    if (!isLexicallyInside(realRoot, realFile)) return false;
    const ext = path.extname(realFile).toLowerCase();
    if (!GENERATED_MEDIA_EXT.has(ext)) return false;
    return true;
  } catch {
    return false;
  }
}
