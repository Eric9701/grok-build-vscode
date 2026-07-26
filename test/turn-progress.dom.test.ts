// Two live-turn presentation bugs, both reported from dogfooding. Drives the
// REAL media/chat.js in happy-dom.
//
// 1. The copy/timestamp footer appeared while the turn was still running, so
//    tool rows rendered BELOW it — the footer flickered in and left a gap.
//    It must appear only when the turn actually ends.
// 2. After a subagent finished and grok went quiet, nothing on screen said the
//    turn was still going: no Grokking, no Thinking, no dots.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bootWebview, dispatch } from "./webview-harness";

const META = { totalTokens: 100, usage: { inputTokens: 10 } };

const agentFooter = (doc: Document) =>
  doc.querySelector(".msg.agent .msg-actions") as HTMLElement | null;
const grokking = (doc: Document) => doc.querySelector(".grokking, .msg.grokking");

function startTurn(window: any) {
  dispatch(window, { type: "userMessage", text: "do it", chips: [] });
  dispatch(window, { type: "agentStart" });
}

describe("turn footer waits for the turn to end", () => {
  it("stays hidden while the agent is still streaming", () => {
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, { type: "messageChunk", text: "working on it" });
    expect(agentFooter(doc)!.hidden).toBe(true);
  });

  it("stays hidden through promptComplete — that ends a prompt, not the turn", () => {
    // A plan verdict runs a SECOND prompt inside the same turn, so promptComplete
    // is not a turn end. Revealing here is what put a footer mid-conversation.
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, { type: "messageChunk", text: "here is the plan" });
    dispatch(window, { type: "promptComplete", meta: META });
    expect(agentFooter(doc)!.hidden).toBe(true);
  });

  it("is still hidden when a tool runs after the text — the reported gap", () => {
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, { type: "messageChunk", text: "let me check" });
    dispatch(window, { type: "promptComplete", meta: META });
    dispatch(window, { type: "toolCall", call: { toolCallId: "t1", title: "Read a.ts", kind: "read" } });
    expect(agentFooter(doc)!.hidden).toBe(true);
  });

  it("appears once agentEnd lands", () => {
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, { type: "messageChunk", text: "done" });
    dispatch(window, { type: "agentEnd", meta: META });
    expect(agentFooter(doc)!.hidden).toBe(false);
  });

  it("appears on agentError too — a failed turn is still a finished turn", () => {
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, { type: "messageChunk", text: "partial" });
    dispatch(window, { type: "agentError", text: "boom" });
    expect(agentFooter(doc)!.hidden).toBe(false);
  });
});

describe("a live turn always shows progress (#26 guarantee)", () => {
  it("shows Grokking when a subagent finishes and nothing else is live", () => {
    // The reported case: subagent replied "Hello world", grok kept working, and
    // the UI showed nothing at all.
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "sa", title: "hello world test", kind: "other",
              _meta: { "x.ai/tool": { name: "spawn_subagent" } } },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "sa", status: "completed",
              rawOutput: { SubagentCompleted: { output: "Hello world.", duration_ms: 3000 } } },
    });
    dispatch(window, { type: "subagentUpdate", update: { kind: "subagent_finished", duration_ms: 3000 } });
    expect(grokking(doc)).not.toBeNull();
  });

  it("does NOT add Grokking while text is actively streaming at the tail", () => {
    // The clause still has to earn its keep: streaming text IS visible progress,
    // and stacking a Grokking under every chunk would be noise.
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, { type: "messageChunk", text: "streaming right now" });
    expect(grokking(doc)).toBeNull();
  });

  it("adds nothing once the turn has ended", () => {
    const { window, doc } = bootWebview();
    startTurn(window);
    dispatch(window, { type: "messageChunk", text: "all done" });
    dispatch(window, { type: "agentEnd", meta: META });
    expect(grokking(doc)).toBeNull();
  });
});

// The footer is hidden with the `hidden` property, but `.msg-actions` sets an
// author `display: flex` — which beats the UA `[hidden] { display: none }`. So
// the property was set and the CSS ignored it: the footer still reserved layout
// space under a streaming message and :hover still revealed Copy mid-turn.
// happy-dom does no UA cascade, so a DOM assertion can't catch this; the guard
// has to be on the stylesheet itself.
describe("the hidden footer is actually hidden by CSS", () => {
  const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");

  it("has a rule that makes [hidden] win over the flex display", () => {
    expect(css).toMatch(/\.msg-actions\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  it("declares it before the .msg-actions display rule it must survive", () => {
    // Same specificity (0,1,1 vs 0,1,0 — the attribute selector is higher), but
    // keep them ordered so the intent stays obvious to the next reader.
    expect(css.indexOf(".msg-actions[hidden]")).toBeLessThan(
      css.indexOf(".msg-actions {"),
    );
  });
});
