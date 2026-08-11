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
