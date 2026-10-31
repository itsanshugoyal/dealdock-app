/**
 * SpeechProvider — the single seam between DealDock and a speech vendor
 * (docs/research/03-voice-cloning-and-audio.md §6.1). Implementations:
 * ElevenLabsProvider (hosted, first choice), SelfHostedProvider (an
 * OpenAI-compatible server in front of Chatterbox Multilingual) and
 * MockSpeechProvider (dev/demo/tests, refused in production).
 *
 * Privacy: adapters never log audio, transcripts or synthesized text, and
 * their errors carry only an HTTP status plus the vendor's machine code.
 */

export type SpeechProviderKind = "elevenlabs" | "self_hosted" | "mock";

export interface VoiceClip {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface CloneVoiceInput {
  /** Vendor-side label; never the creator's real name. */
  name: string;
  clips: VoiceClip[];
  description?: string;
}

export interface CloneVoiceResult {
  externalVoiceId: string;
  /** The vendor wants extra speaker verification before the voice may be used. */
  requiresVerification: boolean;
}

export interface SynthesizeInput {
  externalVoiceId: string;
  text: string;
  /** BCP-47 primary language ("hi", "en") where the model accepts one. */
  languageHint?: string;
}

/** Always WAV: Instagram accepts aac/m4a/wav/mp4 audio, never MP3 or Opus. */
export interface SynthesizedAudio {
  bytes: Uint8Array;
  mimeType: "audio/wav";
  durationMs: number;
}

export interface TranscribeInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface Transcript {
  text: string;
  /** BCP-47 ("hi", "en"); null when the vendor could not tell. */
  language: string | null;
  durationMs?: number;
}

export interface SpeechProvider {
  readonly kind: SpeechProviderKind;
  cloneVoice(input: CloneVoiceInput): Promise<CloneVoiceResult>;
  /** Idempotent: deleting a voice the vendor no longer has succeeds. */
  deleteVoice(externalVoiceId: string): Promise<void>;
  synthesize(input: SynthesizeInput): Promise<SynthesizedAudio>;
  transcribe(input: TranscribeInput): Promise<Transcript>;
}

export type SpeechErrorKind = "auth" | "quota" | "validation" | "transient";

/**
 * Typed vendor failure so callers can decide (tell the creator, alert ops,
 * try later) without parsing vendor prose. `code` is a snake_case machine
 * code — free text from the vendor is deliberately never copied in.
 */
export class SpeechProviderError extends Error {
  constructor(
    public readonly kind: SpeechErrorKind,
    public readonly code: string,
    public readonly status?: number
  ) {
    super(`speech_${kind}: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "SpeechProviderError";
  }
}

/** A voice the vendor no longer has counts as deleted (revocation is idempotent). */
export function isVoiceGone(error: unknown): boolean {
  return error instanceof SpeechProviderError && (error.status === 404 || /not_found|does_not_exist/.test(error.code));
}
