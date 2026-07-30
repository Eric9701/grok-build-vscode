import { describe, expect, it } from "vitest";
import {
  RemotePcmIngress,
  acceptRemotePcm,
  decodePcmBase64,
} from "../src/remote-voice";

describe("RemotePcmIngress", () => {
  it("buffers chunks during the hands-free restart gap and drains them once ready", () => {
    const ingress = new RemotePcmIngress(8, 32, 120_000, () => {});
    expect(ingress.ready()).toEqual([]);
    expect(ingress.restarting()).toBe(true);
    expect(ingress.restarting()).toBe(false);
    expect(ingress.accept("AQACAA==")).toEqual({ kind: "buffered" });
    expect(ingress.ready()).toEqual([Buffer.from([1, 0, 2, 0])]);
    expect(ingress.accept("AwAEAA==")).toEqual({
      kind: "write",
      bytes: Buffer.from([3, 0, 4, 0]),
    });
    ingress.close();
  });

  it("enforces the host-side cumulative byte cap and rejects unowned chunks", () => {
    const ingress = new RemotePcmIngress(8, 6, 120_000, () => {});
    ingress.ready();
    expect(acceptRemotePcm(undefined, "AQACAA==")).toEqual({ kind: "unowned" });
    expect(acceptRemotePcm(ingress, "AQACAA==").kind).toBe("write");
    expect(acceptRemotePcm(ingress, "AwAEAA==")).toEqual({ kind: "limit" });
    ingress.close();
  });

  it("owns the 120-second host timeout and cancels it on close", () => {
    let fire: (() => void) | undefined;
    let cancelled = false;
    const schedule = (fn: () => void, ms: number) => {
      expect(ms).toBe(120_000);
      fire = fn;
      return 7 as unknown as ReturnType<typeof setTimeout>;
    };
    const ingress = new RemotePcmIngress(
      8,
      32,
      120_000,
      () => { cancelled = true; },
      schedule,
      () => { fire = undefined; },
    );
    fire?.();
    expect(cancelled).toBe(true);
    ingress.close();
    expect(fire).toBeUndefined();
  });
});

describe("decodePcmBase64", () => {
  it("accepts even PCM16 bytes and rejects malformed, odd, or oversized chunks", () => {
    expect([...decodePcmBase64("AQACAA==", 8)!]).toEqual([1, 0, 2, 0]);
    expect(decodePcmBase64("AQI", 8)).toBeNull();
    expect(decodePcmBase64("AQI=", 8)).not.toBeNull();
    expect(decodePcmBase64("AQ==", 8)).toBeNull();
    expect(decodePcmBase64("AQACAA==", 2)).toBeNull();
  });
});
