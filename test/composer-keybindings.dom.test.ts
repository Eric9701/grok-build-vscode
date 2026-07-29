import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

describe("macOS Emacs composer movement", () => {
  it("moves forward by one character", () => {
    const { window, doc } = bootWebview();
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    input.value = "abcd";
    input.focus();
    input.setSelectionRange(1, 1);

    dispatch(window, { type: "moveComposerCaret", direction: "forward" });

    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it("moves to the previous line and preserves the intended column across short lines", () => {
    const { window, doc } = bootWebview();
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    input.value = "012345\nx\nabcdef";
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    dispatch(window, { type: "moveComposerCaret", direction: "previousLine" });
    expect(input.selectionStart).toBe(8);
    dispatch(window, { type: "moveComposerCaret", direction: "previousLine" });
    expect(input.selectionStart).toBe(6);
  });
});
