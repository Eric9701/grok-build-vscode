import * as vscode from "vscode";
import { GrokSidebar } from "./sidebar";
import { createVsCodeHost, createVsCodeHostContext, fromVsCodeUri, wrapWebviewView } from "./vscode-host";
import {
  GROK_VIEW_ID,
  PANEL_CONTAINER_ID,
  PRIMARY_CONTAINER_ID,
  SECONDARY_CONTAINER_ID,
  revealCommandFor,
  viewPlacementCorrection,
  VIEW_PLACEMENT_KEY,
  withAttempt,
  MOVE_VIEW_HINT_USED_KEY,
  type PanelPosition,
  type PlacementRecord,
} from "./view-move";

/**
 * Put the chat somewhere this editor will actually show it.
 *
 * Cursor 3.15 refuses `viewsContainers.secondarySidebar` — reserved for its own
 * agent UI — so our container is never created, the view is dropped into
 * Explorer, and `workbench.view.extension.grokSidebar` never registers. The
 * manifest is static and cannot branch per editor, so the correction runs here,
 * with the same `vscode.moveViews` payload the gear menu already ships
 * (`vscode-host.ts` → `relocateView`).
 *
 * Runs on **startup**, not on first use. Someone whose chat is buried in an
 * Explorer section has no way to open it, so a correction that waits for them to
 * open it never runs — which is why the manifest asks for `onStartupFinished`
 * despite that entry having been dropped as redundant back in 1.x.
 *
 * ONCE, ever — not once per release. Where a view sits is the user's, and the
 * editor's own Move To leaves no trace we can read, so after the first
 * correction there is no way to tell someone who deliberately moved the chat
 * from someone who never touched it. Correcting again would overrule the first
 * of those on every update. See {@link PlacementRecord}.
 *
 * Focus follows the move on purpose. Arriving from a chat you could not open, a
 * silent re-home to a dock you were not looking at is indistinguishable from
 * still being broken.
 *
 * It aims at a CONTAINER, which bounds what it can achieve: a host may keep our
 * container and ignore where it declared it lives — Cursor renders the panel one
 * in the primary side bar. Reaching a dock the host draws for itself needs a
 * LOCATION, and only the host's own picker takes one, which is what
 * `Grok: Move Chat View` and the gear's `Move view…` open.
 *
 * Failure is swallowed: a host that rejects the move must not take activation
 * down with it, and `grok.open` resolves its command independently.
 */
async function ensureViewPlacement(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  isFirstEverRun: boolean,
): Promise<void> {
  const log = (line: string) => output.appendLine(`[placement] ${line}`);
  const version = context.extension.packageJSON?.version ?? "";
  let correctionIssued = false;
  try {
    const availableCommands = await vscode.commands.getCommands(true);
    // The missing diagnostic in every round of this so far: WHICH of our three
    // containers this editor actually created. Whether Cursor registers the
    // panel container at all decides between two completely different fixes.
    log(
      `containers: secondary=${availableCommands.includes(SECONDARY_CONTAINER_ID)} ` +
        `primary=${availableCommands.includes(PRIMARY_CONTAINER_ID)} ` +
        `panel=${availableCommands.includes(PANEL_CONTAINER_ID)} ` +
        `viewFocus=${availableCommands.includes(`${GROK_VIEW_ID}.focus`)} ` +
        `app=${vscode.env.appName}`,
    );
    const target = viewPlacementCorrection({ availableCommands, isFirstEverRun });
    if (!target) {
      // Logged rather than silent. When someone reports the chat stuck in
      // Explorer, "why didn't it move" is the first question, and before this
      // there was nothing anywhere that could answer it.
      log(`no move — version=${version}, firstEverRun=${isFirstEverRun}`);
      return;
    }
    log(`moving -> ${target.containerId}, panel ${target.panelPosition ?? "as-is"}`);
    correctionIssued = true;
    // Held for the re-apply below. `onStartupFinished` means the extension host
    // is ready, NOT that the workbench will honour a layout change yet — and
    // there is no API to ask where a view ended up, so a move issued too early
    // fails in silence. Re-applying when the view resolves is the one moment the
    // view is provably live.
    pendingCorrection = target;
    await applyPlacement(target, { reveal: true });
    log("moved");
  } catch (e) {
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    correctionIssued = false;
  } finally {
    // Written only when a move actually went through — a startup where the
    // container had not registered yet, or where the move threw, must not count
    // as done. It is diagnostics, but it also does real work: writing ANY key
    // makes `globalState` non-empty, which is what stops the next launch from
    // reading as a first-ever run. Without it, a genuinely fresh install where
    // nothing else has persisted yet would correct again on the second launch.
    //
    // Re-read rather than reusing a snapshot from before the awaits: anything
    // else in the extension may have persisted state meanwhile, and writing a
    // stale copy back would discard it.
    if (correctionIssued) {
      const latest = context.globalState.get<PlacementRecord>(VIEW_PLACEMENT_KEY);
      await context.globalState.update(VIEW_PLACEMENT_KEY, withAttempt(latest, version));
    }
  }
}

/**
 * The correction the startup pass decided on, kept until the view first resolves
 * so it can be applied a second time.
 *
 * Not a retry loop and not a timer: exactly one repeat, at the first moment the
 * view is demonstrably registered and rendering. Both halves are needed — the
 * startup pass is the only one that reaches a user whose view is buried
 * somewhere they cannot click, and the resolve pass is the only one that happens
 * late enough to be sure the workbench will act on it.
 *
 * `moveViews` on a view already in the destination is a no-op, so applying twice
 * costs nothing when the first attempt worked.
 */
let pendingCorrection: { containerId: string; panelPosition: PanelPosition | null } | null = null;

/** Issue the move. Shared by the automatic correction and the palette command so
 *  there is exactly one place that knows the command sequence. */
async function applyPlacement(
  target: { containerId: string; panelPosition: PanelPosition | null },
  opts: { reveal: boolean; log?: (s: string) => void },
): Promise<void> {
  await vscode.commands.executeCommand("vscode.moveViews", {
    viewIds: [GROK_VIEW_ID],
    destinationId: target.containerId,
  });
  opts.log?.("moveViews returned without throwing");
  if (target.panelPosition) {
    // Caveat worth knowing: panel position is workbench-wide, so this also moves
    // Terminal, Problems and Output. Once per update, and only in an editor that
    // refused the secondary side bar.
    await vscode.commands.executeCommand(
      target.panelPosition === "right"
        ? "workbench.action.positionPanelRight"
        : "workbench.action.positionPanelBottom",
    );
  }
  if (opts.reveal) await vscode.commands.executeCommand(`${GROK_VIEW_ID}.focus`);
}

/** What `activate` hands back through `extension.exports`. Empty in every
 *  released build — the test seam below is populated only under
 *  `ExtensionMode.Test`. */
export interface GrokExtensionApi {
  __test?: ReturnType<GrokSidebar["installTestHooks"]>;
}

export function activate(context: vscode.ExtensionContext): GrokExtensionApi {
  // Read FIRST, before anything below can persist anything. An install with no
  // stored state has never been interacted with, so wherever the editor put the
  // view, nobody chose it — that is the entire licence the placement correction
  // has to move it, and it evaporates the moment any other subsystem writes.
  const isFirstEverRun = context.globalState.keys().length === 0;
  const output = vscode.window.createOutputChannel("Grok");
  const host = createVsCodeHost(output, context);
  const hostContext = createVsCodeHostContext(context);
  const sidebar = new GrokSidebar(hostContext, host);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GrokSidebar.viewId,
      {
        resolveWebviewView(view) {
          sidebar.resolveWebviewView(wrapWebviewView(view));
          // The view exists and is rendering — the earliest point a layout move
          // is certain to be honoured. Deferred off this callback so the move
          // never lands mid-resolve, and cleared so it happens exactly once.
          const correction = pendingCorrection;
          pendingCorrection = null;
          if (correction) {
            setTimeout(() => {
              void applyPlacement(correction, { reveal: false }).then(
                () => output.appendLine("[placement] re-applied on first resolve"),
                (e: unknown) => output.appendLine(`[placement] re-apply failed: ${String(e)}`),
              );
            }, 0);
          }
        },
      },
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    output,
    { dispose: () => sidebar.dispose() },
    vscode.commands.registerCommand("grok.open", async () => {
      // Resolved per invocation rather than baked in: the view can be moved
      // between docks from the gear menu, and in a host that refuses the
      // secondary side bar the container this used to hardcode never exists at
      // all — which is how `grok.open` came to fail with "command not found".
      const cmds = await vscode.commands.getCommands(true);
      await vscode.commands.executeCommand(revealCommandFor(cmds));
    }),
    // Reachable from the palette when the view itself is not — which is the
    // state this whole mechanism exists for. Records nothing: the automatic
    // correction fires only on a first-ever run, so there is no later one for a
    // choice to need protecting from, and nothing to get wrong if the user opens
    // this picker and cancels.
    vscode.commands.registerCommand("grok.moveView", async () => {
      output.appendLine("[placement] palette -> host picker");
      // The host's own picker, preselected on our view. It targets a LOCATION
      // and builds its own container, so it reaches docks no container id of
      // ours can address — in Cursor, the secondary side bar it refuses to give
      // us directly. The view-id argument is what makes it work there at all:
      // without it the command reads the `focusedView` context key, which Cursor
      // never sets for webview views.
      // Retires the same hint the gear does, and BEFORE the picker for the same
      // reason: moving a view makes the host rebuild the webview, and the
      // rebuilt one asks for capabilities immediately, so a write afterwards
      // loses the race and the hint comes back. Only the hint — where the view
      // goes is decided without reference to this.
      await context.globalState.update(MOVE_VIEW_HINT_USED_KEY, true);
      await vscode.commands.executeCommand("workbench.action.moveFocusedView", GROK_VIEW_ID);
    }),
    vscode.commands.registerCommand("grok.newSession", () => sidebar.newSession()),
    vscode.commands.registerCommand("grok.newWorktreeSession", () => sidebar.newWorktreeSession()),
    vscode.commands.registerCommand("grok.applyWorktree", () => sidebar.applyFocusedWorktree()),
    vscode.commands.registerCommand("grok.removeWorktree", () => sidebar.removeFocusedWorktree()),
    vscode.commands.registerCommand("grok.rewind", () => sidebar.rewindFocusedSession()),
    vscode.commands.registerCommand("grok.compact", () => {
      // emulated by sending the slash command as a prompt; CLI handles it
      vscode.window.showInformationMessage(
        "Type /compact in the composer to compress the conversation.",
      );
    }),
    vscode.commands.registerCommand("grok.pickModel", () => sidebar.pickModel()),
    vscode.commands.registerCommand("grok.toggleMode", () => sidebar.openModePopover()),
    vscode.commands.registerCommand("grok.sendSelection", () =>
      sidebar.insertActiveMention({ selection: true }),
    ),
    vscode.commands.registerCommand(
      "grok.sendFile",
      // Pass the explorer Uri intact — flattening to fsPath drops remote authority.
      (uri?: vscode.Uri) =>
        sidebar.insertActiveMention({
          uri: uri ? fromVsCodeUri(uri) : undefined,
          pickIfMissing: true,
        }),
    ),
    vscode.commands.registerCommand("grok.insertAtMention", () =>
      sidebar.insertActiveMention(),
    ),
    vscode.commands.registerCommand("grok.showLogs", () => output.show()),
    vscode.commands.registerCommand("grok.expandAllToolDetails", () => sidebar.setAllToolDetails(true)),
    vscode.commands.registerCommand("grok.collapseAllToolDetails", () => sidebar.setAllToolDetails(false)),
    vscode.commands.registerCommand("grok.logout", () => sidebar.logout()),
    vscode.commands.registerCommand("grok.linkRemote", () => sidebar.linkRemoteDevice()),
    vscode.commands.registerCommand("grok.unlinkRemote", () => sidebar.unlinkRemoteDevice()),
    vscode.commands.registerCommand("grok.composerForward", () => sidebar.moveComposerCaret("forward")),
    vscode.commands.registerCommand("grok.composerPreviousLine", () => sidebar.moveComposerCaret("previousLine")),
    // Internal debug helper for manually exercising the plan-review card UI
    // (Approve / Reject / Cancel flows) without a live CLI session.
    vscode.commands.registerCommand("grok._debugDummyPlan", () => sidebar.debugShowDummyPlan()),
  );

  // Not awaited: activation must not block on a workbench command, and nothing
  // below depends on where the view ended up.
  void ensureViewPlacement(context, output, isFirstEverRun);

  // VS Code sets ExtensionMode.Test ONLY when the extension host was launched by
  // a test runner, so an installed build can never reach this branch and the
  // seam is genuinely absent there rather than merely undocumented.
  return context.extensionMode === vscode.ExtensionMode.Test
    ? { __test: sidebar.installTestHooks() }
    : {};
}

export function deactivate(): void {
  // disposables handle cleanup
}
