import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  locateGrokCli,
  extensionWasUpgraded,
  parseGrokVersion,
  compareVersionTuple,
  grokUpdatePolicy,
  shouldReactivelyDowngrade,
  isLockedBinaryError,
  isGrokVersionBelowRequired,
  isStdioBrokenGrokVersion,
  decidePlanModeAvailability,
  probeVersionOutput,
  GROK_REQUIRED_VERSION,
  GROK_STDIO_DOWNGRADE_TARGET,
} from "../src/cli-locator";

const IS_WIN = process.platform === "win32";
const PATH_SEP = IS_WIN ? ";" : ":";
const FAKE_BIN_NAME = IS_WIN ? "grok.cmd" : "grok";

describe("locateGrokCli", () => {
  let tmpDir: string;
  let fakeBin: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-locate-"));
    fakeBin = path.join(tmpDir, FAKE_BIN_NAME);
    if (IS_WIN) {
      fs.writeFileSync(fakeBin, "@echo mock\r\n");
    } else {
      fs.writeFileSync(fakeBin, "#!/bin/sh\necho mock\n");
      fs.chmodSync(fakeBin, 0o755);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the configured path when it exists", () => {
    expect(locateGrokCli(fakeBin)).toBe(fakeBin);
  });

  it("returns undefined when configured path is missing", () => {
    expect(locateGrokCli(path.join(tmpDir, "missing"))).toBeUndefined();
  });

  it("falls back to PATH when no config and no ~/.grok/bin/grok", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = tmpDir + PATH_SEP + (originalPath ?? "");
    try {
      const result = locateGrokCli("");
      // Either ~/.grok/bin/grok wins (if installed) or PATH lookup finds the fake.
      const found = result?.toLowerCase();
      expect(found === fakeBin.toLowerCase() || !!found?.includes("grok")).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns undefined when nothing found", () => {
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.PATH = "";
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    try {
      expect(locateGrokCli("")).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      if (originalHome) process.env.HOME = originalHome;
      if (originalUserProfile) process.env.USERPROFILE = originalUserProfile;
    }
  });
});

describe("extensionWasUpgraded", () => {
  it("leaves fresh installs and unchanged versions alone", () => {
    expect(extensionWasUpgraded(undefined, "2.2.0")).toBe(false);
    expect(extensionWasUpgraded("2.2.0", "2.2.0")).toBe(false);
  });

  it("detects an extension version change", () => {
    expect(extensionWasUpgraded("2.1.1", "2.2.0")).toBe(true);
    expect(extensionWasUpgraded("2.2.0", "2.1.1")).toBe(true);
  });
});

describe("parseGrokVersion", () => {
  it("parses the real --version banner", () => {
    expect(parseGrokVersion("grok 0.2.64 (9a9ac25b10) [stable]")).toEqual([0, 2, 64]);
  });

  it("parses a bare version string", () => {
    expect(parseGrokVersion("0.2.60")).toEqual([0, 2, 60]);
  });

  it("parses double-digit and larger components", () => {
    expect(parseGrokVersion("grok 1.10.205 (abc) [alpha]")).toEqual([1, 10, 205]);
  });

  it("returns undefined when no X.Y.Z is present", () => {
    expect(parseGrokVersion("grok (dev build)")).toBeUndefined();
    expect(parseGrokVersion("")).toBeUndefined();
    expect(parseGrokVersion(undefined as unknown as string)).toBeUndefined();
  });
});

describe("compareVersionTuple", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersionTuple([0, 2, 60], [0, 2, 61])).toBeLessThan(0);
    expect(compareVersionTuple([0, 2, 64], [0, 2, 60])).toBeGreaterThan(0);
    expect(compareVersionTuple([0, 2, 60], [0, 2, 60])).toBe(0);
    expect(compareVersionTuple([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareVersionTuple([0, 3, 0], [0, 2, 99])).toBeGreaterThan(0);
  });
});

describe("required grok behavior floor", () => {
  it("identifies versions below 0.2.117, including versions outside the old Windows regression", () => {
    for (const version of ["0.1.999", "0.2.60", "0.2.71", "0.2.100", "0.2.116"]) {
      expect(isGrokVersionBelowRequired(`grok ${version} (x) [stable]`)).toBe(true);
    }
    expect(GROK_REQUIRED_VERSION).toBe("0.2.117");
    expect(GROK_STDIO_DOWNGRADE_TARGET).toBe(GROK_REQUIRED_VERSION);
  });

  it("accepts the floor and newer versions, and leaves unverifiable banners to the caller", () => {
    for (const version of ["0.2.117", "0.2.118", "0.3.0", "1.0.0"]) {
      expect(isGrokVersionBelowRequired(`grok ${version} (x) [stable]`)).toBe(false);
    }
    expect(isGrokVersionBelowRequired("grok (dev build)")).toBe(false);
  });
});

describe("decidePlanModeAvailability (#105 — verified-old vs unverified)", () => {
  it("enables Plan for the floor and newer (including 1.0.0)", () => {
    for (const version of ["0.2.117", "0.2.118", "1.0.0"]) {
      expect(decidePlanModeAvailability(`grok ${version} (x) [stable]`)).toEqual({
        available: true,
        verified: true,
      });
    }
  });

  it("disables Plan with a latched verified-old reason for a parseable below-floor CLI", () => {
    const decision = decidePlanModeAvailability("grok 0.2.100 (x) [stable]");
    expect(decision).toEqual({
      available: false,
      verified: true,
      installed: "0.2.100",
      reason: `Plan mode requires Grok CLI ${GROK_REQUIRED_VERSION} or newer; installed version is 0.2.100.`,
    });
    // Distinct from the unverified copy — users must not conclude "too old" from a probe miss.
    expect(decision.reason).toContain("installed version is");
    expect(decision.reason).not.toMatch(/could not verify/i);
  });

  it("fails closed but marks unverified when the banner cannot be parsed", () => {
    for (const banner of ["", "grok (dev build)", "not a version"]) {
      const decision = decidePlanModeAvailability(banner);
      expect(decision.available).toBe(false);
      expect(decision.verified).toBe(false);
      if (decision.available || decision.verified) throw new Error("expected unverified");
      expect(decision.reason).toMatch(/could not verify/i);
      expect(decision.reason).toContain(GROK_REQUIRED_VERSION);
      expect(decision.reason).not.toContain("installed version is");
    }
  });

  it("keeps the two unavailable reasons distinguishable", () => {
    const old = decidePlanModeAvailability("grok 0.2.50 (x)");
    const unverified = decidePlanModeAvailability("");
    expect(old.available).toBe(false);
    expect(unverified.available).toBe(false);
    expect(old.verified).toBe(true);
    expect(unverified.verified).toBe(false);
    if (!old.available && old.verified && !unverified.available && !unverified.verified) {
      expect(old.reason).not.toBe(unverified.reason);
      expect(old.reason).toContain("installed version is 0.2.50");
      expect(unverified.reason).toMatch(/could not verify/i);
    }
  });
});

describe("probeVersionOutput (#105 — retry empty probe, latch parseable)", () => {
  it("returns the first parseable answer without retrying", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = await probeVersionOutput(
      async () => {
        calls += 1;
        return "grok 0.2.50 (x) [stable]";
      },
      async (ms) => { sleeps.push(ms); },
    );
    expect(out).toBe("grok 0.2.50 (x) [stable]");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries once after backoff when the first read is empty, then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = await probeVersionOutput(
      async () => {
        calls += 1;
        return calls === 1 ? "" : "grok 1.0.0 (x) [stable]";
      },
      async (ms) => { sleeps.push(ms); },
      50,
    );
    expect(out).toBe("grok 1.0.0 (x) [stable]");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([50]);
    // End state after fail-then-succeed: Plan available (the behaviour that matters).
    expect(decidePlanModeAvailability(out)).toEqual({ available: true, verified: true });
  });

  it("retries unparseable output once and stays fail-closed if still empty", async () => {
    let calls = 0;
    const out = await probeVersionOutput(
      async () => {
        calls += 1;
        return "";
      },
      async () => {},
    );
    expect(out).toBe("");
    expect(calls).toBe(2);
    const decision = decidePlanModeAvailability(out);
    expect(decision.available).toBe(false);
    expect(decision.verified).toBe(false);
  });

  it("does not retry a parseable below-floor CLI however many times asked", async () => {
    // Simulate "user reaches for Plan" N times: each probe sees a stable old banner.
    for (let i = 0; i < 3; i++) {
      let calls = 0;
      const out = await probeVersionOutput(
        async () => {
          calls += 1;
          return "grok 0.2.100 (x) [stable]";
        },
        async () => { throw new Error("sleep should not run for parseable output"); },
      );
      expect(calls).toBe(1);
      const decision = decidePlanModeAvailability(out);
      expect(decision).toMatchObject({ available: false, verified: true, installed: "0.2.100" });
    }
  });
});

describe("isStdioBrokenGrokVersion (issue #22 bounded proactive pin)", () => {
  it("matches only Windows builds 0.2.61 through 0.2.70", () => {
    for (const version of ["0.2.61", "0.2.64", "0.2.67", "0.2.70"]) {
      expect(isStdioBrokenGrokVersion(`grok ${version} (x) [stable]`, "win32")).toBe(true);
    }
    for (const version of ["0.2.60", "0.2.71", "0.2.117", "0.3.0", "1.0.0"]) {
      expect(isStdioBrokenGrokVersion(`grok ${version} (x) [stable]`, "win32")).toBe(false);
    }
  });

  it("is a no-op off Windows and for unverifiable banners", () => {
    expect(isStdioBrokenGrokVersion("grok 0.2.67 (x) [stable]", "linux")).toBe(false);
    expect(isStdioBrokenGrokVersion("grok 0.2.67 (x) [stable]", "darwin")).toBe(false);
    expect(isStdioBrokenGrokVersion("grok (dev build)", "win32")).toBe(false);
  });
});

describe("grokUpdatePolicy (issue #22 update pause lifted in 0.2.71)", () => {
  it("allows updates on every platform now that the regression is fixed (no block, no pin)", () => {
    for (const plat of ["win32", "linux", "darwin"] as const) {
      for (const v of ["0.2.60", "0.2.67", "0.2.70", "0.2.71", "0.2.72"]) {
        const p = grokUpdatePolicy(`grok ${v} (x) [stable]`, plat);
        expect(p.allow).toBe(true);
        expect(p.target).toBeUndefined();
        expect(p.note).toBeUndefined();
      }
    }
  });

  it("allows when the version is unparseable too", () => {
    const p = grokUpdatePolicy("grok (dev build)", "win32");
    expect(p.allow).toBe(true);
    expect(p.target).toBeUndefined();
  });
});

describe("shouldReactivelyDowngrade (issue #22 — backstop above the verified target)", () => {
  it("downgrades any Windows build ABOVE the supported 0.2.117", () => {
    for (const v of ["0.2.118", "0.2.199", "0.3.0", "1.0.0"]) {
      expect(shouldReactivelyDowngrade(`grok ${v} (x) [stable]`, "win32")).toBe(true);
    }
  });

  it("never downgrades 0.2.117 or below — the loop guard once recovery lands", () => {
    // The behavior floor handles older builds; reactive recovery applies only to
    // a newer build that actually failed startup.
    for (const v of ["0.2.117", "0.2.116", "0.2.72", "0.2.71", "0.2.70", "0.2.60", "0.1.211"]) {
      expect(shouldReactivelyDowngrade(`grok ${v} (x) [stable]`, "win32")).toBe(false);
    }
  });

  it("is Windows-only", () => {
    for (const plat of ["linux", "darwin"] as const) {
      expect(shouldReactivelyDowngrade("grok 0.2.99 (x) [stable]", plat)).toBe(false);
    }
  });

  it("leaves an unparseable version alone (no spurious downgrade)", () => {
    expect(shouldReactivelyDowngrade("grok (dev build)", "win32")).toBe(false);
    expect(shouldReactivelyDowngrade("", "win32")).toBe(false);
  });
});

describe("isLockedBinaryError (CLI-update lock retry)", () => {
  it("detects grok's real locked-executable failure (worth a retry)", () => {
    const real =
      "Command failed: C:\\Users\\Dell\\.grok\\bin\\grok.exe update\n" +
      "Error: Auto-update failed: cannot rename locked executable " +
      "C:\\Users\\Dell\\.grok\\bin\\grok.exe: Access is denied. (os error 5)";
    expect(isLockedBinaryError(real)).toBe(true);
  });

  it("matches each lock signature independently and is case-insensitive", () => {
    expect(isLockedBinaryError("cannot rename LOCKED EXECUTABLE")).toBe(true);
    expect(isLockedBinaryError("Access is Denied.")).toBe(true);
    expect(isLockedBinaryError("failed (os error 5)")).toBe(true);
  });

  it("does not match unrelated update failures (those are real, no retry)", () => {
    expect(isLockedBinaryError("network timeout while downloading grok")).toBe(false);
    expect(isLockedBinaryError("ENOENT: grok not found")).toBe(false);
    expect(isLockedBinaryError("")).toBe(false);
  });
});
