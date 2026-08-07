import { describe, expect, it } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

/**
 * Client-owned font scale: AFK Pilot (IS_REMOTE) and the desktop Electron
 * shell (grokDesktopShell). VS Code webview stays on host `fontScale` only.
 */

/**
 * Open the surface the SETTINGS live on.
 *
 * Rail hosts split the popover: the composer gear holds what is about this
 * conversation (model, effort), the rail gear holds what is about the app.
 * Text size is a setting, so it belongs on the rail surface — putting it beside
 * model and effort was the first attempt and it read as a property of the
 * conversation. VS Code has no rail, both halves render, and the composer gear
 * is the only one there is.
 */
const withRail = (window: any) => {
  const el = window.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  window.document.body.appendChild(el);
  const search = window.document.createElement("input");
  search.id = "rail-search";
  window.document.body.appendChild(search);
};

function openGearMain(window: any, doc: Document) {
  // The rail only mounts once a `repos` frame arrives, and the settings surface
  // lives on the rail gear — so a harness that never sent one would silently
  // fall back to the composer gear and assert against the wrong panel.
  dispatch(window, {
    type: "repos",
    entries: [{ cwd: "/work/alpha", name: "alpha", available: true }],
    selectedCwd: "/work/alpha",
    activeCwd: "/work/alpha",
  } as never);
  const rail = doc.getElementById("rail-gear-btn");
  click(window, (rail || doc.getElementById("gear-btn"))!);
  // Text size lives in the Basic settings sub-panel, not on the gear root: the
  // root holds account and purpose, which are not settings.
  const entry = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
    .find((el) => /Basic settings/.test(el.textContent || ""));
  if (entry) click(window, entry as HTMLElement);
}

/**
 * Text size must LEAD THE SETTINGS GROUP, which is a different claim from
 * "first item in the popover": on a host with no rail the popover is not split,
 * so the conversation half renders above the app half and Text size is
 * correctly not first overall. Asserting position relative to a known app-half
 * item states the actual requirement and does not depend on whether the
 * harness happens to have mounted a rail.
 */
function leadsSettings(doc: Document): boolean {
  // "Leads Basic settings" = the first thing under the back link, i.e. above
  // every preference toggle in the panel. Stated against the toggles rather
  // than a neighbouring label, so renaming a setting cannot silently retire the
  // assertion.
  const items = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")];
  const size = items.findIndex((el) => /Text size/.test(el.textContent || ""));
  const firstSwitch = items.findIndex((el) => el.querySelector(".popover-switch"));
  return size >= 0 && (firstSwitch === -1 || size < firstSwitch);
}

function firstGearLabel(doc: Document): string {
  const first = doc.querySelector(
    "#gear-popover .toolbar-popover-item, #gear-popover .popover-section",
  );
  return (first?.textContent || "").replace(/\s+/g, " ").trim();
}

describe("client font scale (remote)", () => {
  it("puts Text size first on the settings surface", () => {
    const { window, doc } = bootWebview({ remote: true, beforeScripts: withRail });
    openGearMain(window, doc);
    expect(doc.getElementById("remote-font-scale")).toBeTruthy();
    expect(leadsSettings(doc)).toBe(true);
  });

  it("steps, resets, persists, and is bounded", () => {
    const { window, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        withRail(w);
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
        withRail(w);
        (w as any).localStorage.setItem("grok.remote.fontScale", "1.4");
      },
    });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
  });

  it("Ctrl/Cmd + +/- /0 and wheel adjust zoom", () => {
    const { window } = bootWebview({ remote: true, beforeScripts: withRail });
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

  it("shows Text size first on the settings surface and keeps the slider in sync with shortcuts", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (w) => {
        (w as any).grokDesktopShell = true;
        // The settings entry points are gated on the rail mount existing, and
        // the desktop shell ships one.
        withRail(w);
      },
    });
    openGearMain(window, doc);
    expect(leadsSettings(doc)).toBe(true);
    const slider = doc.getElementById("remote-font-scale") as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.value).toBe("100");
    // Model/effort stay on the conversation surface, not this one.

    // Ctrl+= steps zoom; open slider must reflect the same value.
    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "=", ctrlKey: true, bubbles: true }),
    );
    expect((window as any).__grokFontScale.get()).toBeCloseTo(1.1, 5);
    expect(slider.value).toBe("110");
    expect(slider.parentElement!.querySelector("output")!.textContent).toBe("110%");

    // Slider change updates zoom the same way.
    slider.value = "140";
    slider.dispatchEvent(new (window as any).Event("change", { bubbles: true }));
    expect((window as any).__grokFontScale.get()).toBeCloseTo(1.4, 5);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
    expect((window as any).localStorage.getItem("grok.desktop.fontScale")).toBe("1.4");
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

  it("does not show a Text size slider on the main gear panel", () => {
    const { window, doc } = bootWebview();
    openGearMain(window, doc);
    expect(doc.getElementById("remote-font-scale")).toBeNull();
    expect(firstGearLabel(doc)).toMatch(/Model and Effort/);
  });
});
