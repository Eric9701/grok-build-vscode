import { describe, it, expect } from "vitest";
import {
  isInsideWorkspace,
  isGrokOwnedPlanFile,
  isMutatingKind,
  isReadOnlyCommand,
  isPlanFileWrite,
  permissionAnswerAllowed,
  permissionOptionsForPlan,
  pickRejectOption,
  shouldBlockWrite,
  shouldBlockTerminal,
  shouldRejectPermission,
  PlanGateContext,
} from "../src/plan-gate";

// Real paths captured from the grok 0.2.3 plan-mode probe (research/plan-probe.cjs).
const WIN_ROOT = "C:\\Users\\Dell\\AppData\\Local\\Temp\\grok-plan-exp-GyuZ1W";
const WIN_WORKSPACE_WRITE = "\\\\?\\C:\\Users\\Dell\\AppData\\Local\\Temp\\grok-plan-exp-GyuZ1W\\app.js";
const WIN_PLAN_FILE =
  "\\\\?\\C:\\Users\\Dell\\.grok\\sessions\\C%3A%5CUsers%5CDell%5CAppData%5CLocal%5CTemp%5Cgrok-plan-exp-GyuZ1W\\019e6b7e\\plan.md";

const active = (root: string, grokHome?: string): PlanGateContext => ({ active: true, workspaceRoot: root, grokHome });
const off = (root: string): PlanGateContext => ({ active: false, workspaceRoot: root });

describe("isInsideWorkspace", () => {
  it("treats a write inside the workspace as inside — even with the \\\\?\\ long-path prefix", () => {
    expect(isInsideWorkspace(WIN_WORKSPACE_WRITE, WIN_ROOT)).toBe(true);
  });

  it("treats grok's own ~/.grok/.../plan.md as OUTSIDE the workspace (the key case)", () => {
    expect(isInsideWorkspace(WIN_PLAN_FILE, WIN_ROOT)).toBe(false);
  });

  it("is case-insensitive for Windows drive paths", () => {
    expect(isInsideWorkspace("c:\\Proj\\src\\a.ts", "C:\\proj")).toBe(true);
  });

  it("is case-sensitive for POSIX paths", () => {
    expect(isInsideWorkspace("/Work/src/a.ts", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/src/a.ts", "/work")).toBe(true);
  });

  it("does not treat a sibling dir with a shared prefix as inside", () => {
    expect(isInsideWorkspace("/work2/a.ts", "/work")).toBe(false);
    expect(isInsideWorkspace("C:\\proj-other\\a.ts", "C:\\proj")).toBe(false);
  });

  it("does not treat an absolute UNC path as workspace-relative", () => {
    expect(isInsideWorkspace("\\\\server\\share\\file.ts", "C:\\proj")).toBe(false);
  });

  it("resolves .. traversal that escapes the workspace as outside", () => {
    expect(isInsideWorkspace("/work/../etc/passwd", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/sub/../keep.ts", "/work")).toBe(true);
  });

  it("returns false on empty inputs", () => {
    expect(isInsideWorkspace("", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/a", "")).toBe(false);
  });
});

describe("shouldBlockWrite", () => {
  it("blocks a workspace write while planning", () => {
    expect(shouldBlockWrite(WIN_WORKSPACE_WRITE, active(WIN_ROOT))).toBe(true);
  });

  it("ALLOWS grok writing its own plan.md while planning (outside workspace)", () => {
    expect(shouldBlockWrite(WIN_PLAN_FILE, active(WIN_ROOT, "C:\\Users\\Dell\\.grok"))).toBe(false);
  });

  it("ALLOWS grok writing its own plan.md even when the home dir is the workspace", () => {
    const posixHomePlan = "/home/u/.grok/sessions/%2Fhome%2Fu/019e7608/plan.md";
    expect(isPlanFileWrite(posixHomePlan)).toBe(true);
    expect(isInsideWorkspace(posixHomePlan, "/home/u")).toBe(true);
    expect(shouldBlockWrite(posixHomePlan, active("/home/u", "/home/u/.grok"))).toBe(false);

    expect(isPlanFileWrite(WIN_PLAN_FILE)).toBe(true);
    expect(isInsideWorkspace(WIN_PLAN_FILE, "C:\\Users\\Dell")).toBe(true);
    expect(shouldBlockWrite(WIN_PLAN_FILE, active("C:\\Users\\Dell", "C:\\Users\\Dell\\.grok"))).toBe(false);
  });

  it("does not treat an arbitrary project-local .grok/sessions plan file as grok's own plan.md", () => {
    const projectPlan = "/home/u/proj/.grok/sessions/%2Fhome%2Fu%2Fproj/019e7608/plan.md";
    expect(isPlanFileWrite(projectPlan)).toBe(true);
    expect(isInsideWorkspace(projectPlan, "/home/u/proj")).toBe(true);
    expect(shouldBlockWrite(projectPlan, active("/home/u/proj", "/home/u/.grok"))).toBe(true);
  });

  it("allows any write when the gate is off (normal Agent mode never blocks)", () => {
    expect(shouldBlockWrite(WIN_WORKSPACE_WRITE, off(WIN_ROOT))).toBe(false);
  });

  it("blocks every non-plan write while planning, including paths outside the workspace", () => {
    const ctx = active("/home/u/proj", "/home/u/.grok");
    expect(shouldBlockWrite("/tmp/scratch.txt", ctx)).toBe(true);
    expect(shouldBlockWrite("/home/u/sibling-repo/src/a.ts", ctx)).toBe(true);
    expect(shouldBlockWrite("/home/u/.grok/cache/scratch.txt", ctx)).toBe(true);
  });

  it("requires a positively identified canonical Grok session plan path", () => {
    const home = "/home/u/.grok";
    const valid = "/home/u/.grok/sessions/%2Fhome%2Fu%2Fproj/019e7608/plan.md";
    expect(isGrokOwnedPlanFile(valid, home)).toBe(true);
    expect(isGrokOwnedPlanFile(valid, undefined)).toBe(false);
    expect(isGrokOwnedPlanFile("/tmp/.grok/sessions/repo/id/plan.md", home)).toBe(false);
    expect(isGrokOwnedPlanFile(
      "/home/u/.grok/sessions/repo/id/../../foreign/plan.md",
      home,
    )).toBe(false);
    expect(shouldBlockWrite(valid, active("/home/u/proj"))).toBe(true);
  });

  it("blocks a workspace write addressed with forward slashes on Windows", () => {
    expect(shouldBlockWrite("C:/proj/src/a.ts", active("C:\\proj"))).toBe(true);
  });

  it("blocks a nested workspace file while planning", () => {
    expect(shouldBlockWrite("/home/u/proj/src/deep/nested/x.ts", active("/home/u/proj"))).toBe(true);
  });

  it("blocks a relative workspace write while planning", () => {
    expect(shouldBlockWrite("src/file.ts", active("/home/u/proj"))).toBe(true);
  });
});

describe("isReadOnlyCommand", () => {
  it("allows common read-only exploration commands", () => {
    for (const c of ["ls -la", "git status", "git diff HEAD~1", "git log --oneline",
                     "grep -rn foo src", "rg pattern", "cat package.json",
                     "npm ls", "pnpm outdated", "node --version", "git rev-parse HEAD",
                     "git branch -vv", "git remote -v", "git remote show origin",
                     "git config --get user.name", "git tag --list", "git reflog show"]) {
      expect(isReadOnlyCommand(c), c).toBe(true);
    }
  });

  it("blocks mutating commands", () => {
    for (const c of ["npm install", "rm -rf build", "git commit -m x", "git push",
                     "git checkout -b feat", "node build.js", "yarn add lodash",
                     "mkdir out", "mv a b", "touch new.txt"]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks mutating forms of otherwise read-only command heads", () => {
    for (const c of ["sed -i s/a/b/ src/file.ts", "sed -Ei s/a/b/ src/file.ts",
                     "sed --in-place=.bak s/a/b/ src/file.ts",
                     "find . -delete", "find . -fprint out.txt", "find . -fprintf out.txt %p",
                     "fd -x touch src/pwned", "fd --exec-batch touch src/pwned",
                     "sort -o out.txt input.txt", "tree -o tree.txt",
                     "git diff --output=patch.diff", "git diff --ext-diff",
                     "git config user.name x", "git branch newbranch",
                     "git branch --unset-upstream", "git remote add origin example",
                     "git remote set-url origin example", "git reflog expire --expire=now --all",
                     "git tag -d v1.0.0", "npm audit --fix"]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks read-only heads when a chained segment mutates, or on redirection", () => {
    expect(isReadOnlyCommand("git diff && rm -rf x")).toBe(false);
    expect(isReadOnlyCommand("echo ok&touch src/pwned")).toBe(false); // lone & = backgrounding
    expect(isReadOnlyCommand("ls\nrm -rf src")).toBe(false);
    expect(isReadOnlyCommand("cat secrets > out.txt")).toBe(false);
    expect(isReadOnlyCommand("ls | xargs rm")).toBe(false);
    expect(isReadOnlyCommand("echo $(rm x)")).toBe(false);
  });

  it("allows only redirections that provably discard or merge streams", () => {
    for (const command of [
      "git log -1 2>$null",
      "git log -1 2>> $null",
      "git log -1 2>&1",
      "git log -1 *> $null",
      "git log -1 *>>$NULL",
    ]) {
      expect(isReadOnlyCommand(command, "powershell"), command).toBe(true);
    }
    for (const command of [
      "git log -1 2>/dev/null",
      "git log -1 2>> /dev/null",
      "git log -1 2>&1",
      "git log -1 &>/dev/null",
      "git log -1 &>> /dev/null",
      "git log -1 >| /dev/null",
    ]) {
      expect(isReadOnlyCommand(command, "posix"), command).toBe(true);
    }
    for (const command of [
      "git log -1 2>NUL",
      "git log -1 2>> nul:",
      "git log -1 2>&1",
    ]) {
      expect(isReadOnlyCommand(command, "cmd"), command).toBe(true);
    }
  });

  it("keeps every redirection that names a path blocked", () => {
    for (const dialect of ["posix", "powershell", "cmd"] as const) {
      for (const command of [
        "echo hi > out.txt",
        "git log > log.txt",
        "cmd >> append.txt",
        "git log 2> errors.txt",
      ]) {
        expect(isReadOnlyCommand(command, dialect), `${dialect}: ${command}`).toBe(false);
      }
    }
    expect(isReadOnlyCommand("git log 2>$null.txt", "powershell")).toBe(false);
    expect(isReadOnlyCommand("git log 2>/dev/null.log", "posix")).toBe(false);
    expect(isReadOnlyCommand("git log 2>NUL.txt", "cmd")).toBe(false);
  });

  it("allows chains where every segment is read-only (#36)", () => {
    expect(isReadOnlyCommand("cd repo && git status")).toBe(true); // the exact #36 shape
    expect(isReadOnlyCommand("cd src && ls -la && git diff")).toBe(true);
    expect(isReadOnlyCommand("git status; git log --oneline")).toBe(true);
    expect(isReadOnlyCommand("cat a.txt || echo missing")).toBe(true);
    expect(isReadOnlyCommand("cd repo && git log --oneline | head -5")).toBe(true); // chain + pipe mix
    expect(isReadOnlyCommand("git status;")).toBe(true); // trailing separator is harmless
  });

  it("still blocks chains where ANY segment mutates or backgrounds", () => {
    expect(isReadOnlyCommand("cd repo && npm install")).toBe(false);
    expect(isReadOnlyCommand("git status; rm -rf x")).toBe(false);
    expect(isReadOnlyCommand("ls || touch x")).toBe(false);
    expect(isReadOnlyCommand("cd repo && git commit -m x")).toBe(false);
    expect(isReadOnlyCommand("ls && cat x &")).toBe(false); // trailing background
    expect(isReadOnlyCommand("ls & cat x")).toBe(false); // cmd.exe-style single & stays blocked
    expect(isReadOnlyCommand("cd repo && cat x > out.txt")).toBe(false); // redirect anywhere blocks all
    expect(isReadOnlyCommand("gci; Remove-Item x")).toBe(false); // PowerShell ; chain
  });

  it("blocks read-only-looking commands that can execute arbitrary commands", () => {
    expect(isReadOnlyCommand("env touch src/pwned")).toBe(false);
    expect(isReadOnlyCommand("awk 'BEGIN { system(\"touch src/pwned\") }'")).toBe(false);
    expect(isReadOnlyCommand("sed '1e touch src/pwned' file.ts")).toBe(false);
  });

  it("blocks parenthesized commands hidden behind an allowlisted head", () => {
    for (const command of [
      "echo (Set-Content .\\victim.txt owned)",
      "echo (Remove-Item .\\src\\a.ts)",
      "cat (New-Item .\\z.txt)",
      "ls (npm install evil)",
      "echo @(Remove-Item .\\src\\a.ts)",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
      expect(shouldBlockTerminal(command, active("C:\\repo")), command).toBe(true);
      expect(shouldRejectPermission({
        kind: "execute",
        rawInput: { command, is_background: false },
      }, active("C:\\repo")), command).toBe(true);
    }
  });

  it("allows sips property queries from issue #89", () => {
    for (const command of [
      "sips -g pixelWidth img.png",
      "sips -g all img.png",
      "sips --getProperty pixelWidth img.png",
      "sips -g pixelWidth -g pixelHeight screenshot.png",
      "sips --oneLine -g pixelWidth assets/*.png",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
      expect(shouldBlockTerminal(command, active("/p")), command).toBe(false);
    }
  });

  it("blocks every documented sips writer, code runner, and non-query generator", () => {
    const mutatingForms = [
      "-X tag out.tag", "--extractTag tag out.tag",
      "-x out.icc", "--extractProfile out.icc",
      "-s format png", "--setProperty format png",
      "-d profile", "--deleteProperty profile",
      "--deleteTag desc", "--copyTag src dst", "--loadTag desc tag.bin", "--repair",
      "-o out.png", "--out out.png",
      "-e profile.icc", "--embedProfile profile.icc",
      "-E profile.icc", "--embedProfileIfNone profile.icc",
      "-m profile.icc", "--matchTo profile.icc",
      "-M profile.icc perceptual", "--matchToWithIntent profile.icc perceptual",
      "--deleteColorManagementProperties",
      "-r 90", "--rotate 90", "-f horizontal", "--flip horizontal",
      "-c 10 10", "--cropToHeightWidth 10 10", "--cropOffset 1 1",
      "-p 10 10", "--padToHeightWidth 10 10", "--padColor FFFFFF",
      "-z 10 10", "--resampleHeightWidth 10 10",
      "--resampleWidth 10", "--resampleHeight 10",
      "-Z 10", "--resampleHeightWidthMax 10",
      "-i", "--addIcon", "--optimizeColorForSharing",
      "-j mutate.js", "--js mutate.js", "--man",
    ];
    for (const form of mutatingForms) {
      const command = `sips -g pixelWidth ${form} img.png`;
      expect(isReadOnlyCommand(command), command).toBe(false);
      expect(shouldBlockTerminal(command, active("/p")), command).toBe(true);
    }
  });

  it("allows routine inspection commands that have no mutation mode", () => {
    for (const command of [
      "cmp before.txt after.txt",
      "comm expected.txt actual.txt",
      "jq . package.json",
      "mdls screenshot.png",
      "afinfo sound.m4a",
      "sw_vers",
      "shasum package.json",
      "md5 screenshot.png",
      "cksum archive.zip",
      "strings app",
      "hexdump -C app",
      "od -c data.bin",
      "nl -ba README.md",
      "paste left.txt right.txt",
      "join left.txt right.txt",
      "tr a-z A-Z",
      "column -t data.txt",
      "ps aux",
      "id",
      "groups",
      "locale",
      "otool -L app",
      "nm app",
      "size app",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });

  it("allows guarded mixed-purpose inspection forms without enabling their writers", () => {
    for (const command of [
      "git grep TODO",
      "git show-ref",
      "git for-each-ref --format='%(refname)'",
      "git merge-base HEAD main",
      "git check-ignore -v .env",
      "git check-attr -a package.json",
      "diff -u before.txt after.txt",
      "plutil -p Info.plist",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
    for (const command of [
      "git grep -Ovim TODO",
      "git grep --open-files-in-pager='sh -c touch-pwned' TODO",
      "git grep --open-files=vim TODO",
      "diff --output=changes.patch before.txt after.txt",
      "plutil -replace CFBundleName -string Pwned Info.plist",
      "plutil -convert json Info.plist",
      "plutil -insert NewKey -string value Info.plist",
      "plutil -remove CFBundleName Info.plist",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("blocks cmd environment expansion that can inject operators after classification", () => {
    expect(isReadOnlyCommand("echo safe %PLAN_GATE_PAYLOAD%", "cmd")).toBe(false);
    expect(isReadOnlyCommand("echo safe !PLAN_GATE_PAYLOAD!", "cmd")).toBe(false);
    expect(isReadOnlyCommand("find . -de^lete", "cmd")).toBe(false);
    expect(isReadOnlyCommand("git log --format=%H", "cmd")).toBe(true);
    expect(isReadOnlyCommand("echo safe %PLAN_GATE_PAYLOAD%", "powershell")).toBe(true);
  });

  it("normalizes quote and escape splicing before applying dangerous-option checks", () => {
    for (const command of [
      "find . '-delete'",
      "find . -de\"lete\"",
      "find . -de\\lete",
      "find . -e\\xec rm x ;",
      "npm i\\nstall evil",
      "npm 'install' evil",
      "find . -delete$IFS",
      "find . $FIND_OPTION",
      "find . -*",
      "find . -de?ete",
      "find . -[d]elete",
      "git show --format=~/.config",
      "git diff '--output=stolen.patch'",
      "sort '-o' output.txt input.txt",
      "Get-ChildItem @params",
      "cat ~/.config",
      "cat #comment",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
      expect(shouldBlockTerminal(command, active("/p")), command).toBe(true);
      expect(shouldRejectPermission({
        kind: "execute",
        rawInput: { command, is_background: false },
      }, active("/p")), command).toBe(true);
    }
    expect(isReadOnlyCommand("find . -de`lete", "powershell")).toBe(false);
    expect(isReadOnlyCommand("sort.exe /O output.txt input.txt", "powershell")).toBe(false);
    expect(isReadOnlyCommand("sort.exe /^O output.txt input.txt", "cmd")).toBe(false);
  });

  it("allows inert quoting and ordinary globs used for codebase exploration", () => {
    for (const command of [
      'grep -rn "TODO" src',
      "grep -rn 'TODO' src",
      "find . -name *.ts",
      'find . -name "*.ts"',
      'cat "my file.txt"',
      'ls "src/some dir"',
      "git log --format=%H",
      'git log --format="%h %s"',
      'rg "function foo" src',
      'Get-Content "package.json"',
      'Select-String -Pattern "TODO" -Path src',
      "echo '$(rm -rf src)'",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
      expect(shouldBlockTerminal(command, active("/p")), command).toBe(false);
      expect(shouldRejectPermission({
        kind: "execute",
        rawInput: { command, is_background: false },
      }, active("/p")), command).toBe(false);
    }
  });

  it("rejects expansion inside double quotes and globs that can become mutating options", () => {
    for (const command of [
      'echo "$PLAN_GATE_PAYLOAD"',
      'echo "`touch src/pwned`"',
      "find . -name *",
      "git diff *",
      "npm audit *",
      "fd *",
      "sort *",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
    expect(isReadOnlyCommand("find --% . %FIND_OPTION%", "powershell")).toBe(false);
  });

  it("allows read-only PowerShell pipelines (the common plan-mode listing)", () => {
    // The exact shape grok 0.2.3 issues at the start of a plan on native Windows.
    expect(isReadOnlyCommand(
      "Get-ChildItem -Force -Recurse | Select-Object -First 50 Name, FullName, Length, LastWriteTime")).toBe(true);
    expect(isReadOnlyCommand(
      "Get-ChildItem -Path . -Recurse -Force | Select-Object FullName, Name | Format-Table -Auto")).toBe(true);
    expect(isReadOnlyCommand("gci | select Name")).toBe(true);
    expect(isReadOnlyCommand("Get-Content package.json")).toBe(true);
    expect(isReadOnlyCommand("Test-Path app.js")).toBe(true);
    expect(isReadOnlyCommand("cat app.js | sls TODO")).toBe(true);
  });

  it("allows the narrow read-only PowerShell conditional production (#91)", () => {
    const real =
      "git log --oneline -15; git status --short; " +
      "git log --oneline origin/production..main 2>$null; " +
      "if (-not $?) { git branch -a | Select-String production }";
    expect(isReadOnlyCommand(real, "powershell")).toBe(true);
    expect(isReadOnlyCommand(
      "Get-ChildItem -Force | Format-Table Name, Mode; " +
      "if (Test-Path package.json) { Get-Content package.json } " +
      "else { Write-Output \"No package.json\" }",
      "powershell",
    )).toBe(true);
    expect(isReadOnlyCommand(
      "if ($LASTEXITCODE -ne 0) { git branch -a } else { git status }",
      "powershell",
    )).toBe(true);
  });

  it("keeps arbitrary, nested, computed, and mutating PowerShell blocks blocked", () => {
    for (const command of [
      "if ($(Remove-Item x)) { git status } else { git diff }",
      "if (Test-Path $target) { git status } else { git diff }",
      "if (Test-Path package.json) { Remove-Item x } else { git diff }",
      "if (Test-Path package.json) { git status } else { Set-Content x y }",
      "if (Test-Path package.json) { if ($?) { git status } else { git diff } } else { git log }",
      "if (Test-Path package.json) { git status } trailing",
      "ForEach-Object { git status }",
      "Select-Object @{n='x';e={ git status }}",
    ]) {
      expect(isReadOnlyCommand(command, "powershell"), command).toBe(false);
    }
  });

  it("still blocks a pipeline if ANY stage can write or execute", () => {
    expect(isReadOnlyCommand("Get-ChildItem | Out-File listing.txt")).toBe(false);
    expect(isReadOnlyCommand("Get-Content x | Set-Content y")).toBe(false);
    expect(isReadOnlyCommand("cat secrets.txt | iex")).toBe(false);
    expect(isReadOnlyCommand("Get-ChildItem | ForEach-Object { Remove-Item $_ }")).toBe(false); // braces blocked
    expect(isReadOnlyCommand("Select-Object @{n='x';e={ Remove-Item y }}")).toBe(false); // script-block smuggling
    expect(isReadOnlyCommand("Get-ChildItem | Where-Object { $_.Length -gt 0 } | Remove-Item")).toBe(false);
  });

  it("blocks bare git tag with an argument (can create a tag) but allows the listing form", () => {
    expect(isReadOnlyCommand("git tag")).toBe(true);
    expect(isReadOnlyCommand("git tag v1.0.0")).toBe(false);
  });

  it("treats .exe/.cmd suffixed heads the same", () => {
    expect(isReadOnlyCommand("git.exe status")).toBe(true);
  });

  it("blocks Windows cmd/PowerShell mutating builtins", () => {
    for (const c of ["del file.txt", "copy a b", "move a b", "rd /s build",
                     "Remove-Item x", "New-Item y", "rmdir out"]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks interpreters running a script but allows their --version", () => {
    expect(isReadOnlyCommand("python script.py")).toBe(false);
    expect(isReadOnlyCommand("python3 -m build")).toBe(false);
    expect(isReadOnlyCommand("python --version")).toBe(true);
    expect(isReadOnlyCommand("deno --version")).toBe(true);
  });

  it("blocks build tooling that has side effects", () => {
    for (const c of ["npm run build", "tsc", "make", "cargo build", "docker build ."]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks an empty or whitespace command", () => {
    expect(isReadOnlyCommand("")).toBe(false);
    expect(isReadOnlyCommand("   ")).toBe(false);
  });
});

describe("shouldBlockTerminal", () => {
  it("blocks a mutating command while planning", () => {
    expect(shouldBlockTerminal("npm install", active("/p"))).toBe(true);
  });
  it("allows a read-only command while planning", () => {
    expect(shouldBlockTerminal("git diff", active("/p"))).toBe(false);
  });
  it("never blocks when the gate is off", () => {
    expect(shouldBlockTerminal("rm -rf /", off("/p"))).toBe(false);
  });

  it("blocks every shell write, including legitimate attempts to persist Grok's plan", () => {
    const ws = "C:\\GitHub\\grok-build-vscode";
    const home = "C:\\Users\\Dell\\.grok";
    const plan = "C:\\Users\\Dell\\.grok\\sessions\\c%3A%5CGitHub%5Cgrok-build-vscode\\019f9240\\plan.md";
    const commands = [
      // The genuine shape and the read-only-prefix variant remain regression
      // cases: they are deliberately blocked so the CLI retries through fs.
      `@'\n# No-op plan\n\n## Goal\nChange nothing.\n'@ | Set-Content -Encoding utf8 "${plan}"`,
      `Get-Content package.json; "plan" | Out-File "${plan}"`,
      // Round-one bypasses.
      `Remove-Item .\\src\\victim.ts; "plan" | Out-File "${plan}"`,
      `npm install evil; "plan" | Out-File "${plan}"`,
      // Round-two bypasses: expandable payloads and extra writer targets.
      `"$(Set-Content .\\pwned.txt owned)" | Out-File "${plan}"`,
      `"$(& { Remove-Item .\\src\\victim.ts })" | Out-File "${plan}"`,
      `"plan" | Out-File "${plan}"; Set-Content .\\src\\victim.ts owned`,
      `Set-Content "${plan}" ".\\src\\victim.ts" -Value plan`,
    ];
    for (const command of commands) {
      expect(shouldBlockTerminal(command, active(ws, home))).toBe(true);
    }

    // The supported fallback is the ACP filesystem callback to Grok's owned
    // plan file, which remains allowed and is where plan text is snooped.
    expect(shouldBlockWrite(plan, active(ws, home))).toBe(false);
  });
});

describe("permission gating", () => {
  it("isMutatingKind classifies edit/execute as mutating and read/search as not", () => {
    expect(isMutatingKind("edit")).toBe(true);
    expect(isMutatingKind("execute")).toBe(true);
    expect(isMutatingKind("delete")).toBe(true);
    expect(isMutatingKind("read")).toBe(false);
    expect(isMutatingKind("fetch")).toBe(false);
    expect(isMutatingKind(undefined)).toBe(false);
  });

  it("auto-rejects mutating permission requests only while planning", () => {
    expect(shouldRejectPermission({ kind: "edit" }, active("/p"))).toBe(true);
    expect(shouldRejectPermission({ kind: "read" }, active("/p"))).toBe(false);
    expect(shouldRejectPermission({ kind: "edit" }, off("/p"))).toBe(false);
  });

  it("uses the command classifier for execute permission requests", () => {
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "file foo.png", is_background: false },
    }, active("/p"))).toBe(false);
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "Get-ChildItem -Force | Format-Table Name, Mode" },
    }, active("/p"))).toBe(false);
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "echo hello > file", is_background: false },
    }, active("/p"))).toBe(true);
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "npm install" },
    }, active("/p"))).toBe(true);
  });

  it("fails closed when an execute permission has no recoverable command", () => {
    expect(shouldRejectPermission({ kind: "execute" }, active("/p"))).toBe(true);
    expect(shouldRejectPermission({ kind: "execute", rawInput: {} }, active("/p"))).toBe(true);
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: 42 },
    }, active("/p"))).toBe(true);
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "   " },
    }, active("/p"))).toBe(true);
  });

  it("rejects structured background execute requests even when the command is read-only", () => {
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "ls -la", is_background: true },
    }, active("/p"))).toBe(true);
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "ls -la", is_background: "false" },
    }, active("/p"))).toBe(true);
  });

  it("does not plan-reject execute permissions when the gate is off", () => {
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command: "rm -rf /", is_background: true },
    }, off("/p"))).toBe(false);
  });

  it("rejects shell-based plan persistence on the permission path too", () => {
    const ws = "C:\\GitHub\\grok-build-vscode";
    const home = "C:\\Users\\Dell\\.grok";
    const plan = "C:\\Users\\Dell\\.grok\\sessions\\enc\\019f9240\\plan.md";
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: {
        command: `"plan text" | Out-File "${plan}"`,
        is_background: false,
      },
    }, active(ws, home))).toBe(true);
  });

  it("allows only the recognized PowerShell conditional on the permission path", () => {
    const command =
      "Get-ChildItem -Force | Format-Table Name, Mode; " +
      "if (Test-Path package.json) { Get-Content package.json } else { Write-Output \"No package.json\" }";
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: { command, is_background: false },
    }, { ...active("/p"), shellDialect: "powershell" })).toBe(false);
    expect(shouldRejectPermission({
      kind: "execute",
      rawInput: {
        command: "if (Test-Path package.json) { Get-Content package.json } else { Remove-Item x }",
        is_background: false,
      },
    }, { ...active("/p"), shellDialect: "powershell" })).toBe(true);
  });

  it("pickRejectOption prefers reject_once, falls back, and bails when none", () => {
    expect(pickRejectOption([
      { optionId: "a", kind: "allow_once" },
      { optionId: "r", kind: "reject_once" },
    ])).toBe("r");
    expect(pickRejectOption([
      { optionId: "x", kind: "allow_always" },
      { optionId: "y", kind: "deny" },
    ])).toBe("y");
    expect(pickRejectOption([{ optionId: "x", kind: "allow_once" }])).toBeUndefined();
    expect(pickRejectOption([])).toBeUndefined();
  });

  it("rejects persistent execute grants and unoffered ids at the answer boundary", () => {
    const options = [
      { optionId: "once", kind: "allow_once" },
      { optionId: "always", kind: "allow_always" },
      { optionId: "reject", kind: "reject_once" },
    ];
    expect(permissionAnswerAllowed(options, "once", true, "execute")).toBe(true);
    expect(permissionAnswerAllowed(options, "reject", true, "execute")).toBe(true);
    expect(permissionAnswerAllowed(options, "always", true, "execute")).toBe(false);
    expect(permissionAnswerAllowed(options, "forged", true, "execute")).toBe(false);
    expect(permissionAnswerAllowed(options, "always", false, "execute")).toBe(true);
  });

  it("does not render persistent execute grants while planning", () => {
    const options = [
      { optionId: "once", kind: "allow_once" },
      { optionId: "always", kind: "allow_always" },
      { optionId: "reject", kind: "reject_once" },
    ];
    expect(permissionOptionsForPlan(options, true, "execute").map((option) => option.optionId))
      .toEqual(["once", "reject"]);
    expect(permissionOptionsForPlan(
      [{ optionId: "always", kind: "allow_always" }],
      true,
      "execute",
    )).toEqual([]);
    expect(permissionOptionsForPlan(options, false, "execute")).toBe(options);
    expect(permissionOptionsForPlan(options, true, "edit")).toBe(options);
  });
});

describe("isPlanFileWrite", () => {
  it("matches grok's plan.md under .grok/sessions", () => {
    expect(isPlanFileWrite(WIN_PLAN_FILE)).toBe(true);
    expect(isPlanFileWrite("/home/u/.grok/sessions/abc/def/plan.md")).toBe(true);
  });
  it("does not match an ordinary workspace file", () => {
    expect(isPlanFileWrite(WIN_WORKSPACE_WRITE)).toBe(false);
    expect(isPlanFileWrite("/home/u/proj/plan.md")).toBe(false);
  });
});
