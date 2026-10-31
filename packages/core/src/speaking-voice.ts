/**
 * Speaking voice (the creator's cloned voice for voice-note replies): the
 * recording limits, the consent sentence and the WAV encoding, shared by
 * the in-app recorder and the API's POST /voice/speaking checks.
 * Browser-safe: typed arrays only, no Node or DOM APIs.
 */

export const VOICE_CLIP_LIMITS = {
  /** Each take: the spoken consent (take 1) and the two sample reads. */
  takeMinMs: 5_000,
  takeMaxMs: 60_000,
  /** All three takes together; ElevenLabs instant cloning wants no more than 3 minutes. */
  totalMinMs: 30_000,
  totalMaxMs: 180_000,
  /** "Listen in your voice" preview text. */
  previewMaxChars: 300,
} as const;

/** Take 1, read aloud: the creator's own consent and 18+ attestation (vendor use policy). */
export function consentStatement(handle: string): string {
  return `This is my own voice and I'm 18 or older. I consent to DealDock creating a copy of my voice for @${handle}, to send voice notes that I approve. I can delete it at any time.`;
}

/** The statement must mention consent, voice and 18; the API rejects a recording without them. */
export function acknowledgesVoiceConsent(statement: string): boolean {
  return /\bconsent\b/i.test(statement) && /\bvoice\b/i.test(statement) && /\b18\b/.test(statement);
}

/** 16-bit PCM mono WAV container for float samples in [-1, 1] (out-of-range samples clip). */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return bytes;
}
