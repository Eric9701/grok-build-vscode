/**
 * Pure plans for opening a visible OS terminal (desktop host).
 * Interactive CLI actions (login, install, mcp list) must not be silent no-ops.
 */
import * as path from "node:path";
import { grokCliNeedsShell } from "../cli-process";

export type ExternalTerminalPlan =
  | {
      kind: "spawn";
      command: string;
      args: string[];
      cwd?: string;
      shell: boolean;
      /** Human-readable description for logs / errors. */
      label: string;
    }
  | { kind: "unsupported"; reason: string };

/**
 * Open a visible terminal that runs `shellPath` with `shellArgs` (login / logout / mcp).
 * On Windows, `.cmd`/`.bat` shims are launched via `cmd /c start` so they get a
 * console and shell interpretation (Node `shell:false` cannot run them).
 */
export function planOpenCliInTerminal(
  title: string,
  shellPath: string,
  shellArgs: readonly string[],
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ExternalTerminalPlan {
  if (!shellPath) {
    return { kind: "unsupported", reason: "no CLI path" };
  }
  const safeTitle = (title || "Grok").replace(/["\r\n]/g, "");
  if (platform === "win32") {
    // `start "title" /D cwd command args` — title is required so a quoted path
    // is not eaten as the window title.
    const args = ["/c", "start", safeTitle];
    if (cwd) args.push("/D", cwd);
    args.push(shellPath, ...shellArgs);
    return {
      kind: "spawn",
      command: process.env.ComSpec || "cmd.exe",
      args,
      shell: false,
      label: `${safeTitle}: ${path.basename(shellPath)} ${shellArgs.join(" ")}`.trim(),
    };
  }
  if (platform === "darwin") {
    const cmd = shellQuote([shellPath, ...shellArgs]);
    const script = cwd
      ? `cd ${shellQuote([cwd])} && ${cmd}; exec bash`
      : `${cmd}; exec bash`;
    return {
      kind: "spawn",
      command: "osascript",
      args: ["-e", `tell application "Terminal" to do script ${osascriptString(script)}`],
      shell: false,
      label: safeTitle,
    };
  }
  // Linux: prefer x-terminal-emulator, fall back to xterm.
  const cmd = shellQuote([shellPath, ...shellArgs]);
  const bashLine = cwd
    ? `cd ${shellQuote([cwd])} && ${cmd}; exec bash`
    : `${cmd}; exec bash`;
  return {
    kind: "spawn",
    command: "x-terminal-emulator",
    args: ["-T", safeTitle, "-e", "bash", "-lc", bashLine],
    shell: false,
    label: safeTitle,
  };
}

/**
 * Open a visible terminal and run a shell command string (Install Grok script).
 */
export function planRunCommandInTerminal(
  title: string,
  commandText: string,
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ExternalTerminalPlan {
  const text = (commandText || "").trim();
  if (!text) {
    return { kind: "unsupported", reason: "empty command" };
  }
  const safeTitle = (title || "Grok").replace(/["\r\n]/g, "");
  if (platform === "win32") {
    // PowerShell keeps the window open so the user can read install output.
    const args = ["/c", "start", safeTitle];
    if (cwd) args.push("/D", cwd);
    args.push(
      "powershell.exe",
      "-NoExit",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      text,
    );
    return {
      kind: "spawn",
      command: process.env.ComSpec || "cmd.exe",
      args,
      shell: false,
      label: safeTitle,
    };
  }
  if (platform === "darwin") {
    const script = cwd
      ? `cd ${shellQuote([cwd])} && ${text}; exec bash`
      : `${text}; exec bash`;
    return {
      kind: "spawn",
      command: "osascript",
      args: ["-e", `tell application "Terminal" to do script ${osascriptString(script)}`],
      shell: false,
      label: safeTitle,
    };
  }
  const bashLine = cwd
    ? `cd ${shellQuote([cwd])} && ${text}; exec bash`
    : `${text}; exec bash`;
  return {
    kind: "spawn",
    command: "x-terminal-emulator",
    args: ["-T", safeTitle, "-e", "bash", "-lc", bashLine],
    shell: false,
    label: safeTitle,
  };
}

/**
 * Whether a detached Node spawn of `cliPath` needs `shell: true` (Windows .cmd).
 * Re-exported name for host call sites that do a non-interactive spawn.
 */
export function cliSpawnNeedsShell(cliPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return grokCliNeedsShell(cliPath, platform);
}

function shellQuote(parts: string[]): string {
  return parts
    .map((p) => {
      if (!/[^\w@%+=:,./-]/.test(p)) return p;
      return `'${p.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

function osascriptString(s: string): string {
  // AppleScript string literal with backslash/quote escapes.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
