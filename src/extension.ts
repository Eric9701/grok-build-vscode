import * as vscode from "vscode";
import { GrokSidebar } from "./sidebar";
import { createVsCodeHost, createVsCodeHostContext, fromVsCodeUri, wrapWebviewView } from "./vscode-host";
import { GROK_VIEW_ID, revealCommandFor, viewRelocationTarget } from "./view-move";

/** Set once the view has been re-homed away from a refused container, so the
 *  correction never fights a placement the user chose afterwards. */
const RELOCATED_KEY = "grok.viewRelocatedFromSecondary";

/**
 * Cursor 3.15 refuses `viewsContainers.secondarySidebar` — it is reserved for
 * Cursor's own agent UI — so the view is dropped into Explorer and the container
 * command never registers. `grok.open` then throws "command not found" and the
 * extension cannot be opened at all.
 *
 * The manifest is static and cannot branch per editor, so the correction runs
 * here, with the same `vscode.moveViews` payload the gear menu already ships
 * (`vscode-host.ts` → `relocateView`), and like that helper it finishes by
 * revealing the view. Normally stealing focus at activation would be rude; here
 * it is the point. The user is arriving from an extension that could not be
 * opened at all, and silently re-homing it to a dock they were not looking at
 * is indistinguishable from still being broken.
 *
 * Failure is swallowed deliberately: a host that rejects the move must not take
 * activation down with it, and `grok.open` resolves its command independently.
 */
async function relocateViewIfHostRefusedSecondary(context: vscode.ExtensionContext): Promise<void> {
  try {
    const target = viewRelocationTarget({
      availableCommands: await vscode.commands.getCommands(true),
      alreadyRelocated: context.globalState.get<boolean>(RELOCATED_KEY) === true,
    });
    if (!target) return;
    await vscode.commands.executeCommand("vscode.moveViews", {
      viewIds: [GROK_VIEW_ID],
      destinationId: target,
    });
    // Docked right, the panel IS a secondary side bar — same screen position,
    // same tall narrow shape the chat is designed for. Without this the view
    // lands in a short strip along the bottom, which is worse than where it
    // started.
    //
    // Caveat worth knowing: panel position is workbench-wide, so this also moves
    // Terminal, Problems and Output. Done once, only in a host that refused the
    // secondary side bar, and never repeated — a user who puts the panel back at
    // the bottom keeps it there.
    await vscode.commands.executeCommand("workbench.action.positionPanelRight");
    // Show it. Moving a view the user cannot see is not a fix they can observe,
    // and this only ever runs on the one activation that performs the move.
    await vscode.commands.executeCommand(`${GROK_VIEW_ID}.focus`);
    await context.globalState.update(RELOCATED_KEY, true);
  } catch {
    /* best effort — grok.open still resolves a command that exists */
  }
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
  void relocateViewIfHostRefusedSecondary(context);

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
