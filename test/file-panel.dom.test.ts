import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Window } from "happy-dom";
// @ts-expect-error Plain-JS webview module intentionally has no TS build step.
import {
  applyDraft,
  applySaveSuccess,
  createFilePanel,
  resolveMarkdownLink,
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
  list?: (scopeId: string, relPath: string) => Promise<unknown>;
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
      if (options?.list) return options.list(scopeId, relPath);
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

  it("stays in edit mode after a save that covered everything", () => {
    // Saving is not "I am done with this file". Dropping to the read view on
    // every successful save threw you out mid-thought and made you click Edit
    // again — for the ordinary habit of saving as you work.
    const tab = makeTab("a", {
      relPath: "notes.md", kind: "text", text: "one",
      stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md",
    });
    applyDraft(tab, "one two");
    applySaveSuccess(tab, "one two", { stamp: { mtimeMs: 2, size: 7 } });

    expect(tab.dirty).toBe(false);
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

  it("reloads a conflicted tab into the scope that owns it after a scope switch", async () => {
    const reload = deferred<unknown>();
    let appReads = 0;
    const h = harness({
      read: async (scopeId, relPath) => {
        if (scopeId === "scope-a") {
          appReads++;
          if (appReads === 2) return reload.promise;
          return {
            ok: true, kind: "markdown", relPath, text: "one",
            stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md",
          };
        }
        return {
          ok: true, kind: "markdown", relPath, text: "other",
          stamp: { mtimeMs: 1, size: 5 }, absPath: "/work/relay/notes.md",
        };
      },
      write: async () => ({ ok: false, reason: "changed" }),
    });
    await settle();
    await openAndEdit(h, "notes.md", "app draft");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")]
      .find((node) => node.textContent === "Reload") || null);

    await h.switchScope(h.scopes.b);
    await h.panel.openPath("notes.md", true);
    // Markdown's modes are a pair: [Preview, Edit source]. The second enters
    // edit mode; the first is already active on open and would be a no-op.
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);
    type(h.window, h.document, "relay draft");
    reload.resolve({
      ok: true, kind: "markdown", relPath: "notes.md", text: "fresh app",
      stamp: { mtimeMs: 2, size: 9 }, absPath: "/work/app/notes.md",
    });
    await settle();

    const relayTab = h.panel._scopes.get("scope-b")?.tabs.get("notes.md");
    expect(relayTab?.scopeId).toBe("scope-b");
    expect(relayTab?.draftText).toBe("relay draft");
    expect(h.panel._scopes.get("scope-a")?.tabs.get("notes.md")?.baselineText).toBe("fresh app");
    await h.switchScope(h.scopes.a);
    expect(h.document.querySelector(".gfp-markdown")?.textContent).toContain("fresh app");
  });

  it("overwrites the latest text typed while the stamp refresh is in flight", async () => {
    const refresh = deferred<unknown>();
    let reads = 0;
    let writes = 0;
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        if (reads === 2) return refresh.promise;
        return {
          ok: true, kind: "markdown", relPath, text: "one",
          stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md",
        };
      },
      write: async (_scopeId, request) => {
        writes++;
        return writes === 1
          ? { ok: false, reason: "changed" }
          : { ok: true, relPath: request.relPath, stamp: { mtimeMs: 3, size: String(request.text).length } };
      },
    });
    await settle();
    await openAndEdit(h, "notes.md", "draft before overwrite");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")]
      .find((node) => node.textContent === "Overwrite") || null);
    type(h.window, h.document, "draft typed during refresh");
    refresh.resolve({
      ok: true, kind: "markdown", relPath: "notes.md", text: "host version",
      stamp: { mtimeMs: 2, size: 12 }, absPath: "/work/app/notes.md",
    });
    await settle();

    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].request.text).toBe("draft typed during refresh");
    expect(h.panel._scopes.get("scope-a")?.tabs.get("notes.md")?.baselineText).toBe("draft typed during refresh");
    // A successful save now leaves you in edit mode, so the surviving text is in
    // the textarea rather than the read-only <pre> this used to look at.
    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement).value)
      .toBe("draft typed during refresh");
  });

  it("renders the cached tree when returning to a previous scope", async () => {
    const h = harness({
      list: async (scopeId) => ({
        ok: true,
        entries: [{
          name: scopeId === "scope-a" ? "app-only.txt" : "relay-only.txt",
          kind: "file",
          relPath: scopeId === "scope-a" ? "app-only.txt" : "relay-only.txt",
        }],
        truncated: false,
      }),
    });
    h.panel.setOpen(true);
    await settle();
    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("app-only.txt");
    await h.switchScope(h.scopes.b);
    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("relay-only.txt");
    await h.switchScope(h.scopes.a);

    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("app-only.txt");
    expect(h.document.querySelector(".gfp-tree")?.textContent).not.toContain("relay-only.txt");
  });

  it("finishes an in-flight tree load when the same scope id is reasserted with a fresh object", async () => {
    const root = deferred<unknown>();
    const h = harness({ list: async () => root.promise });
    h.panel.setOpen(true);
    await settle();
    const sameProject = { ...h.scopes.a };
    const reassigned = h.panel.setScope(sameProject);
    root.resolve({
      ok: true,
      entries: [{ name: "loaded.txt", kind: "file", relPath: "loaded.txt" }],
      truncated: false,
    });
    await reassigned;
    await settle();

    expect(h.document.querySelector(".gfp-tree")?.textContent).toContain("loaded.txt");
    expect(h.document.querySelector(".gfp-tree")?.textContent).not.toContain("Loading");
  });

  it("leaves clean edit mode when Cancel is clicked", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    expect(h.document.querySelector(".gfp-editor")).toBeTruthy();
    click(h.window, h.document.querySelector(".gfp-cancel"));
    await settle();

    expect(h.document.querySelector(".gfp-editor")).toBeNull();
    expect(h.document.querySelector(".gfp-edit")).toBeTruthy();
  });

  it("shows Markdown Preview after source editing has started", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");
    // Markdown's modes are a pair: [Preview, Edit source]. Edit, then back.
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);
    type(h.window, h.document, "preview this draft");
    click(h.window, h.document.querySelectorAll(".gfp-mode")[0]);

    expect(h.document.querySelector(".gfp-editor")).toBeNull();
    expect(h.document.querySelector(".gfp-markdown")?.textContent).toContain("preview this draft");
  });

  it("uses overlay presentation while the responsive dock host is display-none", async () => {
    const window = new Window({ url: "https://example.test/" });
    const document = window.document;
    const panelHost = document.createElement("main");
    const dockHost = document.createElement("aside");
    dockHost.style.display = "none";
    document.body.append(panelHost, dockHost);
    const panel = createFilePanel({
      access: { currentScope: async () => null, list: async () => ({ ok: true, entries: [] }) },
      document,
      window,
      mount: { panelHost, dockHost, presentation: "responsive" },
    });

    panel.setOpen(true);
    await settle();
    expect(panel.element.classList.contains("gfp-overlay")).toBe(true);
    expect(panel.element.parentElement).toBe(panelHost);

    dockHost.style.display = "block";
    window.dispatchEvent(new window.Event("resize"));
    expect(panel.element.classList.contains("gfp-docked")).toBe(true);
    expect(panel.element.parentElement).toBe(dockHost);
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

  it("holds the editor while a Reload is in flight instead of dropping what you type", async () => {
    // Reload replaces the whole tab with the host's version. On a phone that
    // round trip is long enough to type into, and those keystrokes used to
    // vanish without a word when the answer arrived.
    const pending = deferred<unknown>();
    let reads = 0;
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        if (reads === 2) return pending.promise;
        return { ok: true, kind: "text", relPath, text: "one", stamp: { mtimeMs: 1, size: 3 }, absPath: "/work/app/notes.md" };
      },
      write: async () => ({ ok: false, reason: "changed" }),
    });
    await settle();
    await openAndEdit(h, "src/a.ts", "mine");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((n) => n.textContent === "Reload") || null);
    await settle();

    expect((h.document.querySelector(".gfp-editor") as HTMLTextAreaElement)?.readOnly).toBe(true);
    // Reload and Overwrite resolve the same conflict in opposite directions.
    // Running both leaves the panel showing one outcome over a file holding the
    // other, with no warning on close.
    expect(
      [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")]
        .map((n) => (n as HTMLButtonElement).disabled),
    ).toEqual([true, true]);
    pending.resolve({ ok: true, kind: "text", relPath: "src/a.ts", text: "host version", stamp: { mtimeMs: 2, size: 12 }, absPath: "/work/app/src/a.ts" });
    await settle();
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent).toContain("host version");
  });

  it("measures Overwrite's dirtiness against the bytes now on disk", async () => {
    // Overwrite exists because the file moved underneath us, so the version the
    // tab was OPENED at is the one value certain to be stale. Comparing against
    // it meant typing your way back to the opened text during the refresh made
    // the tab read clean, the write was skipped, and the panel then showed the
    // older content as saved while the disk kept the newer bytes.
    let reads = 0;
    const writes: string[] = [];
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        return {
          ok: true, kind: "text", relPath,
          text: reads === 1 ? "opened" : "newer on disk",
          stamp: { mtimeMs: reads, size: 6 }, absPath: "/work/app/src/a.ts",
        };
      },
      write: async (_scopeId, request) => {
        writes.push(String(request.text));
        return { ok: writes.length > 1, reason: "changed", relPath: request.relPath, stamp: { mtimeMs: 9, size: 6 } };
      },
    });
    await settle();
    await openAndEdit(h, "src/a.ts", "mine");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    // Type back to exactly what the tab was opened at, then Overwrite.
    type(h.window, h.document, "opened");
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((n) => n.textContent === "Overwrite") || null);
    await settle();

    expect(writes).toEqual(["mine", "opened"]);
  });

  it("keeps the caret where it was when a save repaints the editor", async () => {
    // renderViewer() rebuilds the textarea, so saving mid-sentence sent the
    // cursor back to position 0 and lost the selection — on every save.
    const h = harness();
    await settle();
    await openAndEdit(h, "src/a.ts", "one two three");
    const editor = h.document.querySelector(".gfp-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(4, 7);
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();

    const after = h.document.querySelector(".gfp-editor") as HTMLTextAreaElement;
    expect(after).toBeTruthy();
    expect([after.selectionStart, after.selectionEnd]).toEqual([4, 7]);
  });

  it("finishes an Overwrite the disk has already satisfied", async () => {
    // If the refresh proves the file already holds exactly this text there is
    // nothing to write — but saveTab refuses a clean tab and returns silently,
    // which left "Refreshing version…" on screen forever.
    let reads = 0;
    const writes: string[] = [];
    const h = harness({
      read: async (_scopeId, relPath) => {
        reads++;
        return {
          ok: true, kind: "text", relPath,
          text: reads === 1 ? "opened" : "mine",
          stamp: { mtimeMs: reads, size: 4 }, absPath: "/work/app/src/a.ts",
        };
      },
      write: async (_scopeId, request) => {
        writes.push(String(request.text));
        return { ok: false, reason: "changed" };
      },
    });
    await settle();
    await openAndEdit(h, "src/a.ts", "mine");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();
    click(h.window, [...h.document.querySelectorAll(".gfp-conflict-actions .gfp-action")].find((n) => n.textContent === "Overwrite") || null);
    await settle();

    expect(writes).toEqual(["mine"]);
    const notice = h.document.querySelector(".gfp-notice")?.textContent || "";
    expect(notice).toContain("Already matches");
    expect(notice).not.toContain("Refreshing");
  });

  it("does not rebuild the visible editor when a background save lands", async () => {
    // renderViewer() recreates the textarea, taking the caret, the selection and
    // any in-progress IME composition with it. A save finishing in another
    // project must not disturb what you are typing here.
    const pending = deferred<unknown>();
    const h = harness({ write: async () => pending.promise });
    await settle();
    await openAndEdit(h, "notes.md", "app draft");
    click(h.window, h.document.querySelector(".gfp-save"));

    await h.switchScope(h.scopes.b);
    await h.panel.openPath("notes.md", true);
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);
    const editorBefore = h.document.querySelector(".gfp-editor");
    pending.resolve({ ok: true, relPath: "notes.md", stamp: { mtimeMs: 2, size: 9 } });
    await settle();

    expect(h.document.querySelector(".gfp-editor")).toBe(editorBefore);
  });

  it("gives Markdown the desktop's two-icon mode pair, with the current one marked", async () => {
    // Markdown had become the only file type with a WORDED toggle while every
    // other text file got a pencil, which is what made the toolbar read as
    // inconsistent. The desktop reference has always shown Preview and Edit
    // source as an icon pair with the active mode marked.
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");

    const modes = [...h.document.querySelectorAll(".gfp-mode")];
    expect(modes.map((m) => m.getAttribute("title"))).toEqual(["Preview", "Edit source"]);
    expect(modes.every((m) => !m.textContent?.trim())).toBe(true);
    expect(modes[0].classList.contains("gfp-active")).toBe(true);
    expect(modes[1].classList.contains("gfp-active")).toBe(false);

    click(h.window, modes[1]);
    await settle();
    const after = [...h.document.querySelectorAll(".gfp-mode")];
    expect(after[1].classList.contains("gfp-active")).toBe(true);
    expect(h.document.querySelector(".gfp-editor")).toBeTruthy();
  });

  it("marks the panel as viewing only while a file is open", async () => {
    // The filter searches the tree, so it is hidden with a file open — by CSS,
    // keyed on this class. The class is the contract worth pinning here.
    const h = harness();
    await settle();
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(false);
    await h.panel.openPath("notes.md");
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(true);
    h.panel.element.querySelector(".gfp-title")?.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(false);
  });

  it("sizes a drag against the shared row, not its own shrink-wrapped column", () => {
    // The relay docks the panel into a `flex: 0 0 auto` host, so that host's
    // width IS the panel's width. Measuring it collapses the computed maximum
    // to the minimum, and one drag strands the panel at 200px with no way to
    // widen it again.
    const window = new Window({ url: "https://example.test/" });
    const document = window.document;
    // happy-dom has no layout engine; these are the only measurements
    // setPanelWidth reads.
    const width = (el: unknown, px: number) => {
      (el as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
        () => ({ width: px });
    };

    const row = document.createElement("div");
    const dock = document.createElement("div");
    row.appendChild(dock);
    document.body.appendChild(row);
    width(row, 1400);
    // The shrink-wrapped column reports only what the panel already occupies.
    width(dock, 200);

    const panel = createFilePanel({
      access: {
        currentScope: async () => null,
        list: async () => ({ ok: true, entries: [], truncated: false }),
        read: async () => ({ ok: false, reason: "none" }),
      },
      document,
      window,
      mount: {
        panelHost: document.body,
        dockHost: dock,
        toggleHost: document.body,
        presentation: "docked",
        widthBasis: row,
      },
      ui: { confirm: async () => "discard", renderMarkdown: (s: string) => s },
    });

    expect(panel.setWidth(520, false)).toBe(520);
  });
});

// Syntax highlighting. The panel reads the highlighter off the global the way a
// browser sets it via <script>; these tests install it explicitly and restore
// it afterwards, so the rest of the file keeps exercising the no-highlighter
// path — which is a real deployment (VS Code ships no panel, and a stale relay
// page can predate the script).
describe("file panel syntax highlighting", () => {
  const require = createRequire(import.meta.url);
  const api = require("../media/syntax-highlight.js");

  beforeEach(() => { (globalThis as any).GrokSyntaxHighlight = api; });
  afterEach(() => { delete (globalThis as any).GrokSyntaxHighlight; });

  const SOURCE = 'const x = "hi"; // note\n';
  const sourceHarness = () => harness({
    read: async (_scopeId: string, relPath: string) => ({
      ok: true,
      kind: "text",
      relPath,
      absPath: `/work/app/${relPath}`,
      text: SOURCE,
      stamp: { mtimeMs: 1, size: SOURCE.length },
    }),
  });

  it("paints tokens in read mode", async () => {
    const h = sourceHarness();
    await settle();
    await h.panel.openPath("src/a.ts");
    const pre = h.document.querySelector(".gfp-viewer-body pre");
    expect(pre).toBeTruthy();
    expect(pre!.querySelector(".hl-kw")?.textContent).toBe("const");
    expect(pre!.querySelector(".hl-str")?.textContent).toBe('"hi"');
    expect(pre!.querySelector(".hl-com")?.textContent).toBe("// note");
  });

  it("shows the same text whether or not it is highlighted", async () => {
    // Colour is the only difference the user should ever see.
    const h = sourceHarness();
    await settle();
    await h.panel.openPath("src/a.ts");
    expect(h.document.querySelector(".gfp-viewer-body pre")!.textContent).toBe(SOURCE);
  });

  it("builds the overlay for a language it knows", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));

    const wrap = h.document.querySelector(".gfp-code-edit");
    expect(wrap).toBeTruthy();
    const editor = wrap!.querySelector(".gfp-editor") as HTMLTextAreaElement;
    const under = wrap!.querySelector(".gfp-code-underlay");
    expect(editor).toBeTruthy();
    expect(under).toBeTruthy();
    // The textarea still holds the real text — the underlay is decoration.
    expect(editor.value).toBe("a");
    expect(under!.getAttribute("aria-hidden")).toBe("true");
    // …and the underlay is BEHIND the textarea in document order, so the
    // textarea takes the clicks.
    expect(wrap!.firstElementChild).toBe(under);
  });

  it("repaints the underlay as you type", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    type(h.window, h.document, 'const x = "hi";');
    await settle();

    const under = h.document.querySelector(".gfp-code-underlay")!;
    expect(under.querySelector(".hl-kw")?.textContent).toBe("const");
    expect(under.textContent).toContain('const x = "hi";');
  });

  it("keeps a trailing newline visible on the underlay", async () => {
    // A textarea draws the empty last line; a <pre> does not, so without a
    // sentinel the two layers drift by one line on almost every real file.
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    type(h.window, h.document, "a\n");
    await settle();

    const under = h.document.querySelector(".gfp-code-underlay")!;
    expect(under.textContent!.endsWith("\n")).toBe(false);
    expect(under.textContent).toBe("a\n ");
  });

  it("never lets file contents become markup", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));
    type(h.window, h.document, '<img src=x onerror="boom()">');
    await settle();

    const under = h.document.querySelector(".gfp-code-underlay")!;
    expect(under.querySelector("img")).toBeNull();
    expect(under.textContent).toContain('<img src=x onerror="boom()">');
  });

  it("degrades to a bare textarea when the highlighter is absent", async () => {
    // The kill switch. Deleting the global must leave exactly the editor this
    // replaced — no wrapper, no transparent text, nothing to misalign.
    delete (globalThis as any).GrokSyntaxHighlight;
    const h = harness();
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-edit"));

    expect(h.document.querySelector(".gfp-code-edit")).toBeNull();
    expect(h.document.querySelector(".gfp-code-underlay")).toBeNull();
    const editor = h.document.querySelector(".gfp-editor") as HTMLTextAreaElement;
    expect(editor).toBeTruthy();
    expect(editor.classList.contains("gfp-editor-overlaid")).toBe(false);
  });

  it("degrades for a file type it has no ruleset for", async () => {
    const h = harness();
    await settle();
    await h.panel.openPath("notes.md");
    // Markdown opens in preview; switch to source editing.
    click(h.window, h.document.querySelectorAll(".gfp-mode")[1]);

    expect(h.document.querySelector(".gfp-code-edit")).toBeNull();
    expect(h.document.querySelector(".gfp-editor")).toBeTruthy();
  });

  it("still sends what the textarea holds, highlighted or not", async () => {
    // The save payload comes off the textarea; the underlay must not touch it.
    const h = harness();
    await settle();
    await openAndEdit(h, "src/a.ts", "const saved = 1;\n");
    click(h.window, h.document.querySelector(".gfp-save"));
    await settle();

    const write = h.writes.at(-1);
    expect(write?.request.text).toBe("const saved = 1;\n");
  });
});

// A relative link in a rendered README points at a file in this workspace, not
// at a URL. Left as a plain <a href> the browser resolves it against the PAGE —
// on a remote client that is the relay, so `_shared/auth.ts` navigated to
// https://<relay>/_shared/auth.ts and the user lost the app.
describe("markdown links open workspace files", () => {
  it("resolves a link against the file it was written in", () => {
    expect(resolveMarkdownLink("docs/README.md", "_shared/auth.ts")).toBe("docs/_shared/auth.ts");
    expect(resolveMarkdownLink("README.md", "_shared/auth.ts")).toBe("_shared/auth.ts");
    expect(resolveMarkdownLink("docs/README.md", "./auth.ts")).toBe("docs/auth.ts");
    expect(resolveMarkdownLink("docs/a/b.md", "../../src/x.ts")).toBe("src/x.ts");
  });

  it("treats a leading slash as the workspace root, not the filesystem root", () => {
    expect(resolveMarkdownLink("docs/deep/x.md", "/src/root.ts")).toBe("src/root.ts");
  });

  it("drops a query or fragment, which a repo link often carries", () => {
    expect(resolveMarkdownLink("docs/README.md", "auth.ts#usage")).toBe("docs/auth.ts");
    expect(resolveMarkdownLink("docs/README.md", "auth.ts?plain=1")).toBe("docs/auth.ts");
  });

  it("decodes percent-escapes so a spaced filename resolves", () => {
    expect(resolveMarkdownLink("docs/README.md", "my%20file.ts")).toBe("docs/my file.ts");
  });

  it("leaves genuinely external links to the browser", () => {
    for (const href of [
      "https://example.com/x",
      "http://example.com/x",
      "mailto:someone@example.com",
      "//cdn.example.com/x",
      "#heading",
      "",
      "   ",
    ]) {
      expect(resolveMarkdownLink("docs/README.md", href), href).toBeNull();
    }
    expect(resolveMarkdownLink("docs/README.md", undefined as any)).toBeNull();
  });

  it("refuses to climb above the workspace root", () => {
    // The host re-checks containment regardless; a link should not be the thing
    // that asks for a path outside the workspace.
    expect(resolveMarkdownLink("README.md", "../escape.ts")).toBeNull();
    expect(resolveMarkdownLink("docs/a.md", "../../../etc/passwd")).toBeNull();
  });

  it("opens the linked file instead of navigating, when clicked", async () => {
    const md = '<a href="_shared/auth.ts">auth</a>';
    const h = harness({
      read: async (_scopeId: string, relPath: string) => ({
        ok: true,
        kind: relPath.endsWith(".md") ? "markdown" : "text",
        relPath,
        absPath: `/work/app/${relPath}`,
        text: md,
        stamp: { mtimeMs: 1, size: md.length },
      }),
    });
    await settle();
    await h.panel.openPath("README.md");
    const link = h.document.querySelector(".gfp-markdown a[href]") as HTMLAnchorElement;
    expect(link).toBeTruthy();

    const event = new h.window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await settle();

    // The browser must not be allowed to follow it…
    expect(event.defaultPrevented).toBe(true);
    // …and the panel must have asked the host for that file.
    expect(h.reads.map((r) => r.relPath)).toContain("_shared/auth.ts");
  });

  it("does not intercept an external link", async () => {
    const md = '<a href="https://example.com/docs">docs</a>';
    const h = harness({
      read: async (_scopeId: string, relPath: string) => ({
        ok: true, kind: "markdown", relPath, absPath: `/work/app/${relPath}`,
        text: md, stamp: { mtimeMs: 1, size: md.length },
      }),
    });
    await settle();
    await h.panel.openPath("README.md");
    const link = h.document.querySelector(".gfp-markdown a[href]") as HTMLAnchorElement;
    const event = new h.window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(h.reads.map((r) => r.relPath)).not.toContain("https://example.com/docs");
  });
});

// A file that cannot be opened used to paint its message OVER THE TREE: no tab,
// so nothing named the file that failed, and the tree's filter box stayed on
// screen above a message about a file you could no longer see.
describe("a file that cannot be opened gets a tab", () => {
  const failing = () => harness({
    read: async (_scopeId: string, relPath: string) =>
      (relPath === "app.bin"
        ? { ok: false, reason: "file type not previewable" }
        : { ok: true, kind: "text", relPath, absPath: `/work/app/${relPath}`, text: "x", stamp: { mtimeMs: 1, size: 1 } }),
  });

  it("names the file in a tab of its own", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((n) => n.textContent))
      .toContain("app.bin");
  });

  it("puts the reason inside the tab, not over the tree", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    const body = h.document.querySelector(".gfp-viewer-body");
    expect(body?.textContent).toContain("file type not previewable");
    // The tree is not what you are looking at any more.
    expect(h.document.querySelector(".gfp-tree")?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the tree's filter box, which searches a tree you are not in", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.panel.element.classList.contains("gfp-viewing")).toBe(true);
  });

  it("offers no Edit for something it could not read", async () => {
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-edit")).toBeNull();
  });

  it("leaves the failed tab behind when you open something that works", async () => {
    // It behaves like any other tab: still there, still named, still closable.
    const h = failing();
    await settle();
    await h.panel.openPath("app.bin");
    await h.panel.openPath("notes.md");
    await settle();
    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((n) => n.textContent))
      .toEqual(["app.bin", "notes.md"]);
  });
});

// The viewer's "More actions" button did nothing at all on the desktop, and did
// it silently: the document-level dismiss handler ran on the BUBBLE phase, so
// the same click that opened the menu reached it and closed the menu again. The
// tree's own more-button had been papered over with stopPropagation, which
// fixes one button and leaves the trap set for the next.
describe("the overflow menu opens from every button that offers it", () => {
  const withOsAccess = () => harness({
    read: async (_scopeId: string, relPath: string) => ({
      ok: true, kind: "text", relPath, absPath: `/work/app/${relPath}`,
      text: "x", stamp: { mtimeMs: 1, size: 1 },
    }),
  });

  it("opens from the viewer's More actions, and survives its own click", async () => {
    const h = withOsAccess();
    (h.access as any).openExternal = async () => ({ ok: true });
    (h.access as any).reveal = async () => ({ ok: true });
    await settle();
    await h.panel.openPath("src/a.ts");

    const more = h.document.querySelector(".gfp-viewer .gfp-more");
    expect(more, "the viewer must offer More actions when the host can open/reveal").toBeTruthy();
    click(h.window, more);
    await settle();

    const menu = h.document.querySelector(".gfp-menu");
    expect(menu, "the menu must still be open after the click that opened it").toBeTruthy();
    expect(menu!.textContent).toContain("Open in default app");
  });

  it("still closes on a click somewhere else", async () => {
    const h = withOsAccess();
    (h.access as any).openExternal = async () => ({ ok: true });
    await settle();
    await h.panel.openPath("src/a.ts");
    click(h.window, h.document.querySelector(".gfp-viewer .gfp-more"));
    await settle();
    expect(h.document.querySelector(".gfp-menu")).toBeTruthy();

    click(h.window, h.document.body);
    await settle();
    expect(h.document.querySelector(".gfp-menu")).toBeNull();
  });
});

// A non-previewable file used to be handed straight to the OS on the desktop,
// so the same click meant different things on different clients: a tab with a
// message in the browser, a silently launched external app on the desktop.
describe("a non-previewable file behaves the same on every client", () => {
  const unopenable = () => harness({
    read: async () => ({ ok: false, reason: "file type not previewable", openExternal: true }),
  });

  it("opens a tab instead of launching an app behind your back", async () => {
    const h = unopenable();
    let launched = 0;
    (h.access as any).openExternal = async () => { launched += 1; return { ok: true }; };
    await settle();
    await h.panel.openPath("app.bin");

    expect(launched, "the OS must not be handed the file uninvited").toBe(0);
    expect([...h.document.querySelectorAll(".gfp-tab-name")].map((n) => n.textContent))
      .toContain("app.bin");
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent)
      .toContain("file type not previewable");
  });

  it("offers the OS route inside that tab, where you can see what it applies to", async () => {
    const h = unopenable();
    let launched: string[] = [];
    (h.access as any).openExternal = async (_s: string, relPath: string) => {
      launched.push(relPath);
      return { ok: true };
    };
    await settle();
    await h.panel.openPath("app.bin");

    const open = h.document.querySelector(".gfp-open-external");
    expect(open, "the desktop must still offer Open in default app").toBeTruthy();
    click(h.window, open);
    await settle();
    expect(launched).toEqual(["app.bin"]);
  });

  it("offers nothing to open with when the host has no OS access", async () => {
    // The browser client: there is no default app to hand it to.
    const h = unopenable();
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-open-external")).toBeNull();
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent)
      .toContain("file type not previewable");
  });
});

// An empty toolbar over an error message is a row of chrome explaining nothing.
describe("the error tab's action row appears only when it has actions", () => {
  const unopenable = (withOs: boolean) => {
    const h = harness({
      read: async () => ({ ok: false, reason: "file type not previewable", openExternal: true }),
    });
    if (withOs) (h.access as any).openExternal = async () => ({ ok: true });
    return h;
  };

  it("drops the bar on a client with nothing to put in it", async () => {
    const h = unopenable(false);
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-viewer-head")).toBeNull();
    expect(h.document.querySelector(".gfp-viewer-body")?.textContent)
      .toContain("file type not previewable");
  });

  it("keeps the bar where the host can still act on the file", async () => {
    const h = unopenable(true);
    await settle();
    await h.panel.openPath("app.bin");
    expect(h.document.querySelector(".gfp-viewer-head")).toBeTruthy();
    expect(h.document.querySelector(".gfp-more")).toBeTruthy();
  });
});
