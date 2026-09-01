// "Done" must mean usable from the surface that asked.
//
// The owner cloned a PRIVATE repository onto a cloud machine from his phone.
// It cloned, it appeared in the rail, and then the file explorer was empty and
// New Session did nothing visible. Two symptoms that look unrelated and are
// one cause: `cloneProject` registered the project with the HOST and never
// touched the requesting tab's own selected repository, so the tab stayed on
// the project it started from — and both the explorer and New Session follow
// the TAB's repository, not the host's.
//
// The same shape was in `createProject`, unreported only because nobody had
// tried it from a browser yet.
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = new Session();
  sidebar.remoteClients = new RemoteClientState<Session>("/projects/first");
  sidebar.postProjectSetup = vi.fn();
  sidebar.addProjectFolder = vi.fn(async () => {});
  sidebar.selectRemoteRepo = vi.fn(async () => {});
  return sidebar;
}

describe("a clone enters the project for the tab that asked", () => {
  it("binds the requesting remote client to the newly cloned project", async () => {
    const sidebar = makeSidebar();

    await sidebar.enterProjectForRequester("/projects/editor", "remote", "client-1");

    expect(sidebar.selectRemoteRepo).toHaveBeenCalledWith("client-1", "/projects/editor");
  });

  it("does nothing extra at the desk, where activating the folder IS the job", async () => {
    const sidebar = makeSidebar();

    await sidebar.enterProjectForRequester("/projects/editor", "local");

    expect(sidebar.selectRemoteRepo).not.toHaveBeenCalled();
  });

  it("does nothing for a remote with no client id to bind", async () => {
    const sidebar = makeSidebar();

    await sidebar.enterProjectForRequester("/projects/editor", "remote", undefined);

    expect(sidebar.selectRemoteRepo).not.toHaveBeenCalled();
  });
});

describe("both ways of adding a project enter it", () => {
  /**
   * A source check, deliberately. The behaviour above is unit-tested through
   * the helper; what this pins is that BOTH callers actually call it, which is
   * the part that was missing and the part a refactor would drop silently.
   * `createProject` had the identical defect and was found only by reading it
   * beside the reported one.
   */
  it("clone and create both bind the requester before reporting done", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../src/sidebar.ts", import.meta.url)), "utf8");

    // Look only BETWEEN each `addProjectFolder(dest)` and the `done: true` that
    // follows it. Splitting on `done: true` alone passes trivially, because the
    // first segment contains the helper's own definition — which is exactly how
    // this check failed to catch a deleted caller the first time it was written.
    const ADD = "await this.addProjectFolder(dest);";
    const DONE = "this.postProjectSetup({ done: true });";
    const starts: number[] = [];
    for (let i = src.indexOf(ADD); i !== -1; i = src.indexOf(ADD, i + 1)) starts.push(i);
    expect(starts.length).toBe(2); // clone and create

    for (const start of starts) {
      const done = src.indexOf(DONE, start);
      expect(done).toBeGreaterThan(start);
      const between = src.slice(start, done);
      expect(between).toContain("enterProjectForRequester");
    }
  });
});
