/**
 * What an Antigravity tool card shows, end to end: frames as Google's server
 * sent them live (2026-10-15), through AgyBackend, into the real renderer --
 * the same frames a phone renders. Before the backend normalised them, a
 * command row read "Run" with no command and no output, and a PowerShell line
 * turned into a row like `Run ''"]([^`.
 */
import { describe, expect, it } from "vitest";
import { AgyBackend } from "../src/agy-backend";
import { childStreamFromRoute, routeSessionUpdate } from "../src/acp-dispatch";
import { bootWebview, click, dispatch } from "./webview-harness";

const WS = "C:/work/proj";

/** A parent-session update as the host posts it. */
function post(window: Window, update: any): void {
  const route = routeSessionUpdate(update);
  if (route?.event === "messageChunk") dispatch(window, { type: "messageChunk", text: route.text });
  else if (route?.event === "toolCall") dispatch(window, { type: "toolCall", call: route.payload });
  else if (route?.event === "toolCallUpdate") dispatch(window, { type: "toolCallUpdate", call: route.payload });
}

/** Frames through AgyBackend and on to the renderer, routed as AcpClient and
 *  the host route them: a child's update as `childStream`, the rest as usual. */
function feed(window: Window, backend: AgyBackend, frames: any[]): void {
  for (const frame of frames) {
    const normalized = backend.normalizeUpdate(frame, undefined);
    for (const earlier of normalized.precede ?? []) post(window, earlier);
    if (!normalized.update) continue;
    if (normalized.childSessionId) {
      const payload = childStreamFromRoute(normalized.childSessionId, routeSessionUpdate(normalized.update)!);
      if (payload) dispatch(window, { type: "childStream", ...payload });
      continue;
    }
    post(window, normalized.update);
  }
}

function endTurn(window: Window, backend: AgyBackend): void {
  for (const update of backend.turnEnded("completed")) post(window, update);
}

const labels = (doc: Document) => [...doc.querySelectorAll(".tool-label, .tool-item-label")].map((el) => el.textContent);

describe("Antigravity tool cards in the renderer", () => {
  it("a command shows what ran and what came back, with no path read out of the command line", () => {
    const { window, doc } = bootWebview();
    const backend = new AgyBackend();
    const id = "5a8085cb16c64ae88a2c0ccfc5090a42";
    const line = "Get-ChildItem -Force 'src' | ForEach-Object { \"`t\" + $_.Name + \"`n\" }";
    feed(window, backend, [
      { sessionUpdate: "tool_call", toolCallId: id, title: line, kind: "execute", status: "pending", rawInput: { CommandLine: line, Cwd: WS, WaitMsBeforeAsync: 5000 } },
      { sessionUpdate: "tool_call_update", toolCallId: id, title: line, kind: "execute", status: "in_progress", rawInput: { command_line: line, working_dir: WS } },
      { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { commandLine: line, workingDir: WS, exitCode: 0, exit_code: 0, combinedOutput: "\tapp.js\n", formatted_output: "\tapp.js\n" } },
    ]);
    dispatch(window, { type: "messageChunk", text: "done" });
    expect(labels(doc)).toEqual(["Run Get-ChildItem"]);
    const row = doc.querySelector(".has-details") as HTMLElement;
    click(window, row);
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe(line);
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("\tapp.js\n");
  });

  it("a read names its file, and a page read its address", () => {
    const { window, doc } = bootWebview();
    const backend = new AgyBackend();
    feed(window, backend, [
      { sessionUpdate: "tool_call", toolCallId: "call_576434", title: "Running view_file", kind: "read", status: "in_progress",
        rawInput: { absolute_path: `${WS}/src/app.js` }, locations: [{ path: `${WS}/src/app.js` }] },
      { sessionUpdate: "tool_call", toolCallId: "7543ce01", title: "Run read_url_content?", kind: "fetch", status: "pending", rawInput: { Url: "https://example.com" } },
      { sessionUpdate: "tool_call_update", toolCallId: "7543ce01", status: "completed", rawOutput: "Read example.com" },
      { sessionUpdate: "tool_call_update", toolCallId: "call_576434", status: "completed" },
    ]);
    dispatch(window, { type: "messageChunk", text: "done" });
    const shown = labels(doc).join(" | ");
    expect(shown).toContain("Read app.js");
    expect(shown).toContain("Fetch example.com");
    expect(shown).not.toContain("Generat");
  });

  // The owner's run: "Run some demo subagent for me". The parent's reply
  // streams a link in pieces while the child explores; before, the child's
  // rows landed between the pieces and split the link across two lines.
  const id = "24ac72049c3b49ecac09e055152210cf";
  const subagentTurn = [
    { sessionUpdate: "tool_call", toolCallId: id, title: "Run invoke_subagent?", kind: "other", status: "pending",
      rawInput: { Subagents: [{ Model: "inherit", Prompt: "Explore the project and summarise it.", Role: "Project Explorer", TypeName: "research" }] } },
    { sessionUpdate: "tool_call_update", toolCallId: id, title: "Running invoke_subagent", kind: "other", status: "in_progress", rawInput: {} },
    { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "Invoke subagent" },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I started a Project Explorer subagent on the [grok-remote](file:///" } },
    { sessionUpdate: "tool_call", toolCallId: "5a8085cb", title: "Get-ChildItem", kind: "execute", status: "pending", rawInput: { CommandLine: "Get-ChildItem", Cwd: WS } },
    { sessionUpdate: "tool_call_update", toolCallId: "5a8085cb", status: "completed", rawOutput: { exitCode: 0, exit_code: 0, combinedOutput: "README.md\n" } },
    { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Running view_file", kind: "read", status: "in_progress", rawInput: { absolute_path: `${WS}/README.md` } },
    { sessionUpdate: "tool_call", toolCallId: "call_2", title: "Running view_file", kind: "read", status: "in_progress", rawInput: { absolute_path: `${WS}/package.json` } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c:/GitHub/grok-remote) repository." } },
    { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" },
    { sessionUpdate: "tool_call_update", toolCallId: "call_2", status: "completed" },
  ];

  it("keeps a subagent's work inside its card and the parent's text whole, then settles the card when the turn ends", () => {
    const { window, doc } = bootWebview();
    feed(window, new AgyBackend(), subagentTurn.slice(0, 3));
    const card = doc.querySelector(".subagent-card") as HTMLElement;
    expect(card.querySelector(".subagent-title")!.textContent).toBe("Project Explorer");
    expect(card.querySelector(".subagent-status")!.textContent).toBe("running");
    const backend = new AgyBackend();
    const fresh = bootWebview();
    feed(fresh.window, backend, subagentTurn);
    // The child's three calls are rows inside the card, not tool groups in the transcript.
    const inside = fresh.doc.querySelector(".subagent-card")!;
    expect(inside.querySelectorAll(".subagent-tool")).toHaveLength(3);
    expect(fresh.doc.querySelectorAll(".tool-group, .tool-flat")).toHaveLength(0);
    expect(inside.querySelector(".subagent-status")!.textContent).toBe("running");
    // The host settles the backend's cards, then reports the turn complete.
    endTurn(fresh.window, backend);
    dispatch(fresh.window, { type: "promptComplete" });
    expect(inside.querySelector(".subagent-status")!.textContent).toBe("done");
    expect(inside.textContent).not.toContain("Invoke subagent");
    const message = [...fresh.doc.querySelectorAll(".msg.agent")];
    // One message, and its link whole: nothing was inserted between the pieces.
    expect(message).toHaveLength(1);
    expect(message[0].textContent).toContain("on the grok-remote repository.");
    expect(message[0].querySelector("a")?.textContent).toBe("grok-remote");
  });

  it("shows the same grouped, settled card from history and in a remote's snapshot", () => {
    for (const surface of [{}, { remote: true }]) {
      const { window, doc } = bootWebview(surface);
      const backend = new AgyBackend();
      dispatch(window, { type: "historyReplay", active: true });
      // session/load replays the turn the same way; the load's end settles it.
      feed(window, backend, [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Run some demo subagent for me" } }, ...subagentTurn]);
      endTurn(window, backend);
      dispatch(window, { type: "historyReplay", active: false });
      const card = doc.querySelector(".subagent-card")!;
      expect(card.querySelectorAll(".subagent-tool")).toHaveLength(3);
      expect(card.querySelector(".subagent-status")!.textContent).toBe("done");
      expect(doc.querySelector(".msg.agent")!.querySelector("a")?.textContent).toBe("grok-remote");
    }
  });
});
