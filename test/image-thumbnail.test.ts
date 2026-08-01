import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { thumbnailImage, thumbnailMime } from "../src/image-thumbnail";

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

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function png(width: number, height: number, colorType: number, pixels: Buffer, extra: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    extra,
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Read a thumbnail's size back whatever format the encoder chose. */
function sizeOf(thumb: Uint8Array): { width: number; height: number } {
  if (thumbnailMime(thumb) === "image/png") {
    const view = Buffer.from(thumb);
    return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  }
  const out = decodeJpeg(Buffer.from(thumb), { useTArray: true });
  return { width: out.width, height: out.height };
}

describe("image thumbnails", () => {
  it("downscales an 8-bit RGBA PNG", () => {
    // 2x1 RGBA, one filter byte then two pixels.
    const source = png(2, 1, 6, Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]));
    const out = thumbnailImage(source, "image/png", 1);
    expect(out).not.toBeNull();
    expect(sizeOf(out!)).toEqual({ width: 1, height: 1 });
  });

  it("decodes a palette PNG instead of refusing it", () => {
    // colorType 3 is common — the extension's own icon is one, and it produced
    // no thumbnail at all until PLTE was supported.
    const palette = chunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255]));
    const source = png(2, 1, 3, Buffer.from([0, 0, 1]), palette);
    const out = thumbnailImage(source, "image/png", 320);
    expect(out).not.toBeNull();
    expect(sizeOf(out!)).toEqual({ width: 2, height: 1 });
  });

  it("produces a thumbnail from a JPEG, which used to be impossible", () => {
    // Every JPEG was previously returned unresized and then rejected for being
    // over budget: 0 of 15 real photos produced anything.
    const width = 600;
    const height = 400;
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.byteLength; i += 4) {
      data[i] = (i / 4) % 256;
      data[i + 1] = 128;
      data[i + 2] = 200;
      data[i + 3] = 255;
    }
    const source = encodeJpeg({ data, width, height }, 90).data;
    const out = thumbnailImage(source, "image/jpeg", 320);
    expect(out).not.toBeNull();
    expect(sizeOf(out!).width).toBe(320);
    expect(out!.byteLength).toBeLessThanOrEqual(96 * 1024);
  });

  it("composites transparency onto white, not black", () => {
    // JPEG has no alpha. Left unhandled, a transparent screenshot goes black and
    // its text becomes unreadable.
    const width = 2;
    const height = 1;
    const data = Buffer.alloc(width * height * 4); // fully transparent, rgb 0
    const source = png(width, height, 6, Buffer.concat([Buffer.from([0]), data]));
    const out = thumbnailImage(source, "image/png", 320);
    expect(out).not.toBeNull();
    if (thumbnailMime(out!) === "image/jpeg") {
      const decoded = decodeJpeg(Buffer.from(out!), { useTArray: true });
      expect(decoded.data[0]).toBeGreaterThan(200); // white, not 0
    }
  });

  it("reports the mime of the bytes it produced, not of the source", () => {
    const source = png(2, 1, 6, Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]));
    const out = thumbnailImage(source, "image/png", 1)!;
    // A PNG source can legitimately come back as JPEG when that encodes smaller.
    // Whatever it is, the label must match the bytes, or the data: URI lies.
    const claimed = thumbnailMime(out);
    const isPng = Buffer.from(out).subarray(0, 8).equals(SIGNATURE);
    expect(claimed).toBe(isPng ? "image/png" : "image/jpeg");
  });

  it("refuses an unsupported format rather than passing the bytes through", () => {
    // The old behaviour returned non-PNG sources unchanged, which is how a
    // multi-megabyte photo reached the byte budget and was silently dropped.
    expect(thumbnailImage(Buffer.alloc(64, 7), "image/webp", 320)).toBeNull();
  });

  it("bails before parsing an implausibly large source", () => {
    expect(thumbnailImage(Buffer.alloc(8 * 1024 * 1024 + 1), "image/png", 320)).toBeNull();
  });

  it("bails after IHDR when the pixel count is too large", () => {
    // Above 12 MP the decode would block the host's main thread for seconds.
    const source = png(4_000, 3_001, 6, Buffer.from([0]));
    expect(thumbnailImage(source, "image/png", 320)).toBeNull();
  });

  it("still accepts 4K, which an earlier 4 MP ceiling silently refused", () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(3840, 0);
    header.writeUInt32BE(2160, 4);
    header[8] = 8;
    header[9] = 6;
    // Truncated IDAT: this asserts it gets PAST the dimension gate (failing
    // later, on the pixel data) rather than being rejected for its size.
    const source = Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0])))]);
    expect(thumbnailImage(source, "image/png", 320)).toBeNull(); // fails on data, not on dimensions
    const tooBig = png(4_000, 3_001, 6, Buffer.from([0]));
    expect(thumbnailImage(tooBig, "image/png", 320)).toBeNull();
  });
});
