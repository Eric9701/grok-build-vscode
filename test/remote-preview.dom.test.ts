import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

describe("remote preview registration", () => {
  it("uses the remote token format and stores data before chips render", () => {
    const { window, doc } = bootWebview({ remote: true });
    const previewId = (window as any).grokRegisterRemoteImagePreview("data:image/jpeg;base64,AAAA");
    expect(previewId).toMatch(/^[A-Za-z0-9_-]{20,128}$/);
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:remote:1:1",
        path: "/remote/photo.jpg",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        previewId,
      }],
    });
    expect(doc.querySelector(".attachment-preview img")?.getAttribute("src"))
      .toBe("data:image/jpeg;base64,AAAA");
  });
});
