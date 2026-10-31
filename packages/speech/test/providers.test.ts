import { describe, expect, it } from "vitest";
import {
  ElevenLabsProvider,
  MOCK_TRANSCRIPT,
  MockSpeechProvider,
  SelfHostedProvider,
  SpeechProviderError,
  createSpeechProvider,
  isSpeechConfigured,
  normalizeLanguageCode,
  parseWav,
  pcmToWav,
  speechProviderKind,
  toneWav,
  wavDurationMs,
} from "../src/index";

interface Call {
  url: string;
  init: RequestInit;
}

/** Records every request and answers from the handler; Response bodies may be bytes or JSON. */
function fakeFetch(handler: (call: Call) => { status?: number; json?: unknown; bytes?: Uint8Array } | Error) {
  const calls: Call[] = [];
  const impl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const result = handler(call);
    if (result instanceof Error) throw result;
    const body = result.bytes ?? JSON.stringify(result.json ?? {});
    return new Response(body, { status: result.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const clip = (filename: string, size = 10) => ({ bytes: new Uint8Array(size), mimeType: "audio/wav", filename });

describe("normalizeLanguageCode", () => {
  it("maps ISO 639-3 and language names to BCP-47", () => {
    expect(normalizeLanguageCode("hin")).toBe("hi");
    expect(normalizeLanguageCode("ENG")).toBe("en");
    expect(normalizeLanguageCode("Hindi")).toBe("hi");
    expect(normalizeLanguageCode("hi-in")).toBe("hi-IN");
    expect(normalizeLanguageCode("fil")).toBe("fil"); // no 639-1 code: the 3-letter code is valid BCP-47
  });

  it("returns null for anything that is not a language code", () => {
    expect(normalizeLanguageCode("")).toBeNull();
    expect(normalizeLanguageCode("12")).toBeNull();
    expect(normalizeLanguageCode("<script>")).toBeNull();
    expect(normalizeLanguageCode(undefined)).toBeNull();
  });
});

describe("ElevenLabsProvider", () => {
  const provider = (impl: typeof fetch, extra: Partial<ConstructorParameters<typeof ElevenLabsProvider>[0]> = {}) =>
    new ElevenLabsProvider({ apiKey: "xi-test-key", fetchImpl: impl, ...extra });

  it("creates an instant voice clone from multipart takes", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { voice_id: "voice_123", requires_verification: false } }));
    const result = await provider(impl).cloneVoice({ name: "dealdock-v1", clips: [clip("take-1.wav"), clip("take-2.wav")], description: "consented" });
    expect(result).toEqual({ externalVoiceId: "voice_123", requiresVerification: false });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.elevenlabs.io/v1/voices/add");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-test-key");
    const form = call.init.body as FormData;
    expect(form.get("name")).toBe("dealdock-v1");
    expect(form.get("remove_background_noise")).toBe("true");
    expect(form.getAll("files").map((file) => (file as File).name)).toEqual(["take-1.wav", "take-2.wav"]);
  });

  it("reports a vendor-side verification requirement", async () => {
    const { impl } = fakeFetch(() => ({ json: { voice_id: "v", requires_verification: true } }));
    await expect(provider(impl).cloneVoice({ name: "n", clips: [clip("a.wav")] })).resolves.toMatchObject({ requiresVerification: true });
  });

  it("synthesizes 24 kHz PCM and wraps it as WAV Instagram accepts", async () => {
    const pcm = new Uint8Array(24_000 * 2); // one second of silence
    const { impl, calls } = fakeFetch(() => ({ bytes: pcm }));
    const audio = await provider(impl).synthesize({ externalVoiceId: "voice/1", text: "  Hi! Sharing rates now.  ", languageHint: "hi" });
    expect(audio.mimeType).toBe("audio/wav");
    expect(audio.durationMs).toBe(1_000);
    expect(parseWav(audio.bytes)).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=pcm_24000");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ text: "Hi! Sharing rates now.", model_id: "eleven_multilingual_v2" });
    expect(body.voice_settings).toMatchObject({ stability: 0.5, similarity_boost: 0.75 });
    expect(body.language_code).toBeUndefined(); // multilingual_v2 rejects language_code
  });

  it("passes language_code to models that accept it", async () => {
    const { impl, calls } = fakeFetch(() => ({ bytes: new Uint8Array(480) }));
    await provider(impl, { ttsModel: "eleven_v3", baseUrl: "https://api.in.residency.elevenlabs.io/" }).synthesize({ externalVoiceId: "v", text: "Namaste", languageHint: "hin" });
    expect(calls[0]!.url.startsWith("https://api.in.residency.elevenlabs.io/v1/text-to-speech/v")).toBe(true);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model_id: "eleven_v3", language_code: "hi" });
  });

  it("transcribes with Scribe and normalizes its ISO 639-3 language", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { text: " Collab ke liye rate kya hai? ", language_code: "hin", words: [{ end: 1.2 }, { end: 3.45 }] } }));
    const transcript = await provider(impl).transcribe({ bytes: new Uint8Array(20), mimeType: "audio/mp4" });
    expect(transcript).toEqual({ text: "Collab ke liye rate kya hai?", language: "hi", durationMs: 3_450 });
    const form = calls[0]!.init.body as FormData;
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("tag_audio_events")).toBe("false");
    expect((form.get("file") as File).name).toBe("voice-note.m4a");
  });

  it("treats deleting a voice the vendor no longer has as success", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 404, json: { detail: { status: "voice_not_found" } } }));
    await expect(provider(impl).deleteVoice("gone")).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: "https://api.elevenlabs.io/v1/voices/gone", init: { method: "DELETE" } });
  });

  it("types failures without copying vendor prose", async () => {
    const cases: Array<[number, unknown, string, string]> = [
      [401, { detail: { status: "quota_exceeded", message: "Hi! Sharing rates now." } }, "quota", "quota_exceeded"],
      [401, { detail: { status: "invalid_api_key", message: "bad key" } }, "auth", "invalid_api_key"],
      [422, { detail: [{ msg: "field required" }] }, "validation", "http_422"],
      [503, null, "transient", "http_503"],
    ];
    for (const [status, json, kind, code] of cases) {
      const { impl } = fakeFetch(() => ({ status, json }));
      const error = await provider(impl).synthesize({ externalVoiceId: "v", text: "Hi! Sharing rates now." }).catch((e) => e);
      expect(error).toBeInstanceOf(SpeechProviderError);
      expect(error).toMatchObject({ kind, code, status });
      expect(String(error.message)).not.toContain("Sharing rates");
    }
  });

  it("maps network failures and timeouts to transient errors", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    for (const [failure, code] of [[new TypeError("fetch failed"), "network_error"], [timeout, "timeout"]] as const) {
      const { impl } = fakeFetch(() => failure);
      await expect(provider(impl).transcribe({ bytes: new Uint8Array(4), mimeType: "audio/wav" })).rejects.toMatchObject({ kind: "transient", code });
    }
  });

  it("refuses an insecure base URL and empty text", async () => {
    expect(() => new ElevenLabsProvider({ apiKey: "k", baseUrl: "http://api.elevenlabs.io" })).toThrow();
    expect(() => new ElevenLabsProvider({ apiKey: "" })).toThrow();
    const { impl } = fakeFetch(() => ({ bytes: new Uint8Array(4) }));
    await expect(provider(impl).synthesize({ externalVoiceId: "v", text: "   " })).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("SelfHostedProvider", () => {
  const make = (impl: typeof fetch, extra: Partial<ConstructorParameters<typeof SelfHostedProvider>[0]> = {}) =>
    new SelfHostedProvider({ baseUrl: "http://chatterbox.internal:4123/", apiKey: "secret", fetchImpl: impl, ...extra });

  it("synthesizes through the OpenAI-compatible speech route and repairs a streaming WAV header", async () => {
    const wav = pcmToWav(new Uint8Array(32_000), 16_000);
    new DataView(wav.buffer).setUint32(40, 0, true); // size left unset by a streaming encoder
    const { impl, calls } = fakeFetch(() => ({ bytes: wav }));
    const audio = await make(impl).synthesize({ externalVoiceId: "dealdock-v1", text: "Hello", languageHint: "hi-IN" });
    expect(audio).toMatchObject({ mimeType: "audio/wav", durationMs: 1_000 });
    expect(new DataView(audio.bytes.buffer).getUint32(40, true)).toBe(32_000);
    expect(calls[0]!.url).toBe("http://chatterbox.internal:4123/v1/audio/speech");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: "chatterbox", input: "Hello", voice: "dealdock-v1", response_format: "wav", language: "hi" });
  });

  it("rejects audio that is not WAV", async () => {
    const { impl } = fakeFetch(() => ({ bytes: new Uint8Array([0xff, 0xfb, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }));
    await expect(make(impl).synthesize({ externalVoiceId: "v", text: "Hi" })).rejects.toMatchObject({ kind: "transient", code: "unexpected_audio_format" });
  });

  it("uploads the longest take to the configurable voice library path", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { voice_name: "dealdock-v1" } }));
    const result = await make(impl, { voiceUploadPath: "/voices" }).cloneVoice({ name: "DealDock V1!", clips: [clip("consent.wav", 5), clip("english.wav", 50), clip("hinglish.wav", 20)] });
    expect(result).toEqual({ externalVoiceId: "dealdock-v1", requiresVerification: false });
    expect(calls[0]!.url).toBe("http://chatterbox.internal:4123/voices");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("voice_name")).toBe("dealdock-v1-");
    expect((form.get("voice_file") as File).name).toBe("english.wav");
  });

  it("deletes idempotently and transcribes via verbose_json", async () => {
    const { impl, calls } = fakeFetch(({ url }) =>
      url.endsWith("/transcriptions") ? { json: { text: "Price?", language: "english", duration: 2.5 } } : { status: 404, json: {} }
    );
    const provider = make(impl);
    await expect(provider.deleteVoice("dealdock-v1")).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("http://chatterbox.internal:4123/v1/voices/dealdock-v1");
    await expect(provider.transcribe({ bytes: new Uint8Array(8), mimeType: "audio/wav" })).resolves.toEqual({ text: "Price?", language: "en", durationMs: 2_500 });
    expect((calls[1]!.init.body as FormData).get("response_format")).toBe("verbose_json");
  });

  it("refuses unsafe configuration", () => {
    expect(() => new SelfHostedProvider({ baseUrl: "ftp://x" })).toThrow();
    expect(() => new SelfHostedProvider({ baseUrl: "https://user:pw@x" })).toThrow();
    expect(() => new SelfHostedProvider({ baseUrl: "https://x", voiceUploadPath: "/../../etc" })).toThrow();
  });
});

describe("MockSpeechProvider", () => {
  it("is deterministic, follows text length and never claims to understand speech", async () => {
    const mock = new MockSpeechProvider({ NODE_ENV: "test" });
    const a = await mock.cloneVoice({ name: "n", clips: [clip("a.wav")] });
    expect(a).toEqual(await mock.cloneVoice({ name: "n", clips: [clip("a.wav")] }));
    expect(a.externalVoiceId).toMatch(/^mock-voice-[0-9a-f]{16}$/);
    const short = await mock.synthesize({ externalVoiceId: a.externalVoiceId, text: "Hi" });
    const long = await mock.synthesize({ externalVoiceId: a.externalVoiceId, text: "Thanks for reaching out! ".repeat(4) });
    expect(short.durationMs).toBe(500);
    expect(long.durationMs).toBeGreaterThan(short.durationMs);
    expect(wavDurationMs(long.bytes)).toBe(long.durationMs);
    await expect(mock.transcribe()).resolves.toEqual({ text: MOCK_TRANSCRIPT, language: null });
  });

  it("is refused in production", () => {
    expect(() => new MockSpeechProvider({ NODE_ENV: "production" })).toThrow("refused in production");
  });
});

describe("provider configuration", () => {
  it("reports a provider only when its credentials are present", () => {
    expect(speechProviderKind({})).toBeNull();
    expect(speechProviderKind({ SPEECH_PROVIDER: "elevenlabs" })).toBeNull();
    expect(speechProviderKind({ SPEECH_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k" })).toBe("elevenlabs");
    expect(speechProviderKind({ SPEECH_PROVIDER: "self_hosted", SELF_HOSTED_SPEECH_URL: "http://tts:4123" })).toBe("self_hosted");
    expect(speechProviderKind({ SPEECH_PROVIDER: "mock", NODE_ENV: "development" })).toBe("mock");
    expect(speechProviderKind({ SPEECH_PROVIDER: "mock", NODE_ENV: "production" })).toBeNull();
    expect(speechProviderKind({ SPEECH_PROVIDER: "sarvam", ELEVENLABS_API_KEY: "k" })).toBeNull();
    expect(isSpeechConfigured({ SPEECH_PROVIDER: "mock" })).toBe(true);
  });

  it("builds the configured provider, or a stored one for cleanup after a vendor switch", () => {
    const env = { SPEECH_PROVIDER: "self_hosted", SELF_HOSTED_SPEECH_URL: "http://tts:4123", ELEVENLABS_API_KEY: "k", NODE_ENV: "test" };
    expect(createSpeechProvider({ env })?.kind).toBe("self_hosted");
    expect(createSpeechProvider({ env, kind: "elevenlabs" })?.kind).toBe("elevenlabs");
    expect(createSpeechProvider({ env, kind: "mock" })?.kind).toBe("mock");
    expect(createSpeechProvider({ env: { ...env, NODE_ENV: "production" }, kind: "mock" })).toBeNull();
    expect(createSpeechProvider({ env: {} })).toBeNull();
  });

  it("produces tones the WAV parser agrees with", () => {
    expect(wavDurationMs(toneWav(2_000))).toBe(2_000);
  });
});
