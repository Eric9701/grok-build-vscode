/**
 * Pure policy for which absolute paths the Electron `app-resource://` protocol
 * may serve. VS Code's webview sandbox makes a broad `localResourceRoots`
 * (including `~/.grok`) acceptable; Electron maps the same roots to direct
 * filesystem reads, so the protocol must narrow them.
 *
 * Allowed:
 *   - extension assets / staging dirs (roots whose basename is a known asset root)
 *   - generated session media under Grok home: `…/sessions/…/images|videos/*`
 *
 * Refused:
 *   - `auth.json` and other credential/config/history files under `~/.grok`
 *   - any other path under a media-only root (the whole Grok home is media-only)
 */
import * as path from "node:path";

/** Basenames of roots that may serve any contained file (not credentials). */
const FULL_SERVE_ROOT_BASENAMES = new Set([
  "media",
  "resources",
  "image-staging",
  "file-staging",
]);

/** Extensions of agent-generated media we stream from session dirs. */
const GENERATED_MEDIA_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
]);

export type AppResourceRootPolicy = "full" | "media-only";

export function rootServePolicy(rootFsPath: string): AppResourceRootPolicy {
  const base = path.basename(rootFsPath.replace(/[\\/]+$/, "")).toLowerCase();
  return FULL_SERVE_ROOT_BASENAMES.has(base) ? "full" : "media-only";
}

/**
 * True when `fsPath` is equal to or under `root` (segment-boundary safe,
 * lexical only — callers already resolved the URL to a path).
 */
export function isPathUnderRoot(fsPath: string, root: string): boolean {
  const target = path.normalize(fsPath);
  const r = path.normalize(root);
  if (target === r) return true;
  const rel = path.relative(r, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Generated media path shape under a Grok home / sessions tree:
 * `…/sessions/<anything>/images|videos/<file.ext>`
 */
export function isGeneratedSessionMediaPath(fsPath: string): boolean {
  const n = path.normalize(fsPath).replace(/\\/g, "/");
  const ext = path.extname(n).toLowerCase();
  if (!GENERATED_MEDIA_EXT.has(ext)) return false;
  // Require the two parent segments to be images|videos under sessions.
  return /\/sessions\/.+\/(images|videos)\/[^/]+$/i.test(n);
}

/**
 * Whether the app-resource protocol may serve `fsPath` given the webview's
 * localResourceRoots. Roots are necessary; media-only roots (Grok home) are
 * not sufficient without the generated-media path shape.
 */
export function appResourceMayServe(fsPath: string, allowedRoots: readonly string[]): boolean {
  if (!fsPath || !allowedRoots.length) return false;
  const target = path.normalize(fsPath);

  // Never serve the CLI credential file even if a root is misconfigured.
  if (/(^|[/\\])auth\.json$/i.test(target)) return false;

  let underAny = false;
  for (const root of allowedRoots) {
    if (!isPathUnderRoot(target, root)) continue;
    underAny = true;
    const policy = rootServePolicy(root);
    if (policy === "full") return true;
    // media-only root: only generated session media.
    if (isGeneratedSessionMediaPath(target)) return true;
  }
  return false;
}
