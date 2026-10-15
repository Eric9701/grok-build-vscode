/**
 * Claude Code's native Auto in the mode picker: offered only when the host
 * advertises it (Claude sessions), described as the agent deciding and asking,
 * and never offered by the fallback list an older host gets.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function openModes(h: ReturnType<typeof bootWebview>) {
  const pop = h.doc.getElementById("mode-popover") as HTMLElement;
  if (pop.hidden) click(h.window, h.doc.getElementById("mode-btn")!);
  return pop;
}
const labels = (doc: Document) => [...doc.querySelectorAll("#mode-popover .mode-item-label")].map((el) => el.textContent);
const descs = (doc: Document) => [...doc.querySelectorAll("#mode-popover .mode-item-desc")].map((el) => el.textContent);

describe("native Auto mode in the picker", () => {
  it.each([{}, { remote: true }])("offers Claude's Auto beside Agent, Plan and Auto accept, and posts it (%j)", (surface) => {
    const h = bootWebview(surface);
    dispatch(h.window, { type: "providerState", providers: [{ id: "claude", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "c", provider: "claude", models: [] });
    dispatch(h.window, { type: "modeChanged", modeId: "auto", modes: ["agent", "auto", "plan", "yolo"] });
    expect(h.doc.getElementById("mode-btn")!.textContent).toBe("Auto mode");
    openModes(h);
    expect(labels(h.doc)).toEqual(["Agent mode", "Auto mode", "Plan mode", "Auto accept"]);
    expect(descs(h.doc)[1]).toBe("Claude decides which actions are safe to run and asks you about the rest");
    click(h.window, h.doc.querySelectorAll(".mode-popover-item")[0]);
    expect(h.posted).toContainEqual({ type: "setMode", modeId: "agent" });
  });

  it("never offers Auto to a host that does not advertise its modes", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "claude", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "c", provider: "claude", models: [] });
    dispatch(h.window, { type: "modeChanged", modeId: "agent" });
    openModes(h);
    expect(labels(h.doc)).toEqual(["Agent mode", "Plan mode", "Auto accept"]);
  });
});
