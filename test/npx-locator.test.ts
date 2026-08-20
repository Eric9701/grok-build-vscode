import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NPX_WELL_KNOWN_DIRS,
  npxChildPath,
  npxSpawnPlan,
  resolveNpx,
  withNpxChildEnv,
  type NpxEnv,
} from "../src/npx-locator";

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
    expect(r).toEqual({
      command: "/opt/homebrew/bin/npx",
      shell: false,
      source: "well-known",
      dir: "/opt/homebrew/bin",
    });
  });

  it("prefers PATH over the well-known list", () => {
    const r = resolveNpx(machine({
      pathEnv: "/opt/custom/bin:/usr/bin",
      files: ["/opt/custom/bin/npx", "/opt/homebrew/bin/npx"],
    }));
    expect(r).toEqual({ command: "npx", shell: false, source: "path", dir: "/opt/custom/bin" });
  });

  it("falls back through Intel Homebrew and MacPorts", () => {
    expect(resolveNpx(machine({ files: ["/usr/local/bin/npx"] })))
      .toMatchObject({ command: "/usr/local/bin/npx", source: "well-known", dir: "/usr/local/bin" });
    expect(resolveNpx(machine({ files: ["/opt/local/bin/npx"] })))
      .toMatchObject({ command: "/opt/local/bin/npx", source: "well-known", dir: "/opt/local/bin" });
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
    expect(onPath).toEqual({ command: "npx.cmd", shell: true, source: "path", dir: "C:\\nodejs" });
  });

  it("looks in the linux well-known dirs", () => {
    expect(resolveNpx(machine({
      platform: "linux",
      pathEnv: "/usr/bin:/bin",
      files: ["/usr/local/bin/npx"],
    }))).toEqual({ command: "/usr/local/bin/npx", shell: false, source: "well-known", dir: "/usr/local/bin" });
  });
});

describe("the child's PATH, not just the command string", () => {
  const stripped = "/usr/bin:/bin:/usr/sbin:/sbin";
  const homebrew = "/opt/homebrew/bin";

  it("prepends the resolved directory and the well-known list onto a stripped GUI PATH", () => {
    // A path-only fix returns `/opt/homebrew/bin/npx` and leaves PATH alone.
    // `#!/usr/bin/env node` then fails because Homebrew's node is in that
    // same missing directory. This is the assertion that would have caught it.
    expect(npxChildPath("darwin", homebrew, stripped)).toBe(
      `${homebrew}:/usr/local/bin:/opt/local/bin:${stripped}`,
    );
  });

  it("puts the resolved directory first so node next to npx wins over later PATH entries", () => {
    const parts = npxChildPath("darwin", "/opt/custom/bin", "/usr/bin").split(":");
    expect(parts[0]).toBe("/opt/custom/bin");
    expect(parts.slice(1, 4)).toEqual([...NPX_WELL_KNOWN_DIRS.darwin]);
    expect(parts.at(-1)).toBe("/usr/bin");
  });

  it("still prepends well-known dirs when npx was not found, and does not name node", () => {
    expect(npxChildPath("darwin", undefined, stripped)).toBe(
      `/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:${stripped}`,
    );
    expect(npxChildPath("darwin", homebrew, stripped)).not.toMatch(/\bnode\b/);
  });

  it("leaves a Windows PATH string alone — no prepend, no well-known dir, no dedupe", () => {
    expect(npxChildPath("win32", "C:\\nodejs", "C:\\Windows")).toBe("C:\\Windows");
    expect(npxChildPath("win32", undefined, "C:\\Windows")).toBe("C:\\Windows");
    expect(npxChildPath("win32", "C:\\nodejs", "C:\\Tools;C:\\Node;C:\\Node"))
      .toBe("C:\\Tools;C:\\Node;C:\\Node");
  });

  it("keeps duplicate entries the parent PATH already had", () => {
    expect(npxChildPath("darwin", homebrew, "/usr/bin:/usr/bin")).toBe(
      `${homebrew}:/usr/local/bin:/opt/local/bin:/usr/bin:/usr/bin`,
    );
  });

  it("withNpxChildEnv rewrites the existing PATH key on POSIX without dropping the rest", () => {
    const next = withNpxChildEnv(
      { PATH: stripped, HOME: "/Users/grok", LANG: "C" },
      "darwin",
      homebrew,
    );
    expect(next.HOME).toBe("/Users/grok");
    expect(next.LANG).toBe("C");
    expect(next.PATH).toBe(`${homebrew}:/usr/local/bin:/opt/local/bin:${stripped}`);
    const mixed = withNpxChildEnv({ Path: "/usr/bin", HOME: "/Users/a" }, "darwin", homebrew);
    expect(Object.keys(mixed)).toEqual(["Path", "HOME"]);
    expect(mixed.Path).toBe(`${homebrew}:/usr/local/bin:/opt/local/bin:/usr/bin`);
    expect(mixed.PATH).toBeUndefined();
  });

  it("clones a Windows env byte-identical, including mixed-case Path and duplicates", () => {
    // Repro: Path=C:\Tools;C:\Node;C:\Node used to come back as PATH=C:\Node;C:\Tools.
    const processEnv = { Path: "C:\\Tools;C:\\Node;C:\\Node", USERPROFILE: "C:\\Users\\a" };
    const next = withNpxChildEnv(processEnv, "win32", "C:\\nodejs");
    expect(next).not.toBe(processEnv);
    expect(Object.keys(next)).toEqual(["Path", "USERPROFILE"]);
    expect(next).toEqual(processEnv);
    expect(next.Path).toBe("C:\\Tools;C:\\Node;C:\\Node");
    expect(next.PATH).toBeUndefined();
    const plan = npxSpawnPlan("win32", {
      pathEnv: processEnv.Path,
      isFile: (p) => p === "C:\\Node\\npx.cmd",
      processEnv,
    });
    expect(plan.command).toBe("npx.cmd");
    expect(plan.shell).toBe(true);
    expect(plan.env).toEqual(processEnv);
    expect(plan.env).not.toBe(processEnv);
  });
});

describe("npxSpawnPlan", () => {
  it("keeps the Windows cmd shim with a shell when PATH is empty", () => {
    const empty = { pathEnv: "", isFile: () => false, processEnv: { PATH: "" } };
    expect(npxSpawnPlan("win32", empty)).toMatchObject({ command: "npx.cmd", shell: true, env: { PATH: "" } });
    expect(npxSpawnPlan("linux", empty)).toMatchObject({ command: "npx", shell: false });
    expect(npxSpawnPlan("darwin", empty)).toMatchObject({ command: "npx", shell: false });
    expect(npxSpawnPlan("darwin", empty).env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/opt/local/bin");
  });

  it("hands Connect a Homebrew command AND a PATH the shebang can use", () => {
    const stripped = "/usr/bin:/bin:/usr/sbin:/sbin";
    const plan = npxSpawnPlan("darwin", {
      pathEnv: stripped,
      isFile: (p) => p === "/opt/homebrew/bin/npx",
      processEnv: { PATH: stripped, HOME: "/Users/pawel" },
    });
    expect(plan.command).toBe("/opt/homebrew/bin/npx");
    expect(plan.shell).toBe(false);
    expect(plan.env.HOME).toBe("/Users/pawel");
    // Command-only would leave PATH === stripped. The child must see Homebrew
    // first so `env node` and npx's node grandchild both resolve.
    expect(plan.env.PATH).toBe(
      `/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:${stripped}`,
    );
  });
});

/**
 * Actually spawn a `#!/usr/bin/env node` npx under a PATH that has `env` and
 * not `node`. A path-only fix execs the script and then dies with
 * "node: No such file or directory"; the PATH prefix is what lets both the
 * shebang and a `node` grandchild start.
 *
 * Invokable on the Mac (and Linux CI):
 *   npx vitest run test/npx-locator.test.ts -t "shebang child"
 */
describe("shebang child under a stripped PATH", () => {
  it.skipIf(process.platform === "win32")("starts the script and a node grandchild only when PATH includes the resolved dir", () => {
    const envBin = "/usr/bin/env";
    if (!existsSync(envBin)) return;

    const root = mkdtempSync(join(tmpdir(), "npx-shebang-"));
    try {
      const binDir = join(root, "bin");
      const sysDir = join(root, "sys");
      mkdirSync(binDir);
      mkdirSync(sysDir);

      const npxFile = join(binDir, "npx");
      writeFileSync(npxFile, [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const child = spawnSync(\"node\", [\"-e\", \"process.stdout.write('grandchild-ok')\"], { encoding: \"utf8\" });",
        "process.stdout.write(JSON.stringify({",
        "  started: true,",
        "  path: process.env.PATH,",
        "  grandchild: child.status === 0 && child.stdout === \"grandchild-ok\",",
        "}));",
        "",
      ].join("\n"));
      chmodSync(npxFile, 0o755);
      symlinkSync(process.execPath, join(binDir, "node"));
      symlinkSync(envBin, join(sysDir, "env"));

      const stripped = { PATH: sysDir, LANG: "C" };
      const pathOnly = spawnSync(npxFile, [], { encoding: "utf8", env: stripped, timeout: 8_000 });
      expect(pathOnly.status).not.toBe(0);

      const env = withNpxChildEnv(stripped, process.platform, binDir);
      expect(env.PATH?.split(process.platform === "win32" ? ";" : ":")[0]).toBe(binDir);

      const ok = spawnSync(npxFile, [], { encoding: "utf8", env, timeout: 8_000 });
      expect(ok.error).toBeUndefined();
      expect(ok.status).toBe(0);
      const report = JSON.parse(ok.stdout) as { started: boolean; path: string; grandchild: boolean };
      expect(report.started).toBe(true);
      expect(report.grandchild).toBe(true);
      expect(report.path.split(":")[0]).toBe(binDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
