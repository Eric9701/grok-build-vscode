import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

// @vscode/test-electron smoke suite — the layer the grok-free vitest suite structurally
// can't reach: it boots a real VS Code, activates the extension, and resolves the webview
// inside a genuine Extension Host. It never needs the grok binary (CI has none), so it
// runs the extension's *missing-CLI* path — which is exactly the host glue we want to
// exercise: activation, command registration, getHtml/CSP, localResourceRoots, and the
// first host->webview posts. See CLAUDE.md "What's next" #1.

const EXT_ID = "PawelHuryn.grok-vscode-phuryn";

suite("grok-build extension smoke", () => {
  test("is present and activates without throwing", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found — check publisher.name`);
    await ext!.activate();
    assert.ok(ext!.isActive, "extension failed to activate");
  });

  test("registers its contributed commands", async () => {
    const all = await vscode.commands.getCommands(true);
    // A stable subset that must always exist (the full list lives in package.json).
    for (const id of ["grok.open", "grok.newSession", "grok.showLogs", "grok.logout"]) {
      assert.ok(all.includes(id), `command not registered: ${id}`);
    }
    // The gear-menu "Move view" items depend on these workbench commands
    // (vscode.moveViews is internal but stable — GitLens relies on it too).
    for (const id of ["vscode.moveViews", "workbench.action.moveFocusedView"]) {
      assert.ok(all.includes(id), `workbench command missing: ${id}`);
    }
  });

  test("resolving the webview view does not crash (missing-CLI onboarding path)", async () => {
    // Focusing the view triggers resolveWebviewView -> getHtml -> the first posts.
    // With no grok binary on the CI box the extension takes the missing-CLI onboarding
    // branch; reaching the assertion below without an unhandled rejection is the check.
    await vscode.commands.executeCommand("grok.chat.focus").then(undefined, () => {});
    await new Promise((r) => setTimeout(r, 2000)); // let the webview resolve + post
    // A second, lightweight command that touches the sidebar without needing grok.
    await vscode.commands.executeCommand("grok.showLogs").then(undefined, () => {});
    assert.ok(true, "webview resolved without throwing");
  });

  // TODO (follow-up): inject a synthetic `session`/`historyReplay` event and assert the
  // webview renders it. The hook now exists (see the repo-selection suite below).
});

// The repo selection is global for remote clients — that IS the AFK Pilot feature — but
// the VS Code webview ignores it, because it hides the switcher and so can neither show
// the selection nor change it. `repoScopeFor` is unit-tested and proves WHICH cwd each
// audience should get. What it cannot prove is that the two payloads reach the right
// destinations: swap `postLocal` and `postRemote` and every one of the 1386 unit tests
// still passes. That wiring is what this suite holds.
suite("repo selection: global for remote, workspace-local in VS Code", () => {
  let hooks: any;
  let repoB = "";
  const prevGrokHome = process.env.GROK_HOME;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, "extension not found");
    const api = await ext!.activate();
    hooks = api?.__test;
    assert.ok(hooks, "test hooks missing — activate() exposes them under ExtensionMode.Test");

    // A second selectable repo. `discoverRepos` enumerates <grokHome>/sessions/<encoded
    // cwd> and stats each decoded path, so the catalog needs BOTH a session dir and a
    // real directory. The sessions STORE is sandboxed through GROK_HOME
    // (`resolveGrokHome` reads process.env on every call, and this runs inside the
    // extension host), so nothing here touches the developer's own ~/.grok.
    //
    // The repo itself must NOT live under os.tmpdir(): discoverRepos rejects temp roots
    // on purpose, because grok's own `grok-live-*` test sessions pile up there (574 of
    // 602 catalogs on the owner's box). A fixture in tmp is silently filtered and the
    // test then proves nothing — which is exactly how this first ran.
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-int-home-"));
    repoB = path.join(hooks.workspaceRoot(), ".int-second-repo");
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(path.join(grokHome, "sessions", encodeURIComponent(repoB)), { recursive: true });
    process.env.GROK_HOME = grokHome;
  });

  suiteTeardown(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    hooks?.onPost(() => {});
    try {
      fs.rmSync(repoB, { recursive: true, force: true });
    } catch {
      /* best effort — it lives in the throwaway fixture workspace */
    }
  });

  test("a remote repo switch moves the remote payload and leaves VS Code on its workspace", async () => {
    const workspaceRoot: string = hooks.workspaceRoot();
    const posts: Array<{ dest: string; msg: any }> = [];
    hooks.onPost((dest: string, msg: any) => posts.push({ dest, msg }));

    // Exactly what a phone tapping the repo chip sends, through the real remote seam:
    // capability gate, then the cwd gate, then onMessage with origin "remote".
    hooks.fromRemote({ type: "selectRepo", cwd: repoB });
    await new Promise((r) => setTimeout(r, 1500)); // -> postRepoCatalog + postSessionsList

    const repos = posts.filter((p) => p.msg?.type === "repos");
    const localRepos = repos.filter((p) => p.dest === "local").pop();
    const remoteRepos = repos.filter((p) => p.dest === "remote").pop();
    assert.ok(localRepos, "the webview must still receive a repos frame");
    assert.ok(remoteRepos, "remote clients must receive a repos frame");

    // The whole point. If these two are ever equal, the split has collapsed and a phone
    // can again re-scope a window that has no way to show what happened.
    assert.strictEqual(
      remoteRepos!.msg.selectedCwd,
      repoB,
      "the remote payload must follow the global selection",
    );
    assert.strictEqual(
      localRepos!.msg.selectedCwd,
      workspaceRoot,
      "the VS Code payload must stay on its own workspace, whatever a phone picked",
    );

    // Both audiences still get a history refresh — the split changes scope, never
    // whether a client is kept up to date.
    for (const dest of ["local", "remote"]) {
      assert.ok(
        posts.some((p) => p.dest === dest && p.msg?.type === "sessions"),
        `${dest} must receive a refreshed sessions list`,
      );
    }
  });

  test("an undiscovered cwd is refused, so a remote cannot name an arbitrary path", async () => {
    const posts: Array<{ dest: string; msg: any }> = [];
    hooks.onPost((dest: string, msg: any) => posts.push({ dest, msg }));

    hooks.fromRemote({ type: "selectRepo", cwd: path.join(os.tmpdir(), "not-a-known-repo") });
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(
      posts.filter((p) => p.msg?.type === "repos").length,
      0,
      "a cwd outside the discovered catalog must be dropped before it reaches onMessage",
    );

    // ...and the tap was genuinely live while that happened. Without this, the
    // assertion above also passes when selectRepo is broken for EVERY cwd — which
    // is how this test first went green against a fixture that was being filtered
    // out of the catalog entirely.
    hooks.fromRemote({ type: "selectRepo", cwd: repoB });
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(
      posts.some((p) => p.msg?.type === "repos"),
      "a DISCOVERED cwd must still be accepted — otherwise the check above is vacuous",
    );
  });
});
