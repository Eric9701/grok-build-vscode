/**
 * Model picker rows: provider marks always, versioned Claude labels, and a
 * fixed Manage providers footer. Drives the shipped media/chat.js.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootWebview, click, dispatch } from "./webview-harness";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const modelBtn = (doc: Document) => doc.querySelector(".model-name-btn") as HTMLButtonElement;
const pickerItems = (doc: Document) => [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")];

function openModelPicker(h: ReturnType<typeof bootWebview>, models: object[], extra: object = {}) {
  dispatch(h.window, {
    type: "session",
    sessionId: "fresh",
    provider: "grok",
    currentModelId: "grok-build",
    models,
    ...extra,
  });
  click(h.window, $(h.doc, "gear-btn"));
  click(h.window, modelBtn(h.doc));
}

describe("model picker provider marks and manage-providers", () => {
  it("puts a provider mark on every model row even when only one agent is connected", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "grok", connected: true }],
    });
    openModelPicker(h, [
      { provider: "grok", modelId: "grok-build", name: "Grok Build" },
    ]);

    const rows = [...h.doc.querySelectorAll("#gear-popover .model-picker-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".provider-glyph.provider-grok")).toBeTruthy();
    expect(rows[0].textContent).toContain("Grok Build");
    expect(h.doc.querySelectorAll(".model-provider-heading")).toHaveLength(0);
  });

  it("always offers Manage providers and opens Settings → Providers", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "grok", connected: true }],
    });
    openModelPicker(h, [
      { provider: "grok", modelId: "grok-build", name: "Grok Build" },
    ]);

    const manage = pickerItems(h.doc).find((el) => el.classList.contains("model-manage-providers"));
    expect(manage, "Manage providers footer").toBeTruthy();
    expect(manage!.textContent).toContain("Manage providers");
    expect(manage!.previousElementSibling?.classList.contains("popover-sep")).toBe(true);

    click(h.window, manage!);
    expect(h.doc.getElementById("settings-overlay")).toBeTruthy();
    const activeNav = h.doc.querySelector("#settings-overlay .settings-nav-item.active");
    expect(activeNav?.textContent).toContain("Providers");
  });

  it("surfaces Claude generation numbers from the adapter description", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "claude", connected: true }],
    });
    openModelPicker(h, [
      {
        provider: "claude",
        modelId: "claude-sonnet-4-5",
        name: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks",
      },
      {
        provider: "claude",
        modelId: "claude-haiku-4-5",
        name: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
    ], { provider: "claude", currentModelId: "claude-sonnet-4-5" });

    const text = h.doc.getElementById("gear-popover")!.textContent || "";
    expect(text).toContain("Sonnet 5");
    expect(text).toContain("Haiku 4.5");
    const sonnet = [...h.doc.querySelectorAll("#gear-popover .model-picker-row")]
      .find((el) => el.textContent?.includes("Sonnet 5"));
    expect(sonnet?.querySelector(".provider-glyph.provider-claude")).toBeTruthy();
  });
});

describe("New session in the top bar", () => {
  it("keeps New session next to History and out of the overflow", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const newBtn = $(h.doc, "new-btn") as HTMLButtonElement;
    expect(newBtn.hidden).toBe(false);
    expect(newBtn.title).toBe("New session");

    const overflow = $(h.doc, "session-head-actions").querySelector(".rail-menu-btn");
    expect(overflow).toBeTruthy();
    click(h.window, overflow!);
    const labels = [...h.doc.querySelectorAll(".rail-menu-item")].map((el) => el.textContent || "");
    expect(labels.some((t) => /New session/.test(t))).toBe(false);
    expect(labels.some((t) => /Continue in a new chat/.test(t))).toBe(true);
  });

  it("injects New session beside Session history on a remote header", () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (window) => {
        const head = window.document.getElementById("session-head")!;
        const history = window.document.createElement("button");
        history.id = "session-history";
        head.appendChild(history);
      },
    });
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const history = $(h.doc, "session-history");
    const sessionNew = $(h.doc, "session-new");
    expect(sessionNew).toBeTruthy();
    expect(sessionNew.hidden).toBe(false);
    expect(sessionNew.previousElementSibling).toBe(history);
    expect(sessionNew.getAttribute("aria-label")).toBe("New session");
  });
});

describe("context popover width", () => {
  it("caps the shared popover at 350px in CSS", () => {
    const css = readFileSync(fileURLToPath(new URL("../media/chat.css", import.meta.url)), "utf8");
    expect(css).toMatch(/#context-popover\s*\{[^}]*max-width:\s*350px/);
  });
});
