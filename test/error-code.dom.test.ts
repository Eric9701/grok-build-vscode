// Additive error.code must be visible on the rendered node so a DOM harness
// can key off it instead of matching user-facing copy.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";
import { INTERRUPTED_SEND_CODE } from "../src/protocol";
import { INTERRUPTED_SEND_TEXT } from "../src/session";

describe("error.code → data-error-code", () => {
  it("stamps data-error-code when the host sends a code", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "error",
      text: INTERRUPTED_SEND_TEXT,
      code: INTERRUPTED_SEND_CODE,
    });
    const el = doc.querySelector(".msg.error") as HTMLElement | null;
    expect(el?.textContent).toBe(INTERRUPTED_SEND_TEXT);
    expect(el?.getAttribute("data-error-code")).toBe(INTERRUPTED_SEND_CODE);
  });

  it("leaves the attribute off when no code is present", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "error", text: "Could not rename this conversation." });
    const el = doc.querySelector(".msg.error") as HTMLElement | null;
    expect(el?.textContent).toBe("Could not rename this conversation.");
    expect(el?.hasAttribute("data-error-code")).toBe(false);
  });
});
