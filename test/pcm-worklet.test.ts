import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("pcm AudioWorklet", () => {
  it("downsamples browser audio to 16 kHz signed PCM16", () => {
    let Processor: any;
    const posted: unknown[] = [];
    class FakeAudioWorkletProcessor {
      port = {
        onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
        postMessage: (message: unknown) => posted.push(message),
      };
    }
    const context = vm.createContext({
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
      Int16Array,
      Math,
      sampleRate: 48_000,
      registerProcessor: (_name: string, ctor: any) => { Processor = ctor; },
    });
    vm.runInContext(readFileSync("media/pcm-worklet.js", "utf8"), context);
    const processor = new Processor();

    processor.process([[new Float32Array(480).fill(0.5)]]);
    processor.port.onmessage({ data: "flush" });

    expect(posted).toHaveLength(2);
    const pcm = new Int16Array(posted[0] as ArrayBuffer);
    expect(pcm).toHaveLength(160);
    expect([...pcm]).toEqual(new Array(160).fill(16_384));
    expect(posted[1]).toEqual({ type: "flushed" });
  });
});
