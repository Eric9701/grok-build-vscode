// A send the host QUEUES instead of running used to render twice: once as the
// optimistic placeholder bubble, once as the queued block.
//
// The placeholder exists because over a relay the host's `userMessage` echo is a
// second or two away, and the composer has already cleared — without it the send
// reads as lost. It is retired by that echo. But a send that arrives while a
// turn is in flight is DIVERTED into the host-owned queue, which emits no
// `userMessage` at all: the collapse of several contributions into one string
// means the queue cannot carry a submission id to acknowledge with (see
// divertRacingSend). So nothing ever retired the placeholder and the same text
// sat on screen twice, one copy of it inert.
//
// The queue snapshot IS the host's answer to that submission, so it retires the
// placeholder — and the queued block is the better rendering anyway, since it
// carries Steer, edit and cancel.
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

// A queued block is also `.msg.user`, so sent bubbles have to exclude it — and
// the bubble carries a timestamp, so read the body rather than the whole node.
const bubbles = (doc: Document) =>
  [...doc.querySelectorAll(".msg.user:not(.queued) .body")].map((e) => (e.textContent || "").trim());
const queuedBlocks = (doc: Document) =>
  [...doc.querySelectorAll(".msg.queued .queued-text")].map((e) => e.textContent);

/** Type into the composer and send, the way a person does. */
function send(window: any, doc: Document, text: string): void {
  const input = doc.getElementById("input") as HTMLTextAreaElement;
  input.value = text;
  (doc.getElementById("send-btn") as HTMLElement).click();
}

describe("a queued send does not leave its optimistic placeholder behind", () => {
  it("retires the placeholder when the host reports the text queued", () => {
    const { window, doc, posted } = bootWebview({ remote: true });
    // Idle as far as this tab knows — which is exactly the case that produced
    // the duplicate: the host thought otherwise and queued the send.
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "Hey");
    expect(posted.some((p) => p.type === "send")).toBe(true);
    expect(bubbles(doc)).toEqual(["Hey"]); // the placeholder

    // The host diverted it into the queue instead of running it.
    dispatch(window, { type: "queuedSends", items: ["Hey"] });

    expect(queuedBlocks(doc)).toEqual(["Hey"]);
    expect(bubbles(doc)).toEqual([]); // and only once, as a queued block
  });

  // The dangerous false positive, because acknowledging also clears the pending
  // submission id — and that id is what the "Not sent" recovery block needs if
  // the relay later bounces the real send. A wrong acknowledgement here does not
  // just leave a stale bubble, it can lose the text.
  it("is not fooled by a queued message that merely contains the pending text", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "fix");
    dispatch(window, { type: "queuedSends", items: ["prefix fixup please"] });

    expect(bubbles(doc)).toEqual(["fix"]);
  });

  // The queue joins contributions with a blank line AND a message may contain
  // blank lines, so a joined string cannot say where one contribution ends:
  // "prefix\n\nfix\n\nup" as a single message is indistinguishable from a queue
  // holding "fix" on its own. Matching is exact-only for that reason, and the
  // two cases below are the two sides of that decision.
  it("is not fooled by a blank line inside somebody else's message", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "fix");
    dispatch(window, { type: "queuedSends", items: ["prefix\n\nfix\n\nup"] });

    expect(bubbles(doc)).toEqual(["fix"]);
  });

  it("accepts the cost: a queue already holding text leaves the placeholder", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    // Our text was appended to an existing contribution, so it is no longer its
    // own entry and cannot be recognised. A stale placeholder until the next
    // refresh is cosmetic; retiring a submission still in flight would not be.
    send(window, doc, "Hey");
    dispatch(window, { type: "queuedSends", items: ["from the desk\n\nHey"] });

    expect(bubbles(doc)).toEqual(["Hey"]);
  });

  // Retiring the placeholder must not retire the RECOVERY. A queue snapshot is
  // not proof the relay accepted the send — only the host's own echo is — so the
  // pending submission has to survive, or a bounced send loses its text.
  it("keeps the Not-sent recovery available after retiring the placeholder", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "Hey");
    dispatch(window, { type: "queuedSends", items: ["Hey"] });
    expect(bubbles(doc)).toEqual([]);

    // The relay bounces it after all: the text must come back, not vanish.
    dispatch(window, { type: "queuedSends", items: [] });
    dispatch(window, { type: "error", text: "Slow down — at most 20 messages per minute." });
    expect(queuedBlocks(doc)).toEqual(["Hey"]);
  });

  it("leaves an unrelated queue snapshot alone", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "Hey");
    // Someone else's queued text says nothing about our submission, so the
    // placeholder must stay until its own answer arrives.
    dispatch(window, { type: "queuedSends", items: ["something else entirely"] });

    expect(bubbles(doc)).toEqual(["Hey"]);
  });

  // The whole point of keeping the pending submission alive. A dying process
  // takes the host's queue with it — so the queued block vanishes, and the
  // placeholder had already been retired by the queue that is now gone. Without
  // this the text is simply lost: never sent, and no longer on screen either.
  it("gives the text back when the process dies before flushing the queue", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "Hey");
    dispatch(window, { type: "queuedSends", items: ["Hey"] });
    expect(bubbles(doc)).toEqual([]);
    expect(queuedBlocks(doc)).toEqual(["Hey"]);

    // The CLI crashes. The host's order matters and is asserted here: it emits
    // `exit` FIRST and empties the queue immediately after, so the exit handler
    // still sees the queue it has to rescue.
    dispatch(window, { type: "exit", code: 1 });
    dispatch(window, { type: "queuedSends", items: [] });

    expect(queuedBlocks(doc)).toEqual(["Hey"]);
  });

  // The queue collapses contributions into one string and flushes them under a
  // combined text with no submission id, so a tab cannot recognise its own
  // message coming back. Rebuilding it as "Not sent" would invite sending it
  // twice — which is why the exit handler reads the queue rather than the
  // pending submission: by then the queue is empty, because it was delivered.
  it("does not resurrect a contribution that was merged and then sent", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "Hey");
    dispatch(window, { type: "queuedSends", items: ["Hey"] });
    // Another view adds to the same queue entry.
    dispatch(window, { type: "queuedSends", items: ["Hey\n\nand this"] });
    // The turn ends and the host flushes the pair as one submission.
    dispatch(window, { type: "userMessage", text: "Hey\n\nand this" });
    dispatch(window, { type: "queuedSends", items: [] });

    dispatch(window, { type: "exit", code: 1 });

    expect(queuedBlocks(doc)).toEqual([]);
  });

  // The other side of that recovery: once the user has taken the text back, it
  // is theirs and must not come back a second time. Removing a queued message
  // and then losing the process would otherwise resurrect the thing you had
  // just deleted; editing one would hand you a copy of what is already in the
  // composer.
  it("does not resurrect text the user removed from the queue", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "Hey");
    dispatch(window, { type: "queuedSends", items: ["Hey"] });
    // The X on the queued block.
    const remove = doc.querySelectorAll(".msg.queued .queued-action")[1] as HTMLElement;
    remove.dispatchEvent(new (window as any).PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    dispatch(window, { type: "queuedSends", items: [] });

    dispatch(window, { type: "exit", code: 1 });

    expect(queuedBlocks(doc)).toEqual([]);
    expect(bubbles(doc)).toEqual([]);
  });

  // The queue is SESSION-wide; a pending submission belongs to one tab. Acting
  // on somebody else's queued text — or losing the process while it sits there
  // — must not discard this tab's own in-flight send, which is the only thing a
  // relay rejection can rebuild the message from.
  it("keeps this tab's in-flight send when the queue holds someone else's text", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    // Another view's contribution is already queued when this tab sends.
    dispatch(window, { type: "queuedSends", items: ["from the desk"] });
    send(window, doc, "mine");
    expect(bubbles(doc)).toEqual(["mine"]);

    // Removing THEIR queued block says nothing about MY submission.
    const remove = doc.querySelectorAll(".msg.queued .queued-action")[1] as HTMLElement;
    remove.dispatchEvent(new (window as any).PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    dispatch(window, { type: "queuedSends", items: [] });

    // …so the relay bouncing it can still give the text back.
    dispatch(window, { type: "error", text: "Slow down — at most 20 messages per minute." });
    expect(queuedBlocks(doc)).toEqual(["mine"]);
  });

  it("still lets the ordinary echo retire it when the send is not queued", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "setBusy", value: false });

    send(window, doc, "Hey");
    const sent = (doc.getElementById("input") as HTMLTextAreaElement).value;
    expect(sent).toBe(""); // composer cleared on send

    // The host ran it: the authoritative echo replaces the placeholder, and the
    // count must not double here either.
    dispatch(window, { type: "userMessage", text: "Hey" });
    expect(bubbles(doc)).toEqual(["Hey"]);
  });
});
