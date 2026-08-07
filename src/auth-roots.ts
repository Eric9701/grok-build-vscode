/**
 * Which directories a message from a given session may reach.
 *
 * Pure, and separate from sidebar.ts on purpose: the rule it encodes is a
 * security boundary, and a boundary that can only be tested by asserting on the
 * shape of its own source code is not really tested at all. Everything here is
 * decidable from arguments, so the interesting cases are ordinary assertions.
 *
 * Two conditions, both necessary:
 *   1. the folder is one the host has open (the caller's `isAuthorized`), and
 *   2. it belongs to the session that sent the message.
 *
 * (2) is the one that was missing. Desktop returned every open project, so a
 * message from a session in repo A could open or diff a file in repo B just
 * because B was also open. Being open is what makes a folder reachable at all;
 * it is not what makes it this session's business.
 */
import * as path from "node:path";

export interface SessionScopedRootsInput {
  /** The cwd of the session the message came from. */
  sessionCwd?: string;
  /** That session's worktree, when it is working in one. */
  worktreePath?: string;
  /** The checkout the worktree was branched from. */
  worktreeSourceRoot?: string;
  /** Active folder, used only when the session has no cwd of its own yet. */
  activeRoot?: string;
  /** Host-owned open-folder test. */
  isAuthorized: (cwd: string) => boolean;
  /** Defaults to the running platform; injectable so both casings are testable. */
  platform?: NodeJS.Platform;
}

export function sessionScopedRoots(input: SessionScopedRootsInput): string[] {
  const platform = input.platform ?? process.platform;
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p || typeof p !== "string") return;
    const abs = path.resolve(p);
    const key = platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(abs);
  };

  const cwd = input.sessionCwd;
  if (cwd && input.isAuthorized(cwd)) {
    add(cwd);
    // The session's own worktree travels with it: host-created, under this
    // session's repo, and where its files actually live. It is not separately
    // "open", so it cannot be gated on the open set without breaking every
    // worktree session.
    add(input.worktreePath);
    add(input.worktreeSourceRoot);
    return roots;
  }

  // A session with no cwd of its own — a fresh window before anything has been
  // opened. Fall back to the active folder so the panel and chrome have a root,
  // under the same open-set check.
  if (input.activeRoot && input.isAuthorized(input.activeRoot)) add(input.activeRoot);
  return roots;
}
