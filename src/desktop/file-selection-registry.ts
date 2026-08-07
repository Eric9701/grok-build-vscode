/**
 * Host-issued opaque handles for user-selected files (OS picker / genuine drop).
 *
 * Same shape as {@link ResourceRegistry}: the renderer never invents a path the
 * host will open. A drop/pick registers the absolute path and returns a
 * high-entropy id; `dropFile` carries only that id. Unknown or already-consumed
 * ids resolve to nothing.
 *
 * At register we snapshot the canonical (realpath) target; at take we refuse
 * when the real target diverged (symlink swap between pick and attach).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalPath, type TreePathFs } from "./file-tree";

export interface FileSelectionRegistryFs {
  realpathSync(p: string): string;
  existsSync(p: string): boolean;
  statSync(p: string): fs.Stats;
}

export interface RegisteredSelection {
  fsPath: string;
  realPath: string;
}

const defaultFs: FileSelectionRegistryFs = {
  realpathSync: (p) => fs.realpathSync(p),
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
};

function toTreeFs(pathFs: FileSelectionRegistryFs): TreePathFs {
  return {
    realpathSync: pathFs.realpathSync,
    existsSync: pathFs.existsSync,
    statSync: pathFs.statSync,
    readdirSync: () => {
      throw new Error("readdir not used by file selection registry");
    },
  };
}

/** Opaque handle: 32 hex chars (same density as media resource ids). */
export function isFileSelectionId(id: string): boolean {
  return typeof id === "string" && /^[a-f0-9]{32}$/i.test(id);
}

export class FileSelectionRegistry {
  private readonly byId = new Map<string, RegisteredSelection>();

  constructor(private readonly pathFs: FileSelectionRegistryFs = defaultFs) {}

  /**
   * Register an absolute path chosen by a genuine user gesture (dialog / OS drop).
   * Refuses missing paths, non-files, and credential files.
   */
  register(fsPath: string): string {
    if (!fsPath || typeof fsPath !== "string") {
      throw new Error("file selection: empty path");
    }
    const abs = path.resolve(fsPath);
    if (/(^|[/\\])auth\.json$/i.test(abs)) {
      throw new Error("file selection: credential path refused");
    }
    let st: fs.Stats;
    try {
      st = this.pathFs.statSync(abs);
    } catch {
      throw new Error(`file selection: not found: ${abs}`);
    }
    if (!st.isFile()) {
      throw new Error(`file selection: not a file: ${abs}`);
    }
    const real = canonicalPath(abs, toTreeFs(this.pathFs));
    if (/(^|[/\\])auth\.json$/i.test(real)) {
      throw new Error("file selection: credential target refused");
    }
    const id = crypto.randomBytes(16).toString("hex");
    this.byId.set(id, { fsPath: abs, realPath: real });
    return id;
  }

  /**
   * One-shot resolve: returns the absolute path or null when the id is unknown,
   * the file is gone, or the canonical target changed since registration.
   * Consumes the handle so a replay cannot re-attach.
   */
  take(id: string): string | null {
    if (!isFileSelectionId(id)) return null;
    const key = id.toLowerCase();
    const entry = this.byId.get(key) ?? this.byId.get(id);
    if (!entry) return null;
    this.byId.delete(key);
    this.byId.delete(id);
    try {
      const st = this.pathFs.statSync(entry.fsPath);
      if (!st.isFile()) return null;
    } catch {
      return null;
    }
    const real = canonicalPath(entry.fsPath, toTreeFs(this.pathFs));
    const a = process.platform === "win32" ? real.toLowerCase() : real;
    const b = process.platform === "win32" ? entry.realPath.toLowerCase() : entry.realPath;
    if (a !== b) return null;
    if (/(^|[/\\])auth\.json$/i.test(real)) return null;
    return entry.fsPath;
  }

  size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
  }
}
