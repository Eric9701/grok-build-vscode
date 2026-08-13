/**
 * `isMediaGenToolCall` exists twice — the host's in `src/acp-dispatch.ts`, and a
 * copy in `media/webview-helpers.js` so the webview can gate a failure hint
 * without a host rewrite or a new message type.
 *
 * Two copies of the same knowledge drift. When grok learns another media-gen
 * tool name, whoever teaches the host will not necessarily teach the webview,
 * and the failure hint would quietly stop firing — or start firing on something
 * else. Same reason `protocol.test.ts` asserts the two message-type lists are
 * set-equal, and the same remedy: one fixture set, both implementations, equal
 * verdicts, so changing either alone fails here.
 */
import { describe, it, expect } from "vitest";
import { isMediaGenToolCall as hostImpl } from "../src/acp-dispatch";
import { isMediaGenToolCall as webviewImpl } from "../media/webview-helpers.js";

/** Every shape either copy claims to recognise, plus the ones it must not. */
const FIXTURES: ReadonlyArray<{ what: string; payload: unknown }> = [
  // Relabeled titles.
  { what: "imagine", payload: { title: "imagine: a small red cube" } },
  { what: "imagine-video", payload: { title: "imagine-video: the cube rotates" } },
  { what: "imagine-edit", payload: { title: "imagine-edit: give him a rocket" } },
  // Raw tool names.
  { what: "image_gen", payload: { title: "image_gen", rawInput: { prompt: "x" } } },
  { what: "image_edit", payload: { title: "image_edit", rawInput: { prompt: "x" } } },
  { what: "video_gen", payload: { title: "video_gen" } },
  { what: "image_to_video", payload: { title: "image_to_video", rawInput: { duration: 6 } } },
  { what: "reference_to_video", payload: { title: "reference_to_video" } },
  // Legacy relabels.
  { what: "image-to-video:", payload: { title: "image-to-video: x" } },
  { what: "reference-to-video:", payload: { title: "reference-to-video: x" } },
  // Variant-only — the shape that matters most, because a completed or FAILED
  // update commonly arrives with title:null and only rawInput to go on.
  { what: "variant ImageGen, no title", payload: { title: null, rawInput: { variant: "ImageGen" } } },
  { what: "variant VideoGen", payload: { rawInput: { variant: "VideoGen" } } },
  { what: "variant ImageEdit", payload: { rawInput: { variant: "ImageEdit" } } },
  { what: "variant ImageToVideo", payload: { rawInput: { variant: "ImageToVideo" } } },
  { what: "variant ReferenceToVideo", payload: { rawInput: { variant: "ReferenceToVideo" } } },
  // Not media generation.
  { what: "an ordinary edit", payload: { title: "Edit acp.ts" } },
  { what: "a command", payload: { title: "npm test" } },
  { what: "a read", payload: { title: "Read package.json" } },
  { what: "a subagent", payload: { title: "spawn_subagent: audit" } },
  { what: "a title merely containing the word", payload: { title: "Edit imagine.md" } },
  { what: "a variant that is not media", payload: { rawInput: { variant: "Search" } } },
  // Degenerate input — both copies must agree on these too, not merely not throw.
  { what: "null", payload: null },
  { what: "undefined", payload: undefined },
  { what: "a string", payload: "imagine: x" },
  { what: "empty object", payload: {} },
  { what: "title null, no rawInput", payload: { title: null } },
  { what: "rawInput not an object", payload: { rawInput: "ImageGen" } },
  { what: "variant not a string", payload: { rawInput: { variant: 3 } } },
];

describe("isMediaGenToolCall — host and webview copies agree", () => {
  it.each(FIXTURES)("$what", ({ payload }) => {
    expect(webviewImpl(payload)).toBe(hostImpl(payload));
  });

  it("the fixture set actually exercises both verdicts", () => {
    // Without this, deleting every true case would leave the suite passing on a
    // pair of implementations that agree only because both say no to everything.
    const verdicts = FIXTURES.map((f) => hostImpl(f.payload));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it("agrees on the provider-scoped Codex capture without globally matching its title", () => {
    const payload = { kind: "other", title: "Image generation", rawInput: { id: "exec-1" } };
    expect(webviewImpl(payload, "codex")).toBe(true);
    expect(hostImpl(payload, "codex")).toBe(true);
    expect(webviewImpl(payload, "grok")).toBe(false);
    expect(hostImpl(payload, "grok")).toBe(false);
  });
});
