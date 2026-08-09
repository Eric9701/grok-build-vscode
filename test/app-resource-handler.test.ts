import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAppResourceHandler } from "../src/desktop/app-resource-handler";

describe("app-resource handler", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("streams a ranged media slice with the required response headers", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resource-handler-"));
    const clip = path.join(tmp, "clip.mp4");
    fs.writeFileSync(clip, "0123456789");
    const handler = createAppResourceHandler({
      resolveResourceUrl: () => clip,
      fetchFile: async () => new Response("should not fetch"),
    });

    const request = {
      url: "app-resource://vsc-resource/clip.mp4",
      headers: { Range: "bytes=2-5" },
    };
    const response = await handler(request, request.url);
    expect(response.status).toBe(206);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(await response.text()).toBe("2345");
  });

  it("advertises ranges on a full media response and returns 416 only when needed", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resource-handler-"));
    const clip = path.join(tmp, "clip.mp4");
    fs.writeFileSync(clip, "0123456789");
    const handler = createAppResourceHandler({
      resolveResourceUrl: () => clip,
      fetchFile: async () => new Response("should not fetch"),
    });

    const url = "app-resource://vsc-resource/clip.mp4";
    const full = await handler({ url }, url);
    expect(full.status).toBe(200);
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(full.headers.get("Content-Length")).toBe("10");
    expect(await full.text()).toBe("0123456789");

    const unsatisfiableRequest = {
      url: "app-resource://vsc-resource/clip.mp4",
      headers: { range: "bytes=10-" },
    };
    const unsatisfiable = await handler(unsatisfiableRequest, unsatisfiableRequest.url);
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("Content-Range")).toBe("bytes */10");

    const multipleRequest = {
      url: "app-resource://vsc-resource/clip.mp4",
      headers: { range: "bytes=0-1,4-5" },
    };
    const multiple = await handler(multipleRequest, multipleRequest.url);
    expect(multiple.status).toBe(200);
    expect(multiple.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await multiple.text()).toBe("0123456789");

    const ignoredUnitRequest = {
      url: "app-resource://vsc-resource/clip.mp4",
      headers: { range: "items=0-1" },
    };
    const ignoredUnit = await handler(ignoredUnitRequest, ignoredUnitRequest.url);
    expect(ignoredUnit.status).toBe(200);
    expect(await ignoredUnit.text()).toBe("0123456789");

    const malformedRequest = {
      url: "app-resource://vsc-resource/clip.mp4",
      headers: { range: "bytes=not-a-range" },
    };
    const malformed = await handler(malformedRequest, malformedRequest.url);
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("0123456789");
  });

  it("resolves before Range and preserves net.fetch for non-media files", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resource-handler-"));
    const css = path.join(tmp, "chat.css");
    fs.writeFileSync(css, "body{}");
    const calls: string[] = [];
    const handler = createAppResourceHandler({
      resolveResourceUrl: (url) => {
        calls.push(`resolve:${url}`);
        return css;
      },
      fetchFile: async (url) => {
        calls.push(`fetch:${url}`);
        return new Response("chromium file response", { status: 200 });
      },
    });

    const request = {
      url: "app-resource://vsc-resource/chat.css",
      headers: { range: "bytes=1-2" },
    };
    const response = await handler(request, request.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chromium file response");
    expect(calls[0]).toBe("resolve:app-resource://vsc-resource/chat.css");
    expect(calls[1]).toMatch(/^fetch:file:\/\//);
    expect(calls).toHaveLength(2);
  });

  it("does not inspect or fetch a blocked resource", async () => {
    const calls: string[] = [];
    const handler = createAppResourceHandler({
      resolveResourceUrl: (url) => {
        calls.push(`resolve:${url}`);
        return null;
      },
      fetchFile: async () => {
        calls.push("fetch");
        return new Response("unexpected");
      },
    });

    const request = {
      url: "app-resource://vsc-resource/secret.mp4",
      headers: { range: "bytes=0-1" },
    };
    const response = await handler(request, request.url);
    expect(response.status).toBe(403);
    expect(calls).toEqual(["resolve:app-resource://vsc-resource/secret.mp4"]);
  });
});
