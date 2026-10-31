import { describe, expect, it } from "vitest";
import { isWav, normalizeWav, parseWav, pcmToWav, toneWav, validateVoiceClip, wavDurationMs } from "../src/index";

/** 16-bit mono PCM where every sample has the given value. */
function constantPcm(seconds: number, value: number, sampleRate = 16_000): Uint8Array {
  const pcm = new Uint8Array(Math.round(seconds * sampleRate) * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 2; i += 1) view.setInt16(i * 2, value, true);
  return pcm;
}

describe("pcmToWav / parseWav", () => {
  it("wraps PCM in a canonical header whose duration matches the frames", () => {
    const wav = pcmToWav(new Uint8Array(24_000 * 2 * 3), 24_000);
    expect(isWav(wav)).toBe(true);
    expect(wav.length).toBe(44 + 144_000);
    expect(parseWav(wav)).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 24_000, bitsPerSample: 16, dataOffset: 44 });
    expect(wavDurationMs(wav)).toBe(3_000);
  });

  it("drops a trailing partial frame instead of writing a corrupt data chunk", () => {
    const wav = pcmToWav(new Uint8Array(101), 16_000);
    expect(parseWav(wav)?.dataLength).toBe(100);
  });

  it("skips unknown chunks (with RIFF word padding) before the data chunk", () => {
    const base = pcmToWav(new Uint8Array(32_000), 16_000);
    const list = new Uint8Array([...Buffer.from("LIST"), 3, 0, 0, 0, 1, 2, 3, 0]); // odd size + pad byte
    const withList = new Uint8Array([...base.subarray(0, 36), ...list, ...base.subarray(36)]);
    expect(parseWav(withList)).toMatchObject({ dataOffset: 44 + list.length, durationMs: 1_000 });
  });

  it("trusts the bytes present when a streaming encoder left the data size unset", () => {
    const wav = pcmToWav(new Uint8Array(32_000), 16_000);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(wavDurationMs(wav)).toBe(1_000);
    const fixed = normalizeWav(wav);
    expect(new DataView(fixed.buffer).getUint32(40, true)).toBe(32_000);
  });

  it("resolves WAVE_FORMAT_EXTENSIBLE to its PCM sub-format", () => {
    const wav = pcmToWav(new Uint8Array(32_000), 16_000);
    const fmt = new Uint8Array(48);
    const view = new DataView(fmt.buffer);
    fmt.set(Buffer.from("fmt "), 0);
    view.setUint32(4, 40, true);
    view.setUint16(8, 0xfffe, true);
    view.setUint16(10, 1, true);
    view.setUint32(12, 16_000, true);
    view.setUint32(16, 32_000, true);
    view.setUint16(20, 2, true);
    view.setUint16(22, 16, true);
    view.setUint16(32, 1, true); // sub-format GUID starts with 0x0001 (PCM)
    const extensible = new Uint8Array([...wav.subarray(0, 12), ...fmt, ...wav.subarray(36)]);
    expect(parseWav(extensible)).toMatchObject({ audioFormat: 1, durationMs: 1_000 });
  });

  it("rejects non-WAV and truncated input", () => {
    expect(parseWav(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseWav(Buffer.from("RIFF\0\0\0\0WAVEdata\0\0\0\0"))).toBeNull(); // data before fmt
    expect(() => normalizeWav(new Uint8Array(10))).toThrow("not_a_wav");
  });

  it("makes a deterministic tone of the requested length", () => {
    expect(wavDurationMs(toneWav(1_500))).toBe(1_500);
    expect(toneWav(800)).toEqual(toneWav(800));
  });
});

describe("validateVoiceClip", () => {
  it("accepts a clean 16-bit take within bounds", () => {
    const result = validateVoiceClip(toneWav(6_000));
    expect(result.ok).toBe(true);
  });

  it("enforces duration bounds", () => {
    expect(validateVoiceClip(toneWav(4_000))).toEqual({ ok: false, problem: "too_short" });
    expect(validateVoiceClip(toneWav(8_000), { maxMs: 7_000 })).toEqual({ ok: false, problem: "too_long" });
  });

  it("flags a dead microphone and heavy clipping", () => {
    expect(validateVoiceClip(pcmToWav(constantPcm(6, 10), 16_000))).toEqual({ ok: false, problem: "silent" });
    expect(validateVoiceClip(pcmToWav(constantPcm(6, 32767), 16_000))).toEqual({ ok: false, problem: "clipped" });
  });

  it("rejects unsupported sample rates and encodings", () => {
    expect(validateVoiceClip(pcmToWav(constantPcm(6, 5000, 8_000), 8_000))).toEqual({ ok: false, problem: "unsupported_sample_rate" });
    expect(validateVoiceClip(pcmToWav(new Uint8Array(16_000 * 6), 16_000, 1, 8))).toEqual({ ok: false, problem: "unsupported_encoding" });
    expect(validateVoiceClip(new Uint8Array(100))).toEqual({ ok: false, problem: "not_wav" });
  });
});
