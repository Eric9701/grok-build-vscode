/**
 * What an Antigravity tool card shows, end to end: frames as Google's server
 * sent them live (2026-10-15), through AgyBackend, into the real renderer --
 * the same frames a phone renders. Before the backend normalised them, a
 * command row read "Run" with no command and no output, and a PowerShell line
 * turned into a row like `Run ''"]([^`.
 */
import { describe, expect, it } from "vitest";
import { AgyBackend } from "../src/agy-backend";
import { bootWebview, click, dispatch } from "./webview-harness";

const WS = "C:/work/proj";

function feed(window: Window, backend: AgyBackend, frames: any[]): void {
  for (const frame of frames) {
    const call = backend.normalizeUpdate(frame, undefined).update;
    if (!call) continue;
    dispatch(window, { type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call });
  }
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

  it("invoke_subagent is a subagent card with its role, in the background", () => {
    const { window, doc } = bootWebview();
    const backend = new AgyBackend();
    const id = "24ac72049c3b49ecac09e055152210cf";
    feed(window, backend, [
      { sessionUpdate: "tool_call", toolCallId: id, title: "Run invoke_subagent?", kind: "other", status: "pending",
        rawInput: { Subagents: [{ Model: "inherit", Prompt: "List the files and read notes.txt.", Role: "Project File Reader", TypeName: "research" }] } },
      { sessionUpdate: "tool_call_update", toolCallId: id, title: "Running invoke_subagent", kind: "other", status: "in_progress", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "Invoke subagent" },
    ]);
    const card = doc.querySelector(".subagent-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector(".subagent-title")!.textContent).toBe("Project File Reader");
    expect(card.querySelector(".subagent-status")!.textContent).toBe("in background");
    expect(card.textContent).not.toContain("Invoke subagent");
    expect(labels(doc).join(" ")).not.toContain("invoke_subagent");
  });
});
