/**
 * What a signed-out agent looks like in the real webview.
 *
 * Driven through the shipped `media/chat.js` so the assertions are about the
 * rendered popover, not about the intent behind it: the picker must never offer
 * a row that reads as a selectable model for an account that cannot answer, and
 * the Accounts cluster must offer signing in rather than signing out of
 * credentials that are already being refused.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Posted } from "./webview-harness";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const modelBtn = (doc: Document) => doc.querySelector(".model-name-btn") as HTMLButtonElement;
const popoverText = (doc: Document) => doc.getElementById("gear-popover")!.textContent || "";
const items = (doc: Document) => [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")];
const types = (posted: Posted[]) => posted.map((p) => p.type);

function bootSignedOutCodex(opts: { remote?: boolean } = {}) {
  const h = bootWebview({ remote: opts.remote });
  dispatch(h.window, {
    type: "providerState",
    providers: [{ id: "codex", connected: true, needsLogin: true }],
  });
  dispatch(h.window, {
    type: "session",
    sessionId: "s1",
    provider: "codex",
    currentModelId: "gpt-5.6-sol",
    models: [
      // A model remembered from when the account still worked, plus the
      // synthesized default-model placeholder the field report showed. Neither
      // is something this account can honour right now.
      { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { provider: "codex", modelId: "", name: "Codex default", defaultImplied: true },
    ],
  });
  h.posted.length = 0;
  return h;
}

describe("model picker for an agent that needs a sign-in", () => {
  it("replaces its model rows with the sign-in action", () => {
    const h = bootSignedOutCodex();
    click(h.window, $(h.doc, "gear-btn"));
    click(h.window, modelBtn(h.doc));

    expect(popoverText(h.doc)).not.toContain("Codex default");
    expect(popoverText(h.doc)).not.toContain("GPT-5.6 Sol");
    const action = items(h.doc).find((el) => el.textContent?.includes("Sign in to load models"));
    expect(action).toBeDefined();

    click(h.window, action as HTMLElement);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "codex" });
    expect(types(h.posted)).not.toContain("setModel");
  });

  it("keeps a healthy agent's models next to a signed-out one's action", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true, needsLogin: true },
      ],
    });
    dispatch(h.window, {
      type: "session",
      sessionId: "fresh",
      provider: "grok",
      currentModelId: "grok-build",
      models: [
        { provider: "grok", modelId: "grok-build", name: "Grok Build" },
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      ],
    });
    click(h.window, $(h.doc, "gear-btn"));
    click(h.window, modelBtn(h.doc));

    expect(popoverText(h.doc)).toContain("Grok Build");
    expect(popoverText(h.doc)).not.toContain("GPT-5.6 Sol");
    expect([...h.doc.querySelectorAll(".model-provider-heading")].map((el) => el.textContent))
      .toEqual(["Grok", "Codex"]);
    expect(popoverText(h.doc)).toContain("Sign in to load models");
  });

  it("tells a remote where the sign-in has to happen instead of offering a dead button", () => {
    const h = bootSignedOutCodex({ remote: true });
    click(h.window, $(h.doc, "gear-btn"));
    click(h.window, modelBtn(h.doc));

    const action = items(h.doc).find((el) => el.textContent?.includes("Sign in at the desk"));
    expect(action).toBeDefined();
    click(h.window, action as HTMLElement);
    // `runGrokLogin` is host-local; the host would refuse it, so the phone must
    // not send it in the first place.
    expect(types(h.posted)).not.toContain("runGrokLogin");
  });
});

describe("the Accounts cluster for an agent that needs a sign-in", () => {
  it("offers signing in again, not signing out", () => {
    const h = bootSignedOutCodex();
    click(h.window, $(h.doc, "gear-btn"));

    expect(popoverText(h.doc)).toContain("Sign in again");
    expect(popoverText(h.doc)).not.toContain("Sign out");
    const row = items(h.doc).find((el) => el.textContent?.includes("Sign in again")) as HTMLElement;
    click(h.window, row);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "codex" });
    expect(types(h.posted)).not.toContain("logout");
  });

  it("keeps sign-out for a healthy account in Settings, not the gear", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "codex", connected: true }],
    });
    click(h.window, $(h.doc, "gear-btn"));
    expect(popoverText(h.doc)).not.toContain("Sign out");
    const settings = items(h.doc).find((el) =>
      /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()),
    );
    click(h.window, settings!);
    const providers = [...h.doc.querySelectorAll("#settings-overlay .settings-nav-item")]
      .find((el) => (el.textContent || "").trim() === "Providers")!;
    click(h.window, providers);
    expect(h.doc.querySelector('[data-id="providerCodex"]')!.textContent).toContain("Sign out");
    expect(h.doc.querySelector('[data-id="providerCodex"]')!.textContent).not.toContain("Sign in again");
  });
});

describe("remote missing-provider guidance", () => {
  it.each([
    ["missing-cli", "grok"],
    ["missing-codex", "codex"],
  ] as const)("keeps the remote %s screen guidance-only", (state, provider) => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "onboarding", state, platform: "linux", provider });
    const onboarding = $(h.doc, "welcome-onboarding");
    expect(onboarding.textContent).toContain("missing at the desk");
    expect(onboarding.textContent).toContain("refresh this remote view");
    expect(onboarding.querySelector('[data-act="installCodex"]')).toBeNull();
    expect(onboarding.querySelector('[data-act="runInstall"]')).toBeNull();
    expect(onboarding.querySelector('[data-act="retryProvider"]')).toBeNull();
    expect(types(h.posted)).not.toContain("retryProviderSession");
  });
});
