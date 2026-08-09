/**
 * Read-only project file access for remote (phone / browser) clients.
 *
 * ## This pass is READ-ONLY — deliberate, not forgotten
 *
 * Browse directories, open one file, read its contents. No write, save, delete,
 * rename, mkdir, or bulk/large-file download. Editing from a relay would need
 * version stamps, conflict UI, and executable-write policy that the desktop
 * panel already owns; do not grow this module into that without a separate
 * design.
 *
 * ## Fence composition (do not invent a second root)
 *
 * 1. **Which root** — {@link repoScopeFor}: for a remote origin, that tab's
 *    selected repo cwd. Remote file access inherits the same per-tab cross-repo
 *    isolation as history / New session, instead of opening a second,
 *    differently-wrong boundary. A phone deliberately reaches *less* than the
 *    desktop panel (which roots at the whole workspace).
 * 2. **Which paths inside it** — {@link resolveTreePath} / {@link listTreeDir} /
 *    {@link readTreeFile}: refuses traversal, refuses outbound symlinks/
 *    junctions, re-resolves before use (TOCTOU). Same containment the desktop
 *    panel uses; pure and unit-tested there.
 *
 * Preview classification reuses {@link classifyFilePreview} (and its byte caps)
 * so remote and desktop never disagree on which extensions are text vs binary.
 */

import {
  listTreeDir,
  readTreeFile,
  type ListTreeResult,
  type ReadTreeFileResult,
  type TreePathFs,
} from "./file-tree";
import { repoScopeFor, type MsgOrigin } from "./remote-policy";

/** Cap constants re-exported so callers document the same ceiling. */
export {
  FILE_PREVIEW_MAX_BYTES,
  FILE_PREVIEW_MAX_IMAGE_BYTES,
  FILE_TREE_MAX_ENTRIES,
} from "./file-tree";

export type RemoteFileRootResult =
  | { ok: true; root: string }
  | { ok: false; reason: string };

/**
 * Resolve the filesystem root a remote (or local) message may browse.
 *
 * `claimedCwd` is the cwd the client put on the wire. It must:
 * - be a catalog cwd the host already published (`isKnownCwd`) — otherwise
 *   `allowRemoteRepoTarget`'s default-true trap would let a remote name an
 *   arbitrary path that never appears in the switcher;
 * - equal the tab's scoped root from {@link repoScopeFor} — a known-but-other
 *   checkout would let the phone read a second repo without selecting it first.
 */
export function resolveRemoteFileRoot(opts: {
  origin: MsgOrigin;
  claimedCwd: string;
  selectedCwd: string;
  workspaceRoot: string;
  isKnownCwd: (cwd: string) => boolean;
  sameCwd: (a: string, b: string) => boolean;
}): RemoteFileRootResult {
  if (typeof opts.claimedCwd !== "string" || !opts.claimedCwd) {
    return { ok: false, reason: "missing cwd" };
  }
  // Unknown cwd first: this is the allowRemoteRepoTarget trap. Everything not
  // listed there falls through to true; listing these message types is what
  // makes a forged cwd fail closed.
  if (!opts.isKnownCwd(opts.claimedCwd)) {
    return { ok: false, reason: "cwd was not discovered" };
  }
  const root = repoScopeFor(opts.origin, {
    selectedCwd: opts.selectedCwd,
    workspaceRoot: opts.workspaceRoot,
  });
  if (!root) {
    return { ok: false, reason: "no repository scope" };
  }
  // Per-tab isolation: the claim must be the root this tab is already in.
  // selectRepo is the legitimate way to change that root (view-tier).
  if (!opts.sameCwd(opts.claimedCwd, root)) {
    return { ok: false, reason: "cwd is not this tab's selected repository" };
  }
  return { ok: true, root };
}

/**
 * List one directory under the remote file root. Containment is entirely
 * {@link listTreeDir}'s (canonical + outbound-symlink drop).
 */
export function listRemoteProjectDir(
  root: string,
  relPath: string = "",
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
): ListTreeResult {
  return listTreeDir(root, relPath || "", undefined, platform, pathFs);
}

/**
 * Read one file for the in-page remote viewer. Uses {@link readTreeFile}:
 * text/markdown/json/image only, byte-capped, binary refused. Never returns
 * absolute host paths to the wire — callers must strip `absPath`.
 *
 * Unsupported kinds (`external`) and oversize files fail closed for remote:
 * a phone has no OS open hand-off.
 */
export function readRemoteProjectFile(
  root: string,
  relPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
  readFileSync?: (p: string) => Buffer,
): ReadTreeFileResult {
  return readTreeFile(root, relPath, platform, pathFs, readFileSync);
}

/** Wire-safe success payload: no absPath, no stamp/editor fields. */
export type RemoteProjectFileWire =
  | {
      ok: true;
      kind: "markdown" | "json" | "image" | "text";
      relPath: string;
      text?: string;
      dataUrl?: string;
      pretty?: boolean;
    }
  | { ok: false; reason: string };

/**
 * Strip host-only fields from a read result before it crosses the relay.
 * Absolute paths must never leave the machine; stamps are for desktop save.
 */
export function projectFileContentForWire(result: ReadTreeFileResult): RemoteProjectFileWire {
  if (!result.ok) {
    // Map "open externally" to a clear remote reason — no OS hand-off on a phone.
    if (result.openExternal) {
      return {
        ok: false,
        reason: result.reason === "open externally"
          ? "file type not previewable"
          : result.reason,
      };
    }
    return { ok: false, reason: result.reason };
  }
  return {
    ok: true,
    kind: result.kind,
    relPath: result.relPath,
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.dataUrl !== undefined ? { dataUrl: result.dataUrl } : {}),
    ...(result.pretty !== undefined ? { pretty: result.pretty } : {}),
  };
}
