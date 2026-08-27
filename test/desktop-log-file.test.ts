/**
 * The desktop log file.
 *
 * This exists because its absence was a bug that cost two crash reports. The
 * app wrote to stdout, which is discarded when it is launched from an icon;
 * "Show logs" was a no-op; DevTools is off when packaged. A reporter went
 * looking for a log, found a button that did nothing, and said so — which was
 * the only correct thing anyone could have reported.
 *
 * So the properties pinned here are the ones that decide whether a person in
 * trouble can send you anything: the lines are on disk, they survive, the file
 * cannot grow without bound, and none of it can take the app down.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_LOG_BYTES,
  createLogFileSink,
  desktopLogPath,
  formatLogLine,
  prepareLogFile,
  rotatedLogPath,
  type LogFileIo,
} from "../src/desktop/log-file";

function io(over: Partial<LogFileIo> = {}) {
  const calls: string[] = [];
  const files = new Map<string, number>();
  const base: LogFileIo = {
    mkdirSync: (dir) => { calls.push(`mkdir:${dir}`); },
    statSync: (p) => ({ size: files.get(p) ?? 0 }),
    existsSync: (p) => files.has(p),
    renameSync: (from, to) => {
      calls.push(`rename:${from}->${to}`);
      files.set(to, files.get(from) ?? 0);
      files.delete(from);
    },
    unlinkSync: (p) => { calls.push(`unlink:${p}`); files.delete(p); },
    appendFileSync: (p, data) => { files.set(p, (files.get(p) ?? 0) + data.length); },
  };
  return { io: { ...base, ...over }, calls, files };
}

describe("where the log lives", () => {
  it("is under the app's own user data, not a temp directory", () => {
    // It has to survive a restart: the report always comes after the crash.
    const p = desktopLogPath("/data/GrokBuildDesktop");
    expect(p.replace(/\\/g, "/")).toBe("/data/GrokBuildDesktop/logs/desktop.log");
  });

  it("keeps exactly one previous log beside it", () => {
    expect(rotatedLogPath("/d/logs/desktop.log")).toBe("/d/logs/desktop.log.1");
  });
});

describe("a line", () => {
  it("carries a timestamp and ends the line itself", () => {
    // The caller writes the same string to stdout and to the file, so the
    // newline belongs here rather than at each call site.
    expect(formatLogLine("2026-08-27T00:00:00.000Z", "hello"))
      .toBe("[desktop 2026-08-27T00:00:00.000Z] hello\n");
  });
});

describe("preparing the file", () => {
  it("makes the directory", () => {
    const { io: f, calls } = io();
    expect(prepareLogFile("/d/logs/desktop.log", f)).toBe(true);
    expect(calls.some((c) => c.startsWith("mkdir:"))).toBe(true);
  });

  it("rotates a log that has grown too big", () => {
    const { io: f, files, calls } = io();
    files.set("/d/logs/desktop.log", MAX_LOG_BYTES + 1);
    prepareLogFile("/d/logs/desktop.log", f);
    expect(calls).toContain("rename:/d/logs/desktop.log->/d/logs/desktop.log.1");
  });

  it("clears the previous log first, because Windows will not rename onto it", () => {
    const { io: f, files, calls } = io();
    files.set("/d/logs/desktop.log", MAX_LOG_BYTES + 1);
    files.set("/d/logs/desktop.log.1", 10);
    prepareLogFile("/d/logs/desktop.log", f);
    expect(calls.indexOf("unlink:/d/logs/desktop.log.1"))
      .toBeLessThan(calls.indexOf("rename:/d/logs/desktop.log->/d/logs/desktop.log.1"));
  });

  it("leaves a small log alone", () => {
    const { io: f, files, calls } = io();
    files.set("/d/logs/desktop.log", 10);
    prepareLogFile("/d/logs/desktop.log", f);
    expect(calls.some((c) => c.startsWith("rename:"))).toBe(false);
  });

  it("still logs when it cannot rotate", () => {
    // An un-rotatable log is still a usable log. Refusing to log because
    // tidying failed would throw away the thing somebody needs.
    const { io: f, files } = io({ renameSync: () => { throw new Error("locked"); } });
    files.set("/d/logs/desktop.log", MAX_LOG_BYTES + 1);
    expect(prepareLogFile("/d/logs/desktop.log", f)).toBe(true);
  });

  it("gives up honestly when the directory cannot be made", () => {
    // Reported as false so the caller does not promise a log that is not there.
    const { io: f } = io({ mkdirSync: () => { throw new Error("EACCES"); } });
    expect(prepareLogFile("/d/logs/desktop.log", f)).toBe(false);
  });
});

describe("the sink", () => {
  it("rotates while the app is RUNNING, not only at startup", () => {
    // Startup-only rotation was the first version and it was wrong: a desktop
    // app stays open for days and a cloud machine for weeks, and provider
    // stderr goes straight through — so a looping agent fills the volume long
    // before the next restart, taking project and session-state writes with it.
    const { io: f, files } = io();
    const write = createLogFileSink("/d/logs/desktop.log", f, 10);
    write("12345678\n");   // 9 bytes — under
    write("12345678\n");   // would cross 10, so rotate first
    expect(files.get("/d/logs/desktop.log.1")).toBe(9);
    expect(files.get("/d/logs/desktop.log")).toBe(9);
  });

  it("counts what is already on disk, so restarts cannot dodge the cap", () => {
    // Otherwise every restart resets the budget and an append-only file grows
    // without limit across many short sessions.
    const { io: f, files } = io();
    files.set("/d/logs/desktop.log", 100);
    const write = createLogFileSink("/d/logs/desktop.log", f, 10);
    write("x\n");
    expect(files.get("/d/logs/desktop.log.1")).toBe(100);
  });


  it("appends what it is given", () => {
    const { io: f, files } = io();
    const write = createLogFileSink("/d/logs/desktop.log", f);
    write("one\n");
    write("two\n");
    expect(files.get("/d/logs/desktop.log")).toBe(8);
  });

  it("NEVER throws at its caller", () => {
    // `log()` is called from error paths. A logger that throws turns a handled
    // problem into an unhandled one.
    const write = createLogFileSink("/d/logs/desktop.log", {
      appendFileSync: () => { throw new Error("ENOSPC"); },
    });
    expect(() => write("boom\n")).not.toThrow();
  });

  it("stops trying after the first failure", () => {
    // A disk that refuses one write refuses the next thousand, and retrying
    // per line turns a slow disk into a frozen app — which is the very
    // symptom being investigated.
    let attempts = 0;
    const write = createLogFileSink("/d/logs/desktop.log", {
      appendFileSync: () => { attempts += 1; throw new Error("ENOSPC"); },
    });
    write("a\n"); write("b\n"); write("c\n");
    expect(attempts).toBe(1);
  });
});
