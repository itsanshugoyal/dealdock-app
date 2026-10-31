import { describe, expect, it } from "vitest";
import { VOICE_CLIP_LIMITS, acknowledgesVoiceConsent, consentStatement, encodePcm16Wav } from "../src/speaking-voice";

describe("speaking voice consent", () => {
  it("names the account and passes the API's consent check", () => {
    const statement = consentStatement("diya.makes");
    expect(statement).toContain("@diya.makes");
    expect(statement).toContain("18 or older");
    expect(acknowledgesVoiceConsent(statement)).toBe(true);
  });

  it("needs consent, voice and 18 as whole words", () => {
    expect(acknowledgesVoiceConsent("I consent to a copy of my voice and I am 18.")).toBe(true);
    expect(acknowledgesVoiceConsent("I CONSENT to cloning my VOICE, age 18")).toBe(true);
    expect(acknowledgesVoiceConsent("I consent to a copy of my voice.")).toBe(false);
    expect(acknowledgesVoiceConsent("I consent to a copy, I am 18.")).toBe(false);
    expect(acknowledgesVoiceConsent("My voice, I am 18.")).toBe(false);
    expect(acknowledgesVoiceConsent("I consented to my voices at 180.")).toBe(false);
  });
});

describe("voice clip limits", () => {
  it("match the API's recording bounds", () => {
    expect(VOICE_CLIP_LIMITS).toEqual({ takeMinMs: 5_000, takeMaxMs: 60_000, totalMinMs: 30_000, totalMaxMs: 180_000, previewMaxChars: 300 });
  });
});

describe("PCM16 WAV encoding", () => {
  it("writes a valid 16-bit mono PCM header and payload", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = encodePcm16Wav(samples, 24_000);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
    expect(bytes.length).toBe(44 + samples.length * 2);
    expect(text(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000); // byte rate
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(44 + 3 * 2, true)).toBe(0x7fff);
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-0x8000);
  });

  it("clips out-of-range samples instead of wrapping", () => {
    const view = new DataView(encodePcm16Wav(new Float32Array([2, -3]), 16_000).buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });

  it("encodes silence as a bare header", () => {
    expect(encodePcm16Wav(new Float32Array(), 24_000)).toHaveLength(44);
  });
});
