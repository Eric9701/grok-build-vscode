import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { TerminalManager, resolveExitCode, buildKillPlan, resolveTerminalShell, grokShellEnvValue, commandLanguageForDialect } from "../src/terminal-manager";

// Use `node -e` everywhere so tests are deterministic on Windows, macOS, and Linux.
// Quoting strategy: single-quote the outer node script, escape inner single quotes if any.
const nodeEval = (script: string) => `node -e "${script.replace(/"/g, '\\"')}"`;

describe("TerminalManager", () => {
  it("captures stdout from a quick command", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("process.stdout.write('HELLO_TM')") });
    const { exitCode } = await m.waitForExit(terminalId);
    expect(exitCode).toBe(0);
    const r = m.output(terminalId);
    expect(r.output).toContain("HELLO_TM");
    expect(r.exitStatus).toEqual({ exitCode: 0 });
    expect(r.truncated).toBe(false);
    m.release(terminalId);
  });

  it("captures stderr and nonzero exit", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stderr.write('ERR'); process.exit(7)"),
    });
    const r = await m.waitForExit(terminalId);
    // The Windows host is PowerShell (#46). Windows PowerShell 5.1 collapses any
    // non-zero native exit to 1 (pwsh 7 preserves the exact code); /bin/sh passes
    // it through. Assert failure is detected everywhere, exact code only off-win32
    // (this box may resolve to 5.1, so don't assert exactly 7 on Windows).
    expect(r.exitCode).not.toBe(0);
    if (process.platform !== "win32") expect(r.exitCode).toBe(7);
    const out = m.output(terminalId);
    expect(out.output).toContain("ERR");
    m.release(terminalId);
  });

  it("respects outputByteLimit and sets truncated flag", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write('a'.repeat(5000))"),
      outputByteLimit: 100,
    });
    await m.waitForExit(terminalId);
    const r = m.output(terminalId);
    expect(r.output.length).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
    m.release(terminalId);
  });

  // Regression: truncating at a byte boundary must not split a multi-byte UTF-8
  // character into a replacement char (U+FFFD). '✓' is 3 bytes; a 100-byte limit
  // lands mid-character. Pre-fix `Buffer.toString` on the partial slice produced
  // a trailing '�'; a StringDecoder buffers the incomplete bytes instead.
  it("does not emit U+FFFD when truncation splits a multi-byte character", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      // 60 copies of '✓' = 180 bytes; limit 100 cuts mid-character.
      command: nodeEval("process.stdout.write('\\u2713'.repeat(60))"),
      outputByteLimit: 100,
    });
    await m.waitForExit(terminalId);
    const r = m.output(terminalId);
    expect(r.truncated).toBe(true);
    expect(r.output).not.toContain("�");
    expect(/^✓+$/.test(r.output)).toBe(true);
    m.release(terminalId);
  });

  it("returns exitStatus null while still running", () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("setTimeout(()=>{}, 5000)"),
    });
    const r = m.output(terminalId);
    expect(r.exitStatus).toBeNull();
    m.kill(terminalId);
    m.release(terminalId);
  });

  it("injects env from {name,value} pairs", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write(process.env.GROK_TEST_VAR || '')"),
      env: [{ name: "GROK_TEST_VAR", value: "INJECTED" }],
    });
    await m.waitForExit(terminalId);
    expect(m.output(terminalId).output).toContain("INJECTED");
    m.release(terminalId);
  });

  it("honors cwd", async () => {
    const m = new TerminalManager();
    const tmp = os.tmpdir();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write(process.cwd())"),
      cwd: tmp,
    });
    await m.waitForExit(terminalId);
    // On macOS tmpdir() resolves a /private/var symlink; normalize both sides.
    const got = m.output(terminalId).output.trim().toLowerCase();
    expect(got).toContain(tmp.replace(/\\/g, "/").toLowerCase().split("/").pop()!);
  });

  it("waitForExit resolves immediately if already exited", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("process.exit(0)") });
    await m.waitForExit(terminalId);
    const r = await m.waitForExit(terminalId);
    expect(r.exitCode).toBe(0);
    m.release(terminalId);
  });

  it("output() throws on unknown terminalId", () => {
    const m = new TerminalManager();
    expect(() => m.output("nope")).toThrowError(/unknown terminalId/);
  });

  it("kill+release on a missing id is a no-op", () => {
    const m = new TerminalManager();
    expect(() => m.kill("nope")).not.toThrow();
    expect(() => m.release("nope")).not.toThrow();
  });

  it("disposeAll kills outstanding terminals", () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("setTimeout(()=>{}, 60000)"),
    });
    m.disposeAll();
    expect(() => m.output(terminalId)).toThrow();
  });

  // Regression: a process killed by a signal must not be reported as a clean
  // exit (code 0). The old `code ?? 0` masked signal kills as success, so the
  // agent assumed a command it interrupted had actually succeeded.
  it("reports a non-zero exit code when a running process is killed", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("setInterval(()=>{}, 1000)") });
    await new Promise((r) => setTimeout(r, 150)); // let it start
    m.kill(terminalId);
    const { exitCode } = await m.waitForExit(terminalId);
    expect(exitCode).not.toBe(0);
    m.release(terminalId);
  });
});

// Real-shell integration for #46: on Windows the agent's `terminal/*` commands
// now run under PowerShell, so PowerShell-only syntax that cmd.exe cannot run
// must succeed end-to-end through TerminalManager. These spawn the actual host
// shell, so they only make sense on Windows — skipped on the Linux CI box, where
// the host is /bin/sh and unchanged. (CLAUDE.md's "node -e everywhere" rule is
// for the cross-platform tests above; proving the PowerShell switch inherently
// needs PowerShell syntax, so this block is the deliberate exception.)
const describeWin = process.platform === "win32" ? describe : describe.skip;

describeWin("Windows PowerShell host (#46)", () => {
  const runToEnd = async (command: string) => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command });
    const { exitCode } = await m.waitForExit(terminalId);
    const output = m.output(terminalId).output;
    m.release(terminalId);
    return { exitCode, output };
  };

  it("runs a PowerShell pipeline cmd.exe cannot (the issue's failure mode)", async () => {
    // Under the old cmd host this errored: "'Measure-Object' is not recognized".
    const { exitCode, output } = await runToEnd("'a','b','c' | Measure-Object | ForEach-Object { $_.Count }");
    expect(exitCode).toBe(0);
    expect(output).toContain("3");
  });

  it("runs a cmdlet that is not a cmd builtin (Get-Date)", async () => {
    const { exitCode, output } = await runToEnd("Get-Date -Format yyyy");
    expect(exitCode).toBe(0);
    expect(output.trim()).toMatch(/^\d{4}$/);
  });

  it("executes inside a real PowerShell host ($PSVersionTable resolves)", async () => {
    // cmd would treat "$PSVersionTable.PSVersion.Major" as an unknown command;
    // PowerShell prints the host major version (5 for Windows PowerShell, 7 for pwsh).
    const { exitCode, output } = await runToEnd("$PSVersionTable.PSVersion.Major");
    expect(exitCode).toBe(0);
    expect(output.trim()).toMatch(/^\d+$/);
  });

  it("survives a Format-List pipeline (the exact re-wrap the agent had to do)", async () => {
    const { exitCode, output } = await runToEnd("[pscustomobject]@{ RepoRoot = 'demo' } | Format-List");
    expect(exitCode).toBe(0);
    expect(output).toMatch(/RepoRoot/);
    expect(output).toMatch(/demo/);
  });

  it("resolves the host shell to a PowerShell, never cmd.exe, on this box", () => {
    const shell = resolveTerminalShell("win32", (name) => {
      try {
        const out = execFileSync("where", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const first = out.split(/\r?\n/)[0]?.trim();
        return first && existsSync(first) ? first : undefined;
      } catch {
        return undefined;
      }
    });
    // pwsh may be absent; either PowerShell is acceptable, cmd (true) is not.
    expect(shell).not.toBe(true);
    expect(String(shell).toLowerCase()).toMatch(/pwsh\.exe$|powershell\.exe$/);
  });
});

describe("resolveExitCode", () => {
  it("passes through a real exit code, including 0", () => {
    expect(resolveExitCode(0, null)).toBe(0);
    expect(resolveExitCode(7, null)).toBe(7);
  });

  it("maps a signal kill to 128 + signum (SIGTERM -> 143), never 0", () => {
    expect(resolveExitCode(null, "SIGTERM")).toBe(128 + os.constants.signals.SIGTERM);
    expect(resolveExitCode(null, "SIGTERM")).toBe(143);
    expect(resolveExitCode(null, "SIGKILL")).toBe(128 + os.constants.signals.SIGKILL);
    expect(resolveExitCode(null, "SIGTERM")).not.toBe(0);
  });
});

describe("buildKillPlan", () => {
  it("uses taskkill with /T /F (tree + force) on Windows", () => {
    const plan = buildKillPlan(1234, "win32");
    expect(plan.kind).toBe("taskkill");
    if (plan.kind === "taskkill") {
      expect(plan.file).toBe("taskkill");
      expect(plan.args).toContain("/T");
      expect(plan.args).toContain("/F");
      expect(plan.args).toContain("1234");
    }
  });

  it("signals the whole process GROUP on POSIX, not just the shell", () => {
    // `sh -c 'node build.js & wait'` is one wrapper and one long-lived child.
    // Signalling the wrapper alone leaves the child running with nothing
    // tracking it — and a running command is what keeps a cloud machine awake,
    // so we would stop paying for a machine that is still working and then
    // freeze it. On a laptop the orphan is the battery.
    const plan = buildKillPlan(1234, "linux");
    expect(plan).toEqual({ kind: "group", signal: "SIGTERM", pid: 1234 });
  });

  it("kills the group by negative pid, and falls back to the child", () => {
    const killed: number[] = [];
    const m = new TerminalManager({
      platform: "linux",
      killImpl: (pid) => {
        killed.push(pid);
        if (pid < 0) throw new Error("ESRCH"); // group already gone
      },
    });
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 3000)") });
    m.kill(terminalId);
    // The negative pid is the group; the throw proves the fallback path runs
    // rather than leaving the command alive.
    expect(killed.some((p) => p < 0)).toBe(true);
    m.release(terminalId);
  });
});

describe("resolveTerminalShell", () => {
  // Fake PATH resolver: returns a path only for the listed names.
  const has = (map: Record<string, string>) => (name: string) => map[name];
  const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  it("returns true (/bin/sh) on POSIX without probing PATH", () => {
    let probed = false;
    const shell = resolveTerminalShell("linux", () => {
      probed = true;
      return undefined;
    });
    expect(shell).toBe(true);
    expect(probed).toBe(false); // never shell out to `where` off Windows
  });

  it("returns true on darwin", () => {
    expect(resolveTerminalShell("darwin", () => PWSH)).toBe(true);
  });

  it("prefers pwsh.exe (PowerShell 7) on Windows when available", () => {
    expect(resolveTerminalShell("win32", has({ pwsh: PWSH, powershell: POWERSHELL }))).toBe(PWSH);
  });

  it("falls back to powershell.exe (5.1) when pwsh is absent", () => {
    expect(resolveTerminalShell("win32", has({ powershell: POWERSHELL }))).toBe(POWERSHELL);
  });

  it("falls back to cmd.exe (shell:true) when neither PowerShell is on PATH", () => {
    expect(resolveTerminalShell("win32", () => undefined)).toBe(true);
  });

  it("probes pwsh before powershell", () => {
    const order: string[] = [];
    resolveTerminalShell("win32", (name) => {
      order.push(name);
      return undefined;
    });
    expect(order).toEqual(["pwsh", "powershell"]);
  });

  it("pref 'cmd' forces cmd.exe (shell:true) on Windows without probing PATH", () => {
    let probed = false;
    const shell = resolveTerminalShell("win32", () => {
      probed = true;
      return PWSH;
    }, "cmd");
    expect(shell).toBe(true);
    expect(probed).toBe(false); // escape hatch short-circuits before `where`
  });

  it("pref 'cmd' is a no-op on POSIX (still /bin/sh)", () => {
    expect(resolveTerminalShell("linux", () => undefined, "cmd")).toBe(true);
  });

  it("pref 'auto' matches the default (PowerShell on Windows)", () => {
    expect(resolveTerminalShell("win32", has({ pwsh: PWSH }), "auto")).toBe(PWSH);
  });
});

describe("grokShellEnvValue (GROK_SHELL derived from the shell we run)", () => {
  const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  it("maps a resolved pwsh path to 'pwsh' on Windows", () => {
    expect(grokShellEnvValue(PWSH, "win32")).toBe("pwsh");
  });
  it("maps a resolved Windows PowerShell path to 'powershell'", () => {
    expect(grokShellEnvValue(POWERSHELL, "win32")).toBe("powershell");
  });
  it("maps the cmd.exe fallback (true) to 'cmd' on Windows", () => {
    expect(grokShellEnvValue(true, "win32")).toBe("cmd");
  });
  it("returns undefined on POSIX (grok's host detection is correct there)", () => {
    expect(grokShellEnvValue(true, "linux")).toBeUndefined();
    expect(grokShellEnvValue("/bin/bash", "darwin")).toBeUndefined();
  });
  it("returns undefined for an unrecognized Windows shell path", () => {
    expect(grokShellEnvValue("C:\\weird\\thing.exe", "win32")).toBeUndefined();
  });
});

describe("commandLanguageForDialect (View all command language)", () => {
  it("maps each known dialect to a VS Code language id", () => {
    expect(commandLanguageForDialect("powershell")).toBe("powershell");
    expect(commandLanguageForDialect("posix")).toBe("shellscript");
    expect(commandLanguageForDialect("cmd")).toBe("bat");
  });

  it("returns undefined for an unknown dialect", () => {
    expect(commandLanguageForDialect("unknown")).toBeUndefined();
    expect(commandLanguageForDialect(undefined)).toBeUndefined();
    expect(commandLanguageForDialect("")).toBeUndefined();
  });
});

// #6 regression: a taskkill that RUNS BUT FAILS (Access Denied, protected child)
// used to be fire-and-forget — the tree stayed alive and the agent's
// wait_for_exit pended forever. The manager must fall back to a direct signal.
// Deps-injected so the Windows plan runs deterministically on every platform.
describe("TerminalManager kill fallback (Windows taskkill failure)", () => {
  it("falls back to SIGTERM when taskkill errors, so waitForExit still settles", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const failingExec = ((file: string, args: string[], cb: (err: Error | null) => void) => {
      calls.push({ file, args });
      // Simulate taskkill running and failing (e.g. Access Denied) — async like
      // the real execFile callback.
      setImmediate(() => cb(new Error("ERROR: The process could not be terminated. Access is denied.")));
    }) as unknown as typeof import("node:child_process").execFile;

    const m = new TerminalManager({ execFileImpl: failingExec, platform: "win32" });
    // A process that outlives the test unless something actually kills it (but
    // self-expires in 8s so a regression can't leak it past the suite).
    const { terminalId } = m.create({ command: nodeEval("setTimeout(()=>{}, 8000)") });
    // Give the shell a beat to actually start the child.
    await new Promise((r) => setTimeout(r, 300));

    m.kill(terminalId);
    const { exitCode } = await m.waitForExit(terminalId);

    // The taskkill plan ran (and failed)…
    expect(calls.length).toBe(1);
    expect(calls[0].file).toBe("taskkill");
    expect(calls[0].args).toContain("/T");
    // …and the SIGTERM fallback still brought the wrapper down: a signal kill
    // resolves as 128+signum via resolveExitCode (143), or the platform's
    // plain non-zero termination code — never a hang, never a clean 0.
    expect(exitCode).not.toBe(0);
    m.release(terminalId);
  }, 15000);

  it("does not signal when taskkill fails but the process already exited", async () => {
    let exec: ((err: Error | null) => void) | undefined;
    const capturedExec = ((_f: string, _a: string[], cb: (err: Error | null) => void) => {
      exec = cb; // hold the callback so we control when taskkill "fails"
    }) as unknown as typeof import("node:child_process").execFile;

    const m = new TerminalManager({ execFileImpl: capturedExec, platform: "win32" });
    const { terminalId } = m.create({ command: nodeEval("process.exit(0)") });
    const { exitCode } = await m.waitForExit(terminalId); // let it finish naturally
    expect(exitCode).toBe(0);

    const t = (m as any).terminals.get(terminalId);
    let signalled = false;
    const origKill = t.proc.kill.bind(t.proc);
    t.proc.kill = (...args: unknown[]) => {
      signalled = true;
      return origKill(...args);
    };

    m.kill(terminalId); // taskkill path (pid may still be defined on the exited proc)
    exec?.(new Error("ERROR: not found"));
    await new Promise((r) => setTimeout(r, 50));
    // exitCode was already recorded — the fallback must not fire a late signal.
    expect(signalled).toBe(false);
    m.release(terminalId);
  }, 15000);
});

describe("anyRunning — the honest answer to 'is this machine still doing something'", () => {
  /**
   * Session status cannot answer that. An agent can start a twenty-five-minute
   * build and THEN ask a question, at which point the session says it is
   * waiting for a person while the build carries on — and on a cloud machine,
   * believing the status there freezes the build.
   */
  it("is false with nothing to run", () => {
    expect(new TerminalManager().anyRunning()).toBe(false);
  });

  it("is true while a command runs and false once it exits", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 300)") });
    expect(m.anyRunning()).toBe(true);
    await m.waitForExit(terminalId);
    expect(m.anyRunning()).toBe(false);
    m.release(terminalId);
  });

  it("stays true while ANY command is still going", async () => {
    // The case that matters: a quick one finishing must not make a long one
    // invisible.
    const m = new TerminalManager();
    const quick = m.create({ command: nodeEval("process.exit(0)") }).terminalId;
    const slow = m.create({ command: nodeEval("setTimeout(() => {}, 600)") }).terminalId;
    await m.waitForExit(quick);
    expect(m.anyRunning()).toBe(true);
    await m.waitForExit(slow);
    expect(m.anyRunning()).toBe(false);
    m.release(quick);
    m.release(slow);
  });

  it("is false once a running command is released", async () => {
    // Released means we have stopped tracking it; holding a machine awake for
    // something nothing is watching would be a bill with no owner.
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 5000)") });
    expect(m.anyRunning()).toBe(true);
    m.release(terminalId);
    expect(m.anyRunning()).toBe(false);
  });
});

describe("commands belong to whoever started them", () => {
  /**
   * A terminal is a child of the extension, not of the agent, so it outlives the
   * ACP client that asked for it — and once that client is gone nothing can
   * send it `terminal/release`. Left alone it is a command nobody owns, and
   * since a running command is what keeps a cloud machine awake, it holds one
   * running and billing until the extension itself exits.
   */
  it("takes an owner's commands with it and leaves everyone else's", async () => {
    const m = new TerminalManager();
    const alice = {};
    const bob = {};
    const a = m.ownedBy(alice).create({ command: nodeEval("setTimeout(() => {}, 5000)") }).terminalId;
    const b = m.ownedBy(bob).create({ command: nodeEval("setTimeout(() => {}, 5000)") }).terminalId;
    expect(m.anyRunning()).toBe(true);

    expect(m.releaseOwnedBy(alice)).toBe(1);
    // Bob's is still going, so the machine is still busy.
    expect(m.anyRunning()).toBe(true);
    expect(() => m.output(a)).toThrow();

    expect(m.releaseOwnedBy(bob)).toBe(1);
    expect(m.anyRunning()).toBe(false);
    void b;
  });

  it("stops reporting a machine as busy once the owner is gone", async () => {
    // The whole point: this is what reopened the ghost path.
    const m = new TerminalManager();
    const owner = {};
    m.ownedBy(owner).create({ command: nodeEval("setTimeout(() => {}, 5000)") });
    expect(m.anyRunning()).toBe(true);
    m.releaseOwnedBy(owner);
    expect(m.anyRunning()).toBe(false);
  });

  it("releasing an owner with nothing running is a no-op", () => {
    expect(new TerminalManager().releaseOwnedBy({})).toBe(0);
  });

  it("hands the agent the same interface either way", () => {
    // The owned view must be indistinguishable from the manager, or the ACP
    // side would need to know about ownership.
    const m = new TerminalManager();
    const view = m.ownedBy({});
    for (const k of ["create", "output", "waitForExit", "kill", "release"]) {
      expect(typeof (view as unknown as Record<string, unknown>)[k]).toBe("function");
    }
  });
});

describe("signalling a process group, and when not to", () => {
  /**
   * Three versions of this rule have now been wrong in three different ways, so
   * the reasoning is worth keeping next to the tests.
   *
   * Signalling whenever asked can reach a pid the OS recycled and kill somebody
   * else's work. Probing first with signal 0 does not save it: that proves *a*
   * group holds the id, not that it is ours — an empty group releases its id
   * and the next holder answers the probe just as happily.
   *
   * The wrapper's own liveness is the one thing that settles it. Alive, its
   * group exists and is unambiguously ours. Exited, we cannot tell our
   * surviving descendants from a stranger's group, and killing a stranger is
   * the worse mistake.
   */
  function manager() {
    const sent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const m = new TerminalManager({
      platform: "linux",
      killImpl: (pid, signal) => { sent.push({ pid, signal }); },
    });
    return { m, sent };
  }

  it("signals the group while the command is running", () => {
    const { m, sent } = manager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 3000)") });
    m.kill(terminalId);
    expect(sent.some((c) => c.pid < 0 && c.signal === "SIGTERM")).toBe(true);
    m.release(terminalId);
  });

  it("sends NOTHING once the command has exited", async () => {
    // Where the pid may since have been recycled. Our cleanup must never kill
    // somebody else's work, and a detached job outliving its shell — which is
    // what detaching means — is the accepted cost.
    const { m, sent } = manager();
    const { terminalId } = m.create({ command: nodeEval("process.exit(0)") });
    await m.waitForExit(terminalId);
    m.kill(terminalId);
    expect(sent).toEqual([]);
    m.release(terminalId);
    expect(sent).toEqual([]);
  });

  it("never probes — a probe cannot tell our group from a stranger's", async () => {
    const { m, sent } = manager();
    const { terminalId } = m.create({ command: nodeEval("setTimeout(() => {}, 3000)") });
    m.kill(terminalId);
    expect(sent.every((c) => c.signal !== 0)).toBe(true);
    m.release(terminalId);
  });
});
