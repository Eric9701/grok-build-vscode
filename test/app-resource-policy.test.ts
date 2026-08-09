import { describe, expect, it } from "vitest";
import {
  mediaContentTypeForPath,
  parseByteRange,
} from "../src/desktop/app-resource-policy";

describe("app-resource byte-range policy", () => {
  it("accepts open-ended and explicit ranges", () => {
    expect(parseByteRange("bytes=10-", 100)).toEqual({
      kind: "single",
      start: 10,
      end: 99,
    });
    expect(parseByteRange("bytes=10-19", 100)).toEqual({
      kind: "single",
      start: 10,
      end: 19,
    });
    expect(parseByteRange("bytes=10-999", 100)).toEqual({
      kind: "single",
      start: 10,
      end: 99,
    });
  });

  it("accepts suffix ranges, including a suffix larger than the file", () => {
    expect(parseByteRange("bytes=-10", 100)).toEqual({
      kind: "single",
      start: 90,
      end: 99,
    });
    expect(parseByteRange("bytes=-1000", 100)).toEqual({
      kind: "single",
      start: 0,
      end: 99,
    });
  });

  it("reports unsatisfiable ranges with the file size", () => {
    expect(parseByteRange("bytes=100-", 100)).toEqual({
      kind: "unsatisfiable",
      size: 100,
    });
    expect(parseByteRange("bytes=20-10", 100)).toEqual({
      kind: "unsatisfiable",
      size: 100,
    });
    expect(parseByteRange("bytes=-0", 100)).toEqual({
      kind: "unsatisfiable",
      size: 100,
    });
  });

  it("ignores multiple ranges instead of half-building multipart", () => {
    expect(parseByteRange("bytes=0-9,20-29", 100)).toEqual({
      kind: "ignore",
      reason: "multiple",
    });
  });

  it("ignores non-byte units and malformed Range fields", () => {
    expect(parseByteRange("items=0-9", 100)).toEqual({
      kind: "ignore",
      reason: "unit",
    });
    expect(parseByteRange("not-a-range", 100)).toEqual({
      kind: "ignore",
      reason: "unit",
    });
    expect(parseByteRange("bytes=not-a-range", 100)).toEqual({
      kind: "ignore",
      reason: "malformed",
    });
  });

  it("treats a missing range as a full response and handles empty files", () => {
    expect(parseByteRange(undefined, 100)).toEqual({ kind: "none" });
    expect(parseByteRange("", 100)).toEqual({ kind: "none" });
    expect(parseByteRange("bytes=0-", 0)).toEqual({
      kind: "unsatisfiable",
      size: 0,
    });
  });

  it("limits ranged delivery to the known generated-video extensions", () => {
    expect(mediaContentTypeForPath("clip.mp4")).toBe("video/mp4");
    expect(mediaContentTypeForPath("clip.m4v")).toBe("video/mp4");
    expect(mediaContentTypeForPath("clip.mov")).toBe("video/quicktime");
    expect(mediaContentTypeForPath("clip.webm")).toBe("video/webm");
    expect(mediaContentTypeForPath("chat.js")).toBeNull();
    expect(mediaContentTypeForPath("image.png")).toBeNull();
  });
});
