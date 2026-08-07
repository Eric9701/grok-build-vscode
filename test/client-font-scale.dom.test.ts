import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

/**
 * Client-owned font scale: AFK Pilot (IS_REMOTE) and the desktop Electron
 * shell (grokDesktopFileTree). VS Code webview stays on host `fontScale` only.
 */

describe("client font scale (remote)", () => {
  it("steps, resets, persists, and is bounded", () => {
    const { window, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.removeItem("grok.remote.fontScale");
      },
    });
    const api = (window as any).__grokFontScale;
    expect(api).toBeTruthy();
    expect(api.get()).toBe(1);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1");

    api.set(api.step(api.get(), api.stepSize));
    expect(api.get()).toBeCloseTo(1.1, 5);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.1");
    expect((window as any).localStorage.getItem("grok.remote.fontScale")).toBe("1.1");

    api.set(api.step(api.get(), -api.stepSize));
    expect(api.get()).toBeCloseTo(1.0, 5);

    api.set(0.5); // below min
    expect(api.get()).toBe(api.min);
    api.set(3); // above max
    expect(api.get()).toBe(api.max);

    api.set(1);
    expect(api.get()).toBe(1);
    expect((window as any).localStorage.getItem("grok.remote.fontScale")).toBe("1");
  });

  it("restores the stored scale on reload", () => {
    const { doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).localStorage.setItem("grok.remote.fontScale", "1.4");
      },
    });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
  });

  it("Ctrl/Cmd + +/- /0 and wheel adjust zoom", () => {
    const { window } = bootWebview({ remote: true });
    const api = (window as any).__grokFontScale;
    api.set(1);

    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "=", ctrlKey: true, bubbles: true }),
    );
    expect(api.get()).toBeCloseTo(1.1, 5);

    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "-", metaKey: true, bubbles: true }),
    );
    expect(api.get()).toBeCloseTo(1.0, 5);

    api.set(1.3);
    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true }),
    );
    expect(api.get()).toBe(1);

    api.set(1);
    // happy-dom's WheelEvent may not accept ctrlKey/deltaY in the init dict —
    // set them on the instance so the client handler sees a real mod+wheel.
    const wheel = new (window as any).WheelEvent("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(wheel, "deltaY", { value: -100, configurable: true });
    Object.defineProperty(wheel, "ctrlKey", { value: true, configurable: true });
    Object.defineProperty(wheel, "metaKey", { value: false, configurable: true });
    window.dispatchEvent(wheel);
    expect(api.get()).toBeGreaterThan(1);
  });
});

describe("client font scale (desktop bridge)", () => {
  it("uses localStorage when grokDesktopShell is present and ignores host fontScale", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (w) => {
        (w as any).grokDesktopShell = true;
        (w as any).localStorage.setItem("grok.desktop.fontScale", "1.2");
      },
    });
    const api = (window as any).__grokFontScale;
    expect(api).toBeTruthy();
    expect(api.key).toBe("grok.desktop.fontScale");
    expect(api.get()).toBeCloseTo(1.2, 5);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.2");

    // Host config must not clobber client-owned zoom.
    dispatch(window, { type: "fontScale", value: 0.9 });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.2");

    api.set(1.5);
    expect((window as any).localStorage.getItem("grok.desktop.fontScale")).toBe("1.5");
  });
});

describe("VS Code webview font scale (host-owned)", () => {
  it("does not wire client shortcuts or localStorage client key", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (w) => {
        // No remote flag, no desktop bridge — pure extension webview.
        (w as any).localStorage.setItem("grok.desktop.fontScale", "1.5");
        (w as any).localStorage.setItem("grok.remote.fontScale", "1.5");
      },
    });
    expect((window as any).__grokFontScale).toBeUndefined();
    // Host baked --chat-zoom wins; stored client keys are ignored.
    dispatch(window, { type: "fontScale", value: 1.1 });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.1");
  });
});
