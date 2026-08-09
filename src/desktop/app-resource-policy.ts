/**
 * Pure policy for which absolute paths the Electron `app-resource://` protocol
 * may serve. VS Code's webview sandbox makes a broad `localResourceRoots`
 * (including `~/.grok`) acceptable; Electron maps the same roots to direct
 * filesystem reads, so the protocol must narrow them.
 *
 * Two serve lanes:
 *   1. **Static full-serve roots** — extension `media/` / `resources/` and
 *      host staging dirs. Path-shaped URLs are allowed only when the path is
 *      **canonically** (realpath) inside a full-serve root.
 *   2. **Host-issued registry handles** — generated session media and any
 *      other host-chosen file. The renderer never invents these paths; the
 *      protocol looks up an opaque id and re-checks the realpath snapshot.
 *
 * Symlink / junction escape is refused the same way as the file-tree panel:
 * lexical containment is never enough.
 */
import * as path from "node:path";
import { canonicalPath, isCanonicallyInsideRoot, type TreePathFs } from "./file-tree";
import {
  registryIdFromUrlPath,
  type ResourceRegistry,
} from "./resource-registry";

/** Basenames of roots that may serve contained files via path-shaped URLs. */
const FULL_SERVE_ROOT_BASENAMES = new Set([
  "media",
  "resources",
  "image-staging",
  "file-staging",
]);

export type AppResourceRootPolicy = "full" | "media-only";

const RANGED_MEDIA_CONTENT_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
]);

/** Content types for the media files Chromium may request with byte ranges. */
export function mediaContentTypeForPath(fsPath: string): string | null {
  const extension = path.extname(fsPath).toLowerCase();
  return RANGED_MEDIA_CONTENT_TYPES.get(extension) ?? null;
}

export type ByteRangeResult =
  | { kind: "none" }
  | { kind: "single"; start: number; end: number }
  | { kind: "unsatisfiable"; size: number }
  | { kind: "ignore"; reason: "unit" | "multiple" | "malformed" };

/**
 * Parse one HTTP byte range against a known file size.
 *
 * Multiple ranges and anything outside the single-byte-range grammar are
 * deliberately reported as `ignore`: the handler falls back to a normal 200
 * response instead of claiming a satisfiable representation is unsatisfiable.
 * Chromium media requests use one byte range, which keeps this seam small.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ByteRangeResult {
  if (header == null || header.trim() === "") return { kind: "none" };
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("byte range size must be a non-negative safe integer");
  }

  const unit = /^([^=]+)=(.*)$/.exec(header.trim());
  if (!unit || unit[1].toLowerCase() !== "bytes") {
    return { kind: "ignore", reason: "unit" };
  }
  const specs = unit[2].split(",");
  if (specs.length !== 1) return { kind: "ignore", reason: "multiple" };

  const match = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(specs[0]);
  if (!match || (!match[1] && !match[2])) {
    return { kind: "ignore", reason: "malformed" };
  }

  const parseInteger = (value: string): number | null => {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const requestedStart = parseInteger(match[1]);
  const requestedEnd = parseInteger(match[2]);

  if (match[1]) {
    if (requestedStart == null || requestedStart >= size) {
      return { kind: "unsatisfiable", size };
    }
    if (requestedEnd != null && requestedEnd < requestedStart) {
      return { kind: "unsatisfiable", size };
    }
    return {
      kind: "single",
      start: requestedStart,
      end: Math.min(requestedEnd ?? size - 1, size - 1),
    };
  }

  // A suffix of zero bytes is unsatisfiable. A larger suffix simply means the
  // whole file, as required by the byte-range rules.
  if (requestedEnd == null || requestedEnd === 0 || size === 0) {
    return { kind: "unsatisfiable", size };
  }
  return {
    kind: "single",
    start: Math.max(0, size - requestedEnd),
    end: size - 1,
  };
}

export function rootServePolicy(rootFsPath: string): AppResourceRootPolicy {
  const base = path.basename(rootFsPath.replace(/[\\/]+$/, "")).toLowerCase();
  return FULL_SERVE_ROOT_BASENAMES.has(base) ? "full" : "media-only";
}

/**
 * True when `fsPath` is equal to or under `root` (segment-boundary safe,
 * lexical only). Prefer {@link isCanonicallyUnderRoot} at the trust boundary.
 */
export function isPathUnderRoot(fsPath: string, root: string): boolean {
  const target = path.normalize(fsPath);
  const r = path.normalize(root);
  if (target === r) return true;
  const rel = path.relative(r, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Realpath containment under a single root. Used for static full-serve paths.
 */
export function isCanonicallyUnderRoot(
  fsPath: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
): boolean {
  return isCanonicallyInsideRoot(root, fsPath, platform, pathFs);
}

/** Re-export: shared definition lives in media-serve.ts. */
export { isGeneratedSessionMediaPath } from "../media-serve";

/**
 * Whether a **path-shaped** app-resource URL may be served.
 * Only full-serve roots, and only after **canonical** containment.
 * Media-only roots (Grok home) always return false here — those files must
 * go through the host registry.
 */
export function appResourceMayServeStaticPath(
  fsPath: string,
  allowedRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
): boolean {
  if (!fsPath || !allowedRoots.length) return false;
  const target = path.normalize(fsPath);

  // Never serve the CLI credential file even if a root is misconfigured.
  if (/(^|[/\\])auth\.json$/i.test(target)) return false;

  for (const root of allowedRoots) {
    if (rootServePolicy(root) !== "full") continue;
    // Lexical first (cheap reject), then realpath containment.
    if (!isPathUnderRoot(target, root)) continue;
    if (!isCanonicallyUnderRoot(target, root, platform, pathFs)) continue;
    // Real target must also not be auth.json (symlink rename attack).
    try {
      const real = pathFs
        ? canonicalPath(target, pathFs)
        : canonicalPath(target);
      if (/(^|[/\\])auth\.json$/i.test(real)) return false;
    } catch {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * @deprecated Prefer {@link appResourceMayServeStaticPath} + registry.
 * Kept as a thin alias so older tests/call sites that only check static
 * full-serve behavior keep working. Media-only paths always fail.
 */
export function appResourceMayServe(
  fsPath: string,
  allowedRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
): boolean {
  return appResourceMayServeStaticPath(fsPath, allowedRoots, platform, pathFs);
}

export type AppResourceResolveResult =
  | { ok: true; fsPath: string; via: "registry" | "static" }
  | { ok: false; reason: string };

/**
 * Resolve an app-resource request to a serveable absolute path.
 * `urlPath` is the decoded URL pathname (e.g. from {@link appResourceUrlToFsPath}
 * helpers or raw URL parsing). Registry ids take precedence over path serving.
 */
export function resolveAppResourceServe(opts: {
  /** Full request URL or decoded pathname containing `/__reg__/<id>`. */
  urlOrPath: string;
  /** Absolute filesystem path decoded from a path-shaped URL (if any). */
  fsPath?: string;
  allowedRoots: readonly string[];
  registry: ResourceRegistry;
  platform?: NodeJS.Platform;
  pathFs?: TreePathFs;
}): AppResourceResolveResult {
  const platform = opts.platform ?? process.platform;
  const id =
    registryIdFromUrlPath(opts.urlOrPath) ||
    (opts.fsPath ? registryIdFromUrlPath(opts.fsPath) : null);
  if (id) {
    const served = opts.registry.resolveForServe(id);
    if (!served) return { ok: false, reason: "unknown or revoked media handle" };
    if (/(^|[/\\])auth\.json$/i.test(served)) {
      return { ok: false, reason: "credential path refused" };
    }
    return { ok: true, fsPath: served, via: "registry" };
  }

  const fsPath = opts.fsPath;
  if (!fsPath) return { ok: false, reason: "no path" };
  if (
    !appResourceMayServeStaticPath(
      fsPath,
      opts.allowedRoots,
      platform,
      opts.pathFs,
    )
  ) {
    return { ok: false, reason: "path not allowed" };
  }
  // Serve the canonical path so net.fetch cannot re-follow a different link.
  const real = opts.pathFs
    ? canonicalPath(fsPath, opts.pathFs)
    : canonicalPath(fsPath);
  return { ok: true, fsPath: real, via: "static" };
}
