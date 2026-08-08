import * as vscode from "vscode";
import { GrokSidebar } from "./sidebar";
import { createVsCodeHost, createVsCodeHostContext, fromVsCodeUri, wrapWebviewView } from "./vscode-host";
import {
  GROK_VIEW_ID,
  PANEL_CONTAINER_ID,
  revealCommandFor,
  viewPlacementCorrection,
  VIEW_PLACEMENT_KEY,
  withAttempt,
  withUserChoice,
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
 * Once per version. An update is when the placement gets undone (reinstalling
 * re-registers the view against the refused container), so an update is when the
 * correction is due. 3.2.8 recorded a plain "done" boolean instead, so its one
 * silent failure was permanent — see {@link PlacementRecord}.
 *
 * Focus follows the move on purpose. Arriving from a chat you could not open, a
 * silent re-home to a dock you were not looking at is indistinguishable from
 * still being broken. The forced palette command skips the reveal for the same
 * reason it exists: you are already looking at it.
 *
 * Failure is swallowed: a host that rejects the move must not take activation
 * down with it, and `grok.open` resolves its command independently.
 */
async function ensureViewPlacement(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const log = (line: string) => output.appendLine(`[placement] ${line}`);
  const placement = context.globalState.get<PlacementRecord>(VIEW_PLACEMENT_KEY);
  const version = context.extension.packageJSON?.version ?? "";
  try {
    const target = viewPlacementCorrection({
      availableCommands: await vscode.commands.getCommands(true),
      placement,
      extensionVersion: version,
    });
    if (!target) {
      // Logged rather than silent. When someone reports the chat stuck in
      // Explorer, "why didn't it move" is the first question, and before this
      // there was nothing anywhere that could answer it.
      log(
        `no move — version=${version}, last attempt ${placement?.attemptedForVersion ?? "never"}` +
          `, chosen ${placement?.chosenLocation ?? "(none)"}`,
      );
      return;
    }
    log(`moving -> ${target.containerId}, panel ${target.panelPosition ?? "as-is"}`);
    await applyPlacement(target, { reveal: true });
    log("moved");
  } catch (e) {
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // Recorded even on failure: an editor that rejects the move will reject it
    // identically on every window, and retrying forever would fight a user who
    // is living with it. The next version tries again, and
    // `Grok: Move Chat to Right Panel` retries on demand.
    await context.globalState.update(VIEW_PLACEMENT_KEY, withAttempt(placement, version));
  }
}

/** Issue the move. Shared by the automatic correction and the palette command so
 *  there is exactly one place that knows the command sequence. */
async function applyPlacement(
  target: { containerId: string; panelPosition: PanelPosition | null },
  opts: { reveal: boolean },
): Promise<void> {
  await vscode.commands.executeCommand("vscode.moveViews", {
    viewIds: [GROK_VIEW_ID],
    destinationId: target.containerId,
  });
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
    // Escape hatch, and the only placement that is not rationed. Reachable from
    // the palette when the view itself is not — which is the state this whole
    // mechanism exists for. Asking for it counts as choosing it, so a later
    // correction restores this rather than the default.
    vscode.commands.registerCommand("grok.moveToRightPanel", async () => {
      await applyPlacement(
        { containerId: PANEL_CONTAINER_ID, panelPosition: "right" },
        { reveal: true },
      );
      await context.globalState.update(
        VIEW_PLACEMENT_KEY,
        withUserChoice(context.globalState.get<PlacementRecord>(VIEW_PLACEMENT_KEY), "panel-right"),
      );
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
  void ensureViewPlacement(context, output);

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
