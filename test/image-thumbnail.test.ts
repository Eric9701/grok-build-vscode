import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { thumbnailImage } from "../src/image-thumbnail";

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type), Buffer.from(data)]);
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  body.copy(out, 4);
  // The thumbnailer validates pixels; this fixture only needs a structurally
  // valid CRC because the decoder does not inspect the input CRC.
  out.writeUInt32BE(0, 8 + data.byteLength);
  return out;
}

describe("image thumbnails", () => {
  it("downscales an 8-bit RGBA PNG without an image package", () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const source = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]))),
      chunk("IEND", new Uint8Array()),
    ]);
    const out = thumbnailImage(source, "image/png", 1);
    expect(out).not.toBeNull();
    expect(Buffer.from(out!).readUInt32BE(16)).toBe(1);
    expect(Buffer.from(out!).readUInt32BE(20)).toBe(1);
  });

  it("bails before parsing an implausibly large PNG source", () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
    expect(thumbnailImage(oversized, "image/png", 320)).toBeNull();
  });

  it("bails after IHDR when the pixel count is too large", () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2_001, 0);
    header.writeUInt32BE(2_000, 4);
    header[8] = 8;
    header[9] = 6;
    const source = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0]))),
    ]);
    expect(thumbnailImage(source, "image/png", 320)).toBeNull();
  });
});
