import { describe, expect, it } from "vitest";
import { clippingRatio, encodeWav, resample } from "../src/lib/wav";

describe("wav encoding for voice samples", () => {
  it("writes a valid 16-bit mono PCM header and payload", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = encodeWav(samples, 24_000);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getInt16(44 + 3 * 2, true)).toBe(0x7fff);
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-0x8000);
  });

  it("resamples by length and keeps endpoints", () => {
    const input = new Float32Array(48_000).map((_, i) => i / 48_000);
    const output = resample(input, 48_000, 24_000);
    expect(output.length).toBe(24_000);
    expect(output[0]).toBe(0);
    expect(resample(input, 24_000, 24_000)).toBe(input);
  });

  it("measures clipping", () => {
    expect(clippingRatio(new Float32Array([0.1, 0.995, -1, 0.2]))).toBe(0.5);
    expect(clippingRatio(new Float32Array())).toBe(0);
  });
});
