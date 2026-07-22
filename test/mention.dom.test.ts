// DOM tests for the composer's "@" file autocomplete: typing `@` posts
// mentionQuery, mentionResults renders the popover, keyboard picks rewrite the
// token + attach the file (addMentionFile) — plus the waiting-indicator
// structure the shimmer CSS animates.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";

type TextArea = HTMLTextAreaElement;

function typeInComposer(h: Harness, text: string): TextArea {
  const input = h.doc.getElementById("input") as TextArea;
  input.value = text;
  // happy-dom doesn't move the caret on programmatic value writes — pin it to
  // the end the way a real keystroke leaves it.
  input.selectionStart = text.length;
  input.selectionEnd = text.length;
  input.dispatchEvent(new (h.window as any).Event("input", { bubbles: true }));
  return input;
}

function key(h: Harness, k: string): void {
  const input = h.doc.getElementById("input") as TextArea;
  input.dispatchEvent(
    new (h.window as any).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
  );
}

const mentionQueries = (h: Harness) => h.posted.filter((p) => p.type === "mentionQuery");

describe("@ file mention popover", () => {
  it("typing @ posts a mentionQuery with the empty token", () => {
    const h = bootWebview();
    typeInComposer(h, "@");
    expect(mentionQueries(h)).toEqual([{ type: "mentionQuery", query: "" }]);
  });

  it("typing after @ posts the growing token", () => {
    const h = bootWebview();
    typeInComposer(h, "@c");
    typeInComposer(h, "@ch");
    expect(mentionQueries(h).map((p) => p.query)).toEqual(["c", "ch"]);
  });

  it("a mid-word @ (email) never posts a query", () => {
    const h = bootWebview();
    typeInComposer(h, "user@host");
    expect(mentionQueries(h)).toEqual([]);
  });

  it("mentionResults renders rows (name + dimmed dir) and shows the popover", () => {
    const h = bootWebview();
    typeInComposer(h, "@");
    dispatch(h.window, { type: "mentionResults", query: "", files: ["README.md", "src/chips.ts"] });

    const popover = h.doc.getElementById("mention-popover") as HTMLElement;
    expect(popover.hidden).toBe(false);
    const rows = [...popover.querySelectorAll(".mention-item")];
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".mention-name")?.textContent).toBe("README.md");
    expect(rows[0].querySelector(".mention-dir")).toBeNull(); // root file — no dir span
    expect(rows[1].querySelector(".mention-name")?.textContent).toBe("chips.ts");
    expect(rows[1].querySelector(".mention-dir")?.textContent).toBe("src");
    expect(rows[0].classList.contains("active")).toBe(true);
  });

  it("drops a stale reply (query no longer under the caret)", () => {
    const h = bootWebview();
    typeInComposer(h, "@ch");
    dispatch(h.window, { type: "mentionResults", query: "old", files: ["x.ts"] });
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(true);
  });

  it("ignores results when no token is active at all", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "mentionResults", query: "", files: ["x.ts"] });
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(true);
  });

  it("an empty result list hides the popover but keeps the token querying", () => {
    const h = bootWebview();
    typeInComposer(h, "@zz");
    dispatch(h.window, { type: "mentionResults", query: "zz", files: [] });
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(true);
    // Further typing still queries — the token never went away.
    typeInComposer(h, "@z");
    expect(mentionQueries(h).map((p) => p.query)).toEqual(["zz", "z"]);
  });

  it("ArrowDown + Enter picks the highlighted file: rewrites the token, attaches, hides", () => {
    const h = bootWebview();
    const input = typeInComposer(h, "@ch");
    dispatch(h.window, {
      type: "mentionResults",
      query: "ch",
      files: ["media/chat.js", "src/chips.ts"],
    });

    key(h, "ArrowDown"); // highlight the second row
    key(h, "Enter");

    expect(input.value).toBe("@src/chips.ts ");
    expect(h.posted.filter((p) => p.type === "addMentionFile")).toEqual([
      { type: "addMentionFile", relPath: "src/chips.ts" },
    ]);
    // The Enter was consumed by the pick — nothing was sent or queued.
    expect(h.posted.filter((p) => p.type === "send" || p.type === "queueSend")).toEqual([]);
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(true);
  });

  it("clicking a row picks it", () => {
    const h = bootWebview();
    const input = typeInComposer(h, "fix @re");
    dispatch(h.window, { type: "mentionResults", query: "re", files: ["README.md"] });

    const row = h.doc.querySelector("#mention-popover .mention-item") as HTMLElement;
    click(h.window, row);

    expect(input.value).toBe("fix @README.md ");
    expect(h.posted.filter((p) => p.type === "addMentionFile")).toEqual([
      { type: "addMentionFile", relPath: "README.md" },
    ]);
  });

  it("Escape closes the popover without touching the text", () => {
    const h = bootWebview();
    const input = typeInComposer(h, "@ch");
    dispatch(h.window, { type: "mentionResults", query: "ch", files: ["src/chips.ts"] });
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(false);

    key(h, "Escape");
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(true);
    expect(input.value).toBe("@ch");
  });

  it("deleting back out of the token hides the popover", () => {
    const h = bootWebview();
    typeInComposer(h, "@c");
    dispatch(h.window, { type: "mentionResults", query: "c", files: ["src/chips.ts"] });
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(false);

    typeInComposer(h, ""); // backspaced everything
    expect((h.doc.getElementById("mention-popover") as HTMLElement).hidden).toBe(true);
  });
});

describe("waiting-for-response indicator", () => {
  it("agentStart shows the Grokking indicator with the shimmer label + title", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "agentStart" });

    const grokking = h.doc.querySelector(".grokking") as HTMLElement;
    expect(grokking).toBeTruthy();
    expect(grokking.title).toBe("Waiting for response");
    // The shimmer CSS animates .grokking-label — the span must exist.
    expect(grokking.querySelector(".grokking-label")?.textContent).toBe("Grokking");
  });
});
