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

// Repo selection is per remote clientId. VS Code ignores it because its hidden
// switcher is permanently scoped to the workspace root. These hooks prove the
// wiring property pure registry tests cannot: each targeted snapshot and live
// session update reaches only the owning tab, even when both tabs select one repo.
suite("repo selection: isolated per remote tab, workspace-local in VS Code", () => {
  let hooks: any;
  let repoB = "";
  let grokHome = "";
  const prevGrokHome = process.env.GROK_HOME;

  const storedSessionDirFor = (cwd: string, id: string) =>
    path.join(grokHome, "sessions", encodeURIComponent(cwd), id);
  const storedSessionDir = (id: string) => storedSessionDirFor(repoB, id);

  const writeStoredSession = (id: string, cwd = repoB) => {
    const dir = storedSessionDirFor(cwd, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), "{}");
  };

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
    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-int-home-"));
    repoB = path.join(hooks.workspaceRoot(), ".int-second-repo");
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(path.join(repoB, ".git"));
    fs.mkdirSync(path.join(grokHome, "sessions", encodeURIComponent(repoB)), { recursive: true });
    process.env.GROK_HOME = grokHome;
  });

  suiteTeardown(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    hooks?.onPost(() => {});
    try {
      fs.rmSync(repoB, { recursive: true, force: true });
      fs.rmSync(grokHome, { recursive: true, force: true });
    } catch {
      /* best effort — it lives in the throwaway fixture workspace */
    }
  });

  test("tab A's repo switch does not move tab B or the VS Code webview", async () => {
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));
    hooks.fromRemote({ type: "remotePreferences", fontScale: 100, readRepliesAloud: false, usesTouch: true }, "tab-a");
    hooks.fromRemote({ type: "remotePreferences", fontScale: 100, readRepliesAloud: false, usesTouch: true }, "tab-b");
    posts.length = 0;

    // Exactly what a phone tapping the repo chip sends, through the real remote seam:
    // capability gate, then the cwd gate, then onMessage with origin "remote".
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-a");
    await new Promise((r) => setTimeout(r, 1500)); // -> postRepoCatalog + postSessionsList

    const repos = posts.filter((p) => p.msg?.type === "repos");
    const tabARepos = repos.filter((p) => p.clientIds?.includes("tab-a"));
    assert.ok(tabARepos.some((p) => p.msg.selectedCwd === repoB));
    assert.ok(!repos.some((p) => p.clientIds?.includes("tab-b")));
    assert.ok(!repos.some((p) => p.dest === "local"));

    // The whole point. If these two are ever equal, the split has collapsed and a phone
    // can again re-scope a window that has no way to show what happened.

    // Both audiences still get a history refresh — the split changes scope, never
    // whether a client is kept up to date.
  });

  test("remote Clear all acknowledges an empty history on the requesting tab", async () => {
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-a");
    await new Promise((r) => setTimeout(r, 1500));
    posts.length = 0;
    hooks.fromRemote({ type: "clearAllSessions", cwd: repoB }, "tab-a");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((p) =>
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "tab-a" &&
      p.msg?.type === "hostNotice" &&
      p.msg.level === "info" &&
      p.msg.text === "No history to clear."
    ), JSON.stringify(posts));
    assert.ok(!posts.some((p) => p.dest === "local" && p.msg?.text === "No history to clear."));
  });

  test("two tabs on the same repo have independent, non-crosstalking sessions", async () => {
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-a");
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-b");
    await new Promise((r) => setTimeout(r, 800));
    hooks.seedRemoteSession("tab-a", "session-a", repoB, [], true);
    hooks.seedRemoteSession("tab-b", "session-b", repoB, [], true);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.emitRemote("tab-a", { type: "messageChunk", text: "only-a" });
    hooks.emitRemote("tab-b", { type: "messageChunk", text: "only-b" });

    const chunks = posts.filter((p) => p.msg?.type === "messageChunk");
    assert.deepStrictEqual(chunks, [
      { msg: { type: "messageChunk", text: "only-a" }, clientIds: ["tab-a"] },
      { msg: { type: "messageChunk", text: "only-b" }, clientIds: ["tab-b"] },
    ]);
    assert.ok(!chunks.some((p) => p.msg.text === "only-a" && p.clientIds?.includes("tab-b")));
    assert.ok(!chunks.some((p) => p.msg.text === "only-b" && p.clientIds?.includes("tab-a")));
  });

  test("remote context usage is read from the session repo, not the VS Code workspace", () => {
    const id = `context-${Date.now()}`;
    const workspaceDir = storedSessionDirFor(hooks.workspaceRoot(), id);
    const remoteDir = storedSessionDirFor(repoB, id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "signals.json"), JSON.stringify({
      contextTokensUsed: 111,
      contextWindowTokens: 100000,
    }));
    fs.writeFileSync(path.join(remoteDir, "signals.json"), JSON.stringify({
      contextTokensUsed: 222,
      contextWindowTokens: 200000,
    }));
    hooks.seedRemoteSession("context-tab", id, repoB);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.emitContextUsage("context-tab");

    assert.deepStrictEqual(
      posts.filter((post) => post.msg?.type === "contextUsage"),
      [{ msg: { type: "contextUsage", used: 222, window: 200000 }, clientIds: ["context-tab"] }],
    );
  });

  test("ordinary history actions cannot destroy another tab's live conversation", async () => {
    const worktree = path.join(repoB, ".clear-all-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    hooks.seedWorktree({
      id: "wt-clear-all",
      path: worktree,
      sourceRepo: repoB,
      repoName: "fixture",
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: "Clear-all fixture",
      userProvidedLabel: true,
    });
    writeStoredSession("session-a");
    writeStoredSession("session-b");
    writeStoredSession("cold-session");
    writeStoredSession("worktree-session", worktree);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "deleteSession", id: "session-b", name: "Tab B" }, "tab-a");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("tab-b"), "session-b");
    assert.ok(fs.existsSync(storedSessionDir("session-b")), "tab B's live session must remain on disk");
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("tab-a") &&
      p.msg?.type === "error" &&
      /open in another tab/.test(p.msg.text)
    ));

    hooks.fromRemote({ type: "clearAllSessions", cwd: repoB }, "tab-a");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("tab-a"), "session-a");
    assert.strictEqual(hooks.activeRemoteSessionId("tab-b"), "session-b");
    assert.ok(fs.existsSync(storedSessionDir("session-a")), "the requester's live session must remain");
    assert.ok(fs.existsSync(storedSessionDir("session-b")), "the other tab's live session must remain");
    assert.ok(!fs.existsSync(storedSessionDir("cold-session")), "inactive history should still be cleared");
    assert.ok(
      !fs.existsSync(storedSessionDirFor(worktree, "worktree-session")),
      "inactive worktree history shown under the repo must also be cleared",
    );
  });

  test("id-only delete and rename stay inside the requesting tab's selected repo", async () => {
    const workspaceRoot: string = hooks.workspaceRoot();
    const foreignId = `foreign-cold-${Date.now()}`;
    writeStoredSession(foreignId, workspaceRoot);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "selectRepo", cwd: workspaceRoot }, "foreign-history-tab");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote({ type: "listSessions", cwd: workspaceRoot }, "foreign-history-tab");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("foreign-history-tab") &&
      p.msg?.type === "sessions" &&
      p.msg.entries.some((entry: any) => entry.id === foreignId)
    ), "the foreign session must be in the shared history cache before the attack");

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "repo-b-attacker");
    await new Promise((r) => setTimeout(r, 100));
    posts.length = 0;
    hooks.fromRemote({ type: "deleteSession", id: foreignId, name: "Foreign" }, "repo-b-attacker");
    hooks.fromRemote({ type: "renameSession", id: foreignId, name: "Cross-repo rename" }, "repo-b-attacker");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(
      fs.existsSync(storedSessionDirFor(workspaceRoot, foreignId)),
      "a cached session outside the selected repo must not be deleted",
    );
    const refusals = posts.filter((p) =>
      p.clientIds?.includes("repo-b-attacker") &&
      p.msg?.type === "error" &&
      /does not belong to this tab's selected repository/.test(p.msg.text)
    );
    assert.strictEqual(refusals.length, 2, JSON.stringify(posts));

    posts.length = 0;
    hooks.fromRemote({ type: "listSessions", cwd: workspaceRoot }, "foreign-history-tab");
    await new Promise((r) => setTimeout(r, 100));
    const foreignEntry = posts
      .filter((p) => p.clientIds?.includes("foreign-history-tab") && p.msg?.type === "sessions")
      .flatMap((p) => p.msg.entries)
      .find((entry: any) => entry.id === foreignId);
    assert.ok(foreignEntry, "the refused target must remain in its own repo history");
    assert.notStrictEqual(foreignEntry.customName, "Cross-repo rename");
  });

  test("a remote tab can delete cold history in its repo and registered worktrees", async () => {
    const worktree = path.join(repoB, `.delete-auth-worktree-${Date.now()}`);
    fs.mkdirSync(worktree, { recursive: true });
    hooks.seedWorktree({
      id: `wt-delete-auth-${Date.now()}`,
      path: worktree,
      sourceRepo: repoB,
      repoName: "fixture",
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: "Delete authorization fixture",
      userProvidedLabel: true,
    });
    hooks.seedWorktreeRefresh(hooks.workspaceRoot(), []);
    const repoSessionId = `own-repo-cold-${Date.now()}`;
    const worktreeSessionId = `own-worktree-cold-${Date.now()}`;
    writeStoredSession(repoSessionId);
    writeStoredSession(worktreeSessionId, worktree);

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "repo-b-owner");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote(
      { type: "renameSession", id: worktreeSessionId, name: "Owned worktree session" },
      "repo-b-owner",
    );
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote({ type: "listSessions", cwd: repoB }, "repo-b-owner");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("repo-b-owner") &&
      p.msg?.type === "sessions" &&
      p.msg.entries.some((entry: any) =>
        entry.id === worktreeSessionId && entry.customName === "Owned worktree session"
      )
    ), "own-worktree rename must use the same repo scope as delete and Clear all");

    hooks.fromRemote({ type: "deleteSession", id: repoSessionId, name: "Repo session" }, "repo-b-owner");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote(
      { type: "deleteSession", id: worktreeSessionId, name: "Worktree session" },
      "repo-b-owner",
    );
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(!fs.existsSync(storedSessionDir(repoSessionId)), "own-repo delete must still succeed");
    assert.ok(
      !fs.existsSync(storedSessionDirFor(worktree, worktreeSessionId)),
      "a registered worktree session belongs to the selected repo and must remain deletable",
    );
  });

  test("a turn watched in a remote tab is not marked unseen", async () => {
    const id = `watched-${Date.now()}`;
    hooks.seedRemoteSession("tab-watched", id, repoB);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.setSessionStatus(id, "done");
    hooks.fromRemote({ type: "listSessions", cwd: repoB }, "tab-watched");
    await new Promise((r) => setTimeout(r, 100));

    const list = posts.filter((p) =>
      p.clientIds?.includes("tab-watched") && p.msg?.type === "sessions"
    ).pop()?.msg;
    assert.ok(list, "the watching tab should receive its history snapshot");
    assert.strictEqual(list.dots[id], "none");
  });

  test("warm remote focus clears a completion badge created while nobody watched", async () => {
    const id = `unwatched-${Date.now()}`;
    hooks.seedRemoteSession("departed-owner", id, repoB, [], true);
    hooks.remoteClientLeft("departed-owner");
    hooks.setSessionStatus(id, "done");
    await new Promise((r) => setTimeout(r, 50));

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "returning-owner");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "returning-owner");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote({ type: "listSessions", cwd: repoB }, "returning-owner");
    await new Promise((r) => setTimeout(r, 100));

    const list = posts.filter((p) =>
      p.clientIds?.includes("returning-owner") && p.msg?.type === "sessions"
    ).pop()?.msg;
    assert.ok(list, "the returning tab should receive its history snapshot");
    assert.strictEqual(list.dots[id], "none");
  });

  test("a replacement relay client resumes before the old client-left without losing ownership", async () => {
    const id = `reload-handoff-${Date.now()}`;
    const tabToken = "0123456789abcdef0123456789abcdef";
    hooks.seedRemoteSession(
      "reload-old",
      id,
      repoB,
      [{ type: "messageChunk", text: "reload-history" }],
      true,
    );
    assert.strictEqual(hooks.activeRemoteSessionId("reload-old"), id);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "reload-old",
      tabToken,
    }));
    assert.strictEqual(hooks.activeRemoteSessionId("reload-old"), id);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    // Adverse reload ordering: the replacement proves the same logical tab
    // identity and resumes while the old relay socket is still present.
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "reload-replacement",
      tabToken,
    }));
    assert.strictEqual(hooks.activeRemoteSessionId("reload-replacement"), id);
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("reload-old") &&
      p.msg?.type === "error" &&
      /replaced by another tab/.test(p.msg.text)
    ), "a superseded page must be told why it can no longer send commands");
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "reload-replacement");
    hooks.fromRemote(
      { type: "resumeSession", id, cwd: repoB },
      "reload-replacement",
    );
    await new Promise((r) => setTimeout(r, 1500));

    const replayToReconnect = posts.filter((p) => p.clientIds?.includes("reload-replacement"));
    assert.ok(
      replayToReconnect.some((p) => p.msg?.type === "messageChunk" && p.msg.text === "reload-history"),
      JSON.stringify(replayToReconnect.map((p) => p.msg)),
    );
    assert.ok(!replayToReconnect.some((p) => p.msg?.type === "messageChunk" && p.msg.text === "only-b"));
    assert.ok(replayToReconnect.some((p) =>
      p.msg?.type === "sessions" && p.msg.activeId === id
    ));
    assert.ok(!posts.some((p) =>
      p.msg?.type === "messageChunk" &&
      p.msg.text === "reload-history" &&
      p.clientIds?.includes("tab-b")
    ));

    hooks.remoteClientLeft("reload-old");
    assert.strictEqual(hooks.activeRemoteSessionId("reload-replacement"), id);
  });

  test("a replacement logical tab joins a deliberately delayed cold session load", async () => {
    const id = `reload-during-load-${Date.now()}`;
    const oldClient = `reload-loading-old-${Date.now()}`;
    const replacement = `reload-loading-new-${Date.now()}`;
    const tabToken = "abcdef0123456789abcdef0123456789";
    writeStoredSession(id);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: oldClient,
      tabToken,
    }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, oldClient);
    await new Promise((r) => setTimeout(r, 50));

    const delay = hooks.delayNextSessionStart(id);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, oldClient);
    await delay.started;

    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: replacement,
      tabToken,
    }));
    assert.strictEqual(
      hooks.activeRemoteSessionId(replacement),
      id,
      "a mid-load snapshot must retain the session identity being restored",
    );
    assert.ok(posts.some((p) =>
      p.clientIds?.includes(replacement) &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === id
    ), JSON.stringify(posts));

    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, replacement);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes(replacement) &&
      p.msg?.type === "error" &&
      /already being opened/.test(p.msg.text)
    ), JSON.stringify(posts));

    const loadCompleted = hooks.waitForSessionLoad(id);
    const beforeCompletion = posts.length;
    delay.release();
    await loadCompleted;
    const completion = posts.slice(beforeCompletion);
    assert.ok(completion.some((p) =>
      p.clientIds?.includes(replacement) && p.msg?.type === "sessions"
    ), `the load completion must target the replacement relay client: ${JSON.stringify(completion)}`);
    assert.ok(!completion.some((p) =>
      p.clientIds?.includes(oldClient) && p.msg?.type === "sessions"
    ), JSON.stringify(completion));
    hooks.remoteClientLeft(oldClient);
    hooks.remoteClientLeft(replacement);
  });

  test("client-ready resync cancels host voice before building its snapshot", () => {
    const clientId = `voice-resync-${Date.now()}`;
    hooks.seedRemoteSession(clientId, `voice-session-${Date.now()}`, repoB, [], true);
    const voice = hooks.seedRemoteVoice(clientId);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId,
      tabToken: "fedcba9876543210fedcba9876543210",
    }));

    const targeted = posts.filter((p) => p.clientIds?.includes(clientId)).map((p) => p.msg);
    assert.strictEqual(voice.cancelled(), true, "the host STT streamer must be cancelled");
    assert.ok(targeted.some((msg) => msg.type === "voiceState" && msg.status === "idle"));
    assert.ok(!targeted.some((msg) => msg.type === "voiceState" && msg.status === "listening"));
    hooks.remoteClientLeft(clientId);
  });

  test("a tokenless client-ready frame keeps the legacy remembered-session resume path", async () => {
    const id = `legacy-ready-${Date.now()}`;
    hooks.seedRemoteSession("legacy-departed", id, repoB, [], true);
    hooks.remoteClientLeft("legacy-departed");
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "legacy-returning",
    }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "legacy-returning");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "legacy-returning");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("legacy-returning"), id);
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes("legacy-returning") && p.msg?.type === "error"
    ), JSON.stringify(posts));
  });

  test("resume never steals another tab's live session or silently blank-starts a missing one", async () => {
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "resumeSession", id: "session-a", cwd: repoB }, "tab-b");
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-missing");
    hooks.fromRemote({ type: "resumeSession", id: "deleted-session", cwd: repoB }, "tab-missing");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((p) =>
      p.clientIds?.includes("tab-b") &&
      p.msg?.type === "error" &&
      /already open/.test(p.msg.text)
    ));
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("tab-b") &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === "session-b"
    ), "a refused selection must correct the tab back to its authoritative active session");
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("tab-missing") &&
      p.msg?.type === "error" &&
      /Could not restore/.test(p.msg.text)
    ));
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes("tab-missing") &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === "deleted-session"
    ));
  });

  test("a phone joins a live VS Code conversation instead of being refused", async () => {
    // Desk↔remote co-attach (owner, 2026-07-30): the VS Code view is the
    // owner's desk, not a rival tab. A remote resume of a desk-held session
    // must JOIN it — emit() then serves both views. Only tab↔tab stays
    // exclusive (covered by "resume never steals another tab's live session").
    const id = `local-background-${Date.now()}`;
    hooks.seedLocalBackgroundSession(id, repoB);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "phone-adopter");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "phone-adopter");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("phone-adopter"), id, "the tab must join the desk conversation");
    assert.ok(hooks.hasLiveSession(id), "the shared session must stay live");
    // The sessions list must confirm the join — the web client's identity
    // restore waits on exactly this activeId before flushing queued work.
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("phone-adopter") &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === id
    ), "the joining tab must receive a sessions list confirming the active id");
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes("phone-adopter") && p.msg?.type === "error"
    ), JSON.stringify(posts.filter((p) => p.msg?.type === "error")));
    hooks.remoteClientLeft("phone-adopter");
    assert.ok(hooks.hasLiveSession(id), "the tab leaving must not tear down the desk's session");
  });

  test("VS Code joins a conversation owned by a phone; both views keep it", async () => {
    const id = `phone-owned-${Date.now()}`;
    hooks.seedRemoteSession("phone-owner", id, repoB, [], true);

    await hooks.openLocalSession(id, repoB);

    assert.strictEqual(hooks.activeRemoteSessionId("phone-owner"), id, "the phone must keep the conversation");
    assert.strictEqual(hooks.focusedSessionId(), id, "the desk must join the same conversation");
    assert.ok(hooks.hasLiveSession(id), "the shared session must stay live");
    hooks.remoteClientLeft("phone-owner");
    assert.strictEqual(hooks.focusedSessionId(), id, "the phone leaving must not evict the desk's view");
  });

  test("a fresh tab continues the desk's conversation instead of a blank session", async () => {
    // "Continue remotely" (and any first visit) arrives with no remembered
    // conversation. It must CONTINUE what the desk is showing — the feature's
    // whole promise, and what desk↔remote co-attach finally allows. The bug
    // this pins: a fresh tab used to get a brand-new Session that had never
    // been started, so it sat on "Starting" forever and its first send
    // quietly began a SECOND conversation.
    const id = `desk-continue-${Date.now()}`;
    const cwd = hooks.workspaceRoot();
    hooks.seedRemoteSession("seed-holder", id, cwd, [], true);
    await hooks.openLocalSession(id, cwd); // the desk joins and focuses it
    hooks.remoteClientLeft("seed-holder"); // …and is now the only view on it
    assert.strictEqual(hooks.focusedSessionId(), id, "the desk should be showing the conversation");

    // Tab tokens must be unique across the whole suite: a repeated token hands
    // ownership from the earlier test's client and this ready would be
    // dropped as superseded.
    const clientId = `continue-remotely-${Date.now()}`;
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId,
      tabToken: `c0nt1nue${Date.now().toString(16).padStart(24, "0")}`.slice(0, 32),
    }));

    assert.strictEqual(
      hooks.activeRemoteSessionId(clientId),
      id,
      "a fresh tab must continue the desk conversation, not open a blank session",
    );
    assert.strictEqual(hooks.focusedSessionId(), id, "the desk keeps showing it too");

    // A SECOND fresh tab is its own conversation — tab↔tab stays exclusive.
    const second = `second-tab-${Date.now()}`;
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: second,
      tabToken: `5ec0nd7ab${Date.now().toString(16).padStart(23, "0")}`.slice(0, 32),
    }));
    assert.notStrictEqual(
      hooks.activeRemoteSessionId(second),
      id,
      "a second tab must not be handed the conversation the first one continued",
    );
    hooks.remoteClientLeft(clientId);
    hooks.remoteClientLeft(second);
  });

  test("a local cold resume reserves its id before a remote cold resume can race it", async () => {
    const id = `local-cold-race-${Date.now()}`;
    writeStoredSession(id);
    const delay = hooks.delayNextSessionStart(id);
    const localOpen = hooks.openLocalSession(id, repoB);
    await delay.started;
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "cold-racer");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "cold-racer");
    await new Promise((r) => setTimeout(r, 100));

    assert.notStrictEqual(hooks.activeRemoteSessionId("cold-racer"), id);
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("cold-racer") &&
      p.msg?.type === "error" &&
      /already being opened/.test(p.msg.text)
    ));
    delay.release();
    await localOpen;
  });

  test("delete and Clear all preserve a conversation while another view is cold-loading it", async () => {
    const id = `cold-protected-${Date.now()}`;
    const clearableId = `cold-clearable-${Date.now()}`;
    writeStoredSession(id);
    writeStoredSession(clearableId);
    const delay = hooks.delayNextSessionStart(id);
    const localOpen = hooks.openLocalSession(id, repoB);
    await delay.started;

    hooks.fromRemote({ type: "deleteSession", id, name: "Cold loading" }, "tab-b");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(storedSessionDir(id)), "delete must preserve the reserved session id");

    hooks.fromRemote({ type: "clearAllSessions", cwd: repoB }, "tab-b");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(storedSessionDir(id)), "Clear all must preserve the reserved session id");
    assert.ok(!fs.existsSync(storedSessionDir(clearableId)), "Clear all should still remove ownerless history");

    delay.release();
    await localOpen;
  });

  test("selectRepo waits behind deliberately delayed New and Resume transitions", async () => {
    const clientId = `ordered-transition-${Date.now()}`;
    const repoHistory = `repo-history-${Date.now()}`;
    const workspaceHistory = `workspace-history-${Date.now()}`;
    const resumeId = `resume-delayed-${Date.now()}`;
    writeStoredSession(repoHistory);
    writeStoredSession(resumeId);
    writeStoredSession(workspaceHistory, hooks.workspaceRoot());

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, clientId);
    await new Promise((r) => setTimeout(r, 100));

    for (const transition of ["new", "resume"] as const) {
      const delay = hooks.delayNextSessionStart(transition === "resume" ? resumeId : undefined);
      const posts: Array<{ msg: any; clientIds?: string[] }> = [];
      hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

      if (transition === "new") hooks.fromRemote({ type: "newSession" }, clientId);
      else hooks.fromRemote({ type: "resumeSession", id: resumeId, cwd: repoB }, clientId);
      await delay.started;
      hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, clientId);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(!posts.some((p) =>
        p.clientIds?.includes(clientId) &&
        p.msg?.type === "repos" &&
        p.msg.selectedCwd === hooks.workspaceRoot()
      ), `selectRepo must not overtake delayed ${transition}`);

      delay.release();
      // The released transition performs a REAL cold CLI spawn on machines with
      // grok installed — 1500ms was only enough when earlier suite tests had
      // pre-warmed the spawn path, and failed in isolation or after suite
      // reordering. Poll instead of sleeping a fixed slice.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !posts.some((p) =>
        p.clientIds?.includes(clientId) &&
        p.msg?.type === "repos" &&
        p.msg.selectedCwd === hooks.workspaceRoot()
      )) await new Promise((r) => setTimeout(r, 200));
      const switchedAt = posts.findIndex((p) =>
        p.clientIds?.includes(clientId) &&
        p.msg?.type === "repos" &&
        p.msg.selectedCwd === hooks.workspaceRoot()
      );
      assert.ok(switchedAt >= 0, `delayed ${transition} should eventually yield to selectRepo`);
      const finalHistory = posts.slice(switchedAt).find((p) =>
        p.clientIds?.includes(clientId) && p.msg?.type === "sessions"
      )?.msg;
      assert.ok(finalHistory, "the selected repository should receive a history snapshot");
      assert.ok(finalHistory.entries.some((entry: any) => entry.id === workspaceHistory));
      assert.ok(!finalHistory.entries.some((entry: any) => entry.id === repoHistory));

      if (transition === "new") {
        hooks.fromRemote({ type: "selectRepo", cwd: repoB }, clientId);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  test("primary-repo deletion refuses another repo's worktree and permits its own", async () => {
    const suffix = Date.now();
    const repoAWorktree = path.join(hooks.workspaceRoot(), `.int-a-worktree-${suffix}`);
    const repoBWorktree = path.join(hooks.workspaceRoot(), `.int-b-worktree-${suffix}`);
    fs.mkdirSync(repoAWorktree, { recursive: true });
    fs.mkdirSync(repoBWorktree, { recursive: true });
    const record = (id: string, worktreePath: string, sourceRepo: string) => ({
      id,
      path: worktreePath,
      sourceRepo,
      repoName: id,
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: id,
      userProvidedLabel: true,
    });
    const repoAGitRoot = path.resolve(hooks.workspaceRoot(), "..", "..");
    hooks.seedWorktree(record("repo-a-wt", repoAWorktree, repoAGitRoot));
    hooks.seedWorktree(record("repo-b-wt", repoBWorktree, repoB));

    const foreignId = `foreign-worktree-${suffix}`;
    const ownId = `own-worktree-${suffix}`;
    const clearOwnId = `clear-own-worktree-${suffix}`;
    const clearForeignId = `clear-foreign-worktree-${suffix}`;
    writeStoredSession(foreignId, repoBWorktree);
    writeStoredSession(ownId, repoAWorktree);
    const clientId = `scope-client-${suffix}`;
    hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, clientId);
    await new Promise((r) => setTimeout(r, 100));

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "deleteSession", id: foreignId, name: "foreign" }, clientId);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      fs.existsSync(storedSessionDirFor(repoBWorktree, foreignId)),
      "repo A must not authorize deleting repo B's worktree history",
    );
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "error" &&
      /does not belong to this tab's selected repository/.test(post.msg.text)
    ), JSON.stringify(posts));

    hooks.fromRemote({ type: "deleteSession", id: ownId, name: "own" }, clientId);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      !fs.existsSync(storedSessionDirFor(repoAWorktree, ownId)),
      "repo A must still authorize cold history in its registered worktree",
    );

    writeStoredSession(clearOwnId, repoAWorktree);
    writeStoredSession(clearForeignId, repoBWorktree);
    hooks.fromRemote({ type: "clearAllSessions", cwd: hooks.workspaceRoot() }, clientId);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fs.existsSync(storedSessionDirFor(repoAWorktree, clearOwnId)));
    assert.ok(
      fs.existsSync(storedSessionDirFor(repoBWorktree, clearForeignId)),
      "Clear all for repo A must not enumerate repo B's worktree catalog",
    );

    hooks.remoteClientLeft(clientId);
    hooks.seedWorktreeRefresh(hooks.workspaceRoot(), []);
    hooks.seedWorktreeRefresh(repoB, []);
    fs.rmSync(repoAWorktree, { recursive: true, force: true });
    fs.rmSync(repoBWorktree, { recursive: true, force: true });
  });

  test("refresh during remote startup preserves a host-owned queued prompt", async () => {
    const suffix = Date.now();
    const id = `starting-refresh-${suffix}`;
    const oldClient = `starting-old-${suffix}`;
    const replacement = `starting-new-${suffix}`;
    const tabToken = "00112233445566778899aabbccddeeff";
    const queuedText = "typed while the new session was starting";
    writeStoredSession(id);
    hooks.seedRemoteStartingSession(oldClient, id, repoB, queuedText);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: oldClient,
      tabToken,
    }));

    hooks.remoteClientLeft(oldClient);
    assert.ok(hooks.hasLiveSession(id), "client-left must not dispose a priming session with queued work");
    assert.ok(fs.existsSync(storedSessionDir(id)), "queued startup work must keep its session directory");

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: replacement,
      tabToken,
    }));

    assert.strictEqual(hooks.activeRemoteSessionId(replacement), id);
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "queuedSends" &&
      post.msg.items?.[0] === queuedText
    ), JSON.stringify(posts));

    hooks.finishRemoteStartup(replacement);
    hooks.remoteClientLeft(replacement);
  });

  test("refresh preserves a chip-only remote session when client-left wins the reload race", async () => {
    const suffix = Date.now();
    const id = `chip-refresh-${suffix}`;
    const oldClient = `chip-old-${suffix}`;
    const replacement = `chip-new-${suffix}`;
    const tabToken = "aabbccddeeff00112233445566778899";
    const chip = {
      id: `pasted-image-${suffix}`,
      path: path.join(grokHome, "uploads", `pasted-${suffix}.png`),
      relPath: `[Image #1]`,
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    writeStoredSession(id);
    hooks.seedRemoteSession(oldClient, id, repoB, [], false, [chip]);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: oldClient,
      tabToken,
    }));

    hooks.remoteClientLeft(oldClient);
    assert.ok(hooks.hasLiveSession(id), "client-left must not dispose a session with a staged attachment");
    assert.ok(fs.existsSync(storedSessionDir(id)), "the chip-only session directory must survive reload");

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: replacement,
      tabToken,
    }));

    assert.strictEqual(hooks.activeRemoteSessionId(replacement), id);
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "chips" &&
      post.msg.chips?.[0]?.id === chip.id
    ), JSON.stringify(posts));
    hooks.remoteClientLeft(replacement);
  });

  test("an idle remote queue asks the browser for a metered send before consuming it", async () => {
    const suffix = Date.now();
    const clientId = `metered-queue-${suffix}`;
    const id = `metered-queue-session-${suffix}`;
    const text = "send me through the relay";
    hooks.seedRemoteSession(clientId, id, repoB, [], true);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "queueSend", text }, clientId);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend" &&
      post.msg.text === text
    ), JSON.stringify(posts));
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "queuedSends" &&
      post.msg.items?.[0] === text
    ), JSON.stringify(posts));
    assert.ok(!posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "userMessage"
    ), JSON.stringify(posts));
    hooks.remoteClientLeft(clientId);
  });

  test("a disconnected remote queue never falls through to the host prompt path", async () => {
    const suffix = Date.now();
    const oldClient = `metered-detach-old-${suffix}`;
    const replacement = `metered-detach-new-${suffix}`;
    const id = `metered-detach-session-${suffix}`;
    const text = "still requires relay metering";
    const tabToken = "11223344556677889900aabbccddeeff";
    hooks.seedRemoteSession(oldClient, id, repoB, [], true);
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: oldClient, tabToken }));
    hooks.fromRemote({ type: "queueSend", text }, oldClient);
    await new Promise((r) => setTimeout(r, 50));
    hooks.remoteClientLeft(oldClient);

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: replacement, tabToken }));

    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "queuedSends" &&
      post.msg.items?.[0] === text
    ), JSON.stringify(posts));
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "submitQueuedSend" &&
      post.msg.text === text
    ), JSON.stringify(posts));
    assert.ok(!posts.some((post) => post.msg?.type === "userMessage"), JSON.stringify(posts));
    hooks.remoteClientLeft(replacement);
  });

  test("a persisted dequeue echo plus its reconnect replay reaches the model once", async () => {
    const suffix = Date.now();
    const oldClient = `dequeue-once-old-${suffix}`;
    const replacement = `dequeue-once-new-${suffix}`;
    const id = `dequeue-once-session-${suffix}`;
    const text = "perform this queued task once";
    const tabToken = "22334455667788990011aabbccddeeff";
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    const model = hooks.seedRemoteQueuedDispatch(oldClient, id, repoB, text);
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: oldClient, tabToken }));
    const original = posts.find((post) =>
      post.clientIds?.includes(oldClient) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.ok(original?.id, JSON.stringify(posts));

    hooks.remoteClientLeft(oldClient);
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: replacement, tabToken }));
    const replay = posts.find((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.deepStrictEqual(replay, original, "the reconnect snapshot must replay the same claimed submission");

    const persistedOutboxEcho = { type: "send", text, queuedSendId: original.id };
    const reconnectEcho = { type: "send", text, queuedSendId: replay.id };
    hooks.fromRemote(persistedOutboxEcho, replacement);
    hooks.fromRemote(reconnectEcho, replacement);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(model.promptCount(), 1, "duplicate dequeue echoes must execute one model prompt");
    hooks.remoteClientLeft(replacement);
  });

  test("an unreadable image retains a metered dequeue plus text appended during the send", async () => {
    const suffix = Date.now();
    const clientId = `dequeue-read-failure-${suffix}`;
    const id = `dequeue-read-failure-session-${suffix}`;
    const first = "keep the charged prompt";
    const second = "and keep this appended part";
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    const model = hooks.seedRemoteQueuedDispatch(clientId, id, repoB, first, [{
      id: "missing-image",
      path: path.join(repoB, `missing-${suffix}.png`),
      relPath: "missing.png",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    }]);
    const dispatch = posts.find((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.ok(dispatch?.id, JSON.stringify(posts));

    hooks.fromRemote({ type: "send", text: first, queuedSendId: dispatch.id }, clientId);
    hooks.fromRemote({ type: "queueSend", text: second }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(model.promptCount(), 0, "the unreadable image must bail before model prompt");
    assert.deepStrictEqual(model.queuedSends(), [`${first}\n\n${second}`]);
    assert.ok(posts.some((post) =>
      post.msg?.type === "agentError" &&
      post.msg.text?.includes("Could not read missing.png")
    ), JSON.stringify(posts));

    hooks.fromRemote({ type: "removeChip", id: "missing-image" }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Known limitation: this retained retry is a fresh relay submission, so it
    // is metered again. Pin that behavior until the queue can represent an
    // already-metered prefix separately from newly appended text.
    const retryDispatch = [...posts].reverse().find((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend" &&
      post.msg.id !== dispatch.id
    )?.msg;
    assert.ok(retryDispatch?.id, JSON.stringify(posts));
    hooks.fromRemote({
      type: "send",
      text: `${first}\n\n${second}`,
      queuedSendId: retryDispatch.id,
    }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(model.promptCount(), 1, "removing the bad chip must deliver the retained prompt");
    assert.deepStrictEqual(model.queuedSends(), []);
    hooks.remoteClientLeft(clientId);
  });

  test("switching repos disposes a primer-only remote session before dropping its mapping", async () => {
    const id = `primer-only-${Date.now()}`;
    writeStoredSession(id);
    hooks.seedRemoteSession("primer-owner", id, repoB, [], false);
    assert.ok(hooks.hasLiveSession(id));
    assert.ok(fs.existsSync(storedSessionDir(id)));

    hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, "primer-owner");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("primer-owner"), undefined);
    assert.ok(!hooks.hasLiveSession(id), "the abandoned primer process must be disposed");
    assert.ok(!fs.existsSync(storedSessionDir(id)), "the primer-only history row must be deleted");
  });

  test("closing a client disposes and deletes its primer-only remote session", async () => {
    const id = `departed-primer-${Date.now()}`;
    writeStoredSession(id);
    hooks.seedRemoteSession("departing-primer-owner", id, repoB, [], false);

    hooks.remoteClientLeft("departing-primer-owner");
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(hooks.activeRemoteSessionId("departing-primer-owner"), undefined);
    assert.ok(!hooks.hasLiveSession(id), "the departed client's primer process must be disposed");
    assert.ok(!fs.existsSync(storedSessionDir(id)), "the departed client's primer history must be deleted");
  });

  test("roster pruning uses the same primer-only client release path", async () => {
    const id = `pruned-primer-${Date.now()}`;
    writeStoredSession(id);
    hooks.seedRemoteSession("pruned-primer-owner", id, repoB, [], false);

    hooks.remoteClientRoster([]);
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(!hooks.hasLiveSession(id), "a pruned client's primer process must be disposed");
    assert.ok(!fs.existsSync(storedSessionDir(id)), "a pruned client's primer history must be deleted");
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

  test("a malformed cwd-bearing frame cannot escape the remote dispatch boundary", () => {
    assert.doesNotThrow(() => {
      hooks.fromRemote({ type: "selectRepo", cwd: {} } as any, "malformed-frame");
      hooks.fromRemote({ type: "resumeSession", id: "remembered", cwd: [] } as any, "malformed-frame");
    });
  });

  test("an audio chunk without an owned voice session is rejected visibly", async () => {
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "remoteVoiceChunk", data: "AQACAA==" }, "unowned-mic");
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(posts.some((p) =>
      p.msg?.type === "voiceError" &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "unowned-mic"
    ));
  });

  test("remote host-side operation notices return only to the requesting tab", async () => {
    hooks.seedRemoteSession("requester", "notice-session", repoB);
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    hooks.fromRemote({ type: "forkSession" }, "requester");
    hooks.fromRemote({ type: "uploadFile", name: "bad.exe", data: "YQ==" }, "requester");
    hooks.fromRemote({ type: "pasteImage", mimeType: "image/bmp", data: "YQ==" }, "requester");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((p) =>
      p.msg?.type === "hostNotice" &&
      /Nothing to fork/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "requester"
    ));
    assert.ok(posts.some((p) =>
      p.msg?.type === "error" &&
      /Could not attach document/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "requester"
    ));
    assert.ok(posts.some((p) =>
      p.msg?.type === "error" &&
      /unsupported image type/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "requester"
    ));
    assert.ok(!posts.some((p) => p.dest === "local"));
  });

  test("a remote New session immediately carries its selected worktree binding", async () => {
    const worktree = path.join(hooks.workspaceRoot(), ".int-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    hooks.seedWorktree({
      id: "wt-remote",
      path: worktree,
      sourceRepo: hooks.workspaceRoot(),
      repoName: "fixture",
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: "Remote fixture",
      userProvidedLabel: true,
    });
    hooks.seedRemoteUnstartedSession("worktree-tab", worktree);

    assert.deepStrictEqual(hooks.activeRemoteWorktree("worktree-tab"), {
      id: "wt-remote",
      path: worktree,
      label: "Remote fixture",
      sourceGitRoot: hooks.workspaceRoot(),
    });
    fs.rmSync(worktree, { recursive: true, force: true });
  });
});
