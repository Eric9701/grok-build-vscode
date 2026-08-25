/**
 * Making a project, rather than finding one.
 *
 * `addProjectFolder` opens a native picker and takes whatever path comes back.
 * That is the right shape for a folder that already exists and the wrong shape
 * for everything else: a knowledge-work user starting their first piece of work
 * has no folder to point at, and a phone has no picker to open.
 *
 * So the two new ways in take a NAME or a URL — never a path. The destination
 * is derived here, inside one configured root, and checked to be inside it
 * afterwards. That is the whole containment model, and it is what lets these
 * be reachable from a remote when `addProjectFolder` never could: a remote
 * cannot say WHERE, only WHAT.
 *
 * Pure. No I/O, no `vscode`, no process spawning — the caller does all three.
 */

import * as path from "node:path";
import { DEFAULT_PROJECT_DIRNAME } from "./desktop/paths";

/** Longest project name we will make a folder for. */
export const PROJECT_NAME_MAX = 64;

/**
 * Windows device names. Reserved with OR without an extension and regardless of
 * case, and creating one fails in ways that do not look like a naming problem.
 */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Characters no folder name may carry on the strictest platform we ship to. */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/;

/**
 * The one directory new projects are created in.
 *
 * `~/Grok Build` — the same location `provisionDefaultProjectDir` already
 * chose for the first-run folder, and for the same reasons: on macOS it is not
 * TCC-protected (unlike Desktop / Documents / Downloads) so creating it raises
 * no consent dialog, and it is findable in Finder without being hidden.
 *
 * A single root is not tidiness. It is what makes a remote-supplied name safe:
 * the client says what to call it, the host says where it goes.
 */
export function projectRoot(homeDir: string): string {
  return path.join(homeDir, DEFAULT_PROJECT_DIRNAME);
}

/** `~/Grok Build`-style display form, so the UI never prints a home path. */
export function displayPath(fullPath: string, homeDir: string): string {
  if (!homeDir) return fullPath;
  const rel = path.relative(homeDir, fullPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return fullPath;
  return `~/${rel.split(path.sep).join("/")}`;
}

/**
 * Why this name cannot become a folder, or null if it can.
 *
 * Messages are the user-facing copy — they say what is wrong and what to do,
 * because the alternative is a native error about an invalid argument.
 */
export function projectNameError(raw: unknown): string | null {
  if (typeof raw !== "string") return "Enter a name for the project.";
  const name = raw.trim();
  if (!name) return "Enter a name for the project.";
  if (name.length > PROJECT_NAME_MAX) {
    return `Names are limited to ${PROJECT_NAME_MAX} characters.`;
  }
  if (ILLEGAL_NAME_CHARS.test(name)) {
    return "A name can't contain \\ / : * ? \" < > or |.";
  }
  // "." and ".." are directory entries, not names; a leading dot merely hides
  // the folder, which is a surprise rather than an error but not what anyone
  // meant to ask for on this screen.
  if (/^\.+$/.test(name)) return "Choose a name, not dots.";
  if (name.startsWith(".")) return "A name starting with a dot would hide the folder.";
  // Windows silently strips these, so `Report.` becomes `Report` and the folder
  // the user is then looking at is not the one they named.
  if (/[. ]$/.test(name)) return "A name can't end with a space or a dot.";
  const stem = name.split(".")[0].toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) {
    return `"${name}" is a reserved name on Windows.`;
  }
  return null;
}

/**
 * Where a named project goes, or null if the name is unusable.
 *
 * The containment check is deliberately made against the RESOLVED path rather
 * than trusted from the validation above: the two disagreeing is exactly the
 * bug class this guards, and one cheap comparison beats reasoning about which
 * separator a platform folds.
 */
export function projectDestination(root: string, name: string): string | null {
  if (projectNameError(name)) return null;
  const full = path.resolve(root, name.trim());
  return withinRoot(root, full) ? full : null;
}

/** Whether `candidate` is a direct child of `root`. Case-folded on Windows. */
export function withinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  // A direct child only — nothing may write into a nested path a name implied.
  return !rel.includes(path.sep);
}

/**
 * Git remotes we will hand to `git clone`, and the folder each produces.
 *
 * Deliberately a small allowlist rather than a blocklist. Git's remote syntax
 * reaches further than it looks: `ext::sh -c ...` runs a command, and a URL
 * beginning with `-` is read by git as an OPTION, which is how
 * `--upload-pack=<anything>` becomes arbitrary execution even though the args
 * are passed as an array and never touch a shell. Both are refused here rather
 * than sanitised.
 */
export function cloneUrlError(raw: unknown): string | null {
  if (typeof raw !== "string") return "Paste a repository URL.";
  const url = raw.trim();
  if (!url) return "Paste a repository URL.";
  if (url.length > 512) return "That URL is too long.";
  if (/\s/.test(url)) return "That doesn't look like a repository URL.";
  // Argument injection: git reads a leading dash as a flag, not an address.
  if (url.startsWith("-")) return "That doesn't look like a repository URL.";
  const httpish = /^https?:\/\/[^/]+\/.+/i.test(url);
  const sshUrl = /^ssh:\/\/[^/]+\/.+/i.test(url);
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:]+$/.test(url);
  if (!httpish && !sshUrl && !scp) {
    return "Use an https:// or git@ repository URL.";
  }
  if (!repoNameFromCloneUrl(url)) return "That URL doesn't name a repository.";
  return null;
}

/**
 * The folder `git clone <url>` would create — the last path segment, minus
 * `.git`, minus any query or fragment.
 *
 * Returns null when the result would not be a usable folder name, which is the
 * same test the typed-name path uses. A URL ending in `/` or naming only a host
 * gets nothing rather than an empty folder.
 */
export function repoNameFromCloneUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url = raw.trim();
  if (!url) return null;
  url = url.split("#")[0].split("?")[0].replace(/\/+$/, "");
  // Drop the scheme, then everything up to and including the host separator.
  // Doing this BEFORE taking the last segment is what stops `https://github.com`
  // — a URL naming only a host — from producing a project called "github.com".
  url = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  const cut = url.search(/[/:]/);
  if (cut < 0) return null;
  const afterHost = url.slice(cut + 1);
  if (!afterHost) return null;
  const segment = afterHost.split(/[/:]/).pop() || "";
  const name = segment.replace(/\.git$/i, "").trim();
  if (!name) return null;
  return projectNameError(name) ? null : name;
}

/** Where a cloned repository lands, or null if the URL yields no usable name. */
export function cloneDestination(root: string, url: string): string | null {
  const name = repoNameFromCloneUrl(url);
  return name ? projectDestination(root, name) : null;
}

/**
 * Classify a failed `git clone` from its combined output.
 *
 * The point is not diagnosis for its own sake — it decides which affordance the
 * form offers next. An authentication failure is the one case where we can do
 * something FOR the user (run `gh auth login`), and a missing `gh` is the one
 * before that. Everything else is reported as-is, because guessing at a network
 * or a typo'd URL helps nobody.
 */
export type CloneFailure = "auth" | "not-found" | "exists" | "no-git" | "other";

export function classifyCloneFailure(output: string): CloneFailure {
  const text = String(output || "").toLowerCase();
  if (/could not resolve host|connection refused|network is unreachable|timed out/.test(text)) {
    return "other";
  }
  if (/'git' is not recognized|command not found: git|spawn git enoent|no such file or directory: git/.test(text)) {
    return "no-git";
  }
  if (/already exists and is not an empty directory|destination path .* already exists/.test(text)) {
    return "exists";
  }
  if (
    /authentication failed|could not read username|permission denied \(publickey\)|invalid username or password|terminal prompts disabled|403 forbidden/.test(text)
  ) {
    return "auth";
  }
  // GitHub answers a private repo you cannot see with a 404, not a 403 — so a
  // "not found" on github.com is far more often a permissions problem than a
  // typo, and offering sign-in there is the useful answer.
  if (/repository not found|not found|404/.test(text)) return "not-found";
  return "other";
}

/**
 * What to tell the user about a failed clone.
 *
 * Git's own output is the last resort, not the first: `fatal: could not read
 * Username for 'https://github.com': terminal prompts disabled` is accurate and
 * says nothing a person can act on. Where we recognise the failure we say what
 * it means; where we do not, we pass the real text through rather than
 * inventing a friendlier lie.
 */
export function cloneFailureText(kind: CloneFailure, raw: string): string {
  switch (kind) {
    case "no-git":
      return "Git isn't installed on this machine. Install it, then try again.";
    case "exists":
      return "There's already a folder with that name.";
    case "auth":
      return "Git couldn't authenticate. If the repository is private, you need to sign in first.";
    case "not-found":
      // GitHub answers a private repo you cannot see with a 404, so "not found"
      // and "not allowed" are the same message from the outside.
      return "That repository wasn't found. Check the URL — or sign in, if it's private.";
    default:
      return lastMeaningfulLine(raw) || "The clone failed.";
  }
}

/** The last non-empty line of git's output, trimmed of its `fatal:` prefix. */
function lastMeaningfulLine(raw: string): string {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1] || "";
  return line.replace(/^fatal:\s*/i, "").slice(0, 300);
}

/**
 * Whether a failed clone should offer to set up GitHub access.
 *
 * Only for github.com — pointing someone at `gh auth login` after a GitLab
 * failure is advice that cannot help, and this is the difference between a
 * useful next step and a wrong one.
 */
export function offersGithubSetup(url: string, failure: CloneFailure): boolean {
  if (failure !== "auth" && failure !== "not-found") return false;
  return /(^|[@/.])github\.com([/:]|$)/i.test(String(url || ""));
}

/**
 * How to install the GitHub CLI on this platform, if we know.
 *
 * Returned as argv rather than a string so the caller starts a process instead
 * of handing a line to a shell, and as `display` so the UI can name the command
 * before running it. Nobody should be asked to approve a command they cannot
 * read.
 */
export interface InstallCommand {
  display: string;
  file: string;
  args: string[];
}

export function githubCliInstallCommand(platform: NodeJS.Platform): InstallCommand | null {
  if (platform === "win32") {
    return { display: "winget install --id GitHub.cli -e", file: "winget", args: ["install", "--id", "GitHub.cli", "-e"] };
  }
  if (platform === "darwin") {
    return { display: "brew install gh", file: "brew", args: ["install", "gh"] };
  }
  if (platform === "linux") {
    // Debian/Ubuntu is the only family we can guess at with any confidence, and
    // guessing wrong here wastes a terminal rather than breaking anything.
    return { display: "sudo apt install gh", file: "sudo", args: ["apt", "install", "gh"] };
  }
  return null;
}
