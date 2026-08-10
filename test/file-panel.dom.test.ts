import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
// @ts-expect-error Plain-JS webview module intentionally has no TS build step.
import {
  applyDraft,
  applySaveSuccess,
  createFilePanel,
  makeTab,
} from "../media/file-panel.js";

type Scope = { id: string; label: string; title?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options?: {
  write?: (scopeId: string, request: Record<string, unknown>) => Promise<unknown>;
  read?: (scopeId: string, relPath: string) => Promise<unknown>;
  confirm?: (request: { title: string }) => Promise<string>;
}) {
  const window = new Window({ url: "https://example.test/" });
  const document = window.document;
  const scopes = {
    a: { id: "scope-a", label: "app", title: "/work/app" },
    b: { id: "scope-b", label: "relay", title: "/work/relay" },
  } satisfies Record<string, Scope>;
  let current = scopes.a;
  let scopeListener: ((scope: Scope) => void) | null = null;
  const reads: Array<{ scopeId: string; relPath: string }> = [];
  const writes: Array<{ scopeId: string; request: Record<string, unknown> }> = [];
  const files: Record<string, Record<string, { text: string; stamp: { mtimeMs: number; size: number }; absPath: string }>> = {
    "scope-a": {
      "notes.md": { text: "one", stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md" },
      "src/a.ts": { text: "a", stamp: { mtimeMs: 1, size: 1 }, absPath: "/work/app/src/a.ts" },
    },
    "scope-b": {
      "notes.md": { text: "other", stamp: { mtimeMs: 1, size: 5 }, absPath: "/work/relay/notes.md" },
    },
  };
  const access = {
    currentScope: async () => current,
    onScopeChanged: (listener: (scope: Scope) => void) => {
      scopeListener = listener;
      return () => { scopeListener = null; };
    },
    list: async (scopeId: string, relPath: string) => {
      if (!relPath) {
        return {
          ok: true,
          entries: [
            { name: "src", kind: "dir", relPath: "src" },
            { name: "notes.md", kind: "file", relPath: "notes.md" },
          ],
          truncated: false,
        };
      }
      return {
        ok: true,
        entries: [{ name: "a.ts", kind: "file", relPath: "src/a.ts" }],
        truncated: false,
      };
    },
    read: async (scopeId: string, relPath: string) => {
      reads.push({ scopeId, relPath });
      if (options?.read) return options.read(scopeId, relPath);
      const file = files[scopeId]?.[relPath];
      return file
        ? { ok: true, kind: relPath.endsWith(".md") ? "markdown" : "text", relPath, ...file }
        : { ok: false, reason: "not found" };
    },
    write: async (scopeId: string, request: Record<string, unknown>) => {
      writes.push({ scopeId, request });
      if (options?.write) return options.write(scopeId, request);
      const text = String(request.text || "");
      return { ok: true, relPath: request.relPath, stamp: { mtimeMs: 2, size: text.length } };
    },
  };
  const panel = createFilePanel({
    access,
    document,
    window,
    mount: { panelHost: document.body, toggleHost: document.body, presentation: "overlay" },
    ui: {
      confirm: options?.confirm || (async () => "discard"),
      renderMarkdown: (source: string) => `<p>${source}</p>`,
    },
  });
  return {
    window,
    document,
    panel,
    access,
    reads,
    writes,
    scopes,
    async switchScope(scope: Scope) {
      current = scope;
      scopeListener?.(scope);
      await settle();
    },
  };
}

function click(window: Window, target: Element | null) {
  expect(target).toBeTruthy();
  target!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function type(window: Window, document: Document, text: string) {
  const editor = document.querySelector(".gfp-editor") as HTMLTextAreaElement | null;
  expect(editor).toBeTruthy();
  editor!.value = text;
  editor!.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function openAndEdit(h: ReturnType<typeof harness>, relPath: string, draft: string) {
  await h.panel.openPath(relPath);
  click(h.window, h.document.querySelector(".gfp-edit"));
  type(h.window, h.document, draft);
}

describe("shared file-panel model", () => {
  it("advances the saved baseline only to the payload that was sent", () => {
    const tab = makeTab("a", {
      relPath: "notes.md",
      kind: "text",
      text: "one",
      stamp: { mtimeMs: 1, size: 3 },
      absPath: "/work/app/notes.md",
    });
    applyDraft(tab, "one two");
    const sent = tab.draftText;
    applyDraft(tab, "one two three");
    applySaveSuccess(tab, sent, { stamp: { mtimeMs: 2, size: 7 } });

    expect(tab.baselineText).toBe("one two");
    expect(tab.draftText).toBe("one two three");
    expect(tab.dirty).toBe(true);
    expect(tab.editing).toBe(true);
  });
});

describe("shared file-panel component", () => {
  it("renders a nested tree and opens multiple tabs in click order", async () => {
    const h = harness();
    h.panel.setOpen(true);
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-row")].find((row) => row.textContent?.includes("src")) || null);
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-row")].find((row) => row.textContent?.includes("a.ts")) || null);
    await settle();
    h.panel.element.querySelector(".gfp-title")?.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    click(h.window, [...h.document.querySelectorAll(".gfp-row")].find((row) => row.textContent?.includes("notes.md")) || null);
    await settle();

    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((node) => node.textContent)).toEqual(["a.ts", "notes.md"]);
  });

  it("keeps drafts in memory by scope and never surfaces one in another project", async () => {
    const h = harness();
    await settle();
    await openAndEdit(h, "notes.md", "draft from app");
    await h.switchScope(h.scopes.b);
    await h.panel.openPath("notes.md", true);
    click(h.window, h.document.querySelector(".gfp-edit"));
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("other");

    await h.switchScope(h.scopes.a);
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft from app");
    expect(h.panel.hasDirty()).toBe(true);
  });

  it("hides without confirming or discarding", async () => {
    let confirms = 0;
    const h = harness({ confirm: async () => { confirms++; return "discard"; } });
    await settle();
    await openAndEdit(h, "notes.md", "draft");
    h.panel.setOpen(false);
    h.panel.setOpen(true);

    expect(confirms).toBe(0);
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft");
  });

  it("keeps keystrokes typed while Save is in flight dirty", async () => {
    const pending = deferred<unknown>();
    const h = harness({ write: async () => pending.promise });
    await settle();
    await openAndEdit(h, "notes.md", "one two");
    click(h.window, h.document.querySelector(".gfp-save"));
    type(h.window, h.document, "one two three");
    pending.resolve({ ok: true, relPath: "notes.md", stamp: { mtimeMs: 2, size: 7 } });
    await settle();

    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("one two three");
    expect(h.document.querySelector(".gfp-tab-dirty")?.textContent).toBe("•");
    expect(h.document.querySelector(".gfp-notice")?.textContent).toContain("typed more");
  });

  it("refreshes a stamp for Overwrite but refuses a different file identity", async () => {
    let reads = 0;
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        return {
          ok: true,
          kind: "text",
          relPath,
          text: reads === 1 ? "one" : "replacement",
          stamp: { mtimeMs: reads, size: reads === 1 ? 3 : 11 },
          absPath: reads === 1 ? "/work/app/notes.md" : "/work/app/other.md",
        };
      },
      write: async () => ({ ok: false, reason: "changed" }),
    });
    await settle();
    await openAndEdit(h, "notes.md", "draft");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((node) => node.textContent === "Overwrite") || null);
    await settle();

    expect(h.writes).toHaveLength(1);
    expect(h.document.querySelector(".gfp-notice")?.textContent).toContain("no longer the one you opened");
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value).toBe("draft");
  });
});
