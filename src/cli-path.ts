import { statSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";

export function isCliFile(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Scan PATH directly; only POSIX hosts retain a shell fallback. */
export function findCliOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (candidate: string) => boolean = (candidate) => isCliFile(candidate, platform),
): string | undefined {
  const win = platform === "win32";
  const paths = win ? path.win32 : path.posix;
  const pathKey = win ? Object.keys(env).find((key) => key.toLowerCase() === "path") : "PATH";
  const pathExtKey = Object.keys(env).find((key) => key.toLowerCase() === "pathext");
  // npm also installs POSIX scripts without an extension on Windows. Only
  // PATHEXT candidates can be launched there, even if the bare file exists.
  const names = win && !paths.extname(name)
    ? (env[pathExtKey ?? "PATHEXT"] || ".COM;.EXE;.BAT;.CMD")
      .split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."))
      .map((ext) => `${name}${ext}`)
    : [name];
  for (const entry of (env[pathKey ?? "PATH"] || "").split(win ? ";" : ":")) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = paths.join(dir, candidateName);
      try {
        if (isFile(candidate)) return candidate;
      } catch { /* A removed or inaccessible PATH entry must not stop discovery. */ }
    }
  }
  // `where` searches the same PATH/PATHEXT we just exhausted. Spawning it
  // synchronously for every absent provider freezes the extension host while
  // startup repeatedly builds provider state (#214). A Windows miss is final;
  // provider locators still check their installer/bundled paths afterward.
  if (win) return undefined;
  try {
    const found = execSync(`command -v ${name}`, {
      encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0]?.trim();
    return found && isFile(found) ? found : undefined;
  } catch {
    return undefined;
  }
}
