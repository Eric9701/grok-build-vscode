import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { locateClaudeCli, parseClaudeVersionOutput, type ClaudeLocatorFs } from "../src/claude-cli-locator";

function fakeFs(files: string[]): ClaudeLocatorFs {
  const set = new Set(files);
  return {
    exists: (value) => set.has(value),
    isFile: (value) => set.has(value),
  };
}

describe("locateClaudeCli", () => {
  it("uses a valid configured override before PATH", () => {
    const configured = "C:\\tools\\claude.exe";
    expect(locateClaudeCli({
      configuredPath: configured,
      platform: "win32",
      fs: fakeFs([configured]),
      which: () => "C:\\path\\claude.cmd",
    })).toBe(configured);
  });

  it("returns undefined for an invalid configured override without falling through", () => {
    expect(locateClaudeCli({
      configuredPath: "missing",
      fs: fakeFs([]),
      which: () => "/bin/claude",
    })).toBeUndefined();
  });

  it("checks claude command variants on Windows PATH", () => {
    const found = "C:\\npm\\claude.cmd";
    const asked: string[] = [];
    expect(locateClaudeCli({
      platform: "win32",
      fs: fakeFs([found]),
      which: (name) => { asked.push(name); return name === "claude.cmd" ? found : undefined; },
    })).toBe(found);
    expect(asked).toEqual(["claude", "claude.cmd"]);
  });

  it("falls back to the official user-bin location when PATH is empty", () => {
    const home = "C:\\Users\\Dev";
    const candidate = path.join(home, ".local", "bin", "claude.exe");
    expect(locateClaudeCli({
      home,
      platform: "win32",
      env: { LOCALAPPDATA: path.join(home, "AppData", "Local") },
      fs: fakeFs([candidate]),
      which: () => undefined,
    })).toBe(candidate);
  });
});

describe("parseClaudeVersionOutput", () => {
  it("reads the numeric banner, not the adapter handshake constant", () => {
    expect(parseClaudeVersionOutput("2.1.233 (Claude Code)")).toBe("2.1.233");
    expect(parseClaudeVersionOutput("claude 2.1.233")).toBe("2.1.233");
    expect(parseClaudeVersionOutput("not a version")).toBe("");
  });
});
