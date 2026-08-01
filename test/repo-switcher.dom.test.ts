import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const repos = [
  { cwd: "/work/alpha", label: "alpha", available: true, pinned: true, pinnedAt: 2, updatedAt: 10 },
  { cwd: "/work/beta", label: "beta", available: true, pinned: false, updatedAt: 20 },
  { cwd: "/mnt/offline", label: "offline", available: false, pinned: true, pinnedAt: 1, updatedAt: 0 },
];

describe("repo switcher DOM", () => {
  function ready(selectedCwd = "/work/alpha", activeCwd = "/work/alpha") {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd, activeCwd });
    return h;
  }

  // The chip is remote-only, and even there it waits for the host to prove it
  // speaks `repos`. Both guards matter: the relay serves a client that can be
  // NEWER than the extension someone has installed, and an older host never
  // sends the frame — an unconditional chip would render empty with a menu
  // saying "no repositories", which reads as broken rather than absent.
  it("stays hidden inside VS Code, where the window already is the repo", () => {
    const { doc, window } = bootWebview();
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect((doc.getElementById("repo-btn") as HTMLElement).hidden).toBe(true);
  });

  it("stays hidden on a remote client until the host sends `repos`", () => {
    const { doc, window, posted } = bootWebview({ remote: true });
    const chip = doc.getElementById("repo-btn") as HTMLElement;
    expect(chip.hidden).toBe(true);

    // Clicking the hidden chip must not open an empty menu either.
    click(window, chip);
    expect((doc.getElementById("repo-popover") as HTMLElement).hidden).toBe(true);
    expect(posted).toEqual([]);

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(chip.hidden).toBe(false);
  });

  it("shows the selected repo in the always-visible chip", () => {
    const { doc } = ready();
    expect(doc.querySelector(".repo-chip-label")?.textContent).toBe("alpha");
    expect(doc.getElementById("repo-btn")?.classList.contains("browsing")).toBe(false);
  });

  it("marks browsing-a-different-repo without changing the live session", () => {
    const { doc } = ready("/work/beta", "/work/alpha");
    const chip = doc.getElementById("repo-btn") as HTMLElement;
    expect(chip.classList.contains("browsing")).toBe(true);
    expect(chip.title).toContain("live session is in /work/alpha");
  });

  it("left-anchors the repo menu under the chip on a wide panel", () => {
    const { window, doc } = ready();
    const popover = doc.getElementById("repo-popover") as HTMLElement;
    const chip = doc.getElementById("repo-btn") as HTMLElement;
    const parent = popover.parentElement as HTMLElement;
    (parent as any).getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 600, width: 1000, height: 600 });
    (chip as any).getBoundingClientRect = () =>
      ({ left: 4, right: 300, top: 8, bottom: 30, width: 296, height: 22 });

    click(window, chip);

    expect(popover.style.left).toBe("6px");
    expect(popover.style.right).toBe("auto");
    expect(popover.style.top).toBe("34px");
    expect(popover.style.maxWidth).toBe("360px");
  });

  it("selects an available repo and pins independently", () => {
    const { window, doc, posted } = ready();
    click(window, doc.getElementById("repo-btn")!);
    const rows = doc.querySelectorAll(".repo-row");
    click(window, rows[1].querySelector(".repo-row-main")!);
    expect(posted).toContainEqual({ type: "selectRepo", cwd: "/work/beta" });

    // Reopen, then use beta's pin action. It must not also select the row.
    click(window, doc.getElementById("repo-btn")!);
    posted.length = 0;
    click(window, doc.querySelectorAll(".repo-row")[1].querySelector(".history-action-btn")!);
    expect(posted).toEqual([{ type: "toggleRepoPin", cwd: "/work/beta", pinned: true }]);
  });

  it("disables repository switching while a conversation is loading", () => {
    const { window, doc, posted } = ready();
    const chip = doc.getElementById("repo-btn") as HTMLButtonElement;
    click(window, chip);
    click(window, doc.querySelectorAll(".repo-row")[1].querySelector(".repo-row-main")!);

    expect(posted).toContainEqual({ type: "selectRepo", cwd: "/work/beta" });
    expect(chip.disabled).toBe(true);
    expect(chip.title).toContain("repository switching is disabled");

    dispatch(window, { type: "historyReplay", active: true });
    expect(chip.disabled).toBe(true);
    expect(chip.title).toContain("Loading conversation");

    dispatch(window, { type: "historyReplay", active: false });
    expect(chip.disabled).toBe(false);
  });

  it("keeps missing pinned repos honest and non-selectable", () => {
    const { window, doc, posted } = ready();
    click(window, doc.getElementById("repo-btn")!);
    const offline = doc.querySelectorAll(".repo-row")[2];
    expect(offline.classList.contains("unavailable")).toBe(true);
    expect(offline.textContent).toContain("Unavailable");
    expect((offline.querySelector(".repo-row-main") as HTMLButtonElement).disabled).toBe(true);
    click(window, offline.querySelector(".repo-row-main")!);
    expect(posted.some((m) => m.type === "selectRepo")).toBe(false);
  });
});
