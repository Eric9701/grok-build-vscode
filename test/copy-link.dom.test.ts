// DOM-level regression for #106: right-click (or the same contextmenu event
// a touch long-press synthesises) on a transcript link offers Copy Link and
// writes the resolved href through the existing clipboard path. Plain text
// and chrome/native links must not grow a disabled stand-in.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

function renderAgent(window: Window, text: string): HTMLElement {
  dispatch(window, { type: "messageChunk", text });
  dispatch(window, { type: "promptComplete" });
  return window.document.querySelector(".msg.agent") as HTMLElement;
}

function contextmenu(window: Window, el: EventTarget): MouseEvent {
  const ev = new (window as any).MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 24,
    clientY: 24,
  });
  (el as Element).dispatchEvent(ev);
  return ev;
}

function mockClipboard(window: Window): { value: string } {
  const box = { value: "" };
  Object.defineProperty((window as any).navigator, "clipboard", {
    value: { writeText: (t: string) => { box.value = t; return Promise.resolve(); } },
    configurable: true,
  });
  return box;
}

function copyLinkItem(doc: Document): HTMLButtonElement | undefined {
  return [...doc.querySelectorAll(".rail-menu-item")].find(
    (el) => el.textContent === "Copy Link",
  ) as HTMLButtonElement | undefined;
}

describe("Copy Link on the chat context menu", () => {
  it("right-click on a markdown link offers Copy Link and writes the href", () => {
    const { window, doc } = bootWebview();
    const copied = mockClipboard(window);
    const el = renderAgent(window, "See [the guide](https://example.com/guide) for details.");
    const link = el.querySelector("a[href]") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe("the guide");
    expect(link.getAttribute("href")).toBe("https://example.com/guide");

    const ev = contextmenu(window, link);
    expect(ev.defaultPrevented).toBe(true);
    expect(copyLinkItem(doc)).toBeTruthy();

    click(window, copyLinkItem(doc)!);
    expect(copied.value).toBe("https://example.com/guide");
    expect(doc.querySelector(".rail-menu")).toBeNull();
  });

  it("copies a file-reference path, not a resolved page URL", () => {
    const { window, doc } = bootWebview();
    const copied = mockClipboard(window);
    const el = renderAgent(window, "Open `src/sidebar.ts` next.");
    const link = el.querySelector("a.file-ref-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("src/sidebar.ts");

    // Visible text is the inner <code>; closest("a[href]") must still win.
    contextmenu(window, link.querySelector("code") || link);
    click(window, copyLinkItem(doc)!);
    expect(copied.value).toBe("src/sidebar.ts");
  });

  it("offers Copy Link when the selection is the link, even if the click is outside it", () => {
    const { window, doc } = bootWebview();
    const copied = mockClipboard(window);
    const el = renderAgent(window, "See [the guide](https://example.com/guide) for details.");
    const link = el.querySelector("a[href]") as HTMLAnchorElement;
    const range = doc.createRange();
    range.selectNodeContents(link);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const ev = contextmenu(window, el);
    expect(ev.defaultPrevented).toBe(true);
    click(window, copyLinkItem(doc)!);
    expect(copied.value).toBe("https://example.com/guide");
  });

  it("right-click on plain text does not show Copy Link", () => {
    const { window, doc } = bootWebview();
    const el = renderAgent(window, "No links in this reply at all.");
    const ev = contextmenu(window, el);
    expect(ev.defaultPrevented).toBe(false);
    expect(copyLinkItem(doc)).toBeUndefined();
    expect(doc.querySelector(".rail-menu")).toBeNull();
  });

  it("does not offer Copy Link for chrome or in-page-only targets", () => {
    const { window, doc } = bootWebview();
    const native = doc.createElement("a");
    native.setAttribute("href", "/");
    native.setAttribute("data-native-link", "");
    native.textContent = "home";
    doc.body.appendChild(native);
    const hash = doc.createElement("a");
    hash.setAttribute("href", "#section");
    hash.textContent = "jump";
    doc.body.appendChild(hash);

    expect(contextmenu(window, native).defaultPrevented).toBe(false);
    expect(copyLinkItem(doc)).toBeUndefined();
    expect(contextmenu(window, hash).defaultPrevented).toBe(false);
    expect(copyLinkItem(doc)).toBeUndefined();
  });
});
