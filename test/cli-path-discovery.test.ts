import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { locateClaudeCli } from "../src/claude-cli-locator";
import { locateCodexCli } from "../src/codex-cli-locator";
import { locateMuseCli } from "../src/muse-cli-locator";
import { locateGrokCli } from "../src/cli-locator";
import { findCliOnPath, isCliFile } from "../src/cli-path";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execSync: vi.fn(() => { throw new Error("not on PATH"); }),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(execSync).mockReset().mockImplementation(() => { throw new Error("not on PATH"); });
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("CLI PATH discovery without a shell (#151)", () => {
  it.each(["grok", "claude", "codex", "muse"])("expands PATHEXT for bare %s on win32 and skips non-files", (name) => {
    const binary = `C:\\bin\\${name}.cmd`;
    const checked: string[] = [];
    expect(findCliOnPath(name, { PATH: "C:\\gone;C:\\directory;C:\\bin", PATHEXT: ".CMD;.EXE" }, "win32", (p) => {
      checked.push(p);
      if (p.startsWith("C:\\gone")) throw new Error("EACCES");
      return p === binary;
    })).toBe(binary);
    expect(checked).toContain(`C:\\directory\\${name}.cmd`);
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["grok", "claude", "codex", "muse"])("holds Windows PATH lookup for %s to PATHEXT names", (name) => {
    const env = { PATH: "C:\\bin", PathExt: ".CMD;.CUSTOM" };
    for (const suffix of ["", ".exe", ".cmd.extra"]) {
      expect(findCliOnPath(name, env, "win32", candidate => candidate === `C:\\bin\\${name}${suffix}`)).toBeUndefined();
    }
    for (const suffix of [".cmd", ".custom"]) {
      const binary = `C:\\bin\\${name}${suffix}`;
      expect(findCliOnPath(name, env, "win32", candidate => candidate === binary)).toBe(binary);
    }
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["grok.cmd", "codex.exe", "claude.exe"])("retains explicitly suffixed Windows PATH lookup for %s", name => {
    const binary = `C:\\bin\\${name}`;
    expect(findCliOnPath(name, { PATH: "C:\\bin", PATHEXT: ".CUSTOM" }, "win32", candidate => candidate === binary)).toBe(binary);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("finds Muse on the Windows PATH without starting a shell on a hit or miss", () => {
    const binary = "C:\\bin\\muse.exe";
    const options = { platform: "win32" as const, env: { PATH: "C:\\bin" }, isExecutable: (file: string) => file === binary };
    expect(locateMuseCli(options)).toBe(binary);
    expect(execSync).not.toHaveBeenCalled();
    expect(locateMuseCli({ ...options, env: { PATH: "C:\\missing" } })).toBeUndefined();
    expect(execSync).not.toHaveBeenCalled();
  });

  it("rejects an extensionless Muse launcher on the Windows PATH", () => {
    const home = mkdtempSync(path.join(tmpdir(), "muse-path-"));
    dirs.push(home);
    const bin = path.join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = path.join(bin, "muse");
    writeFileSync(launcher, "#!/bin/bash\n", { mode: 0o755 });
    expect(isCliFile(launcher, "win32")).toBe(true);
    expect(locateMuseCli({
      platform: "win32", home, env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    })).toBeUndefined();
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("finds a Windows %s.cmd and ignores an earlier directory with that name", (provider) => {
    const shim = `C:\\npm\\${provider}.cmd`;
    const native = `C:\\npm\\package\\${provider}.exe`;
    const isFile = (candidate: string) => [shim, native].some((p) => p.toLowerCase() === candidate.toLowerCase());
    const options = {
      platform: "win32" as const,
      env: { Path: "C:\\directory;\"C:\\npm\"", PATHEXT: ".COM;.EXE;.CMD;.BAT" },
      home: "C:\\empty",
      fs: {
        exists: (candidate: string) => isFile(candidate) || candidate.toLowerCase() === `c:\\directory\\${provider}.cmd`,
        isFile,
        readDir: () => [],
        readText: () => `@echo off\r\n"${native}" %*`,
      },
    };
    const found = provider === "claude" ? locateClaudeCli(options) : locateCodexCli(options);
    expect(found?.toLowerCase()).toBe(provider === "claude" ? native.toLowerCase() : shim.toLowerCase());
    expect(execSync).not.toHaveBeenCalled();
  });

  it("honors custom PATHEXT entries for an extensionless Windows lookup", () => {
    const binary = "C:\\bin\\codex.custom";
    expect(locateCodexCli({
      platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".CUSTOM;.CMD" }, home: "C:\\empty",
      fs: { exists: () => true, isFile: (p) => p.toLowerCase() === binary.toLowerCase(), readDir: () => [] },
    })?.toLowerCase()).toBe(binary.toLowerCase());
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("does not start a shell when Windows %s is missing", (provider) => {
    const options = {
      platform: "win32" as const, env: { PATH: "C:\\missing" }, home: "C:\\empty",
      fs: { exists: () => false, isFile: () => false, readDir: () => [] },
    };
    expect(provider === "claude" ? locateClaudeCli(options) : locateCodexCli(options)).toBeUndefined();
    expect(execSync).not.toHaveBeenCalled();
  });

  it("scans Grok's PATH for a regular executable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grok-path-"));
    dirs.push(dir);
    const first = path.join(dir, "directory");
    const second = path.join(dir, "bin");
    const name = process.platform === "win32" ? "grok.cmd" : "grok";
    mkdirSync(path.join(first, name), { recursive: true });
    mkdirSync(second);
    const binary = path.join(second, name);
    writeFileSync(binary, "", { mode: 0o755 });
    // Inject the environment rather than stubbing process.env, the way every
    // other test in this file already does. Vitest runs test FILES as threads in
    // ONE process, so process.env is shared: a stub here - and the
    // unstubAllEnvs that cleans it up - reaches into whatever else is mid-test.
    // cli-locator.test.ts assigns HOME/USERPROFILE around its own assertions and
    // restores them in a finally, and the two clobbered each other. The flake is
    // invisible exactly where it is checked: with the stub lost, the lookup
    // falls through to the real ~/.grok/bin, which every dev box has and no CI
    // box does, so the suite is green in CI and red on the machine releasing it.
    const env = { PATH: [first, second].join(path.delimiter), PATHEXT: ".COM;.EXE;.CMD;.BAT" };

    expect(findCliOnPath("grok", env, process.platform)?.toLowerCase()).toBe(binary.toLowerCase());
    expect(execSync).not.toHaveBeenCalled();
    // A directory named exactly like the binary is not a hit.
    expect(isCliFile(path.join(first, name))).toBe(false);

  });

  it.each(["darwin", "linux"] as const)("retains the shell fallback on %s", platform => {
    const binary = "/shell/bin/grok";
    vi.mocked(execSync).mockReturnValue(binary + "\n");
    expect(findCliOnPath("grok", { PATH: "/missing" }, platform, candidate => candidate === binary)).toBe(binary);
    expect(execSync).toHaveBeenCalledWith("command -v grok", expect.objectContaining({ windowsHide: true }));
  });
});

describe("Grok-only Windows discovery (#214)", () => {
  it("can repeatedly discover providers without any synchronous child process", () => {
    const home = mkdtempSync(path.join(tmpdir(), "grok-only-"));
    dirs.push(home);
    const bin = path.join(home, ".grok", "bin");
    mkdirSync(bin, { recursive: true });
    const grok = path.join(bin, process.platform === "win32" ? "grok.exe" : "grok");
    writeFileSync(grok, "", { mode: 0o755 });
    const env = { PATH: "C:\\missing", HOME: home, USERPROFILE: home };
    const options = {
      platform: "win32" as const, env, home,
      fs: { exists: () => false, isFile: () => false, readDir: () => [] },
      isExecutable: () => false,
    };
    // Provider state, connected/usable providers and onboarding all rediscover
    // missing CLIs. Previously four passes alone invoked 28 blocking `where`s.
    for (let pass = 0; pass < 4; pass++) {
      expect(locateGrokCli("", env)).toBe(grok);
      expect(locateCodexCli(options)).toBeUndefined();
      expect(locateClaudeCli(options)).toBeUndefined();
      expect(locateMuseCli(options)).toBeUndefined();
    }
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "muse"] as const)("finds %s installed on PATH after an earlier miss", provider => {
    const binary = `C:\\bin\\${provider}.exe`;
    let installed = false;
    const isFile = (candidate: string) => installed && candidate === binary;
    const options = {
      platform: "win32" as const, env: { PATH: "C:\\bin" }, home: "C:\\empty",
      fs: { exists: () => false, isFile, readDir: () => [] }, isExecutable: isFile,
    };
    const locate = () => provider === "codex" ? locateCodexCli(options)
      : provider === "claude" ? locateClaudeCli(options) : locateMuseCli(options);
    expect(locate()).toBeUndefined();
    installed = true;
    expect(locate()).toBe(binary);
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "muse"] as const)("still finds %s outside PATH through its installer/bundle location", provider => {
    const home = path.resolve("empty-home");
    const bundle = "openai.chatgpt-1.0.0";
    const extensions = path.join(home, ".vscode", "extensions");
    const bundleBin = path.join(extensions, bundle, "bin");
    const binary = provider === "codex" ? path.join(bundleBin, "windows-x86_64", "codex.exe")
      : provider === "claude" ? path.join(home, ".local", "bin", "claude.exe")
        : "C:\\local\\Programs\\muse\\muse.cmd";
    const isFile = (candidate: string) => candidate === binary;
    const options = {
      platform: "win32" as const, env: { PATH: "C:\\missing", LOCALAPPDATA: "C:\\local" }, home,
      fs: {
        exists: (candidate: string) => [extensions, bundleBin].includes(candidate), isFile,
        readDir: (dir: string) => dir === extensions ? [bundle] : dir === bundleBin ? ["windows-x86_64"] : [],
      },
      isExecutable: isFile,
    };
    expect(provider === "codex" ? locateCodexCli(options)
      : provider === "claude" ? locateClaudeCli(options) : locateMuseCli(options)).toBe(binary);
    expect(execSync).not.toHaveBeenCalled();
  });
});
