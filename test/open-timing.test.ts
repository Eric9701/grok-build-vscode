import { describe, it, expect } from "vitest";
import { OpenClock, formatMs, formatOpenTimings } from "../src/open-timing";

describe("formatMs", () => {
  it("reads as a person would read it", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(437)).toBe("437ms");
    expect(formatMs(999)).toBe("999ms");
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(4230)).toBe("4.2s");
  });

  it("does not pretend to know a duration it was not given", () => {
    expect(formatMs(NaN)).toBe("?");
    expect(formatMs(-1)).toBe("?");
  });
});

describe("formatOpenTimings", () => {
  it("names where the time went", () => {
    expect(formatOpenTimings({
      kind: "resume",
      totalMs: 4200,
      phases: [
        { name: "dispose", ms: 1100 },
        { name: "probe", ms: 120 },
        { name: "spawn", ms: 400 },
        { name: "load+replay", ms: 2580 },
      ],
      cwd: "c:\work\repo",
    })).toBe(
      "[open] resume took 4.2s — dispose 1.1s, probe 120ms, spawn 400ms, load+replay 2.6s · c:\work\repo",
    );
  });

  it("drops the phases that cost nothing", () => {
    // On a warm open most phases are zero, and a line of zeroes hides the one
    // number worth reading.
    const line = formatOpenTimings({
      kind: "new",
      totalMs: 310,
      phases: [{ name: "dispose", ms: 0 }, { name: "probe", ms: 60 }, { name: "spawn", ms: 250 }],
    });
    expect(line).toBe("[open] new took 310ms — probe 60ms, spawn 250ms");
    expect(line).not.toContain("dispose");
  });

  it("accounts for time the named phases did not explain", () => {
    expect(formatOpenTimings({
      kind: "resume",
      totalMs: 1000,
      phases: [{ name: "spawn", ms: 400 }],
    })).toBe("[open] resume took 1.0s — spawn 400ms, rest 600ms");
  });

  it("says nothing about a breakdown when there is none", () => {
    expect(formatOpenTimings({ kind: "new", totalMs: 12, phases: [] }))
      .toBe("[open] new took 12ms");
  });
});

describe("OpenClock", () => {
  it("attributes each interval to the phase that ended there", () => {
    let t = 1000;
    const clock = new OpenClock(() => t);
    t += 900; clock.mark("dispose");
    t += 100; clock.mark("probe");
    t += 2000; clock.mark("load+replay");
    t += 100; // unnamed tail, never marked
    expect(clock.totalMs()).toBe(3100);
    expect(clock.summary("resume", "/work/a")).toBe(
      "[open] resume took 3.1s — dispose 900ms, probe 100ms, load+replay 2.0s, rest 100ms · /work/a",
    );
  });

  it("survives an open where a phase never ran", () => {
    // A first open has no previous process to dispose, so that mark is skipped
    // outright rather than recorded as zero.
    let t = 0;
    const clock = new OpenClock(() => t);
    t += 300; clock.mark("spawn");
    expect(clock.summary("new")).toBe("[open] new took 300ms — spawn 300ms");
  });
});
