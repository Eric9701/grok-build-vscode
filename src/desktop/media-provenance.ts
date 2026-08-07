/**
 * Desktop registry registration gate — builds on shared {@link media-serve}
 * plus file-tree canonical containment for full-serve / media-only roots.
 */
import * as path from "node:path";
import {
  isGeneratedSessionMediaPath,
  isTrustedGeneratedMediaPath as sharedTrustedMedia,
} from "../media-serve";
import {
  canonicalPath,
  isCanonicallyInsideRoot,
  type TreePathFs,
} from "./file-tree";

const MEDIA_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
]);

export { isGeneratedSessionMediaPath };

export function hasMediaExtension(fsPath: string): boolean {
  return MEDIA_EXT.has(path.extname(fsPath).toLowerCase());
}

/** Desktop wrapper: realpath via file-tree canonicalPath. */
export function isTrustedGeneratedMediaPath(
  fsPath: string,
  mediaRoot: string,
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
): boolean {
  void platform;
  const realpath = (p: string) =>
    pathFs ? canonicalPath(p, pathFs) : canonicalPath(p);
  return sharedTrustedMedia(fsPath, mediaRoot, realpath);
}

/**
 * Whether a path may be registered for app-resource serve.
 * - Full-serve roots: any file canonically inside (static assets, staging).
 * - Media-only roots (Grok home): only trusted generated session media.
 */
export function mayRegisterResourcePath(
  fsPath: string,
  allowedRoots: readonly string[],
  rootPolicy: (root: string) => "full" | "media-only",
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
): boolean {
  if (!fsPath || !allowedRoots.length) return false;
  if (/(^|[/\\])auth\.json$/i.test(fsPath)) return false;

  let real: string;
  try {
    real = pathFs ? canonicalPath(fsPath, pathFs) : canonicalPath(fsPath);
  } catch {
    return false;
  }
  if (/(^|[/\\])auth\.json$/i.test(real)) return false;

  for (const root of allowedRoots) {
    if (!isCanonicallyInsideRoot(root, real, platform, pathFs)) continue;
    const policy = rootPolicy(root);
    if (policy === "full") return true;
    if (
      isTrustedGeneratedMediaPath(fsPath, root, platform, pathFs) ||
      isTrustedGeneratedMediaPath(real, root, platform, pathFs)
    ) {
      return true;
    }
  }
  return false;
}
