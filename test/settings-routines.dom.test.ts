/**
 * The Routines page — the settings surface half of the feature.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1. The collapsed row answers "healthy / when next" without being opened:
 *      it carries the strip and a countdown, and NOT the prompt
 *   2. The strip encodes outcome in class as well as colour, oldest run left
 *   3. A run that opened a session is clickable; a skipped one is not
 *   4. Opening a row reveals the form; the chevron toggles it back
 *   5. The days cadence grows a time control and minutes/hours do not
 *   6. Saving posts the edited draft, not the original values
 *   7. Remove takes two clicks, and the second one says what it does
 *   8. Pause posts the inverse of the current state
 *   9. Clicking a run posts resumeSession with the routine's cwd
 *  10. Opening the category asks the host for the list exactly once
 *  11. The empty state invites rather than announcing emptiness
 *  12. An archived project stays selectable and says so
 *  13. The countdown floors and never claims more time than is left
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settingsSrc = readFileSync(
  fileURLToPath(new URL("../media/settings.js", import.meta.url)),
  "utf8",
);
const settingsCss = readFileSync(
  fileURLToPath(new URL("../media/settings.css", import.meta.url)),
  "utf8",
);

const NOW = Date.UTC(2026, 7, 24, 12, 0);

function routine(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    title: "Morning brief",
    prompt: "Summarise what changed.",
    cwd: "C:/repo",
    provider: "grok",
    model: "grok-4.6",
    cadence: { every: 6, unit: "hours" },
    createdAt: NOW - 3600_000,
    cadenceLabel: "Every 6 hours",
    nextRunAt: NOW + 42 * 60_000,
    projectLabel: "grok-remote",
    // Newest first, as the host sends them. Three DIFFERENT outcomes on
    // purpose: a symmetric fixture cannot tell a reversed strip from a correct
    // one, and the first version of this test could not.
    runs: [
      { routineId: "r1", windowKey: "i2", startedAt: NOW - 1000, outcome: "ran", sessionId: "s-2" },
      { routineId: "r1", windowKey: "i1", startedAt: NOW - 2000, outcome: "skipped", detail: "Skipped — Claude was not connected" },
      { routineId: "r1", windowKey: "i0", startedAt: NOW - 3000, outcome: "failed", detail: "Failed — the agent could not start" },
    ],
    health: { ran: 1, skipped: 1, failed: 1, total: 3 },
    ...over,
  };
}

function boot(snapshotOver: Record<string, unknown> = {}) {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: Record<string, any> }).GrokSettings;
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const posted: Array<Record<string, unknown>> = [];
  api.mount(root, {
    snapshot: api.defaultSnapshot({
      routineProjects: [
        { cwd: "C:/repo", label: "grok-remote" },
        { cwd: "C:/old", label: "notes", archived: true },
      ],
      routineModels: [
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
        { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
      ...snapshotOver,
    }),
    env: api.defaultEnv({ isRemote: false, isDesktop: true, providersKnown: true }),
    standalone: true,
    category: "routines",
    post: (msg: Record<string, unknown>) => posted.push(msg),
  });
  return { api, doc, root, posted, window };
}

function click(el: Element | null): void {
  if (!el) throw new Error("nothing to click");
  (el as HTMLElement).click();
}

describe("the collapsed row", () => {
  it("carries health and a countdown, and not the prompt (req 1)", () => {
    const { root } = boot({ routines: [routine()] });
    const card = root.querySelector(".settings-routine");
    expect(card).toBeTruthy();
    expect(root.querySelector(".settings-routine-name")?.textContent).toContain("Morning brief");
    expect(root.querySelector(".settings-routine-meta")?.textContent).toContain("Every 6 hours");
    expect(root.querySelector(".settings-routine-meta")?.textContent).toContain("grok-remote");
    expect(root.querySelector(".settings-routine-strip")).toBeTruthy();
    expect(root.querySelector(".settings-routine-next")?.textContent).toMatch(/^in \d/);
    // The prompt is what you edit, not what you check.
    expect(root.textContent).not.toContain("Summarise what changed.");
    expect(root.querySelector(".settings-routine-body")).toBeNull();
  });

  it("encodes each outcome in a class, oldest first (req 2)", () => {
    const { root } = boot({ routines: [routine()] });
    const ticks = [...root.querySelectorAll(".settings-routine-tick")];
    expect(ticks).toHaveLength(3);
    // Data arrives newest-first; the strip reads left-to-right in time.
    expect(ticks.map((t) => t.className.split(" ").pop())).toEqual([
      "is-failed", "is-skipped", "is-ran",
    ]);
    expect(root.querySelector(".settings-routine-count")?.textContent).toBe("1/3");
  });

  it("makes only a run with a session clickable (req 3)", () => {
    const { root } = boot({ routines: [routine()] });
    const ticks = [...root.querySelectorAll(".settings-routine-tick")];
    // Oldest (failed) and the skip carry no session; the newest run does.
    expect(ticks[0].getAttribute("data-session")).toBeNull();
    expect(ticks[1].getAttribute("data-session")).toBeNull();
    expect(ticks[2].getAttribute("data-session")).toBe("s-2");
    expect(ticks[1].getAttribute("aria-label")).toContain("Claude was not connected");
  });

  it("says paused instead of a countdown when it is", () => {
    const { root } = boot({ routines: [routine({ paused: true })] });
    expect(root.querySelector(".settings-routine-next")?.textContent).toBe("Paused");
    expect(root.querySelector(".settings-routine")?.className).toContain("is-paused");
  });
});

describe("expanding", () => {
  it("reveals the form and toggles back (req 4)", () => {
    const { root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector(".settings-routine-body")).toBeTruthy();
    expect((root.querySelector('[data-field="prompt"]') as HTMLTextAreaElement).value).toBe(
      "Summarise what changed.",
    );
    expect(root.querySelector(".settings-routine")?.className).toContain("is-open");

    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector(".settings-routine-body")).toBeNull();
  });

  it("grows a time control only on days (req 5)", () => {
    const { root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector('[data-field="at"]')).toBeNull();

    const unit = root.querySelector('[data-field="unit"]') as HTMLSelectElement;
    unit.value = "days";
    unit.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("change", { bubbles: true }));

    const at = root.querySelector('[data-field="at"]') as HTMLInputElement;
    expect(at).toBeTruthy();
    expect(at.type).toBe("time");
  });

  it("lists an archived project as selectable and marked (req 12)", () => {
    const { root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    const options = [...root.querySelectorAll('[data-field="cwd"] option')].map(
      (o) => o.textContent,
    );
    expect(options).toContain("notes (archived)");
  });
});

describe("writing", () => {
  it("posts the edited draft, not the original (req 6)", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));

    const title = root.querySelector('[data-field="title"]') as HTMLInputElement;
    title.value = "Evening brief";
    title.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("input", { bubbles: true }));

    click(root.querySelector(".settings-routine-save"));
    const save = posted.find((m) => m.type === "saveRoutine") as any;
    expect(save).toBeTruthy();
    expect(save.id).toBe("r1");
    expect(save.draft.title).toBe("Evening brief");
    expect(save.draft.prompt).toBe("Summarise what changed.");
    expect(save.draft.cadence).toEqual({ every: 6, unit: "hours" });
  });

  it("sends a time only when the unit is days", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    const unit = root.querySelector('[data-field="unit"]') as HTMLSelectElement;
    unit.value = "days";
    unit.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("change", { bubbles: true }));
    click(root.querySelector(".settings-routine-save"));
    const save = posted.find((m) => m.type === "saveRoutine") as any;
    expect(save.draft.cadence.unit).toBe("days");
    expect(save.draft.cadence.at).toBe("09:00");
  });

  it("takes two clicks to remove, and says so on the second (req 7)", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));

    click(root.querySelector(".settings-routine-remove"));
    expect(posted.some((m) => m.type === "deleteRoutine")).toBe(false);
    expect(root.querySelector(".settings-routine-remove")?.textContent).toBe("Remove for good");

    click(root.querySelector(".settings-routine-remove"));
    expect(posted.find((m) => m.type === "deleteRoutine")).toEqual({
      type: "deleteRoutine",
      id: "r1",
    });
  });

  it("posts the inverse of the current paused state (req 8)", () => {
    const running = boot({ routines: [routine()] });
    click(running.root.querySelector(".settings-routine-toggle"));
    click(running.root.querySelector(".settings-routine-pause"));
    expect(running.posted.find((m) => m.type === "setRoutinePaused")).toEqual({
      type: "setRoutinePaused", id: "r1", paused: true,
    });

    const paused = boot({ routines: [routine({ paused: true })] });
    click(paused.root.querySelector(".settings-routine-toggle"));
    expect(paused.root.querySelector(".settings-routine-pause")?.textContent).toBe("Resume");
    click(paused.root.querySelector(".settings-routine-pause"));
    expect(paused.posted.find((m) => m.type === "setRoutinePaused")).toEqual({
      type: "setRoutinePaused", id: "r1", paused: false,
    });
  });

  it("fires an explicit run", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    click(root.querySelector(".settings-routine-run"));
    expect(posted.find((m) => m.type === "runRoutineNow")).toEqual({
      type: "runRoutineNow", id: "r1",
    });
  });

  it("shows a refusal against the routine it belongs to", () => {
    const { root } = boot({
      routines: [routine()],
      routineError: "Routines run at most once every 15 minutes.",
      routineErrorId: "r1",
    });
    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector(".settings-routine-error")?.textContent).toBe(
      "Routines run at most once every 15 minutes.",
    );
  });
});

describe("opening a run", () => {
  it("posts resumeSession with the routine's project (req 9)", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    click(root.querySelector(".settings-routine-open"));
    expect(posted.find((m) => m.type === "resumeSession")).toEqual({
      type: "resumeSession", id: "s-2", cwd: "C:/repo",
    });
  });

  it("does the same from a tick in the strip", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector('.settings-routine-tick[data-session]'));
    expect(posted.find((m) => m.type === "resumeSession")).toBeTruthy();
  });
});

describe("the page as a whole", () => {
  it("asks the host for the list exactly once (req 10)", () => {
    const { posted, root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    expect(posted.filter((m) => m.type === "listRoutines")).toHaveLength(1);
  });

  it("invites rather than announcing emptiness (req 11)", () => {
    const { root, posted } = boot({ routines: [] });
    const copy = root.querySelector(".settings-routines-empty-copy")?.textContent || "";
    expect(copy).toContain("morning summary");
    expect(copy).toContain("last twenty");
    click(root.querySelector(".settings-routine-new"));
    expect(root.querySelector(".settings-routine.is-new")).toBeTruthy();
    // A brand-new routine defaults to the first project and model rather than
    // to nothing, so the form is savable without touching every field.
    expect((root.querySelector('[data-field="cwd"]') as HTMLSelectElement).value).toBe("C:/repo");
    click(root.querySelector(".settings-routine-save"));
    const save = posted.find((m) => m.type === "saveRoutine") as any;
    expect(save.id).toBeUndefined();
    expect(save.draft.provider).toBe("grok");
  });

  it("says plainly that nothing runs while every window is closed", () => {
    const { root } = boot({ routines: [routine()] });
    expect(root.querySelector(".settings-routines-note")?.textContent).toContain(
      "Nothing runs while they are all closed",
    );
  });
});

describe("the countdown", () => {
  it("floors and never overstates the time left (req 13)", () => {
    const { api } = boot();
    const f = api.formatRoutineCountdown;
    expect(f(0)).toBe("due now");
    expect(f(-5000)).toBe("due now");
    expect(f(59_000)).toBe("in 1m");
    expect(f(42 * 60_000)).toBe("in 42m");
    expect(f(59 * 60_000 + 59_000)).toBe("in 59m");
    expect(f(60 * 60_000)).toBe("in 1h");
    expect(f(6 * 3600_000 + 12 * 60_000)).toBe("in 6h 12m");
    expect(f(23 * 3600_000 + 59 * 60_000)).toBe("in 23h 59m");
    expect(f(24 * 3600_000)).toBe("in 1d");
    expect(f(3 * 24 * 3600_000 + 4 * 3600_000)).toBe("in 3d 4h");
  });

  it("names a skip by its reason and a plain run by its outcome", () => {
    const { api } = boot();
    expect(api.routineRunLabel({ outcome: "ran" })).toBe("Ran");
    expect(api.routineRunLabel({ outcome: "running" })).toBe("Running now");
    expect(api.routineRunLabel({ outcome: "skipped", detail: "Skipped — no model" })).toBe(
      "Skipped — no model",
    );
    expect(api.routineRunLabel({ outcome: "failed" })).toBe("Failed");
  });
});

describe("style pins", () => {
  it("carries run state in shape as well as hue", () => {
    // A greyscale screenshot and a colourblind reader both have to be able to
    // tell these apart, so height and width do the work colour alone cannot.
    expect(settingsCss).toMatch(/\.settings-routine-tick\.is-skipped\s*\{[^}]*height:\s*40%/s);
    expect(settingsCss).toMatch(/\.settings-routine-tick\.is-failed[^{]*\{[^}]*width:\s*5px/s);
    expect(settingsCss).toMatch(/\.settings-routine-tick:last-child\s*\{[^}]*box-shadow/s);
  });

  it("respects reduced motion on the chevron", () => {
    expect(settingsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.settings-routine-chev\s*\{\s*transition:\s*none/s,
    );
  });

  it("gives the row a visible keyboard focus state", () => {
    expect(settingsCss).toMatch(
      /button\.settings-routine-head:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--vscode-focusBorder\)/s,
    );
  });
});
