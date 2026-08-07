import { describe, it, expect } from "vitest";
import {
  buildKeepAwakePlan,
  encodePowerShellCommand,
  ES_CONTINUOUS_SYSTEM_REQUIRED,
  isWslRelease,
  keepAwakeFallbackWhat,
  KEEP_AWAKE_WATCH_SECONDS,
  KEEP_AWAKE_WHO,
  shouldKeepAwake,
  windowsKeepAwakeScript,
} from "../src/keep-awake";

const HOST_PID = 4242;

describe("keep-awake policy", () => {
  it("holds the lock when enabled AND (linked OR a turn is in flight)", () => {
    expect(shouldKeepAwake({ enabled: true, linked: true })).toBe(true);
    expect(shouldKeepAwake({ enabled: true, linked: false })).toBe(false);
    expect(shouldKeepAwake({ enabled: false, linked: true })).toBe(false);
    expect(shouldKeepAwake({ enabled: false, linked: false })).toBe(false);
    // Local turn without AFK Pilot link — the desktop/VS Code walk-away case.
    expect(shouldKeepAwake({ enabled: true, linked: false, turnInFlight: true })).toBe(true);
    expect(shouldKeepAwake({ enabled: true, linked: true, turnInFlight: true })).toBe(true);
    // Opt-out still wins even mid-turn.
    expect(shouldKeepAwake({ enabled: false, linked: false, turnInFlight: true })).toBe(false);
    // turnInFlight false is explicit rest.
    expect(shouldKeepAwake({ enabled: true, linked: false, turnInFlight: false })).toBe(false);
  });
});

describe("macOS wake lock", () => {
  const plan = buildKeepAwakePlan("darwin", { pid: HOST_PID })!;

  it("caffeinates idle + system sleep and dies with the extension host", () => {
    expect(plan.file).toBe("caffeinate");
    expect(plan.args).toEqual(["-i", "-s", "-w", String(HOST_PID)]);
  });

  it("never asks for -d — the display is free to sleep while you're away", () => {
    expect(plan.args).not.toContain("-d");
  });
});

describe("Windows wake lock", () => {
  const plan = buildKeepAwakePlan("win32", { pid: HOST_PID })!;
  const script = Buffer.from(plan.args[plan.args.length - 1], "base64").toString("utf16le");

  it("runs an encoded PowerShell command with no profile", () => {
    expect(plan.file).toBe("powershell.exe");
    expect(plan.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(encodePowerShellCommand(windowsKeepAwakeScript(HOST_PID))).toBe(plan.args[3]);
  });

  it("asserts ES_CONTINUOUS|ES_SYSTEM_REQUIRED as a uint32 PowerShell can pass through", () => {
    // 0x80000000 | 0x1 — the hex literal would parse as a negative Int32 and the
    // P/Invoke signature (uint) would reject it, so it must stay decimal.
    expect(ES_CONTINUOUS_SYSTEM_REQUIRED).toBe(0x80000000 + 0x1);
    expect(script).toContain(`SetThreadExecutionState([uint32]${ES_CONTINUOUS_SYSTEM_REQUIRED})`);
    expect(script).not.toContain("0x80000001");
  });

  it("never asks for ES_DISPLAY_REQUIRED (0x2)", () => {
    expect(script).not.toContain("2147483651");
  });

  it("parks on its own thread — the flag is per-thread, so a one-shot call would be dropped", () => {
    expect(script).toContain(`Start-Sleep -Seconds ${KEEP_AWAKE_WATCH_SECONDS}`);
    expect(script).toContain(`Get-Process -Id ${HOST_PID}`);
  });
});

describe("Linux wake lock", () => {
  it("blocks logind idle+sleep and identifies itself in --list", () => {
    const plan = buildKeepAwakePlan("linux", { pid: HOST_PID })!;
    expect(plan.file).toBe("systemd-inhibit");
    expect(plan.args).toContain("--what=idle:sleep");
    expect(plan.args).toContain("--mode=block");
    expect(plan.args).toContain(`--who=${KEEP_AWAKE_WHO}`);
  });

  it("holds the inhibitor with a loop that ends when the extension host does", () => {
    const plan = buildKeepAwakePlan("linux", { pid: HOST_PID })!;
    expect(plan.args[plan.args.length - 1]).toContain(`kill -0 ${HOST_PID}`);
  });

  it("honours an explicit --what (the polkit fallback)", () => {
    const plan = buildKeepAwakePlan("linux", { pid: HOST_PID, what: "idle" })!;
    expect(plan.args).toContain("--what=idle");
  });

  it("falls back idle:sleep -> idle exactly once", () => {
    expect(keepAwakeFallbackWhat("linux", undefined)).toBe("idle");
    expect(keepAwakeFallbackWhat("linux", "idle:sleep")).toBe("idle");
    expect(keepAwakeFallbackWhat("linux", "idle")).toBeNull();
  });

  it("has no fallback on the other platforms — a failure there is just a failure", () => {
    expect(keepAwakeFallbackWhat("win32", undefined)).toBeNull();
    expect(keepAwakeFallbackWhat("darwin", undefined)).toBeNull();
  });
});

describe("unsupported hosts", () => {
  it("no-ops under WSL — the Windows host owns the sleep decision", () => {
    expect(isWslRelease("5.15.153.1-microsoft-standard-WSL2")).toBe(true);
    expect(isWslRelease("6.8.0-45-generic")).toBe(false);
    expect(isWslRelease(undefined)).toBe(false);
    expect(buildKeepAwakePlan("linux", { pid: HOST_PID, release: "5.15.153.1-microsoft-standard-WSL2" })).toBeNull();
    expect(buildKeepAwakePlan("linux", { pid: HOST_PID, release: "6.8.0-45-generic" })).not.toBeNull();
  });

  it("returns null on a platform we have no wake lock for", () => {
    expect(buildKeepAwakePlan("freebsd", { pid: HOST_PID })).toBeNull();
    expect(buildKeepAwakePlan("aix", { pid: HOST_PID })).toBeNull();
  });
});
