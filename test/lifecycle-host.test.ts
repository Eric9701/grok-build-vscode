import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_HOST_READY_LINE,
  LIFECYCLE_WORKSPACES_ENV,
  parseLifecycleWorkspaces,
} from "../scripts/lifecycle-host.mjs";

describe("parseLifecycleWorkspaces", () => {
  it("splits on the OS path delimiter", () => {
    expect(parseLifecycleWorkspaces("C:\\a;C:\\b", ";")).toEqual(["C:\\a", "C:\\b"]);
    expect(parseLifecycleWorkspaces("/a:/b", ":")).toEqual(["/a", "/b"]);
  });

  it("accepts a JSON array so a path containing the delimiter survives", () => {
    expect(parseLifecycleWorkspaces('["/tmp/a","/tmp/b"]')).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("treats empty / missing as no workspaces", () => {
    expect(parseLifecycleWorkspaces(undefined)).toEqual([]);
    expect(parseLifecycleWorkspaces("")).toEqual([]);
    expect(parseLifecycleWorkspaces("   ")).toEqual([]);
  });

  it("rejects JSON that is not an array of paths", () => {
    expect(() => parseLifecycleWorkspaces('{"cwd":"/a"}')).toThrow(/array/i);
    expect(() => parseLifecycleWorkspaces("[")).toThrow(/JSON/i);
  });

  it("keeps the env name and ready line stable for part 2", () => {
    expect(LIFECYCLE_WORKSPACES_ENV).toBe("GROK_LIFECYCLE_WORKSPACES");
    expect(LIFECYCLE_HOST_READY_LINE).toBe("GROK_LIFECYCLE_HOST_READY");
    // Greppable and unlikely to collide with desktop log lines.
    expect(LIFECYCLE_HOST_READY_LINE).toMatch(/^GROK_LIFECYCLE_HOST_READY$/);
  });
});

describe("lifecycle-host runner", () => {
  it("applies the token gate before spawning Electron", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lifecycle-host.mjs"),
      "utf8",
    );
    const gateAt = src.indexOf("resolveInjectedDeviceToken({");
    const electronAt = src.indexOf("electronExe,");
    expect(gateAt).toBeGreaterThan(0);
    expect(electronAt).toBeGreaterThan(gateAt);
    expect(src).toContain("isProduction: false");
    expect(src).toContain("refusing to start");
  });
});
