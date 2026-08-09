/**
 * VS Code projects rail registration + pure section partition.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GROK_PROJECTS_VIEW_ID, PRIMARY_CONTAINER_ID } from "../src/view-move";
import { partitionRailRepos, sameRepoCwd } from "../src/projects-rail";

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
