/**
 * VS Code projects rail registration + pure section partition.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GROK_PROJECTS_VIEW_ID, PRIMARY_CONTAINER_ID } from "../src/view-move";
import {
  partitionRailRepos,
  sameRepoCwd,
  collectRecentSessions,
  RAIL_RECENT_CAP,
} from "../src/projects-rail";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("projects rail view registration", () => {
  it("registers grok.projects under the primary side bar container", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      contributes: {
        viewsContainers: { activitybar: { id: string }[] };
        views: Record<string, { id: string; type: string; name: string }[]>;
      };
    };
    // Container id without the workbench.view.extension. prefix.
    expect(pkg.contributes.viewsContainers.activitybar.some((c) => c.id === "grokPrimary")).toBe(
      true,
    );
    expect(PRIMARY_CONTAINER_ID).toBe("workbench.view.extension.grokPrimary");

    const primary = pkg.contributes.views.grokPrimary;
    expect(primary).toBeDefined();
    const projects = primary.find((v) => v.id === "grok.projects");
    expect(projects).toEqual({
      type: "webview",
      id: "grok.projects",
      name: "Projects",
    });
    expect(GROK_PROJECTS_VIEW_ID).toBe("grok.projects");

    // Chat stays in the secondary container — rail is alongside, not inside.
    const chat = pkg.contributes.views.grokSidebar?.find((v) => v.id === "grok.chat");
    expect(chat).toBeDefined();
    expect(primary.some((v) => v.id === "grok.chat")).toBe(false);
  });

  it("extension registers the projects view provider", () => {
    const src = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    expect(src).toMatch(/GROK_PROJECTS_VIEW_ID/);
    expect(src).toMatch(/resolveProjectsRailView/);
  });
});

describe("partitionRailRepos", () => {
  const repos = [
    { cwd: "/work/zebra", label: "zebra", updatedAt: 90 },
    { cwd: "/work/alpha", label: "alpha", updatedAt: 10 },
    { cwd: "/work/beta", label: "beta", updatedAt: 50 },
  ];

  it("lifts the open folder into current and sorts the rest by name", () => {
    const { current, other } = partitionRailRepos(repos, "/work/beta");
    expect(current?.cwd).toBe("/work/beta");
    expect(other.map((r) => r.label)).toEqual(["alpha", "zebra"]);
  });

  it("treats Windows-style paths as equal for the current match", () => {
    expect(sameRepoCwd("C:\\GitHub\\app", "c:/GitHub/app")).toBe(true);
    const { current } = partitionRailRepos(
      [{ cwd: "C:\\GitHub\\app", label: "app" }],
      "c:/GitHub/app",
    );
    expect(current?.label).toBe("app");
  });

  it("leaves current undefined when the open folder is not in the catalog", () => {
    const { current, other } = partitionRailRepos(repos, "/work/missing");
    expect(current).toBeUndefined();
    expect(other).toHaveLength(3);
  });
});

describe("collectRecentSessions", () => {
  const s = (id: string, updatedAt: number, cwd = "/work/a") =>
    ({ id, cwd, displayName: id, updatedAt });

  it("merges across lists, newest first, ids unique", () => {
    const out = collectRecentSessions(
      [
        [s("a1", 10), s("a2", 30)],
        [s("b1", 20), s("a1", 50)], // a1 again, fresher stamp wins the map write order then sort
      ],
      [s("p1", 5)],
    );
    expect(out.map((r) => r.id)).toEqual(["a1", "a2", "b1", "p1"]);
  });

  it("includes pinned rows even when they are not in any project list", () => {
    const out = collectRecentSessions([[s("a1", 10)]], [{ id: "pin", cwd: "/w", updatedAt: 99, pinnedAt: 1 }]);
    expect(out.map((r) => r.id)).toEqual(["pin", "a1"]);
  });

  it("caps at RAIL_RECENT_CAP (10), not the per-project preview depth", () => {
    expect(RAIL_RECENT_CAP).toBe(10);
    const many = Array.from({ length: 25 }, (_, i) => s(`s${i}`, 100 - i));
    const out = collectRecentSessions([many]);
    expect(out).toHaveLength(10);
    expect(out[0].id).toBe("s0");
    expect(out[9].id).toBe("s9");
  });

  it("the renderer's own copy of the cap agrees with this one", () => {
    // The webview renderer is plain JS loaded into a view — it cannot import
    // this constant, so the number is duplicated there. A comment saying "keep
    // in lockstep" is not a guard; changing one side and not the other would
    // otherwise ship a rail that caps differently from what this file asserts.
    const railJs = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "projects-rail.js"),
      "utf8",
    );
    const declared = railJs.match(/const\s+RECENT_CAP\s*=\s*(\d+)/);
    expect(declared, "media/projects-rail.js must declare RECENT_CAP").toBeTruthy();
    expect(Number(declared![1])).toBe(RAIL_RECENT_CAP);
  });

  it("prefers the pinned record when the same id appears in both", () => {
    const out = collectRecentSessions(
      [[{ id: "x", cwd: "/a", displayName: "plain", updatedAt: 10 }]],
      [{ id: "x", cwd: "/a", displayName: "pinned", updatedAt: 10, pinnedAt: 5 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].pinnedAt).toBe(5);
    expect(out[0].displayName).toBe("pinned");
  });
});
