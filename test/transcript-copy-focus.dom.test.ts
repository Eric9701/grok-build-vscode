// DOM test for #223 / #225 — VS Code's Ctrl+C and Copy refocus the webview
// before they copy. The window-focus hook used to hand focus to the composer
// whenever it found <body>, which collapsed a highlight in the transcript, so
// the copy read the composer (or nothing) instead.
import { describe, it, expect } from "vitest";
import { bootWebview } from "./webview-harness";

describe("window focus with a transcript highlight (#223, #225)", () => {
  function setup() {
    const { window, doc } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    const p = doc.createElement("p");
    p.textContent = "copy me from the transcript";
    doc.getElementById("messages")!.appendChild(p);
    input.value = "asdf";
    input.blur();
    expect(doc.activeElement).toBe(doc.body);
    return { window, doc, input, p };
  }

  it("leaves focus and the highlight where they are", () => {
    const { window, doc, p } = setup();
    const range = doc.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    window.dispatchEvent(new window.FocusEvent("focus"));

    expect(doc.activeElement).toBe(doc.body);
    expect(String(window.getSelection())).toBe("copy me from the transcript");
  });

  it("still claims the composer when nothing is highlighted", () => {
    const { window, doc, input } = setup();
    window.getSelection()!.removeAllRanges();

    window.dispatchEvent(new window.FocusEvent("focus"));

    expect(doc.activeElement).toBe(input);
  });
});
