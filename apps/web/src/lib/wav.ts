import { encodePcm16Wav } from "@dealdock/core";

/**
 * Browser-side WAV encoding for voice samples. MediaRecorder gives webm/ogg;
 * the speaking-voice API takes 16-bit PCM WAV, so recordings are decoded with
 * Web Audio, mixed to mono, resampled and re-encoded here. Pure functions
 * except `recordingToWav`, which needs an AudioContext.
 */

export const WAV_SAMPLE_RATE = 24_000;

/** Linear-interpolation resample of mono samples. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i += 1) {
    const position = i * step;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const t = position - left;
    output[i] = (input[left] ?? 0) * (1 - t) + (input[right] ?? 0) * t;
  }
  return output;
}

/** 16-bit PCM mono WAV container for float samples in [-1, 1] (encodePcm16Wav in @dealdock/core). */
export function encodeWav(samples: Float32Array, sampleRate = WAV_SAMPLE_RATE): Uint8Array {
  return encodePcm16Wav(samples, sampleRate);
}

/** Share of samples at full scale — above ~0.2% the take is clipping and should be re-recorded. */
export function clippingRatio(samples: Float32Array): number {
  if (!samples.length) return 0;
  let clipped = 0;
  for (const value of samples) if (Math.abs(value) >= 0.99) clipped += 1;
  return clipped / samples.length;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export interface EncodedTake { base64: string; mimeType: "audio/wav"; durationMs: number; clipping: number; url: string }

/** Decode a MediaRecorder blob and re-encode it as 24 kHz mono WAV. */
export async function recordingToWav(blob: Blob): Promise<EncodedTake> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / decoded.numberOfChannels;
    }
    const samples = resample(mono, decoded.sampleRate, WAV_SAMPLE_RATE);
    const wav = encodeWav(samples);
    return {
      base64: bytesToBase64(wav),
      mimeType: "audio/wav",
      durationMs: Math.round((samples.length / WAV_SAMPLE_RATE) * 1000),
      clipping: clippingRatio(samples),
      url: URL.createObjectURL(new Blob([wav as BlobPart], { type: "audio/wav" })),
    };
  } finally {
    void context.close();
  }
}
