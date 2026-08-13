import { describe, expect, it } from "vitest";
import { bootWebview } from "./webview-harness";

/**
 * Desktop boot-layout race: CSS `--chat-zoom` must apply before the first
 * composer focus, that focus must not scroll the document, and only the
 * desktop shell resets html scroll after chrome wrap / resize.
 */

describe("desktop boot layout (zoom + preventScroll)", () => {
  it("applies --chat-zoom before boot focus and uses preventScroll", () => {
    const order: string[] = [];
    const { doc } = bootWebview({
      beforeScripts(w) {
        const input = w.document.getElementById("input") as HTMLTextAreaElement;
        const origFocus = input.focus.bind(input);
        input.focus = function (opts?: FocusOptions) {
          order.push(opts?.preventScroll ? "focus:prevent" : "focus");
          return origFocus(opts);
        };
        const origSet = w.document.body.style.setProperty.bind(w.document.body.style);
        w.document.body.style.setProperty = function (key: string, value: string, priority?: string) {
          if (key === "--chat-zoom") order.push("zoom");
          return origSet(key, value, priority);
        };
      },
    });
    expect(order[0]).toBe("zoom");
    expect(order).toContain("focus:prevent");
    expect(order.indexOf("zoom")).toBeLessThan(order.indexOf("focus:prevent"));
    expect(doc.documentElement.scrollTop).toBe(0);
    expect(doc.documentElement.scrollLeft).toBe(0);
  });

  it("window-focus handler focuses the composer with preventScroll", () => {
    const calls: Array<FocusOptions | undefined> = [];
    const { window, doc } = bootWebview({
      beforeScripts(w) {
        const input = w.document.getElementById("input") as HTMLTextAreaElement;
        const origFocus = input.focus.bind(input);
        input.focus = function (opts?: FocusOptions) {
          calls.push(opts);
          return origFocus(opts);
        };
      },
    });
    const input = doc.getElementById("input") as HTMLElement;
    input.blur();
    expect(doc.activeElement === doc.body || !doc.activeElement).toBe(true);
    calls.length = 0;
    window.dispatchEvent(new window.Event("focus"));
    expect(calls[0]).toEqual({ preventScroll: true });
    expect(doc.activeElement).toBe(input);
  });

  it("desktop resize and the chrome-wrap hook reset documentElement scroll", () => {
    const { window, doc } = bootWebview({
      beforeScripts(w) {
        (w as unknown as { grokDesktopShell: boolean }).grokDesktopShell = true;
      },
    });
    expect(typeof (window as unknown as { __grokResetDocumentScroll?: unknown }).__grokResetDocumentScroll)
      .toBe("function");
    doc.documentElement.scrollTop = 40;
    doc.documentElement.scrollLeft = 12;
    window.dispatchEvent(new window.Event("resize"));
    expect(doc.documentElement.scrollTop).toBe(0);
    expect(doc.documentElement.scrollLeft).toBe(0);

    doc.documentElement.scrollTop = 40;
    (window as unknown as { __grokResetDocumentScroll: () => void }).__grokResetDocumentScroll();
    expect(doc.documentElement.scrollTop).toBe(0);
  });

  it("VS Code webview does not expose the desktop scroll hook or reset on resize", () => {
    const { window, doc } = bootWebview();
    expect((window as unknown as { __grokResetDocumentScroll?: unknown }).__grokResetDocumentScroll)
      .toBeUndefined();
    doc.documentElement.scrollTop = 40;
    window.dispatchEvent(new window.Event("resize"));
    expect(doc.documentElement.scrollTop).toBe(40);
  });
});
