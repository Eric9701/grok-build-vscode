/**
 * Projects are folders the person chose. On a VS Code host the rail used to
 * list every folder any agent's history mentioned -- on the owner's machine 212
 * of them for Grok alone, most only ever touched by benchmark harnesses, a
 * Codex app run that started Grok once per folder, and smoke tests. Those
 * harnesses drive the CLIs over the same protocol we use, so their history
 * carries no marker that tells them apart.
 *
 * Our own record does. `grok.sessionMeta` gains a send-time field only when a
 * message is sent through this host (desk, desktop or phone): that is the one
 * signal no harness produces. So the one-time initialization keeps the folders
 * where the person sent something in the last 30 days, and nothing from a CLI's
 * history adds a project after it.
 *
 * Pure: the caller supplies sessionMeta and the clock, checks the folders still
 * exist, and stores the result.
 */

import * as path from "node:path";
import { hasSentSignal, normalizeRepoPath, type SessionMetaOverrides } from "./sessions";

/** How far back the initialization looks for sends. */
export const PROJECT_INIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProjectInitOptions {
  /** Folders under these are never projects: the temp dir (smoke runs) and
   *  Grok's managed worktrees. */
  excludeRoots?: readonly string[];
  platform?: NodeJS.Platform;
  windowMs?: number;
}

function inside(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const a = normalizeRepoPath(candidate, platform);
  const b = normalizeRepoPath(root, platform);
  if (!a || !b) return false;
  const rel = path.relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The folders the person sent a message in through this host within the window,
 * newest send first, one per folder. A worktree conversation counts for the
 * project it was made from (`sourceGitRoot`). Only send-time fields are read:
 * `sentAt`, else the `activeAt` a send leaves (see `hasSentSignal`); a listing
 * stamps `provider`/`providerCwd`/`activeAt` on adapter rows and never a send,
 * so a listed-only conversation is never a candidate. A conversation with no
 * folder on record (before `providerCwd` was stamped, 2026-08-13) is older than
 * any window this is run with.
 */
export function foldersWithRecentSends(
  meta: SessionMetaOverrides,
  now: number,
  opts: ProjectInitOptions = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  const windowMs = opts.windowMs ?? PROJECT_INIT_WINDOW_MS;
  const newest = new Map<string, { cwd: string; at: number }>();
  for (const entry of Object.values(meta)) {
    if (!entry || !hasSentSignal(entry)) continue;
    const at = typeof entry.sentAt === "number" ? entry.sentAt : entry.activeAt;
    if (typeof at !== "number" || !Number.isFinite(at) || at < now - windowMs || at > now + 60_000) continue;
    const cwd = entry.worktreePath && entry.sourceGitRoot ? entry.sourceGitRoot : entry.providerCwd;
    if (!cwd || !path.isAbsolute(cwd)) continue;
    if ((opts.excludeRoots ?? []).some((root) => root && inside(cwd, root, platform))) continue;
    const key = normalizeRepoPath(cwd, platform);
    if (!key) continue;
    const seen = newest.get(key);
    if (!seen || at > seen.at) newest.set(key, { cwd: seen?.cwd ?? cwd, at });
  }
  return [...newest.values()].sort((a, b) => b.at - a.at).map((f) => f.cwd);
}
