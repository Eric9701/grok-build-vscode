import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

export interface ClaudeLocatorFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
}

export interface ClaudeLocatorOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fs?: ClaudeLocatorFs;
  which?: (name: string) => string | undefined;
}

const defaultFs: ClaudeLocatorFs = {
  exists: existsSync,
  isFile: (file) => {
    try { return statSync(file).isFile(); } catch { return false; }
  },
};

function defaultWhich(name: string, platform: NodeJS.Platform): string | undefined {
  try {
    const command = platform === "win32" ? `where ${name}` : `command -v ${name}`;
    return execSync(command, { encoding: "utf8" }).trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Official Claude Code user-bin locations that are often missing from PATH. */
function wellKnownClaudeBins(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(home, ".local", "bin", "claude.exe"),
      path.join(localAppData, "Programs", "claude", "claude.exe"),
    ];
  }
  return [
    path.join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
}

/**
 * Find an already-installed Claude Code CLI. We never download or install
 * Anthropic's binary — login and credentials stay in their tooling.
 */
export function locateClaudeCli(options: ClaudeLocatorOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const configured = options.configuredPath?.trim();
  if (configured) return fs.isFile(configured) ? configured : undefined;

  const names = platform === "win32" ? ["claude", "claude.cmd", "claude.exe"] : ["claude"];
  for (const name of names) {
    const found = (options.which ?? ((candidate) => defaultWhich(candidate, platform)))(name);
    if (found && fs.isFile(found)) return found;
  }

  const home = options.home || (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  for (const candidate of wellKnownClaudeBins(home, env, platform)) {
    if (fs.isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Normalize `claude --version` output for display. Never use the adapter handshake. */
export function parseClaudeVersionOutput(output: string): string {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output.trim())?.[1] ?? "";
}
