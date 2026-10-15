/**
 * Markers that a conversation was started by automation rather than a person:
 * a headless Grok run (`session_kind: "headless"`, read where the summary is
 * already parsed -- see `buildEntry`), `codex exec` (`originator: "codex_exec"`
 * on the rollout's first `session_meta` line), and a Claude Code SDK script
 * (`entrypoint: "sdk-cli"` on the transcript's first records). Recent leaves
 * them out.
 *
 * Neither adapter's `session/list` carries these, so they are read from the
 * CLI's own files -- for the handful of conversations Recent considers, never
 * a whole history, and only the first few kilobytes of one file each. Pure
 * apart from the injected reader; a file that cannot be read means "not
 * marked", never "automated".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface MarkerFs {
  readdirSync(dir: string): string[];
  /** Up to `bytes` from the start of `file`, as UTF-8; throws when unreadable. */
  readHead(file: string, bytes: number): string;
}

export const defaultMarkerFs: MarkerFs = {
  readdirSync: (dir) => fs.readdirSync(dir),
  readHead: (file, bytes) => {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  },
};

const HEAD_BYTES = 64 * 1024;

function firstLines(text: string, max: number): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (out.length >= max) break;
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line cut at the byte limit */ }
  }
  return out;
}

/**
 * The `originator` of each Codex session in `ids`, from its rollout's first
 * line. Rollouts live at `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`;
 * only the day directories of the last `days` days are read, since Recent only
 * considers conversations inside the history horizon.
 */
export function codexOriginators(
  codexHome: string,
  ids: ReadonlySet<string>,
  now: number,
  days: number,
  io: MarkerFs = defaultMarkerFs,
): Map<string, string> {
  const found = new Map<string, string>();
  if (!ids.size) return found;
  const pad = (n: number) => String(n).padStart(2, "0");
  // One day of slack each way: the folder is the rollout's local date.
  for (let back = -1; back <= days + 1 && found.size < ids.size; back++) {
    const d = new Date(now - back * 24 * 60 * 60 * 1000);
    const dir = path.join(codexHome, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    let names: string[];
    try { names = io.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const id = [...ids].find((candidate) => name.endsWith(`-${candidate}.jsonl`));
      if (!id || found.has(id)) continue;
      let head: string;
      try { head = io.readHead(path.join(dir, name), HEAD_BYTES); } catch { continue; }
      const meta = firstLines(head, 1)[0] as { type?: unknown; payload?: { originator?: unknown } } | undefined;
      const originator = meta?.type === "session_meta" ? meta.payload?.originator : undefined;
      if (typeof originator === "string") found.set(id, originator);
    }
  }
  return found;
}

/** Claude Code's project folder name for a cwd: every character that is not a
 *  letter or digit becomes `-` (`C:\GitHub\x` -> `C--GitHub-x`). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The `entrypoint` of Claude session `id` in `cwd`, from the first records of
 *  `<configDir>/projects/<dir>/<id>.jsonl` (the first one or two lines are queue
 *  records without it). */
export function claudeEntrypoint(
  configDir: string,
  cwd: string,
  id: string,
  io: MarkerFs = defaultMarkerFs,
): string | undefined {
  let head: string;
  try { head = io.readHead(path.join(configDir, "projects", claudeProjectDirName(cwd), `${id}.jsonl`), HEAD_BYTES); }
  catch { return undefined; }
  for (const record of firstLines(head, 20)) {
    const entrypoint = (record as { entrypoint?: unknown } | null)?.entrypoint;
    if (typeof entrypoint === "string") return entrypoint;
  }
  return undefined;
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude");
}

/** The values that mark automation. Anything else -- this app's own sessions
 *  included (`@agentclientprotocol/codex-acp`, Claude's `sdk-ts`) -- does not. */
export const AUTOMATED_CODEX_ORIGINATOR = "codex_exec";
export const AUTOMATED_CLAUDE_ENTRYPOINT = "sdk-cli";
