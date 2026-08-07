/**
 * Host-issued opaque handles for filesystem resources the webview may load.
 *
 * The renderer is untrusted: it must not invent paths into `~/.grok` (or anywhere
 * else). When the host decides a file is legitimate media (ACP-generated image,
 * staged vision chip, …) it registers the absolute path and hands the webview
 * only the opaque id. The `app-resource://` protocol resolves that id — never a
 * free-form path under media-only roots.
 *
 * At register time we snapshot the **canonical** (realpath) target. At serve
 * time the path is re-resolved; if the real target changed (symlink swap) the
 * serve is refused. That is the same property the file-tree uses, applied to
 * the resource protocol.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { rootServePolicy } from "./app-resource-policy";
import { mayRegisterResourcePath } from "./media-provenance";
import { canonicalPath, type TreePathFs } from "./file-tree";

export interface RegisteredResource {
  /** Absolute path as registered (may be a symlink whose real target is inside). */
  fsPath: string;
  /** realpath snapshot at registration — serve refuses when this diverges. */
  realPath: string;
}

export interface ResourceRegistryFs {
  realpathSync(p: string): string;
  existsSync(p: string): boolean;
  statSync(p: string): fs.Stats;
}

export interface RegisterResourceOptions {
  /**
   * When set, the canonical target must stay inside an approved root
   * (full-serve: any file; media-only: generated session media only).
   * Omit only in pure unit tests that pin swap detection without roots.
   */
  allowedRoots?: readonly string[];
  platform?: NodeJS.Platform;
}

const defaultFs: ResourceRegistryFs = {
  realpathSync: (p) => fs.realpathSync(p),
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
};

function toTreeFs(pathFs: ResourceRegistryFs): TreePathFs {
  return {
    realpathSync: pathFs.realpathSync,
    existsSync: pathFs.existsSync,
    statSync: pathFs.statSync,
    readdirSync: () => {
      throw new Error("readdir not used by resource registry");
    },
  };
}

/** Opaque-id segment in app-resource URLs: `/__reg__/<id>`. */
export const RESOURCE_REGISTRY_URL_SEGMENT = "__reg__";

export function isResourceRegistryId(id: string): boolean {
  return typeof id === "string" && /^[a-f0-9]{32}$/i.test(id);
}

/**
 * Extract a registry id from a decoded URL pathname (POSIX-style), or null.
 * Accepts `/__reg__/<id>` and Windows-ish variants with backslashes.
 */
export function registryIdFromUrlPath(urlPath: string): string | null {
  if (typeof urlPath !== "string" || !urlPath) return null;
  const n = urlPath.replace(/\\/g, "/");
  // Leading drive letter forms: /C:/__reg__/id should not match; only the segment.
  const m = n.match(/(?:^|\/)__reg__\/([a-f0-9]{32})(?:\/)?$/i);
  return m ? m[1].toLowerCase() : null;
}

export class ResourceRegistry {
  private readonly byId = new Map<string, RegisteredResource>();
  /** Normalized absolute path → id (reuse handle when the same file is re-served). */
  private readonly byPath = new Map<string, string>();

  constructor(private readonly pathFs: ResourceRegistryFs = defaultFs) {}

  /**
   * Register an absolute filesystem path and return an opaque id.
   * Refuses missing paths, non-files, and (when {@link RegisterResourceOptions.allowedRoots}
   * is set) paths whose **canonical** target leaves every approved root or
   * fails media provenance under a media-only root.
   * Re-registering the same path returns the same id and refreshes the snapshot.
   */
  register(fsPath: string, opts?: RegisterResourceOptions): string {
    if (!fsPath || typeof fsPath !== "string") {
      throw new Error("resource registry: empty path");
    }
    const abs = path.resolve(fsPath);
    if (/(^|[/\\])auth\.json$/i.test(abs)) {
      throw new Error("resource registry: credential path refused");
    }
    let st: fs.Stats;
    try {
      st = this.pathFs.statSync(abs);
    } catch {
      throw new Error(`resource registry: not found: ${abs}`);
    }
    if (!st.isFile()) {
      throw new Error(`resource registry: not a file: ${abs}`);
    }
    const treeFs = toTreeFs(this.pathFs);
    const real = canonicalPath(abs, treeFs);
    // Refuse even when the path is a symlink whose real target is auth.json.
    if (/(^|[/\\])auth\.json$/i.test(real)) {
      throw new Error("resource registry: credential target refused");
    }
    const roots = opts?.allowedRoots;
    if (roots && roots.length > 0) {
      const platform = opts?.platform ?? process.platform;
      if (
        !mayRegisterResourcePath(abs, roots, rootServePolicy, platform, treeFs)
      ) {
        throw new Error(
          "resource registry: path not under an approved media root",
        );
      }
    }
    const key = path.normalize(abs);
    const existing = this.byPath.get(key);
    if (existing) {
      this.byId.set(existing, { fsPath: abs, realPath: real });
      return existing;
    }
    const id = crypto.randomBytes(16).toString("hex");
    this.byId.set(id, { fsPath: abs, realPath: real });
    this.byPath.set(key, id);
    return id;
  }

  /**
   * Resolve a registry id to a serveable absolute path.
   * Returns null when the id is unknown, the file is gone, or the canonical
   * target has changed since registration (symlink / replace attack).
   */
  resolveForServe(id: string): string | null {
    if (!isResourceRegistryId(id)) return null;
    const entry = this.byId.get(id.toLowerCase()) ?? this.byId.get(id);
    if (!entry) return null;
    try {
      const st = this.pathFs.statSync(entry.fsPath);
      if (!st.isFile()) return null;
    } catch {
      return null;
    }
    const real = canonicalPath(entry.fsPath, toTreeFs(this.pathFs));
    // Case-insensitive compare on Windows so drive-letter casing cannot strip a
    // legitimate serve after a re-realpath.
    const a = process.platform === "win32" ? real.toLowerCase() : real;
    const b = process.platform === "win32" ? entry.realPath.toLowerCase() : entry.realPath;
    if (a !== b) return null;
    return real;
  }

  /** Test / diagnostics. */
  size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.byPath.clear();
  }
}
