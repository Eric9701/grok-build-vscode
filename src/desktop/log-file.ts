/**
 * Where the desktop app's log goes, and how it stays a bounded size.
 *
 * ## Why this exists
 *
 * It did not, and that was a bug with consequences. `log()` wrote to
 * `process.stdout`, which for an app launched from a desktop icon is
 * discarded — there is no terminal attached. `showOutput()` was a function
 * whose whole body was a comment saying there was nothing to show. DevTools
 * returns early when packaged. So a packaged desktop user had NO route to any
 * diagnostic information at all, and "Settings > Advanced > Show logs" was a
 * menu item that did nothing.
 *
 * That was discovered the expensive way: two crash reports (#131, #133) where
 * the reporter was asked for logs, went looking, and correctly reported that
 * the button does nothing. Nobody could have sent a log, because none was
 * being kept.
 *
 * ## The choices, and why
 *
 * **Written synchronously.** The logs that matter are the last few lines
 * before a freeze or a crash, which is exactly what a buffered writer loses.
 * Paying a synchronous write per line is the whole point rather than an
 * oversight.
 *
 * **Bounded, by rotation, at startup only.** One previous file is kept, so the
 * cap is roughly twice {@link MAX_LOG_BYTES}. Rotating on a size check per
 * line would mean a `stat` per line; rotating at startup is enough, because
 * the file only grows while the app runs and every report starts with a
 * restart anyway.
 *
 * **stdout as well, still.** It costs nothing and it is what a developer
 * running from a terminal actually reads.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Roughly a week of ordinary use, and small enough to attach to an issue. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** The log file, given the app's user-data directory. */
export function desktopLogPath(userDataDir: string): string {
  return path.join(userDataDir, "logs", "desktop.log");
}

/** The one previous log kept across a restart. */
export function rotatedLogPath(logPath: string): string {
  return `${logPath}.1`;
}

/** One line, as it appears in the file. */
export function formatLogLine(stamp: string, line: string): string {
  return `[desktop ${stamp}] ${line}${NEWLINE}`;
}

const NEWLINE = "\n";

export interface LogFileIo {
  mkdirSync(dir: string, opts: { recursive: true }): void;
  statSync(p: string): { size: number };
  existsSync(p: string): boolean;
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
  appendFileSync(p: string, data: string): void;
}

/**
 * Make the log directory, and rotate an oversized log out of the way.
 *
 * Every step is best-effort: a machine that cannot write a log must still run
 * the app. Losing diagnostics is bad; refusing to start because diagnostics
 * could not be set up would be worse, and is the kind of failure that turns
 * one person's disk permission problem into "the app does not launch".
 */
export function prepareLogFile(logPath: string, io: LogFileIo, maxBytes = MAX_LOG_BYTES): boolean {
  try {
    io.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    return false;
  }
  try {
    if (io.existsSync(logPath) && io.statSync(logPath).size > maxBytes) {
      const previous = rotatedLogPath(logPath);
      // rename onto an existing file fails on Windows, so clear it first.
      try { if (io.existsSync(previous)) io.unlinkSync(previous); } catch { /* keep going */ }
      io.renameSync(logPath, previous);
    }
  } catch {
    // An un-rotatable log is still a usable log. Appending to an oversized file
    // beats losing the lines somebody is about to need.
  }
  return true;
}

/**
 * A sink that appends to the file, and never throws at its caller.
 *
 * `log()` is called from error paths. A logger that can throw turns a handled
 * problem into an unhandled one, which is precisely the wrong direction.
 */
export function createLogFileSink(
  logPath: string,
  io: Pick<LogFileIo, "appendFileSync"> = fs,
): (text: string) => void {
  let broken = false;
  return (text: string) => {
    if (broken) return;
    try {
      io.appendFileSync(logPath, text);
    } catch {
      // Once. A disk that refuses one write refuses the next thousand, and a
      // logger that retries per line makes a slow problem into a frozen app.
      broken = true;
    }
  };
}
