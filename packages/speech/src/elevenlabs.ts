import { audioFilename, readJson, requireHttpBase, vendorFetch } from "./http";
import { normalizeLanguageCode } from "./language";
import {
  SpeechProviderError,
  isVoiceGone,
  type CloneVoiceInput,
  type CloneVoiceResult,
  type SpeechProvider,
  type SynthesizeInput,
  type SynthesizedAudio,
  type TranscribeInput,
  type Transcript,
} from "./provider";
import { pcmToWav, wavDurationMs } from "./wav";

/**
 * ElevenLabs Instant Voice Cloning + TTS + Scribe STT (research 03 §3.1).
 * Professional Voice Cloning is own-voice only, so IVC on DealDock's account
 * with the creator's recorded consent is the viable path. TTS asks for raw
 * 24 kHz PCM (no tier upgrade needed, unlike 44.1 kHz) and wraps it in WAV
 * here, because Instagram rejects ElevenLabs' default MP3.
 */

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const PCM_SAMPLE_RATE = 24_000;
const CLONE_TIMEOUT_MS = 90_000;
const SYNTHESIZE_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const DELETE_TIMEOUT_MS = 15_000;
/** The default model rejects language_code (research 03 §3.1). */
const MODELS_WITHOUT_LANGUAGE_CODE = new Set(["eleven_multilingual_v2"]);

export interface ElevenLabsOptions {
  apiKey: string;
  /** e.g. https://api.in.residency.elevenlabs.io for India data residency. */
  baseUrl?: string;
  ttsModel?: string;
  sttModel?: string;
  fetchImpl?: typeof fetch;
}

export class ElevenLabsProvider implements SpeechProvider {
  readonly kind = "elevenlabs" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly ttsModel: string;
  private readonly sttModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ElevenLabsOptions) {
    if (!opts.apiKey) throw new Error("ElevenLabs API key is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = requireHttpBase(opts.baseUrl || DEFAULT_BASE_URL, false);
    this.ttsModel = opts.ttsModel || "eleven_multilingual_v2";
    this.sttModel = opts.sttModel || "scribe_v2";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async cloneVoice(input: CloneVoiceInput): Promise<CloneVoiceResult> {
    if (!input.clips.length) throw new SpeechProviderError("validation", "no_clips");
    const form = new FormData();
    form.append("name", input.name);
    if (input.description) form.append("description", input.description);
    // In-app takes are recorded without browser noise suppression to keep the
    // natural timbre, so let the vendor isolate the voice from room noise.
    form.append("remove_background_noise", "true");
    for (const clip of input.clips) {
      form.append("files", new Blob([clip.bytes], { type: clip.mimeType }), clip.filename);
    }
    const res = await this.call("/v1/voices/add", { method: "POST", body: form }, CLONE_TIMEOUT_MS);
    const body = await readJson<{ voice_id?: unknown; requires_verification?: unknown }>(res);
    if (typeof body.voice_id !== "string" || !body.voice_id) {
      throw new SpeechProviderError("transient", "missing_voice_id", res.status);
    }
    return { externalVoiceId: body.voice_id, requiresVerification: body.requires_verification === true };
  }

  async deleteVoice(externalVoiceId: string): Promise<void> {
    try {
      await this.call(`/v1/voices/${encodeURIComponent(externalVoiceId)}`, { method: "DELETE" }, DELETE_TIMEOUT_MS);
    } catch (error) {
      if (isVoiceGone(error)) return;
      throw error;
    }
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizedAudio> {
    const text = input.text.trim();
    if (!text) throw new SpeechProviderError("validation", "empty_text");
    const languageCode = input.languageHint && !MODELS_WITHOUT_LANGUAGE_CODE.has(this.ttsModel)
      ? normalizeLanguageCode(input.languageHint)?.split("-")[0]
      : undefined;
    const res = await this.call(
      `/v1/text-to-speech/${encodeURIComponent(input.externalVoiceId)}?output_format=pcm_${PCM_SAMPLE_RATE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: this.ttsModel,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
          ...(languageCode ? { language_code: languageCode } : {}),
        }),
      },
      SYNTHESIZE_TIMEOUT_MS
    );
    const pcm = new Uint8Array(await res.arrayBuffer());
    if (pcm.length < 2) throw new SpeechProviderError("transient", "empty_audio", res.status);
    const bytes = pcmToWav(pcm, PCM_SAMPLE_RATE);
    return { bytes, mimeType: "audio/wav", durationMs: wavDurationMs(bytes) ?? 0 };
  }

  async transcribe(input: TranscribeInput): Promise<Transcript> {
    const form = new FormData();
    form.append("model_id", this.sttModel);
    // Omit language_code so Scribe auto-detects Hindi/English/Hinglish; drop "(laughs)" tags.
    form.append("tag_audio_events", "false");
    form.append("file", new Blob([input.bytes], { type: input.mimeType }), audioFilename("voice-note", input.mimeType));
    const res = await this.call("/v1/speech-to-text", { method: "POST", body: form }, TRANSCRIBE_TIMEOUT_MS);
    const body = await readJson<{ text?: unknown; language_code?: unknown; words?: Array<{ end?: unknown }> }>(res);
    const lastEnd = Array.isArray(body.words)
      ? Math.max(0, ...body.words.map((word) => (typeof word?.end === "number" ? word.end : 0)))
      : 0;
    return {
      text: typeof body.text === "string" ? body.text.trim() : "",
      // Scribe answers in ISO 639-3 ("hin"); store BCP-47 ("hi").
      language: normalizeLanguageCode(body.language_code),
      ...(lastEnd > 0 ? { durationMs: Math.round(lastEnd * 1000) } : {}),
    };
  }

  private call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return vendorFetch(
      this.fetchImpl,
      `${this.baseUrl}${path}`,
      { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "xi-api-key": this.apiKey } },
      timeoutMs
    );
  }
}
