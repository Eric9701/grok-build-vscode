/**
 * The two process calls Add project needs, behind an injectable seam.
 *
 * They live here rather than in sidebar.ts for two reasons. The obvious one is
 * testability: cloning a repository in a unit test is not an option, and
 * `githubCliPresent` would otherwise answer differently on every machine that
 * runs the suite. The other is a standing rule — sidebar.ts holds no bare
 * `execFile`, because every one-shot invocation of the *grok* CLI has to go
 * through `execGrokCli`'s Windows-shim policy, and a test enforces that by
 * banning the call shape outright.
 *
 * Neither of these is a grok CLI call, so neither wants that wrapper: `git` and
 * `where`/`which` are real binaries with no `.cmd` shim problem.
 */

import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from "node:child_process";

/** Injected process seam. Matches the shapes this module actually uses. */
export interface CloneIo {
  execFile: typeof nodeExecFile;
  execFileSync: typeof nodeExecFileSync;
}

const REAL_IO: CloneIo = { execFile: nodeExecFile, execFileSync: nodeExecFileSync };

/** Ten minutes. A big repository on a slow line is not a hang. */
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run `git clone <url> <dest>`.
 *
 * Resolves to the empty string on success, or git's combined output on failure
 * — never rejects, because every caller wants to classify the failure rather
 * than catch it.
 *
 * `GIT_TERMINAL_PROMPT=0` is the difference between a report and a hang: a
 * private repository otherwise makes git block on a username prompt against a
 * terminal that does not exist, and the form waits for ever instead of showing
 * an authentication failure it could offer to fix. `GCM_INTERACTIVE=never` does
 * the same job for Git Credential Manager on Windows, which pops its own window
 * rather than reading the terminal.
 *
 * `--` so a URL that somehow survived validation still cannot be read as a
 * flag. Git treats a leading dash as an option, which is how a remote address
 * becomes `--upload-pack=<command>` even though nothing here touches a shell.
 */
export function runGitClone(
  url: string,
  dest: string,
  io: CloneIo = REAL_IO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve) => {
    io.execFile(
      "git",
      ["clone", "--", url, dest],
      {
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        timeout: CLONE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve("");
          return;
        }
        resolve([String(stderr || ""), String(stdout || ""), error.message].join("\n"));
      },
    );
  });
}

/**
 * Whether `name` resolves on PATH.
 *
 * Only ever asked after a clone has already failed, so the synchronous call
 * never sits on the happy path. A throw means "no" — `where`/`which` exit
 * non-zero when they find nothing, and there is no other answer worth having.
 */
export function commandOnPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  io: CloneIo = REAL_IO,
): boolean {
  try {
    io.execFileSync(platform === "win32" ? "where" : "which", [name], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 4000,
    });
    return true;
  } catch {
    return false;
  }
}
