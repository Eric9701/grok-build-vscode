/**
 * Impure: spawn `git worktree list --porcelain` for a repository.
 * Pure parsing lives in {@link parseGitWorktreeListPorcelain}.
 *
 * Kept out of sidebar.ts so one-shot *grok* invocations stay on execGrokCli
 * while git validation remains a separate, explicit boundary.
 */
import { execFile } from "node:child_process";
import { parseGitWorktreeListPorcelain } from "./worktree";

export function listGitWorktreePaths(
  repoPath: string,
  opts?: {
    execFileImpl?: typeof execFile;
    timeoutMs?: number;
    log?: (msg: string) => void;
  },
): Promise<string[]> {
  const run = opts?.execFileImpl ?? execFile;
  const timeout = opts?.timeoutMs ?? 15_000;
  return new Promise((resolve) => {
    try {
      run(
        "git",
        ["-C", repoPath, "worktree", "list", "--porcelain"],
        { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            opts?.log?.(`[worktree] git worktree list failed: ${err.message}`);
            resolve([]);
            return;
          }
          resolve(parseGitWorktreeListPorcelain(String(stdout ?? "")));
        },
      );
    } catch (e: any) {
      opts?.log?.(`[worktree] git worktree list spawn failed: ${e?.message ?? e}`);
      resolve([]);
    }
  });
}
