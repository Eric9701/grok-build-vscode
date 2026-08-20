import { describe, expect, it } from "vitest";
import { NPX_WELL_KNOWN_DIRS, npxSpawnPlan, resolveNpx, type NpxEnv } from "../src/npx-locator";

/** A machine described as a set of files that exist. */
const machine = (opts: {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  files?: string[];
}): NpxEnv => ({
  platform: opts.platform ?? "darwin",
  pathEnv: opts.pathEnv ?? "/usr/bin:/bin",
  isFile: (p) => (opts.files ?? []).includes(p),
});

describe("finding npx when PATH is stripped", () => {
  it("finds the Homebrew binary a Finder-launched app's PATH cannot see", () => {
    // Owner's Mac mini, macOS 15.6 arm64: /etc/paths is the path_helper set a
    // GUI app inherits, and npx lives only in /opt/homebrew/bin.
    const r = resolveNpx(machine({
      pathEnv: "/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      files: ["/opt/homebrew/bin/npx"],
    }));
    expect(r).toEqual({ command: "/opt/homebrew/bin/npx", shell: false, source: "well-known" });
  });

  it("prefers PATH over the well-known list", () => {
    const r = resolveNpx(machine({
      pathEnv: "/opt/custom/bin:/usr/bin",
      files: ["/opt/custom/bin/npx", "/opt/homebrew/bin/npx"],
    }));
    expect(r).toEqual({ command: "npx", shell: false, source: "path" });
  });

  it("falls back through Intel Homebrew and MacPorts", () => {
    expect(resolveNpx(machine({ files: ["/usr/local/bin/npx"] })))
      .toMatchObject({ command: "/usr/local/bin/npx", source: "well-known" });
    expect(resolveNpx(machine({ files: ["/opt/local/bin/npx"] })))
      .toMatchObject({ command: "/opt/local/bin/npx", source: "well-known" });
  });

  it("still returns the bare command when nothing is installed, so spawn ENOENT stays npx-missing", () => {
    expect(resolveNpx(machine({}))).toEqual({ command: "npx", shell: false, source: "missing" });
  });

  it("uses npx.cmd + a shell on Windows and does not guess a well-known dir", () => {
    expect(NPX_WELL_KNOWN_DIRS.win32).toEqual([]);
    const missing = resolveNpx(machine({
      platform: "win32",
      pathEnv: "C:\\Windows\\system32",
    }));
    expect(missing).toEqual({ command: "npx.cmd", shell: true, source: "missing" });
    const onPath = resolveNpx(machine({
      platform: "win32",
      pathEnv: "C:\\nodejs;C:\\Windows",
      files: ["C:\\nodejs\\npx.cmd"],
    }));
    expect(onPath).toEqual({ command: "npx.cmd", shell: true, source: "path" });
  });

  it("looks in the linux well-known dirs", () => {
    expect(resolveNpx(machine({
      platform: "linux",
      pathEnv: "/usr/bin:/bin",
      files: ["/usr/local/bin/npx"],
    }))).toEqual({ command: "/usr/local/bin/npx", shell: false, source: "well-known" });
  });
});

describe("npxSpawnPlan", () => {
  it("keeps the Windows cmd shim with a shell when PATH is empty", () => {
    const empty = { pathEnv: "", isFile: () => false };
    expect(npxSpawnPlan("win32", empty)).toEqual({ command: "npx.cmd", shell: true });
    expect(npxSpawnPlan("linux", empty)).toEqual({ command: "npx", shell: false });
    expect(npxSpawnPlan("darwin", empty)).toEqual({ command: "npx", shell: false });
  });

  it("hands Connect the Homebrew path a fabricated Finder PATH cannot see", () => {
    expect(npxSpawnPlan("darwin", {
      pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin",
      isFile: (p) => p === "/opt/homebrew/bin/npx",
    })).toEqual({ command: "/opt/homebrew/bin/npx", shell: false });
  });
});
