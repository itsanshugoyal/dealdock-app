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
import { normalizeWav, parseWav } from "./wav";

/**
 * Self-hosted speech behind an OpenAI-compatible server (research 03 §2,
 * phase D). Built for travisvn/chatterbox-tts-api in front of Resemble AI's
 * MIT-licensed Chatterbox Multilingual: POST /v1/audio/speech with
 * response_format "wav", and a voice library upload (multipart voice_name +
 * voice_file). Hindi/Hinglish creators need the server to load the
 * ResembleAI/Chatterbox-Multilingual-hi language-pack checkpoint — the base
 * V3 model's Hindi is unconfirmed (research 03, verification pass). Chatterbox
 * watermarks every clip (PerTh); never post-process the audio to strip it.
 *
 * Voice upload is not part of OpenAI's API, so its path is configurable
 * (SELF_HOSTED_SPEECH_VOICE_UPLOAD_PATH, default /v1/voices; DELETE goes to
 * <path>/<voice>). Transcription expects an OpenAI-compatible
 * /v1/audio/transcriptions route (e.g. a faster-whisper server) behind the
 * same base URL. Keep the server on a private network (one wrapper shipped a
 * path-traversal bug).
 */

const SYNTHESIZE_TIMEOUT_MS = 120_000; // scale-to-zero GPUs add a cold start
const CLONE_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const DELETE_TIMEOUT_MS = 15_000;

export interface SelfHostedOptions {
  baseUrl: string;
  apiKey?: string;
  voiceUploadPath?: string;
  ttsModel?: string;
  sttModel?: string;
  fetchImpl?: typeof fetch;
}

export class SelfHostedProvider implements SpeechProvider {
  readonly kind = "self_hosted" as const;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly voicePath: string;
  private readonly ttsModel: string;
  private readonly sttModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SelfHostedOptions) {
    // Plain http is allowed: the server is expected on a private network.
    this.baseUrl = requireHttpBase(opts.baseUrl, true);
    this.apiKey = opts.apiKey || undefined;
    const path = opts.voiceUploadPath || "/v1/voices";
    if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new Error("self-hosted voice upload path is invalid");
    this.voicePath = path.replace(/\/+$/, "");
    this.ttsModel = opts.ttsModel || "chatterbox";
    this.sttModel = opts.sttModel || "whisper-1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Chatterbox clones zero-shot from one reference clip, so upload the longest take. */
  async cloneVoice(input: CloneVoiceInput): Promise<CloneVoiceResult> {
    const reference = [...input.clips].sort((a, b) => b.bytes.length - a.bytes.length)[0];
    if (!reference) throw new SpeechProviderError("validation", "no_clips");
    const name = input.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64);
    const form = new FormData();
    form.append("voice_name", name);
    form.append("voice_file", new Blob([reference.bytes], { type: reference.mimeType }), reference.filename);
    const res = await this.call(this.voicePath, { method: "POST", body: form }, CLONE_TIMEOUT_MS);
    const body = await readJson<Record<string, unknown>>(res).catch(() => ({}) as Record<string, unknown>);
    const id = [body.voice_id, body.id, body.voice_name, body.name].find((v): v is string => typeof v === "string" && v.length > 0);
    return { externalVoiceId: id ?? name, requiresVerification: false };
  }

  async deleteVoice(externalVoiceId: string): Promise<void> {
    try {
      await this.call(`${this.voicePath}/${encodeURIComponent(externalVoiceId)}`, { method: "DELETE" }, DELETE_TIMEOUT_MS);
    } catch (error) {
      if (isVoiceGone(error)) return;
      throw error;
    }
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizedAudio> {
    const text = input.text.trim();
    if (!text) throw new SpeechProviderError("validation", "empty_text");
    const res = await this.call(
      "/v1/audio/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.ttsModel,
          input: text,
          voice: input.externalVoiceId,
          response_format: "wav",
          ...(input.languageHint ? { language: normalizeLanguageCode(input.languageHint)?.split("-")[0] } : {}),
        }),
      },
      SYNTHESIZE_TIMEOUT_MS
    );
    const raw = new Uint8Array(await res.arrayBuffer());
    if (!parseWav(raw)) throw new SpeechProviderError("transient", "unexpected_audio_format", res.status);
    const bytes = normalizeWav(raw);
    return { bytes, mimeType: "audio/wav", durationMs: parseWav(bytes)?.durationMs ?? 0 };
  }

  async transcribe(input: TranscribeInput): Promise<Transcript> {
    const form = new FormData();
    form.append("model", this.sttModel);
    form.append("response_format", "verbose_json"); // adds language + duration
    form.append("file", new Blob([input.bytes], { type: input.mimeType }), audioFilename("voice-note", input.mimeType));
    const res = await this.call("/v1/audio/transcriptions", { method: "POST", body: form }, TRANSCRIBE_TIMEOUT_MS);
    const body = await readJson<{ text?: unknown; language?: unknown; duration?: unknown }>(res);
    return {
      text: typeof body.text === "string" ? body.text.trim() : "",
      language: normalizeLanguageCode(body.language),
      ...(typeof body.duration === "number" && body.duration > 0 ? { durationMs: Math.round(body.duration * 1000) } : {}),
    };
  }

  private call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return vendorFetch(this.fetchImpl, `${this.baseUrl}${path}`, { ...init, headers }, timeoutMs);
  }
}
