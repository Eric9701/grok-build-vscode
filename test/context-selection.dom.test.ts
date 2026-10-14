import { describe, expect, it, vi } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";
import { GrokSidebar } from "../src/sidebar";
import { Session, sessionUiSnapshot } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { bracketRemoteSnapshot } from "../src/remote-policy";

const selection = { sessionId: "s", modelId: "grok-4.7", generation: 2, sizes: [256000, 500000], defaultSize: 256000, selectedSize: 256000, available: true, changing: false };
function setup(opts: Parameters<typeof bootWebview>[0] = {}) {
  const h = bootWebview(opts);
  dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-4.7", models: [{ modelId: "grok-4.7", name: "Grok 4.7", contextWindowSizes: selection.sizes }] });
  dispatch(h.window, { type: "contextWindowSelection", selection });
  return h;
}
/** The context popup's size dropdown, after opening the popup if it is closed. */
function sizeSelect(h: Harness): HTMLSelectElement {
  if (h.doc.getElementById("context-popover")!.hidden) click(h.window, h.doc.getElementById("donut")!);
  return h.doc.querySelector("#context-popover select.context-window-select") as HTMLSelectElement;
}
function choose(h: Harness, select: HTMLSelectElement, size: number) {
  select.value = String(size);
  select.dispatchEvent(new h.window.Event("change", { bubbles: true }));
}
const popupNotes = (h: Harness) => [...h.doc.querySelectorAll("#context-popover .context-window-control .popover-fineprint")].map((n) => n.textContent);
describe("context-window controls", () => {
  it("updates an already-open popup when a native turn starts and ends", () => {
    const h = setup();
    sizeSelect(h);
    dispatch(h.window, { type: "agentStart" });
    expect(sizeSelect(h).disabled).toBe(true);
    dispatch(h.window, { type: "agentEnd", status: "completed" });
    expect(sizeSelect(h).disabled).toBe(false);
  });

  it("routes a typed command without a busy turn or consuming draft attachments", () => {
    const h = setup();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    dispatch(h.window, { type: "chips", chips: [{ id: "file", kind: "file", relPath: "keep.ts", path: "/keep.ts", hidden: false }] });
    input.value = "/context-window 500k";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    click(h.window, h.doc.getElementById("send-btn")!);
    expect(input.value).toBe("/context-window 500k");
    expect(h.doc.getElementById("attachments")!.textContent).toContain("keep.ts");
    expect(h.posted.at(-1)).toEqual({ type: "send", text: "/context-window 500k", bare: true });
    expect(h.doc.getElementById("send-btn")!.title).not.toContain("Stop");
  });

  it("shows native default and selected size in the context popup's dropdown and preserves the composer", () => {
    const h = setup();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "keep my draft";
    const select = sizeSelect(h);
    expect([...select.options].map((o) => o.textContent)).toEqual(["256K · CLI default", "500K"]);
    expect(select.value).toBe("256000");
    expect(select.classList.contains("settings-select")).toBe(true);
    expect((h.doc.querySelector(`label[for="${select.id}"]`) as HTMLElement).textContent).toBe("Context window");
    // One row: no heading, no option rows, and no standing disclaimer line.
    const popup = h.doc.getElementById("context-popover")!;
    expect(popup.querySelectorAll(".context-window-choice")).toHaveLength(0);
    expect(popup.textContent).not.toContain("Context window · tokens");
    expect(popupNotes(h)).toEqual([]);
    expect(popup.textContent).not.toMatch(/\d,\d{3}/);
    choose(h, select, 500000);
    expect(h.posted.at(-1)).toEqual({ type: "setContextWindow", sessionId: "s", modelId: "grok-4.7", generation: 2, size: 500000 });
    expect(input.value).toBe("keep my draft");
  });
  it.each(["knowledge", "coding"])("puts the dropdown after the occupancy block, not before it (%s)", (purpose) => {
    const h = setup();
    dispatch(h.window, { type: "initialState", appPurpose: purpose });
    dispatch(h.window, { type: "subscriptionUsage", windows: [] });
    dispatch(h.window, { type: "contextUsage", used: 30000, window: 256000, systemPromptTokens: 1000, messageTokens: 29000 });
    sizeSelect(h);
    const children = [...h.doc.getElementById("context-popover")!.children];
    const at = (selector: string) => children.findIndex((el) => el.matches(selector));
    expect(children[0].textContent).toContain("Context used");
    expect(at(".context-window-control")).toBe(at(".context-compact") + 1);
    expect(at(".subscription-usage")).toBeGreaterThan(at(".context-window-control"));
    if (purpose === "coding") expect(children.findIndex((el) => el.textContent === "In this window")).toBeGreaterThan(at(".context-window-control"));
  });
  it("keeps showing the requested size while the host confirms it, then the confirmed one", () => {
    const h = setup();
    choose(h, sizeSelect(h), 500000);
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, generation: 3, changing: true } });
    expect(sizeSelect(h).value).toBe("500000");
    expect(sizeSelect(h).disabled).toBe(true);
    expect(popupNotes(h)).toEqual(["Waiting for native confirmation…"]);
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, generation: 3, selectedSize: 500000 } });
    expect(sizeSelect(h).value).toBe("500000");
    expect(sizeSelect(h).disabled).toBe(false);
    expect(popupNotes(h)).toEqual([]);
  });
  it("puts the confirmed size back when the host refuses or the CLI rejects a choice", () => {
    const h = setup();
    // Refused before the client published `changing`: the host's republish.
    choose(h, sizeSelect(h), 500000);
    dispatch(h.window, { type: "contextWindowSelection", selection });
    expect(sizeSelect(h).value).toBe("256000");
    // Rejected natively after `changing`: the stale, last confirmed selection.
    choose(h, sizeSelect(h), 500000);
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, generation: 3, changing: true } });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, generation: 3, stale: true } });
    expect(sizeSelect(h).value).toBe("256000");
    expect(popupNotes(h)).toEqual(["Last confirmed selection; native state needs a refresh."]);
    // A later change made elsewhere never shows this webview's spent request.
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, generation: 4, changing: true } });
    expect(sizeSelect(h).value).toBe("256000");
  });
  it("keeps the dropdown in place across a rebuild that would draw it identically", () => {
    // A native <select> closes its open list when it leaves the document, and
    // opening the popup itself requests refreshes whose replies rebuild it.
    const h = setup();
    const select = sizeSelect(h);
    dispatch(h.window, { type: "subscriptionUsage", windows: [] });
    dispatch(h.window, { type: "contextUsage", used: 1000, window: 256000 });
    expect(sizeSelect(h)).toBe(select);
    expect(select.isConnected).toBe(true);
    expect(h.doc.getElementById("context-popover")!.textContent).toContain("Subscription usage");
    // Anything it draws differently is a new control.
    dispatch(h.window, { type: "setBusy", value: true });
    expect(sizeSelect(h)).not.toBe(select);
    expect(sizeSelect(h).disabled).toBe(true);
  });
  it("shows the unavailable reason in the popup in place of a dropdown", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, available: false, reason: "CLI update required" } });
    sizeSelect(h);
    expect(h.doc.querySelector("#context-popover select")).toBeNull();
    expect(popupNotes(h)).toEqual(["CLI update required"]);
  });
  it("marks smaller sizes that may compact in the dropdown", () => {
    const h = setup();
    dispatch(h.window, { type: "contextUsage", used: 300000, window: 500000 });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, selectedSize: 500000 } });
    const select = sizeSelect(h);
    expect([...select.options].map((o) => o.textContent)).toEqual(["256K · CLI default · may compact", "500K"]);
    expect(select.value).toBe("500000");
  });
  it("lets no offered size claim to be the window before one is confirmed", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, selectedSize: undefined } });
    const select = sizeSelect(h);
    expect(select.selectedOptions[0].textContent).toBe("—");
    expect(select.selectedOptions[0].disabled).toBe(true);
    expect([...select.options].slice(1).map((o) => o.textContent)).toEqual(["256K · CLI default", "500K"]);
    choose(h, select, 500000);
    expect(h.posted.at(-1)).toMatchObject({ type: "setContextWindow", size: 500000 });
  });
  it("opens the model continuation only after a confirmed host frame and supports keyboard selection", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection, openPicker: true });
    const rows = h.doc.querySelectorAll("#gear-popover .context-window-choice");
    expect(rows).toHaveLength(2);
    // Sizes read the way the meter says them, never as raw token counts.
    expect([...rows].map((r) => r.textContent)).toEqual(["256K · CLI default ✓", "500K"]);
    expect(h.doc.getElementById("gear-popover")!.textContent).not.toMatch(/\d,\d{3}/);
    rows[0].dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(h.doc.activeElement).toBe(rows[1]);
    rows[1].dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(h.posted.at(-1)?.type).toBe("setContextWindow");
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("Continue to reasoning effort");
  });
  it("locks both controls while busy or awaiting confirmation", () => {
    for (const changing of [true, false]) {
      const h = setup();
      if (!changing) dispatch(h.window, { type: "setBusy", value: true });
      dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, changing }, openPicker: true });
      const row = h.doc.querySelector("#gear-popover .context-window-choice")!;
      click(h.window, row);
      expect(row.getAttribute("aria-disabled")).toBe("true");
      const select = sizeSelect(h);
      expect(select.disabled).toBe(true);
      // A change event that reaches a locked control still posts nothing, and
      // the dropdown goes back to the size it was showing.
      choose(h, select, 500000);
      expect(select.value).toBe("256000");
      expect(h.posted.some(m => m.type === "setContextWindow")).toBe(false);
    }
  });
  it("locks the dropdown during initial startup", () => {
    const h = bootWebview({ ready: false });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-4.7", models: [] });
    dispatch(h.window, { type: "contextWindowSelection", selection });
    const select = sizeSelect(h);
    expect(select.disabled).toBe(true);
    choose(h, select, 500000);
    expect(h.posted.some(m => m.type === "setContextWindow")).toBe(false);
  });
  it("rejects a late frame from another session and warns before native compaction", () => {
    const h = setup();
    dispatch(h.window, { type: "contextUsage", used: 300000, window: 500000 });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, selectedSize: 500000 }, openPicker: true });
    expect(h.doc.querySelector(".context-window-choice")!.textContent).toBe("256K · CLI default · may compact");
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, sessionId: "old", sizes: [1, 2] } });
    expect(h.doc.querySelectorAll(".context-window-choice")[1].textContent).toBe("500K ✓");
  });
  it("shows a reason instead of selectable sizes when native support is absent", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, available: false, reason: "CLI update required" }, openPicker: true });
    expect(h.doc.querySelectorAll(".context-window-choice")).toHaveLength(0);
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("CLI update required");
  });
  it("ignores older generations and frames for a model no longer selected", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection, openPicker: true });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, generation: 1, sizes: [1, 2] } });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, modelId: "old-model", generation: 3, sizes: [1, 2] } });
    expect(h.doc.querySelectorAll(".context-window-choice")[1].textContent).toBe("500K");
  });
  it("locks choices during initial startup", () => {
    const h = bootWebview({ ready: false });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-4.7", models: [] });
    dispatch(h.window, { type: "contextWindowSelection", selection, openPicker: true });
    const row = h.doc.querySelector(".context-window-choice")!;
    click(h.window, row);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(h.posted.some(m => m.type === "setContextWindow")).toBe(false);
  });
  it("marks a failed confirmation as stale while keeping the confirmed choice", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, stale: true }, openPicker: true });
    expect(h.doc.querySelector(".context-window-choice.active")!.textContent).toBe("256K · CLI default ✓");
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("native state needs a refresh");
  });
});

describe("dictation during a context-window change", () => {
  const changing = { ...selection, generation: 3, changing: true };
  const sends = (h: Harness) => h.posted.filter((m) => m.type === "send" || m.type === "queueSend" || m.type === "steerSend");
  it("keeps the dictated words in the composer and sends them with the next utterance once the change settles", () => {
    const h = setup();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "Draft:";
    input.setSelectionRange(6, 6);
    dispatch(h.window, { type: "contextWindowSelection", selection: changing });
    dispatch(h.window, { type: "voicePartial", text: "keep these words" });
    dispatch(h.window, { type: "voiceSubmit", text: "keep these words" });
    expect(input.value).toBe("Draft: keep these words");
    expect(sends(h)).toEqual([]);
    dispatch(h.window, { type: "voicePartial", text: "and more" });
    expect(input.value).toBe("Draft: keep these words and more");
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...changing, changing: false, selectedSize: 500000 } });
    dispatch(h.window, { type: "voiceSubmit", text: "and more" });
    expect(sends(h)).toEqual([{ type: "send", text: "Draft: keep these words and more" }]);
    expect(input.value).toBe("");
  });
  it("keeps a phone's send-phrase utterance in the composer", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-4.7", models: [] });
    dispatch(h.window, { type: "contextWindowSelection", selection: changing });
    dispatch(h.window, { type: "voiceSubmit", text: "keep these words" });
    expect((h.doc.getElementById("input") as HTMLTextAreaElement).value).toBe("keep these words");
    expect(sends(h)).toEqual([]);
  });
  it("lets a keyboard correction of the held words survive the next utterance", () => {
    const h = setup();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    dispatch(h.window, { type: "contextWindowSelection", selection: changing });
    dispatch(h.window, { type: "voicePartial", text: "keep these words" });
    dispatch(h.window, { type: "voiceSubmit", text: "keep these words" });
    input.value = "keep those words";
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    dispatch(h.window, { type: "voicePartial", text: "and more" });
    expect(input.value).toBe("keep those words and more");
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...changing, changing: false } });
    dispatch(h.window, { type: "voiceSubmit", text: "and more" });
    expect(sends(h)).toEqual([{ type: "send", text: "keep those words and more" }]);
  });
  it("leaves held words with their conversation when another one is opened with the mic still on", () => {
    const h = setup();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    dispatch(h.window, { type: "sessionName", sessionId: "s", name: "A", cwd: "/repo" });
    dispatch(h.window, { type: "contextWindowSelection", selection: changing });
    dispatch(h.window, { type: "voicePartial", text: "words for A" });
    dispatch(h.window, { type: "voiceSubmit", text: "words for A" });
    expect(input.value).toBe("words for A");
    // focusSession: clear, identity, then the name that swaps the composer draft.
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "session", sessionId: "b", provider: "grok", currentModelId: "grok-4.7", models: [] });
    dispatch(h.window, { type: "sessionName", sessionId: "b", name: "B", cwd: "/repo" });
    expect(input.value).toBe("");
    dispatch(h.window, { type: "voicePartial", text: "words for B" });
    expect(input.value).toBe("words for B");
    dispatch(h.window, { type: "voiceSubmit", text: "words for B" });
    expect(sends(h)).toEqual([{ type: "send", text: "words for B" }]);
    dispatch(h.window, { type: "sessionName", sessionId: "s", name: "A", cwd: "/repo" });
    expect(input.value).toBe("words for A");
  });
});

describe("context-window picker opening is one-shot", () => {
  const gear = (h: Harness) => h.doc.getElementById("gear-popover")!;
  it("opens where the model was changed, but a switch back, reload or phone rebuild only restores the selection", () => {
    const desk = bootWebview(), phone = bootWebview({ remote: true });
    const confirmed = { ...selection, generation: 3, selectedSize: 500000 };
    const session = new Session(); session.cwd = "/repo"; session.provider = "grok";
    session.client = { provider: "grok", currentModelId: "grok-4.7", contextWindowSelection: confirmed } as any;
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.focused = session;
    sidebar.remoteClients = new RemoteClientState("/repo");
    sidebar.remoteClients.ready("phone"); sidebar.remoteClients.setActive("phone", session);
    sidebar.view = { webview: { postMessage: (m: unknown) => dispatch(desk.window, m) } };
    sidebar.localizeHistoryMessage = (m: unknown) => m; sidebar.mirrorToProjectsRail = () => {};
    sidebar.sessionCwd = (s: Session) => s.cwd; sidebar.authorizedSessionCwds = () => ["/repo"];
    sidebar.host = { appendLine: vi.fn() };
    sidebar.sendRemoteClient = (_id: string, m: unknown) => dispatch(phone.window, m);

    sidebar.emit(session, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-4.7", models: [{ modelId: "grok-4.7", name: "Grok 4.7", contextWindowSizes: selection.sizes }] });
    sidebar.emit(session, { type: "modelChanged", modelId: "grok-4.7" });
    sidebar.emit(session, { type: "contextWindowSelection", selection: confirmed, openPicker: true });
    for (const h of [desk, phone]) expect(gear(h).hidden).toBe(false);
    click(desk.window, desk.doc.getElementById("messages")!);
    expect(gear(desk).hidden).toBe(true);

    // focusSession / rehydrateWebviewFromFocused, then focusRemoteSession / a phone reconnect.
    const deskReplay = [{ type: "clearMessages" }, { type: "historyReplay", active: true }, ...session.buffer, { type: "historyReplay", active: false }, ...sessionUiSnapshot(session, "agent")];
    const phoneReplay = [{ type: "clearMessages" }, ...bracketRemoteSnapshot(session.buffer), ...sessionUiSnapshot(session, "agent")];
    const reloaded = bootWebview(), phoneAgain = bootWebview({ remote: true });
    for (const m of deskReplay) { dispatch(desk.window, m); dispatch(reloaded.window, m); }
    for (const m of phoneReplay) dispatch(phoneAgain.window, m);
    for (const h of [desk, reloaded, phoneAgain]) {
      expect(gear(h).hidden).toBe(true);
      click(h.window, h.doc.getElementById("donut")!);
      const select = sizeSelect(h);
      expect(select.value).toBe("500000");
      expect(select.selectedOptions[0].textContent).toBe("500K");
    }
  });
});
