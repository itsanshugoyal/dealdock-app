/**
 * RIFF/WAVE helpers. Instagram accepts WAV voice notes (not MP3/Opus), so
 * vendor PCM is wrapped here, self-hosted output gets a clean header, and
 * in-app recordings are checked before any byte reaches a speech vendor.
 */

export const WAVE_FORMAT_PCM = 1;
export const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export interface WavInfo {
  /** 1 = PCM, 3 = IEEE float (EXTENSIBLE resolved to its sub-format). */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationMs: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

/** Parse the fmt + data chunks; null for anything that is not a playable WAV. */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (!isWav(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Omit<WavInfo, "dataOffset" | "dataLength" | "durationMs"> | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      let audioFormat = view.getUint16(body, true);
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= bytes.length) {
        audioFormat = view.getUint16(body + 24, true); // first two bytes of the sub-format GUID
      }
      fmt = {
        audioFormat,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt || !fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample || fmt.bitsPerSample % 8) return null;
      const remaining = bytes.length - body;
      // Streaming encoders write 0 or 0xFFFFFFFF; trust the bytes actually present.
      const declared = size === 0 || size === 0xffffffff ? remaining : size;
      const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
      const dataLength = Math.min(declared, remaining) - (Math.min(declared, remaining) % blockAlign);
      return {
        ...fmt,
        dataOffset: body,
        dataLength,
        durationMs: Math.round((dataLength / (fmt.sampleRate * blockAlign)) * 1000),
      };
    }
    offset = body + size + (size % 2); // RIFF chunks are word-aligned
  }
  return null;
}

export function wavDurationMs(bytes: Uint8Array): number | null {
  return parseWav(bytes)?.durationMs ?? null;
}

/** Wrap little-endian PCM frames in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8;
  const frames = pcm.subarray(0, pcm.length - (pcm.length % blockAlign)); // whole frames only
  const out = new Uint8Array(44 + frames.length);
  const view = new DataView(out.buffer);
  const tag = (offset: number, value: string) => out.set([...value].map((c) => c.charCodeAt(0)), offset);
  tag(0, "RIFF");
  view.setUint32(4, 36 + frames.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  tag(36, "data");
  view.setUint32(40, frames.length, true);
  out.set(frames, 44);
  return out;
}

/** Re-wrap PCM data under a correct header (servers that stream WAV leave the sizes wrong). */
export function normalizeWav(bytes: Uint8Array): Uint8Array {
  const info = parseWav(bytes);
  if (!info) throw new Error("not_a_wav");
  if (info.audioFormat !== WAVE_FORMAT_PCM) return bytes;
  return pcmToWav(bytes.subarray(info.dataOffset, info.dataOffset + info.dataLength), info.sampleRate, info.channels, info.bitsPerSample);
}

/** A quiet sine tone: deterministic stand-in audio for the mock provider and fixtures. */
export function toneWav(durationMs: number, sampleRate = 16_000, frequencyHz = 440): Uint8Array {
  const samples = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * 0.2 * 32767), true);
  }
  return pcmToWav(pcm, sampleRate);
}

export type VoiceClipProblem =
  | "not_wav"
  | "unsupported_encoding"
  | "unsupported_sample_rate"
  | "too_short"
  | "too_long"
  | "silent"
  | "clipped";

export interface VoiceClipBounds {
  minMs?: number;
  maxMs?: number;
}

/**
 * Server-side gate for in-app recordings (one take): mono/stereo PCM or
 * float WAV at 16–48 kHz within the duration bounds. 16-bit PCM is also
 * checked for a dead microphone and for heavy clipping (> 1% of samples at
 * full scale), both of which make a clone sound wrong.
 */
export function validateVoiceClip(
  bytes: Uint8Array,
  { minMs = 5_000, maxMs = 60_000 }: VoiceClipBounds = {}
): { ok: true; info: WavInfo } | { ok: false; problem: VoiceClipProblem } {
  const info = parseWav(bytes);
  if (!info) return { ok: false, problem: "not_wav" };
  const pcm = info.audioFormat === WAVE_FORMAT_PCM && [16, 24].includes(info.bitsPerSample);
  const float = info.audioFormat === WAVE_FORMAT_FLOAT && info.bitsPerSample === 32;
  if ((!pcm && !float) || info.channels < 1 || info.channels > 2) return { ok: false, problem: "unsupported_encoding" };
  if (info.sampleRate < 16_000 || info.sampleRate > 48_000) return { ok: false, problem: "unsupported_sample_rate" };
  if (info.durationMs < minMs) return { ok: false, problem: "too_short" };
  if (info.durationMs > maxMs) return { ok: false, problem: "too_long" };
  if (info.audioFormat === WAVE_FORMAT_PCM && info.bitsPerSample === 16) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + info.dataOffset, info.dataLength);
    const count = info.dataLength / 2;
    let peak = 0;
    let clipped = 0;
    for (let i = 0; i < count; i += 1) {
      const sample = Math.abs(view.getInt16(i * 2, true));
      if (sample > peak) peak = sample;
      if (sample >= 32767) clipped += 1;
    }
    if (peak < 330) return { ok: false, problem: "silent" }; // below about -40 dBFS throughout
    if (clipped / count > 0.01) return { ok: false, problem: "clipped" };
  }
  return { ok: true, info };
}
