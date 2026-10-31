import { createHash } from "node:crypto";
import type {
  CloneVoiceInput,
  CloneVoiceResult,
  SpeechProvider,
  SynthesizeInput,
  SynthesizedAudio,
  Transcript,
} from "./provider";
import { toneWav } from "./wav";

/** Placeholder transcript: the mock never pretends to understand speech. */
export const MOCK_TRANSCRIPT = "[voice note]";

/**
 * Deterministic stand-in for local dev, demos and tests: a quiet tone whose
 * length follows the text, fake voice ids, a placeholder transcript. It
 * fabricates audio, so it refuses to exist in production.
 */
export class MockSpeechProvider implements SpeechProvider {
  readonly kind = "mock" as const;

  constructor(env: Record<string, string | undefined> = process.env) {
    if (env.NODE_ENV === "production") throw new Error("mock speech provider is refused in production");
  }

  async cloneVoice(input: CloneVoiceInput): Promise<CloneVoiceResult> {
    const hash = createHash("sha256").update(input.name);
    for (const clip of input.clips) hash.update(clip.bytes);
    return { externalVoiceId: `mock-voice-${hash.digest("hex").slice(0, 16)}`, requiresVerification: false };
  }

  async deleteVoice(_externalVoiceId: string): Promise<void> {}

  async synthesize(input: SynthesizeInput): Promise<SynthesizedAudio> {
    // About natural speaking pace (~60 ms per character), bounded like a real voice note.
    const durationMs = Math.min(60_000, Math.max(500, input.text.trim().length * 60));
    return { bytes: toneWav(durationMs), mimeType: "audio/wav", durationMs };
  }

  async transcribe(): Promise<Transcript> {
    return { text: MOCK_TRANSCRIPT, language: null };
  }
}
