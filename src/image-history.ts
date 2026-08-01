import path from "node:path";

/** The suffix used for workspace-origin images in the persisted prompt. */
export const WORKSPACE_IMAGE_TAG_HINT =
  "attached inline; act on the path if needed, but do not Read it";

/** The suffix used for pasted images. The basename is only a correlation hint. */
export const STAGED_IMAGE_TAG_HINT =
  "local staged copy; thumbnail only; do not access this path";

export interface HistoryImagePreview {
  imageIndex: number;
  path?: string;
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[/\\]{1,2}/.test(value);
}

function safeChildPath(root: string, relative: string): string | undefined {
  if (!relative || relative.includes("..") || isAbsolutePath(relative)) return undefined;
  const rootPath = path.resolve(root);
  const candidate = path.resolve(rootPath, relative);
  const remainder = path.relative(rootPath, candidate);
  if (!remainder || remainder === ".." || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder)) {
    return undefined;
  }
  return candidate;
}

function stagedPreviewPath(stagingDir: string, basename: string): string | undefined {
  if (!basename || basename === "." || basename === ".." || basename.includes("..")) return undefined;
  if (/[\\/]/.test(basename) || isAbsolutePath(basename)) return undefined;
  return path.join(stagingDir, basename);
}

function workspacePreviewPath(workspaceRoot: string, relative: string): string | undefined {
  return safeChildPath(workspaceRoot, relative);
}

/** Resolve image tag hints without touching the filesystem. The caller decides
 * whether the resolved path exists before turning it into a preview URI. */
export function historyImagePreviews(
  text: string,
  stagingDir: string,
  workspaceRoot: string,
): HistoryImagePreview[] {
  const images: HistoryImagePreview[] = [];
  const lineRe = /^\[Image #(\d+)\](?: \(([^\r\n]*)\))?$/gm;
  const inlineHint = ` — ${WORKSPACE_IMAGE_TAG_HINT}`;
  const stagedHint = ` — ${STAGED_IMAGE_TAG_HINT}`;
  for (const match of text.matchAll(lineRe)) {
    const imageIndex = Number(match[1]);
    if (!Number.isSafeInteger(imageIndex)) continue;
    const detail = match[2]?.trim();
    let resolved: string | undefined;
    if (detail?.endsWith(stagedHint)) {
      const basename = detail.slice(0, -stagedHint.length).trim();
      resolved = stagedPreviewPath(stagingDir, basename);
    } else if (detail && !/^attached inline\b/i.test(detail)) {
      const cut = detail.indexOf(inlineHint);
      const relative = (cut === -1 ? detail : detail.slice(0, cut)).trim();
      if (relative) resolved = workspacePreviewPath(workspaceRoot, relative);
    }
    images.push({ imageIndex, ...(resolved ? { path: resolved } : {}) });
  }
  return images;
}

