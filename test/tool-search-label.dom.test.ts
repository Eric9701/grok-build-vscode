/**
 * #145 — a running search says WHAT it is searching for.
 *
 * The reporter asked for the details of a "Searching…" row to expand
 * immediately when "Expand command details" is on. Two things stood in the
 * way, and both are deliberate:
 *
 *   - a group in progress has no chevron at all (chat.css, "can't expand while
 *     running"), and
 *   - a search row carries no IN/OUT block — the IN would repeat the row's own
 *     label, and the OUT is the match list, which is the noise we keep out.
 *
 * What was genuinely missing is smaller and is what these cover: the settled
 * row has always named the pattern, while the in-progress header said a bare
 * "Searching" — so the one moment you want to know what is being searched was
 * the one moment we would not say. Every neighbouring verb already carries its
 * argument (Reading foo.ts, Listing src/, Editing bar.css).
 *
 * The last case pins the decision the fix must NOT drift into.
 */
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const label = (doc: any) => doc.querySelector(".tool-group-label")!.textContent as string;

describe("a running search names its pattern (#145)", () => {
  it("says what it is searching for, before any result arrives", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "s1", kind: "search", title: "Grep", rawInput: { pattern: "handleClick" } },
    });
    expect(doc.querySelector(".tool-group")!.classList.contains("in-progress")).toBe(true);
    expect(label(doc)).toContain('Searching for "handleClick"');
  });

  it("falls back to the bare verb when the pattern is not on the wire yet", () => {
    // Claude's first tool_call carries an empty rawInput and fills it in on an
    // update; there is nothing to name at that instant and we must not invent
    // one.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "s2", kind: "search", title: "Grep", rawInput: {} } });
    expect(label(doc).trim()).toBe("Searching");
  });

  it("picks the pattern up from a later update", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "s3", kind: "search", title: "Grep", rawInput: {} } });
    expect(label(doc).trim()).toBe("Searching");
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "s3", kind: "search", rawInput: { pattern: "REMOTE_PROTO_VERSION" } },
    });
    expect(label(doc)).toContain('Searching for "REMOTE_PROTO_VERSION"');
  });

  it("clamps a long pattern the same way the settled row does", () => {
    const { window, doc } = bootWebview();
    const long = "x".repeat(80);
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "s4", kind: "search", title: "Grep", rawInput: { pattern: long } },
    });
    const text = label(doc);
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(41));
  });

  it("names the folder when the search was narrowed to one (#220)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "s7", kind: "search", title: "Grep", rawInput: { pattern: "useState", path: "src/components" } },
    });
    expect(label(doc)).toContain('Searching for "useState" in src/components');
  });

  it("names a web search's query too", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "s5", title: "web_search", rawInput: { query: "acp spec" } },
    });
    expect(label(doc)).toContain('Searching web for "acp spec"');
  });

  it("still gives a search row NO details block — the pattern is the whole story", () => {
    // The guard on the decision above: a future reading of #145 must not
    // "fix" it by inlining grep output. If this fails, that is what happened.
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "s6", kind: "search", title: "Grep", rawInput: { pattern: "needle" } },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "s6",
        kind: "search",
        status: "completed",
        rawInput: { pattern: "needle" },
        content: [{ type: "content", content: { type: "text", text: "a.ts:1\nb.ts:2\nc.ts:3" } }],
      },
    });
    expect(doc.querySelector(".tool-item .tool-item-details")).toBeNull();
    expect(doc.querySelector(".tool-item .cmd-block")).toBeNull();
  });
});
