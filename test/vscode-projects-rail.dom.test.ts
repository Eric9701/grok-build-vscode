/**
 * DOM tests for the VS Code primary-side-bar projects rail (media/projects-rail.js).
 * Separate from test/projects-rail.dom.test.ts, which drives the chat.js rail mount.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const railSrc = read("../media/projects-rail.js");

interface Posted {
  type: string;
  [k: string]: unknown;
}

function bootRail() {
  const posted: Posted[] = [];
  const window = new Window({ url: "https://example.test/" });
  const doc = window.document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (m: Posted) => {
      posted.push(m);
    },
    getState: () => ({}),
    setState: () => {},
  });
  doc.body.innerHTML = `
    <aside id="projects-rail" class="projects-rail" aria-label="Projects">
      <div class="rail-search-wrap">
        <input id="rail-search" class="rail-search" type="search" />
      </div>
      <div id="rail-scroll" class="rail-scroll"></div>
    </aside>
  `;
  window.eval(railSrc);
  return { window, doc, posted };
}

const repos = [
  { cwd: "/work/alpha", label: "alpha", available: true, updatedAt: 30 },
  { cwd: "/work/beta", label: "beta", available: true, updatedAt: 10 },
  { cwd: "/work/gamma", label: "gamma", available: true, updatedAt: 20 },
];

const row = (id: string, cwd: string, name: string) =>
  ({ id, cwd, displayName: name, rawSummary: "", updatedAt: 1, createdAt: 1, numMessages: 2 });

function sectionTitles(doc: Document): string[] {
  return [...doc.querySelectorAll(".rail-head")].map((e) => (e.textContent || "").trim());
}

function repoLabels(doc: Document): string[] {
  return [...doc.querySelectorAll(".rail-repo-label")].map((e) => e.textContent || "");
}

describe("VS Code projects rail renderer", () => {
  let h: ReturnType<typeof bootRail>;

  beforeEach(() => {
    h = bootRail();
  });

  afterEach(() => {
    h.window.close();
  });

  it("posts ready on boot", () => {
    expect(h.posted.some((p) => p.type === "ready")).toBe(true);
  });

  it("renders Current project then Other projects, open folder first", () => {
    const { window, doc } = h;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rail = (window as any).__grokProjectsRail;
    rail.onMessage({
      type: "repos",
      entries: repos,
      selectedCwd: "/work/beta",
      activeCwd: "/work/beta",
    });
    rail.onMessage({
      type: "sessions",
      entries: [row("b1", "/work/beta", "beta chat")],
      activeId: "b1",
      dots: {},
      offset: 0,
      total: 1,
      hasMore: false,
      nextOffset: 1,
      query: "",
    });
    rail.onMessage({
      type: "repoSessions",
      cwd: "/work/alpha",
      entries: [row("a1", "/work/alpha", "alpha chat")],
      dots: {},
      total: 1,
    });
    rail.onMessage({
      type: "repoSessions",
      cwd: "/work/gamma",
      entries: [row("g1", "/work/gamma", "gamma chat")],
      dots: {},
      total: 1,
    });

    expect(sectionTitles(doc)).toEqual(["Current project", "Other projects"]);
    // Current section holds beta; other is name-sorted alpha then gamma.
    const currentList = doc.querySelector(".rail-current");
    const otherList = doc.querySelector(".rail-other");
    expect(currentList?.querySelector(".rail-repo-label")?.textContent).toBe("beta");
    expect(
      [...(otherList?.querySelectorAll(".rail-repo-label") || [])].map((e) => e.textContent),
    ).toEqual(["alpha", "gamma"]);
    expect(repoLabels(doc)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("clicking a conversation in another project posts plain resumeSession only", () => {
    const { window, doc, posted } = h;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rail = (window as any).__grokProjectsRail;
    rail.onMessage({
      type: "repos",
      entries: repos,
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    rail.onMessage({
      type: "sessions",
      entries: [row("a1", "/work/alpha", "here")],
      activeId: "a1",
      dots: {},
      offset: 0,
      total: 1,
      hasMore: false,
      nextOffset: 1,
      query: "",
    });
    rail.onMessage({
      type: "repoSessions",
      cwd: "/work/gamma",
      entries: [row("g1", "/work/gamma", "other chat")],
      dots: {},
      total: 1,
    });

    // Drop the ready + listRepoSessions noise for the assertion.
    posted.length = 0;

    const otherName = [...doc.querySelectorAll(".rail-session-name")].find(
      (e) => e.textContent === "other chat",
    ) as HTMLElement | undefined;
    expect(otherName).toBeTruthy();
    const rowEl = otherName!.closest(".rail-session") as HTMLElement;
    rowEl.click();

    expect(posted).toEqual([
      { type: "resumeSession", id: "g1", cwd: "/work/gamma" },
    ]);
    // No workspace switch, no reload signal.
    expect(posted.some((p) => p.type === "selectRepo")).toBe(false);
  });

  it("requests listRepoSessions for other projects only", () => {
    const { window, posted } = h;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rail = (window as any).__grokProjectsRail;
    rail.onMessage({
      type: "repos",
      entries: repos,
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    const previews = posted.filter((p) => p.type === "listRepoSessions");
    expect(previews.map((p) => p.cwd).sort()).toEqual(["/work/beta", "/work/gamma"]);
    expect(previews.every((p) => p.cwd !== "/work/alpha")).toBe(true);
  });
});
