# 03: Voice cloning and audio DMs (research)

Prepared 31 October 2026. This is a research document only. No production code was changed. It covers the owner's question, "Are there any open-source options for training creator-specific voices? Otherwise we can use ElevenLabs," plus everything else audio needs end to end: incoming voice notes, transcription, Instagram audio sends, consent and the law.

Related: [voice-and-audio-audit.md](../voice-and-audio-audit.md) (the current code gaps), PRD §6.2 / line 198 ("Voice note: needs your ear"), ARCHITECTURE.md line 209.

---

## 0. TL;DR

1. **Ship ElevenLabs Instant Voice Cloning (IVC) first.** Use the `eleven_multilingual_v2` model (Hindi supported, the stable default) with `scribe_v2` for incoming voice notes. Keep the model id in env so `eleven_v3`/`eleven_v4` can be A/B tested on Hinglish. The API surface is three calls: `POST /v1/voices/add`, `POST /v1/text-to-speech/{voice_id}` and `POST /v1/speech-to-text`, plus `DELETE /v1/voices/{voice_id}` on revocation.
2. **Professional Voice Cloning (PVC) cannot be used on DealDock's ElevenLabs account.** ElevenLabs says: *"You can only create a Professional Voice Clone of your own voice. Even with their consent, you cannot clone someone else's voice."* IVC on DealDock's account, with recorded creator consent, is the viable path.
3. **The best open-source option is Chatterbox Multilingual V3 (Resemble AI).** Code and weights are MIT, it clones zero-shot from about 10 s and it watermarks every output (PerTh). *corrected:* Hindi comes from the dedicated, MIT-licensed Hindi Language Pack (`ResembleAI/Chatterbox-Multilingual-hi`, about 0.5B, built on the V3 decoder). Resemble's V3 launch post labels Hindi "Language Pack" only. The README's general list does include `hi`, but don't assume the base V3 model's Hindi is good enough. It is the only reviewed model that combines a permissive weights license, Hindi and zero-shot cloning. Self-host it behind one of the existing OpenAI-compatible `/v1/audio/speech` servers on a scale-to-zero GPU (e.g. Modal L4 at $0.000222/s). Most other "open" models are **non-commercial** (F5-TTS, XTTS-v2, Spark-TTS, MaskGCT, Voxtral, OmniVoice, Fish S2-Pro, Higgs v3) or lack Hindi. *corrected:* IndexTTS (bilibili license) and CosyVoice (Apache-2.0 weights) do allow commercial use, but neither supports Hindi, so they are out for that reason instead.
4. **Consider Sarvam IVC (beta, India) as a second hosted provider** for Hindi-heavy creators: ₹2.00 per 1K characters vs ElevenLabs $0.08 per 1K, Hinglish-native, single 10–15 s reference clip.
5. **Instagram can send audio.** Use `message.attachment.type = "audio"` with `payload.url`. Accepted formats are aac, m4a, wav and mp4, up to 25 MB, inside the 24 h window (7 days with the Human Agent tag). **ElevenLabs' default MP3 is not in Meta's accepted list**, so request `wav_24000` or transcode to m4a/AAC. Whether the audio renders as a native voice-note bubble or as a file is **not documented** and must be tested on a real account.
6. **Incoming voice notes arrive as `attachments[].type = "audio"` with a signed CDN `payload.url` that expires.** Download in the worker immediately; never store only the URL.
7. **Cost at API list prices is about $1–6 per creator per month** for TTS plus STT (≈2–12% of the $49 Solo price). Section 6.6 has the numbers.
8. **Legal obligations are real.** India's IT Rules amendment (in force 20 Feb 2026) covers synthetic *audio*. EU AI Act Art. 50(4) deepfake disclosure has applied since 2 Aug 2026. ElevenLabs' Use Policy requires "explicit and informed consent" and forbids stripping watermarks. Design for recorded consent, default-on disclosure and deletion on revocation, and **get counsel sign-off** before launch.

---

## 1. Where the code is today (relevant facts only)

- `packages/messaging/src/provider.ts`: `sendMessage(account, target, text)` is **text only**. There is no attachment send.
- `packages/messaging/src/instagram/instagram-graph-adapter.ts:103`: `parseWebhook` types `attachments?: Array<{ type?: string }>` but never reads `type` or `payload.url`. A voice note becomes an empty-text message.
- `apps/api/src/routes/webhooks.ts:103` and `apps/api/src/graph-maintenance.ts:39` map textless messages to `contentType: "attachment"`, never `"audio"`. The schema already allows `"audio"` (`packages/db/src/repos/ingestion.ts:11`).
- `GRAPH_BASE = "https://graph.instagram.com/v25.0"`. Meta's current Messaging API samples use **v26.0**.
- The repo has no object/blob storage today (no S3/R2 client). Generated audio needs a public HTTPS URL for Meta to fetch (§6.4).
- The worker must never send (ARCHITECTURE §6.2). Downloading inbound media in the worker is fine because it is not a send.

---

## 2. Open-source voice cloning / TTS (part A)

"Commercial OK?" means the **weights** license, since outputs and serving depend on the weights and the code license is not enough. ✅ = permissive, ⚠️ = conditional or unclear, ❌ = non-commercial or blocked.

| Model (latest) | Code license | Weights license | Commercial OK? | Hindi? | Cloning | Reference audio | Notes |
|---|---|---|---|---|---|---|---|
| **Chatterbox Multilingual V3** (Resemble AI, released 10 Jun 2026) | MIT | MIT | ✅ | ✅ through the dedicated Hindi Language Pack (`ResembleAI/Chatterbox-Multilingual-hi`, MIT). *corrected:* the 23-language list with `hi` is the README's general list. The V3 launch post (25 languages including packs) marks Hindi "Language Pack" only, so base-V3 Hindi is unconfirmed. | Zero-shot | ~10 s (repo examples use a "10s_ref_clip"; no stated minimum) | 0.5B Llama backbone. **PerTh watermark on every output** by default. Hindi pack CER 2.55–6.72%. No published speaker-similarity or MOS numbers yet. Benchmarks were run on an H100. [repo](https://github.com/resemble-ai/chatterbox), [v3 post](https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages) |
| Chatterbox-Turbo / Nano | MIT | MIT | ✅ | ❌ English | Zero-shot | ~10 s | Turbo is 350M with low VRAM. Nano is 110M, "3x faster than realtime on 8 CPU cores". |
| **Higgs Audio v2 / v2.5** (Boson AI) | Apache-2.0 | Boson Higgs Audio 2 Community License (Llama 3-based) | ⚠️ Yes below **100,000 annual active users**. Requires "Built with Higgs Materials" attribution, and outputs may not be used to improve other LLMs. | Not listed | Zero-shot | Not stated | 3.6B LLM + 2.2B adapter, built on Llama-3.2-3B. [LICENSE](https://huggingface.co/bosonai/higgs-audio-v2-generation-3B-base/blob/main/LICENSE) |
| Higgs Audio v3 (4B, 2026) | Apache-2.0 (not needed by v3) | "Research and Non-Commercial License" | ❌ (separate commercial license) | 100+ langs claimed | Zero-shot | Not stated | [repo](https://github.com/boson-ai/higgs-audio) |
| **IndicF5** (AI4Bharat) | MIT label | MIT label, gated | ⚠️ The label says MIT, but the training data (Rasa, IndicTTS, LIMMITS, IndicVoices-R) licenses were **not verified**. The card bans unauthorized cloning. | ✅ Hindi + 10 Indic | Zero-shot (needs `ref_text` transcript) | Not stated | F5 architecture, 1,417 h of Indic speech. The card itself recommends the newer Indic-Speak. [card](https://huggingface.co/ai4bharat/IndicF5) |
| Indic-Speak (bodhan-ai) | n/a | Indic Open Model License v1.0 | ⚠️ (terms not read) | ✅ 22 Indic + English, code-mixed | ❌ **No cloning** (consented artist voices) | n/a | Usable for a non-cloned Hindi fallback voice only. |
| Indic Parler-TTS | Apache-2.0 | Apache-2.0 | ✅ | ✅ 21 langs | ❌ (voice set by text description) | n/a | [card](https://huggingface.co/ai4bharat/indic-parler-tts) |
| XTTS-v2 (Coqui) | MPL (repo) | **Coqui Public Model License**, non-commercial *including outputs* | ❌ Coqui shut down and `coqui.ai/cpml` now 404s, so there is no way to buy a license | ✅ | Zero-shot | ~6 s | License text: use is non-commercial "only so far as you do not receive any direct or indirect payment arising from the use of the model or its output." [card](https://huggingface.co/coqui/XTTS-v2) |
| F5-TTS v1 | MIT | **CC-BY-NC** (Emilia data) | ❌ | ❌ (ZH/EN) | Zero-shot | Not stated | [repo](https://github.com/SWivid/F5-TTS) |
| OpenVoice v2 (MyShell) | MIT | MIT | ✅ "Free for both commercial and research use" | ❌ (EN, ES, FR, ZH, JA, KO) | Tone-color conversion, zero-shot | Short clip | Could convert the timbre of another Hindi TTS (e.g. Indic Parler) into the creator's voice. This two-stage pipeline is unproven for Hindi. [repo](https://github.com/myshell-ai/OpenVoice) |
| CosyVoice 2 / Fun-CosyVoice 3 (Dec 2025) | Apache-2.0 | *corrected:* Apache-2.0. The HF cards `FunAudioLLM/CosyVoice2-0.5B` and `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` are tagged `apache-2.0`. The "for academic purposes only" line is a disclaimer about the demo content. | ✅ under the license tag, with the disclaimer as a caveat | ❌ (9 langs + Chinese dialects) | Zero-shot, cross-lingual | Not stated | vLLM and TensorRT-LLM serving. [repo](https://github.com/FunAudioLLM/CosyVoice) |
| Fish Audio S2-Pro / Drama 3 (2026) | Fish Audio Community License | Fish Audio Community License for the code and non-S2-Pro weights; Fish Audio Research License for S2-Pro | ❌ for DealDock. *corrected reason:* FACL v1.0 allows commercial use below USD 500K annual revenue. It grants no right to offer a "Hosted Service", which includes a feature whose primary purpose is TTS or voice cloning from inputs third parties supply. The S2-Pro weights are research-only. | "~100 languages" claimed (Hindi not confirmed) | Zero-shot | Not stated | [repo](https://github.com/fishaudio/fish-speech) |
| IndexTTS-2 / 2.5 (bilibili) | bilibili Model Use License | same | ✅ *corrected:* LICENSE §2.1 grants a worldwide, royalty-free license. Only users with more than 100M MAU or more than RMB 1B annual revenue need a separate license (§2.2). The README email is for "commercial usage and cooperation". §3.4(c) forbids using it to improve other AI models. | ❌ (ZH, EN, JA, ES, AR) | Zero-shot | Not stated | [repo](https://github.com/index-tts/index-tts) |
| Spark-TTS 0.5B | Apache-2.0 | **CC-BY-NC-SA-4.0** (switched from Apache) | ❌ | ❌ (ZH/EN) | Zero-shot | Not stated | [card](https://huggingface.co/SparkAudio/Spark-TTS-0.5B) |
| Orpheus 3B | Apache-2.0 | `apache-2.0` label on HF, but built on Llama-3.2-3B (Llama license inheritance **not verified**) | ⚠️ | Not listed (7-language research preview) | Weak zero-shot. Fine-tuning works best (~300 examples per speaker). | Many pairs | [repo](https://github.com/canopyai/Orpheus-TTS) |
| Dia 1.6B (Nari Labs) | Apache-2.0 | Apache-2.0 | ✅ | ❌ English only | Audio prompt + transcript | 5–10 s | ~4.4 GB VRAM in bf16. Dia2 is out with no details checked. [repo](https://github.com/nari-labs/dia) |
| VibeVoice (Microsoft) | MIT | MIT | ❌ in practice: **TTS code removed 5 Sep 2025** for misuse, "research and development purposes only" | ❌ | Realtime-0.5B ships fixed voices | n/a | [repo](https://github.com/microsoft/VibeVoice) |
| Kokoro-82M | Apache-2.0 | Apache-2.0 | ✅ | ✅ 4 Hindi voices, overall grade **C** | ❌ **No cloning** | n/a | [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) |
| StyleTTS2 | MIT | Pre-trained models carry use conditions (disclose synthesis unless you have permission) | ⚠️ | ❌ (English checkpoints) | Zero-shot (LibriTTS) | Short | [repo](https://github.com/yl4579/StyleTTS2) |
| MaskGCT (Amphion) | MIT (Amphion) | **CC-BY-NC-4.0** | ❌ | ❌ (EN/ZH) | Zero-shot | Prompt + transcript | [card](https://huggingface.co/amphion/MaskGCT) |
| Sesame CSM-1B | Apache-2.0 | Apache-2.0 | ✅ | ❌ ("likely won't do well" non-English) | Context-conditioned | Prior turns | [card](https://huggingface.co/sesame/csm-1b) |
| Qwen3-TTS (Jan 2026) | Apache-2.0 | Apache-2.0 | ✅ | ❌ (10 langs, no Hindi) | Zero-shot | 3 s | Strong option if Hindi is not needed. [repo](https://github.com/QwenLM/Qwen3-TTS) |
| Voxtral 4B TTS (Mistral, Mar 2026) | n/a | **CC-BY-NC-4.0** | ❌ (API: $0.016/1K chars) | ✅ | Open weights ship preset voices. Cloning is via the Mistral API. | 3 s (API) | Its paper reports the highest Hindi speaker similarity in its comparison (0.839 vs ElevenLabs v3 0.707). [card](https://huggingface.co/mistralai/Voxtral-4B-TTS-2603), [paper](https://arxiv.org/abs/2603.25551) |
| OmniVoice (k2-fsa, 2026) | Apache-2.0 | **CC-BY-NC** (Emilia) | ❌ | 600+ langs (Hindi not confirmed) | Zero-shot | 3–10 s | [card](https://huggingface.co/k2-fsa/OmniVoice) |

**Verdict.** Only **Chatterbox Multilingual V3** has a permissive weights license, Hindi, zero-shot cloning and a built-in watermark. *corrected:* its Hindi comes from the V3 Hindi Language Pack checkpoint, so a self-hosted server must load `Chatterbox-Multilingual-hi` for Hindi or Hinglish creators. Higgs Audio v2 is a conditional runner-up: there are no confirmed Hindi results and its license has conditions. IndicF5 is the most Indic-specialised option, but its commercial provenance needs a legal read of each dataset license first. **No open model has published Hindi or Hinglish speaker-similarity numbers**, so treat open-source quality as unproven until pilot creators listen side by side.

**Hosting reality.** Chatterbox's own benchmarks use an H100. 0.5B models fit comfortably on a 24 GB L4/A10. DealDock's audio replies are not real-time (a human approves every send), so a scale-to-zero GPU is fine. Modal per-second list prices are T4 $0.000164/s, **L4 $0.000222/s (~$0.80/h)**, A10 $0.000306/s and H100 $0.001097/s, with $30/month free on Starter ([pricing](https://modal.com/pricing)). Cold starts add tens of seconds to the first clip. This was not measured.

**Serving.** There is no need to write a model server. Existing community wrappers expose an OpenAI-compatible `POST /v1/audio/speech` plus a voice-upload endpoint:
- [travisvn/chatterbox-tts-api](https://github.com/travisvn/chatterbox-tts-api) (FastAPI, port 4123, `/v1/audio/speech`, voice library via `POST /voices`, multilingual)
- [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) (Original, Multilingual and Turbo; a **CWE-22 path-traversal bug was fixed**, so pin a version and keep it on a private network)
- [Ace-Nanter/chatterbox-tts-server](https://github.com/Ace-Nanter/chatterbox-tts-server) (Multilingual V3, `lang_code` param; maintained "autonomously", so be cautious)

Voice upload is **not** part of OpenAI's API, so the voice-registration call is server-specific. Wrap it in the adapter.

---

## 3. Commercial APIs (part B)

### 3.1 ElevenLabs (recommended first provider)

**Endpoints to implement** (base `https://api.elevenlabs.io`, header `xi-api-key`). An **India data-residency host `api.in.residency.elevenlabs.io`** is listed, which is useful for DPDP.

| Purpose | Call | Fields |
|---|---|---|
| Create IVC | `POST /v1/voices/add` (multipart/form-data) | `name` (req), `files` (req, list of audio files), `remove_background_noise` (bool), `description`, `labels` (keys: language, accent, gender, age). **Response:** `voice_id`, `requires_verification` (bool). [docs](https://elevenlabs.io/docs/api-reference/voices/ivc/create) |
| Synthesize | `POST /v1/text-to-speech/{voice_id}?output_format=…` (JSON) | `text` (req), `model_id` (default `eleven_multilingual_v2`), `language_code` (ISO 639-1; **not supported on multilingual_v2**), `voice_settings` {`stability` 0.5, `similarity_boost` 0.75, `style` 0, `use_speaker_boost` true, `speed` 1}, `seed`, `previous_text`/`next_text`, `apply_text_normalization` (`auto`/`on`/`off`), `pronunciation_dictionary_locators` (≤3). Query `enable_logging=false` (zero-retention) is **enterprise-only**. **Response:** audio bytes. [docs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) |
| Delete voice | `DELETE /v1/voices/{voice_id}` | Returns `{"status":"ok"}`. Call on consent revocation. [docs](https://elevenlabs.io/docs/api-reference/voices/delete) |
| Transcribe | `POST /v1/speech-to-text` (multipart) | `model_id` (req, `scribe_v2`), `file` **or** `source_url`, `language_code` (optional; auto-detect when omitted), `tag_audio_events`, `diarize`, `timestamps_granularity`, `webhook`. **Response:** `text`, `language_code`, `language_probability`, `words[]`. Min 100 ms, file < 5 GB. *corrected / added:* the response example returns `language_code: "eng"` (ISO 639-3), so Hindi comes back as `hin`, not `hi`. Normalize before storing it. Hindi is in Scribe's "High Accuracy" tier (WER between 5% and 10%). [docs](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) |

**`output_format` vs Instagram.** Valid values include `mp3_44100_128` (default), `opus_48000_*`, `pcm_*`, `wav_8000`…`wav_48000`, `ulaw_8000` and `alaw_8000`. Instagram audio accepts **aac, m4a, wav, mp4**, and *not* mp3 or opus. Either request **`wav_24000`** (no transcoding; 24 kHz × 16-bit mono ≈ 48 KB/s, so a 30 s clip ≈ 1.4 MB, well under 25 MB; "PCM and WAV at 44.1 kHz require Pro tier or above", so stay at 24 kHz) or transcode MP3 to **m4a/AAC** with ffmpeg if WAV renders as a file attachment rather than a voice note (this needs a real-account test).

**Models** ([models page](https://elevenlabs.io/docs/overview/models)):

| Model id | Hindi | Char limit | Notes |
|---|---|---|---|
| `eleven_v4` | ✅ (90+ langs) | 10,000 | Newest. "Exceptional voice cloning". Release date not verified. |
| `eleven_v4_turbo` | ✅ | n/a | ~100 ms |
| `eleven_v3` | ✅ (70+) | 5,000 | Most expressive v3 |
| `eleven_multilingual_v2` | ✅ (29) | 10,000 | Stable default. No `language_code`. |
| `eleven_flash_v2_5` | ✅ (32) | 40,000 | ~100 ms, half price |
| `eleven_turbo_v2_5` | ✅ (32) *corrected* | n/a | **Deprecated** in favor of `eleven_flash_v2_5` |
| `scribe_v2` / `scribe_v2_realtime` | ✅ (90+) | n/a | STT |

**IVC vs PVC** ([guide](https://elevenlabs.io/docs/product-guides/voices/voice-cloning/professional-voice-cloning), [IVC](https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning)):
- **IVC:** recommended "1–2 minutes of good audio". Each file ≥ 5 s, total ≥ 10 s, avoid > 3 min total. The number of files is irrelevant. MP3 ≥ 128–192 kbps. Target about −23 to −18 dB RMS with a −3 dB true peak, and no reverb or noise. The UI requires confirming "you have the right and consent to clone the voice". IVC only clones well in languages supported by Flash v2.5 / Multilingual v2 (Hindi ✅).
- **PVC:** 30–180 min of audio, voice verification by the speaker on similar equipment, fine-tuning in 3–24 h, and **own-voice only**. This is unusable on DealDock's account. A creator could create a PVC on *their own* ElevenLabs account and share it with DealDock via a sharing link. That is a power-user option for later.

**Plans** ([pricing](https://elevenlabs.io/pricing), [API pricing](https://elevenlabs.io/pricing/api)): Free $0 (no commercial license, no IVC), Starter $6, Creator $22, **Pro $99 (160 custom voice slots)**, **Scale $299 (660 slots, 3 PVC)**, Business $990 (2,200 slots). PAYG-equivalent API rates: **v3 / Multilingual v2 $0.08 per 1K chars, Flash/Turbo $0.04 per 1K chars, Scribe v2 $0.22 per hour**. **Voice slots cap how many creators one DealDock account can serve.** Scale gives 660 creators, which is enough for the pilot and early V1.

**Policy** ([Use Policy](https://elevenlabs.io/use-policy)): it prohibits "Cloning, synthesizing, or impersonating the voice… of any living individual… without their explicit and informed consent". It bans voice recordings of anyone under 18, bans circumventing "voice verification systems such as Voice CAPTCHA", requires users to "clearly disclose when people are interacting with AI… where failing to do so would materially mislead them", and says users "must not remove, alter, or conceal ElevenLabs watermarks, metadata or other provenance signals".

### 3.2 Sarvam AI (India; recommended second hosted provider)

- **Instant Voice Cloning (beta, launched 26 Sep 2026)** ([overview](https://docs.sarvam.ai/api/api-guides-tutorials/voice-cloning/overview)):
  - Create a voice with `POST /voices/create` (multipart `file`, `name`, `language` BCP-47 such as `hi-IN`/`en-IN`). It returns `voice_id` and an auto-transcribed `reference_text`, and the voice is usable immediately.
  - Generate with `POST /voices/clone` using `text` plus exactly one of `voice_id` or `ref_audio`. Streaming variants exist.
  - Reference audio: **10–15 s recommended**, 50 MB max, 16–24 kHz. It copies the performance style of the clip.
  - Text limit is **1,000 chars per REST call**.
  - Cloning is cross-lingual (a Hindi reference can produce English speech and vice versa).
  - There is **no API verification step**. Consent requirements sit on Sarvam's Commercial Licensing page, which was not read.
- **Pricing** ([pricing](https://docs.sarvam.ai/api-reference-docs/pricing)): Instant Voice Cloning **₹2.00 per 1K chars**, Bulbul v3 ₹3.00 / ₹2.85 / ₹2.70 per 1K, STT **₹0.49/min** (₹0.41–0.45 on higher tiers), ₹100 free credits. One third-party tracker reports ₹3 per 1K for cloning, so re-check before relying on it.
- **Bulbul v3** covers 11 Indian languages including Hindi and Indian English. It handles Hinglish natively "when Indic words are written in native script". Pass `target_language_code`.
- **STT:** `POST https://api.sarvam.ai/speech-to-text`, models `saaras:v4` (default) and `saaras:v3`. The `mode` options are transcribe, translate, verbatim, translit and **codemix** (v3 only). REST is meant for clips under 30 s, which fits most DMs. [docs](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe)

### 3.3 Others

| Provider | Status / cloning | Hindi | Price | Fit |
|---|---|---|---|---|
| **Cartesia** (Sonic 3.x; `sonic-3.6-2026-08-27` per LiveKit) | IVC from ~10 s at no extra fee. Pro clones cost more and support only `sonic-3-2026-01-12`. | Sonic 3.5 (Apr 2026) "step-change" for Hindi (third-party) | 1 credit/char. Plans $5 / $49 / $299 (third-party) | Viable fallback. Prices not verified on cartesia.ai. |
| **PlayHT / PlayAI** | **Dead.** Meta acqui-hired the team in Jul 2025, the API went dark in late Jul 2025 and the platform was terminated on 31 Dec 2025 with voices deleted. | n/a | n/a | Do not use. |
| **Resemble AI** (hosted) | Rapid clone (10 s) and Pro clone (consent-verified). | Via Chatterbox | Pricing in flux: older $2/voice/month; Sep–Oct 2026 reports say API cloning needs Business (~$1,000/mo) (third-party) | Use the open Chatterbox model instead. |
| **Smallest.ai** Lightning v3.1 | IVC from 5–15 s | ✅ incl. Hindi+English code-switching on Pro | ~$0.175–0.195 per 10K chars (conflicting sources) | Cheap Indian alternative. Not verified first-hand. |
| **Azure Speech** personal voice / professional custom voice | **Limited Access** (application + use-case approval), **recorded consent statement required**, watermark on personal voice | ✅ | Pro custom voice ~$24 per 1M chars (third-party) | The approval gate makes it too slow for the pilot. Copy its consent-statement pattern. |
| **OpenAI** TTS | No custom cloning in public pricing (tts-1, tts-1-hd, gpt-4o-mini-tts preset voices) | n/a | n/a | Not applicable for cloning. |

### 3.4 Speech-to-text for incoming voice notes (Hinglish)

| Provider / model | Hindi / code-switch | Price | Source |
|---|---|---|---|
| **ElevenLabs `scribe_v2`** | 90+ langs incl. Hindi. Code-switch quality not documented. | **$0.22/h** | [API pricing](https://elevenlabs.io/pricing/api) |
| OpenAI `gpt-transcribe` / `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` | Multilingual | $0.0045 / $0.006 / $0.003 per min | [pricing](https://developers.openai.com/api/docs/pricing) |
| Deepgram `nova-3` | `hi` monolingual ✅. Hindi appears in Nova-3's multilingual row, but `language=multi` for Hindi is documented only for `nova-3-medical` / Flux. | ~$0.0043/min (third-party) | [languages](https://developers.deepgram.com/docs/models-languages-overview) |
| AssemblyAI Universal-3.5 Pro | Native code-switching across 18 langs incl. Hindi (vendor blog) | $0.21/h | [Hindi page](https://www.assemblyai.com/languages/hindi) |
| **Sarvam `saaras:v3` `mode=codemix`** | Built for Indian code-mixed speech | ₹0.49/min (~$0.33/h) | [docs](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe) |

Recommendation: start with **Scribe v2** (one vendor, one key, cheapest), with `language_code` omitted so it auto-detects. Keep `transcribe()` behind the provider interface and A/B **Sarvam codemix** on 30 real pilot Hinglish voice notes. No independent Hinglish WER comparison was found.

---

## 4. Instagram Messaging API: audio (part C)

Sources: [Messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md), [webhook examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md), [attachment upload (Page route)](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/attachment-upload), [policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy).

### 4.1 Sending audio (Instagram API with Instagram Login)

```http
POST https://graph.instagram.com/v26.0/me/messages        (or /<IG_ID>/messages)
Authorization: Bearer <IG user access token>
Content-Type: application/json

{
  "recipient": { "id": "<IGSID>" },
  "message": {
    "attachment": {
      "type": "audio",
      "payload": { "url": "https://api.dealdock.example/media/a/<id>?exp=…&sig=…" }
    }
  }
}
```

- Use the **singular `attachment`** object (the `attachments` array form appears only in Meta's multi-image examples).
- **Formats and limits:** Audio is aac, m4a, wav or mp4, **max 25 MB**. Video is mp4/ogg/avi/mov/webm, 25 MB. Images are png/jpeg, 8 MB. Files are pdf, 25 MB.
- **Permissions:** `instagram_business_basic` and `instagram_business_manage_messages` (already required for text).
- **Window:** standard **24 h** after the user's last message, or up to 7 days after a Click-to-Direct-ad first message. The **Human Agent tag** gives "a separate 7-day Human Agent window" for *manual* replies. The Instagram doc gives no JSON for it. The Messenger-platform convention is `"messaging_type": "MESSAGE_TAG", "tag": "HUMAN_AGENT"`, which needs the Human Agent permission through App Review. Third-party sources say automated use is rejected. DealDock's human-approved sends fit the tag, but **the exact IG-Login syntax is unverified**.
- **Attachment Upload API** (`POST /<PAGE_ID>/message_attachments` with `platform: "instagram"`, `is_reusable`) returns `attachment_id`. It is documented for the **Facebook-Login/Page route**, while DealDock uses Instagram Login. For Instagram Login, the doc mentions `attachment_id` only for images. **Use `payload.url`.**
- **Rendering:** Meta does not say whether `type: "audio"` shows as a native voice-note bubble or as a playable file. **Test with a real account** before promising "voice notes". Try wav first, then m4a/AAC.
- Group messaging is not supported. Messages in Requests inactive for 30 days are not returned by the API.
- Not stated: whether Meta fetches the URL synchronously at send time. Assume it does, but give the signed URL a 15-minute expiry for retries.

### 4.2 Receiving voice notes (webhook `messages` field)

```json
{
  "object": "instagram",
  "entry": [{
    "id": "<BUSINESS_IG_ID>", "time": 1730000000,
    "messaging": [{
      "sender": { "id": "<IGSID>" }, "recipient": { "id": "<BUSINESS_IG_ID>" },
      "timestamp": 1730000000,
      "message": {
        "mid": "<MID>",
        "attachments": [{ "type": "audio", "payload": { "url": "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=…&signature=…" } }]
      }
    }]
  }]
}
```

- *corrected:* Meta's webhook example shows only `"payload":{"url":"<URL_FOR_THE_MEDIA>"}`. The `lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=…` URL above comes from third-party reports, not Meta's docs, so treat the CDN host allowlist as provisional.
- Documented attachment `type` values are `media`, `audio`, `file`, `image` (image/gif/sticker), `video`, `share` (deprecated after Feb 2026), `ig_post`, `story_mention`, `ig_reel`, `reel`, `story` and `ig_story`. `text` is present only if the message has text. `is_echo: true` marks the business's own sends, and `is_unsupported: true` marks unsupported media.
- **URL expiry:** Meta's docs say nothing about it. Chatwoot's production PR reports that `lookaside.fbsbx.com` signed URLs "expire and intermittently 404". A Meta wrapper's docs say the media becomes unrecoverable after a retention window, and that re-reading the message can return `is_unsupported` with no attachment. **Download on receipt.**
- One open-source project reports that voice notes arrive with a **`video/mp4`** MIME type. Detect by `type === "audio"`, not by MIME. Sarvam and Scribe both accept MP4/M4A.
- **SSRF guard:** fetch only `https:` from `lookaside.fbsbx.com`, `*.fbcdn.net`, `*.cdninstagram.com` (and `cdn.fbsbx.com`), with no token, a 25 MB cap and a timeout. This mirrors the adapter's existing `graph.instagram.com` host check at line 277.

---

## 5. Consent, legal and safety (part D)

*This is not legal advice. DealDock needs counsel review for India and the EU before audio sending is turned on.*

| Regime | What applies | Design consequence |
|---|---|---|
| **ElevenLabs Use Policy** | Explicit and informed consent of the living individual. No minors. No CAPTCHA evasion. Disclose AI where non-disclosure would materially mislead. Don't strip watermarks or metadata. | A recorded consent statement and an 18+ attestation. Never post-process audio in ways that strip provenance. |
| **India IT Rules amendment 2026** (G.S.R. 120(E), 10 Feb 2026, in force 20 Feb 2026; [PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2295500), [analysis](https://www.legal500.com/intelligence/india/technology/it-rules-2026-deepfake-regulation-three-hour-takedowns-and-ai-labelling-obligations)) | "Synthetically generated information" (SGI) covers **audio** that appears real. Labelling is medium-specific (an *audio disclosure* for audio) with permanent metadata or an identifier where feasible. Duties fall mainly on intermediaries and SSMIs (>50 lakh users). Commentators say voice-cloning services face "heightened expectations". Text replies are **not** SGI. | Watermark or metadata on every clip (Chatterbox PerTh, ElevenLabs provenance). Keep an audit row per clip (creator, consent version, text, model, hash). Offer an optional spoken or text disclosure. **Counsel must decide whether DealDock counts as an SGI-enabling "computer resource".** |
| **DPDP Act 2023 + Rules 2025** (notified 13/14 Nov 2025; substantive duties from ~13–14 May 2027) | A voice is personal data. The Act has no separate biometric class (per commentary, not verified). Standalone, clear consent notice. Purpose limitation, erasure and breach duties. | A separate "voice clone" consent, distinct from writing-style consent. Delete provider voice + samples + generated clips on revocation. Prefer the ElevenLabs India residency host. |
| **EU AI Act Art. 50** ([Baker Botts](https://www.bakerbotts.com/thought-leadership/publications/2026/september/eu-ai-act-article-50-transparency-obligations-go-live)) | Since **2 Aug 2026**, deployers must disclose deepfake audio (content resembling real persons that "would falsely appear to be authentic"). Providers must machine-mark outputs (Art. 50(2)), with a grace period to 2 Dec 2026 for pre-existing systems. The Digital Omnibus (Reg. 2026/1744) did **not** delay Art. 50. Fines up to €15M / 3%. | Disclosure **on by default** for EU creators and recipients, e.g. the creator's chosen line "🎙 AI voice note from <creator>, written & approved by me". Watermarking satisfies marking. |
| **Meta** | The Messenger/IG policy requires automated chat experiences to disclose automation where the law requires it. Recommended as best practice. The Human Agent tag is for manual replies. Meta's "AI info" labels cover posts and ads; **no DM-specific synthetic-audio rule was found**. | DealDock sends are human-approved (not "automated chat"), but the voice is synthetic, so follow the EU/India disclosure design anyway. |

**Consent design** (borrowing the Azure pattern, the strictest of the reviewed vendors):
1. Only the **account owner** (the creator) can create their clone. Team seats cannot record or upload on a creator's behalf.
2. The first recorded take *is* the consent statement, read aloud and stored with the consent text version, timestamp, seat and IP. Example: *"I'm <name>, I'm over 18, and I consent to DealDock creating an AI copy of my voice to send voice replies I approve from my Instagram account. I can delete it anytime."*
3. Every voice send needs the creator or an approver to **listen to the preview** before Send. Never auto-send, consistent with the PRD.
4. Revocation calls `DELETE /v1/voices/{id}` (or the Sarvam / self-hosted delete), wipes samples and cached clips, and discards queued audio drafts.
5. Uploading arbitrary files for cloning is not allowed. In-app recording only reduces the chance of cloning a third party.

---

## 6. Recommendation and architecture (part E)

### 6.1 Provider interface

Follow the existing `MessagingProvider` pattern. Use a new `packages/speech` with `elevenlabs`, `sarvam`, `selfhosted` (OpenAI-compatible Chatterbox server) and `mock` adapters.

```ts
export interface SpeechProvider {
  readonly id: "elevenlabs" | "sarvam" | "selfhosted" | "mock";
  cloneVoice(input: {
    name: string;
    samples: Array<{ bytes: Uint8Array; mime: string }>;
    language?: "en" | "hi";
  }): Promise<{ providerVoiceId: string; requiresVerification: boolean }>;
  deleteVoice(providerVoiceId: string): Promise<void>;
  synthesize(input: {
    providerVoiceId: string;
    text: string;
    language?: "en" | "hi";
  }): Promise<{ bytes: Uint8Array; mime: "audio/wav" | "audio/mp4" }>;
  transcribe(input: { bytes: Uint8Array; mime: string; languageHint?: string }): Promise<{
    text: string;
    language: string | null;
    confidence: number | null;
  }>;
}
```

`MessagingProvider` gains one method: `sendAudio(account, target, url): Promise<SendReceipt>`. It sends the same `/me/messages` request with the `attachment` body and throws the same `SendWindowClosedError` / `TokenExpiredError`. `parseWebhook` adds `attachments: Array<{ type: string; url?: string }>` to `RemoteMessage`.

### 6.2 What to ship, in order

| Phase | Scope | Vendor |
|---|---|---|
| **A: Detect & play** (no new vendor; closes the PRD §6.2 gap) | Webhook/history marks `type==="audio"` as `contentType:"audio"`. The worker downloads immediately (allowlist, cap) and stores the bytes. The thread shows an `<audio>` player with the "needs your ear" row. | none |
| **B: Transcribe** | The worker calls `transcribe()`, stores the transcript and language, and feeds the transcript into classification and drafting (still flagged as audio, with lower confidence routed to Review). | ElevenLabs Scribe v2 (A/B Sarvam codemix) |
| **C: Voice clone + voice replies** | Studio "My voice" flow, recorded consent, `cloneVoice`. In the composer, add a "Send as voice note" toggle that synthesizes from the approved text, shows a mandatory preview, then `sendAudio`. | ElevenLabs IVC + `eleven_multilingual_v2` (env `ELEVENLABS_TTS_MODEL`) |
| **D: Self-host option** | A `selfhosted` adapter pointing at a Chatterbox Multilingual V3 OpenAI-compatible server (Modal L4, scale-to-zero). Enabled per org via env `SPEECH_PROVIDER=selfhosted`. | none (MIT) |
| **E: India provider** | A `sarvam` adapter (IVC beta + saaras codemix). Gated until it leaves beta and the commercial-licensing consent terms are read. | Sarvam |

Env additions: `SPEECH_PROVIDER`, `ELEVENLABS_API_KEY`, `ELEVENLABS_BASE_URL` (default host or `https://api.in.residency.elevenlabs.io`), `ELEVENLABS_TTS_MODEL`, `SARVAM_API_KEY`, `SELFHOSTED_TTS_URL`, `MEDIA_URL_SIGNING_KEY`. Keys belong to the API process only. The worker needs the STT key for Phase B, so if keys must stay API-only, route transcription through an API-internal job.

### 6.3 Data model (minimal)

- `VoiceClone` (one per IgAccount): `provider`, `providerVoiceId`, `consentTextVersion`, `consentRecordingAssetId`, `createdBySeatId`, `status` (`active` / `revoked`), `revokedAt`.
- `AudioAsset`: `orgId`, `kind` (`inbound_voice_note` / `generated_reply` / `consent` / `sample`), `mime`, `bytes` (bytea) or `storageKey`, `durationMs`, `sha256`, `messageId?`, `draftId?`, `provider`, `modelId`, `createdAt`.
- `Message`: add `transcript`, `transcriptLanguage` (or keep them on `Classification`).

### 6.4 Public URL Meta can fetch

The repo has no object storage, so for the pilot:
- Store clips in the `AudioAsset.bytes` table. A 30 s wav_24000 clip is ~1.4 MB and an m4a is ~250 KB.
- Serve them from the API at `GET /media/a/:id?exp=<unix>&sig=<HMAC-SHA256(id|exp, MEDIA_URL_SIGNING_KEY)>`, with a 15 min expiry, constant-time signature compare, correct `Content-Type` (`audio/wav` or `audio/mp4`) and `Content-Length`, and no auth cookie required. The API is already publicly reachable for webhooks.
- The same signed route also serves inbound voice notes to the web player, behind normal auth.
- **Shortcut:** Postgres bytea is fine for pilot volume (hundreds of clips per day). Move to S3/R2 presigned GET URLs when the audio table passes a few GB.

### 6.5 Sample-collection UX (Studio, "My voice")

- Record in the browser with `MediaRecorder`. Chrome and Firefox produce `audio/webm;codecs=opus` and Safari produces `audio/mp4`; pick a type with `MediaRecorder.isTypeSupported`. Use mono and request `echoCancellation:false, noiseSuppression:false` so the creator's natural timbre is captured.
- **Three takes, about 90 s total.** This fits ElevenLabs' "1–2 minutes" sweet spot and its "avoid > 3 min" advice. Take 2 or 3 alone (15 s) works for Sarvam and Chatterbox.
  1. **Consent statement**, ~15 s (§5).
  2. **English DM read**, ~35 s, e.g. *"Hey! Thanks so much for reaching out. I'd love to hear more about the campaign: what's the timeline, the deliverables, and the budget you have in mind? For coaching, my next batch starts on the fifth and there are only a few seats left. Send me your questions and I'll get back to you today."*
  3. **Hinglish DM read**, ~35 s, e.g. *"Hiii, bahut thanks message karne ke liye! Collab ke liye main bilkul open hoon. Bas mujhe deliverables, timeline aur budget bata do, phir main proper quote bhej deti hoon. Course ka next batch Monday se start ho raha hai, aur seats limited hain, toh jaldi confirm kar lena!"*
- **Client-side gates** (Web Audio `AnalyserNode`): each take ≥ 5 s and total ≥ 10 s (ElevenLabs minimums), reject clipping (peaks at 0 dBFS), and warn if RMS falls outside about −23 to −18 dB or noise is high. Offer "Re-record" and a playback preview.
- Upload to the API, transcode server-side with ffmpeg to MP3 192 kbps for ElevenLabs (it recommends MP3 at 128–192 kbps; whether it accepts webm/opus directly is unverified), then call `cloneVoice`. After cloning, immediately play a test sentence in the cloned voice and ask "Sounds like you?" with a Yes / Re-record choice.
- The *same* ffmpeg dependency handles the WAV to m4a transcode for sending if the Instagram test shows m4a renders better.

### 6.6 Cost per creator per month (API list prices)

Assumptions: a voice reply averages 250–300 characters (~15–20 s of speech) and an inbound voice note averages 30 s.

| Profile | Voice replies | Inbound voice notes | ElevenLabs TTS (Multilingual v2 / v3 @ $0.08 per 1K) | Scribe v2 @ $0.22/h | **Total** | Sarvam equivalent (₹2 per 1K + ₹0.49/min) |
|---|---|---|---|---|---|---|
| Light (Solo) | 40 × 250 = 10K chars | 150 × 30 s = 1.25 h | $0.80 (Flash $0.40) | $0.28 | **≈ $1.10 (~₹95)** | ₹20 + ₹37 = **₹57** |
| Heavy (Roster seat) | 200 × 300 = 60K chars | 600 × 30 s = 5 h | $4.80 | $1.10 | **≈ $5.90 (~₹500)** | ₹120 + ₹147 = **₹267** |

There is also a fixed platform fee: ElevenLabs **Scale $299/mo** covers 660 voice slots, about $0.45 per creator at full use, or **Pro $99** for ≤160 creators. Self-hosted Chatterbox on Modal L4 is about $0.80 per GPU-hour, so the marginal cost is cents per creator. A 24/7 L4 (~$580/mo) only beats ElevenLabs beyond several hundred active voice creators. The real-time factor and cold-start times were **not measured**.

Against the $49 / $99 / $179 prices, audio costs about 2–4% of revenue. Make voice replies a **Studio and Roster feature**, or Solo with a monthly cap, to protect margin on heavy users.

---

## 7. Claims that could NOT be verified (treat as open questions)

1. Whether an Instagram `type:"audio"` send renders as a **native voice-note bubble** or as a file, and whether wav or m4a matters. Undocumented; needs a real-account test.
2. The exact **HUMAN_AGENT** JSON for the *Instagram API with Instagram Login*, and whether that route needs the Human Agent App Review permission. The IG doc gives no syntax.
3. Whether `attachment_id` (Attachment Upload API) works for **audio on the Instagram-Login route**. It is documented only for the Page route, and for images on IG Login.
4. Inbound **CDN URL lifetime**. Only third-party reports exist; Meta documents none. The claim that voice notes carry a `video/mp4` MIME type is also third-party.
5. Whether Meta fetches `payload.url` synchronously at send time.
6. ElevenLabs **plan credits conflict**: the main pricing page lists Starter at 30K credits, while the API pricing page lists Starter at 75K v2/v3 characters. Also unverified: per-tier IVC eligibility (inferred from feature lists), the `eleven_v4` release date and maturity, and whether `/v1/voices/add` accepts webm/opus directly.
7. **Hindi or Hinglish quality** for Chatterbox V3, Higgs v2 and IndicF5. There are no published speaker-similarity or MOS scores. Third-party papers put ElevenLabs Hindi similarity at about 0.68–0.73 (below Voxtral and MiniMax), not reproduced here.
8. **IndicF5 commercial status.** It is labelled MIT, but the training-dataset licenses (IndicTTS, LIMMITS, Rasa) were not checked. Orpheus inheriting the Llama-3.2 license was also not checked.
9. Sarvam IVC **consent requirements** (Commercial Licensing page not read), its cloning price conflict (₹2 vs ₹3 per 1K) and when it exits beta.
10. Cartesia, Smallest.ai, Resemble, Azure and Deepgram multilingual prices come from third-party pages. Vendor pricing pages were not read for these, except Modal, ElevenLabs, OpenAI and Sarvam.
11. Legal applicability: whether DealDock is an "intermediary" or SGI tool under India's IT Rules 2026, whether voice counts as specially protected under DPDP, and whether a creator-approved cloned voice note to a brand is a "deepfake" under EU AI Act Art. 50(4). Counsel must decide.
12. GPU real-time factor and cold-start latency for Chatterbox V3 on L4/A10, and the self-hosted cost per clip.

---

## 8. Sources (primary first)

- Meta: [Messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md), [Webhook examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md), [Attachment Upload](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/attachment-upload), [Messenger & IG policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy)
- ElevenLabs: [IVC create](https://elevenlabs.io/docs/api-reference/voices/ivc/create), [TTS convert](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [STT convert](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [Delete voice](https://elevenlabs.io/docs/api-reference/voices/delete), [Models](https://elevenlabs.io/docs/overview/models), [IVC guide](https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning), [PVC guide](https://elevenlabs.io/docs/product-guides/voices/voice-cloning/professional-voice-cloning), [Pricing](https://elevenlabs.io/pricing), [API pricing](https://elevenlabs.io/pricing/api), [Use policy](https://elevenlabs.io/use-policy)
- Sarvam: [Voice cloning overview](https://docs.sarvam.ai/api/api-guides-tutorials/voice-cloning/overview), [Pricing](https://docs.sarvam.ai/api-reference-docs/pricing), [STT](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe)
- OpenAI [pricing](https://developers.openai.com/api/docs/pricing). Deepgram [languages](https://developers.deepgram.com/docs/models-languages-overview). AssemblyAI [Hindi](https://www.assemblyai.com/languages/hindi). Modal [pricing](https://modal.com/pricing).
- Models: [Chatterbox](https://github.com/resemble-ai/chatterbox), [Chatterbox ML v3 post](https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages), [F5-TTS](https://github.com/SWivid/F5-TTS), [IndicF5](https://huggingface.co/ai4bharat/IndicF5), [Indic Parler-TTS](https://huggingface.co/ai4bharat/indic-parler-tts), [XTTS-v2](https://huggingface.co/coqui/XTTS-v2) + [LICENSE](https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt), [OpenVoice](https://github.com/myshell-ai/OpenVoice), [CosyVoice](https://github.com/FunAudioLLM/CosyVoice), [Fish Speech](https://github.com/fishaudio/fish-speech), [IndexTTS](https://github.com/index-tts/index-tts), [Spark-TTS weights](https://huggingface.co/SparkAudio/Spark-TTS-0.5B), [Orpheus](https://github.com/canopyai/Orpheus-TTS), [Dia](https://github.com/nari-labs/dia), [Higgs Audio](https://github.com/boson-ai/higgs-audio) + [v2 LICENSE](https://huggingface.co/bosonai/higgs-audio-v2-generation-3B-base/blob/main/LICENSE), [VibeVoice](https://github.com/microsoft/VibeVoice), [Kokoro VOICES](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md), [StyleTTS2](https://github.com/yl4579/StyleTTS2), [MaskGCT](https://huggingface.co/amphion/MaskGCT), [CSM-1B](https://huggingface.co/sesame/csm-1b), [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), [Voxtral TTS](https://huggingface.co/mistralai/Voxtral-4B-TTS-2603), [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice)
- Serving wrappers: [travisvn/chatterbox-tts-api](https://github.com/travisvn/chatterbox-tts-api), [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server)
- Legal: [India IT Rules 2026 (Legal500)](https://www.legal500.com/intelligence/india/technology/it-rules-2026-deepfake-regulation-three-hour-takedowns-and-ai-labelling-obligations), [PIB SGI release](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2295500), [DPDP Rules PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014), [EU AI Act Art. 50 (Baker Botts)](https://www.bakerbotts.com/thought-leadership/publications/2026/september/eu-ai-act-article-50-transparency-obligations-go-live), [Jones Walker on Omnibus](https://www.joneswalker.com/en/insights/blogs/ai-law-blog/yes-august-2-still-matters-the-eu-approved-a-high-risk-ai-delay-but-most-trans.html)
- Third-party (lower confidence): [Chatwoot PR #15665 (CDN expiry)](https://github.com/chatwoot/chatwoot/pull/15665), [PlayHT shutdown (Inworld)](https://inworld.ai/resources/migrate-from-playht), [Cartesia pricing (Cekura)](https://www.cekura.ai/blogs/cartesia-pricing), [Smallest.ai pricing](https://smallest.ai/pricing/models), [Azure personal voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-overview), [Voxtral paper](https://arxiv.org/abs/2603.25551)

---

## Verification pass (independent)

On 31 Oct 2026 an independent fact-checker re-checked the high-stakes claims against primary sources: LICENSE files, Hugging Face model cards, official API docs and vendor pricing pages. Wrong statements are fixed inline above and marked *corrected:*. A claim is **unverifiable** when no primary source settled it.

### 1. Open-source licenses (weights and commercial use)

| Claim | Verdict | Correction / note | Source |
|---|---|---|---|
| Chatterbox Multilingual V3: MIT code + MIT weights, released 10 Jun 2026 | Confirmed | The HF card is tagged `mit`. The launch post says "Today, June 10, 2026" and MIT. | [repo](https://github.com/resemble-ai/chatterbox), [HF](https://huggingface.co/ResembleAI/chatterbox), [post](https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages) |
| Chatterbox V3 Hindi is in the "23-language model" | **Wrong (partly)** | The README's general list (linked from the V3 row) has `hi`. The V3 post lists 25 languages and marks Hindi "Language Pack" only, so use `ResembleAI/Chatterbox-Multilingual-hi` (MIT, V3 decoder). Hindi pack CER 2.55–6.72% is confirmed. No speaker-similarity numbers are published (confirmed). | [post](https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages), [Hindi pack](https://huggingface.co/ResembleAI/Chatterbox-Multilingual-hi) |
| Chatterbox PerTh watermark on every output; ~10 s reference; H100 benchmarks | Confirmed | The README gives no option to turn the watermark off. The self-hosted model has it "embedded by default". | [README](https://raw.githubusercontent.com/resemble-ai/chatterbox/master/README.md), [post](https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages) |
| F5-TTS: code MIT, weights CC-BY-NC, ZH/EN | Confirmed | "The pre-trained models are licensed under the CC-BY-NC license due to the training data Emilia". | [repo](https://github.com/SWivid/F5-TTS) |
| XTTS-v2: CPML, non-commercial including outputs; Hindi; 6 s; `coqui.ai/cpml` 404 | Confirmed | The CPML text excludes any "direct or indirect payment arising from the use of the model or its output". `coqui.ai/cpml` returned HTTP 404. | [card](https://huggingface.co/coqui/XTTS-v2), [LICENSE](https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt) |
| CosyVoice weights license "not separately stated" (⚠️) | **Wrong** | HF cards for `CosyVoice2-0.5B` and `Fun-CosyVoice3-0.5B-2512` are tagged `apache-2.0`, and the repo LICENSE is Apache 2.0. The "academic purposes only" text is a disclaimer about the demo content. There is no Hindi (9 languages). | [CV2 card](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B), [CV3 card](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512), [LICENSE](https://raw.githubusercontent.com/FunAudioLLM/CosyVoice/main/LICENSE) |
| Fish Speech: "❌ without an agreement" | Confirmed (verdict), reason corrected | FACL v1.0 allows commercial use below USD 500K annual revenue. It grants no license for a "Hosted Service", which includes a feature whose primary purpose is TTS or voice cloning from inputs third parties supply. DealDock would likely need Fish's written license. S2-Pro weights are under the Fish Audio Research License. Hindi is not confirmed. | [LICENSE](https://raw.githubusercontent.com/fishaudio/fish-speech/main/LICENSE), [repo](https://github.com/fishaudio/fish-speech) |
| IndexTTS-2/2.5: ❌ commercial, "contact bilibili" | **Wrong** | bilibili Model Use License §2.1 grants a worldwide, royalty-free license. A separate license is needed only above 100M MAU or RMB 1B revenue (§2.2). §3.4(c) bars using it to improve other AI models. No Hindi (2.5 supports ZH/EN/JA/ES/AR), so the recommendation doesn't change. | [LICENSE](https://raw.githubusercontent.com/index-tts/index-tts/main/LICENSE), [repo](https://github.com/index-tts/index-tts) |
| Orpheus: Apache tag, built on Llama-3.2-3B, inheritance unclear | Confirmed (⚠️ stays) | The HF cards are tagged `apache-2.0` with base model `meta-llama/Llama-3.2-3B-Instruct`. Neither mentions the Llama license, so inheritance is still **unverifiable** without counsel. About 300 examples per speaker is recommended for fine-tuning. | [HF ft](https://huggingface.co/canopylabs/orpheus-3b-0.1-ft), [HF pretrained](https://huggingface.co/canopylabs/orpheus-3b-0.1-pretrained), [repo](https://github.com/canopyai/Orpheus-TTS) |
| Higgs Audio v2: Boson community license, 100k annual users, "Built with Higgs Materials", no use of outputs to improve other LLMs | Confirmed | The license is based on the Meta Llama 3 Community License (18 Apr 2024). Derivative model names must begin with "Higgs Audio 2". The HF card says "4 languages" without naming them and never mentions Hindi. | [LICENSE](https://huggingface.co/bosonai/higgs-audio-v2-generation-3B-base/blob/main/LICENSE), [card](https://huggingface.co/bosonai/higgs-audio-v2-generation-3B-base) |
| Higgs Audio v3: research / non-commercial | Confirmed | "Production / hosted / revenue-generating use requires a separate commercial license." It claims 100+ languages; Hindi is not named. | [repo](https://github.com/boson-ai/higgs-audio) |
| IndicF5: MIT label, gated, Hindi + 10 Indic, needs `ref_text`, ~1,417 h, recommends Indic-Speak | Confirmed | Commercial provenance is still **unverifiable**: the training-dataset licenses (Rasa, IndicTTS, LIMMITS, IndicVoices-R) were not checked. | [card](https://huggingface.co/ai4bharat/IndicF5) |
| Indic Parler-TTS Apache, Hindi, no cloning | Confirmed | The language count is inconsistent on the card itself: 18 in the metadata, "20 Indic" in the text, and 21 when English is counted. | [card](https://huggingface.co/ai4bharat/indic-parler-tts) |
| OpenVoice v2 MIT, "Free for commercial use", 6 languages, no Hindi | Confirmed | | [repo](https://github.com/myshell-ai/OpenVoice) |
| Spark-TTS CC-BY-NC-SA-4.0; MaskGCT CC-BY-NC-4.0; OmniVoice CC-BY-NC weights + Apache code | Confirmed | OmniVoice lists 646 languages in its metadata, and Hindi is not named. Its "3–10 s" reference length is **unverifiable** because the card states none. | [Spark](https://huggingface.co/SparkAudio/Spark-TTS-0.5B), [MaskGCT](https://huggingface.co/amphion/MaskGCT), [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) |
| Dia Apache, English only, 5–10 s, ~4.4 GB bf16 | Confirmed | | [repo](https://github.com/nari-labs/dia) |
| VibeVoice MIT, TTS code removed 2025-09-05, R&D only | Confirmed | The Realtime-0.5B model has "experimental speakers" (added 2025-12-16). The README says nothing about cloning. | [repo](https://github.com/microsoft/VibeVoice) |
| Sesame CSM-1B Apache, poor non-English | Confirmed | The card forbids mimicking real people "without their explicit consent". | [card](https://huggingface.co/sesame/csm-1b) |
| StyleTTS2 MIT code + disclosure conditions on pretrained models | Confirmed | | [repo](https://github.com/yl4579/StyleTTS2) |
| Qwen3-TTS Apache, 10 languages without Hindi, 3 s, Jan 2026 | Confirmed | Released 2026-01-22. | [repo](https://github.com/QwenLM/Qwen3-TTS) |
| Voxtral 4B TTS CC-BY-NC-4.0, Hindi | Confirmed | The paper abstract confirms 3 s reference audio and CC BY-NC weights. **Unverifiable:** Hindi similarity of 0.839 vs 0.707 (not in the abstract), whether the open weights can clone, and the $0.016/1K API price. | [card](https://huggingface.co/mistralai/Voxtral-4B-TTS-2603), [paper](https://arxiv.org/abs/2603.25551) |
| Kokoro 4 Hindi voices, grade C | Confirmed | `hf_alpha`, `hf_beta`, `hm_omega` and `hm_psi` are all grade C. | [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) |
| Modal L4 $0.000222/s, $30/mo Starter credit | Confirmed | | [pricing](https://modal.com/pricing) |

### 2. ElevenLabs

| Claim | Verdict | Correction / note | Source |
|---|---|---|---|
| `POST /v1/voices/add`, multipart; `name`, `files` (required); `remove_background_noise`, `description`, `labels`; returns `voice_id`, `requires_verification` | Confirmed | The API page gives no file-format, size or count limits. Regional hosts US, EU, **India (`api.in.residency.elevenlabs.io`)** and SG are confirmed. | [IVC create](https://elevenlabs.io/docs/api-reference/voices/ivc/create) |
| TTS `POST /v1/text-to-speech/{voice_id}`, the field list, `language_code` not supported on multilingual_v2, `enable_logging=false` enterprise-only, ≤3 dictionary locators | Confirmed | Fields the report omits: `previous_request_ids`/`next_request_ids`, `use_pvc_as_ivc`, `clone_strength` (PVC fine-tuned for v4 only) and `audio_effects`. Default `model_id` is `eleven_multilingual_v2`. | [TTS convert](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) |
| Output formats include `wav_24000`; default `mp3_44100_128`; 44.1 kHz PCM/WAV needs Pro | Confirmed | `mp3_44100_192` needs Creator or above. | [TTS convert](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) |
| `DELETE /v1/voices/{voice_id}` returns `{"status":"ok"}` | Confirmed | | [delete](https://elevenlabs.io/docs/api-reference/voices/delete) |
| STT `POST /v1/speech-to-text`, `model_id` `scribe_v2`, `file` or `source_url`, optional `language_code`, `diarize`, `tag_audio_events`; returns `text`, `language_code`, `language_probability`, `words[]`; min 100 ms, < 5 GB | Confirmed, with an addition | The response `language_code` example is `"eng"` (ISO 639-3), so Hindi likely returns `hin`. Scribe accepts AAC, OGG, Opus, M4A, MP4 and WebM audio. Hindi is in the "High Accuracy" (5–10% WER) tier. | [STT convert](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [STT capabilities](https://elevenlabs.io/docs/capabilities/speech-to-text) |
| Models: v4 / v4_turbo / v3 / multilingual_v2 / flash_v2_5 all support Hindi; char limits 10K / 5K / 10K / 40K | Confirmed | *corrected:* `eleven_turbo_v2_5` also supports Hindi (32 languages) and is deprecated. ElevenLabs now calls `eleven_multilingual_v2` and `eleven_v3` "previous-generation". `eleven_v4` costs the same as v2/v3 ($0.08/1K) and is worth testing first. | [models](https://elevenlabs.io/docs/overview/models), [API pricing](https://elevenlabs.io/pricing/api) |
| Prices: v2/v3 $0.08/1K, Flash/Turbo $0.04/1K, Scribe v2 $0.22/h | Confirmed | v4 is also $0.08/1K. | [API pricing](https://elevenlabs.io/pricing/api) |
| Plans: Free has no IVC or commercial license; Pro $99 = 160 slots; Scale $299 = 660 slots, 3 PVC; Business $990 = 2,200 | Confirmed | IVC is included from Starter ($6, 10 slots) upward, inferred from the "Everything in…" feature lists. The Starter 30K credits vs 75K characters conflict is **unresolved**. | [pricing](https://elevenlabs.io/pricing), [API pricing](https://elevenlabs.io/pricing/api) |
| IVC guidance: 1–2 min; ≥5 s per file, ≥10 s total; avoid > 3 min; MP3 128–192 kbps; −23 to −18 dB RMS, −3 dB true peak; consent confirmation; works in Flash v2.5 / Multilingual v2 languages | Confirmed | Whether `/v1/voices/add` accepts webm/opus is **unverifiable**: the API page lists no formats. | [IVC guide](https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning) |
| PVC own-voice only, "Even with their consent, you cannot clone someone else's voice"; 30–180 min audio; verification | Confirmed | Fine-tuning takes "3–6 hours" in the FAQ and "6–24 hours" elsewhere. | [PVC guide](https://elevenlabs.io/docs/product-guides/voices/voice-cloning/professional-voice-cloning) |
| Use Policy quotes: explicit and informed consent, no under-18 recordings, Voice CAPTCHA, AI disclosure, watermarks/provenance | Confirmed | The full disclosure clause reads "where required by law **or** where failing to do so would materially mislead them". The consent clause adds "or other valid authorization". The policy was last updated 09 Oct 2026. | [Use Policy](https://elevenlabs.io/use-policy) |

### 3. Instagram Messaging API

| Claim | Verdict | Correction / note | Source |
|---|---|---|---|
| Send audio: `message.attachment.type:"audio"`, `payload.url`, v26.0 | Confirmed | Meta's example posts to `https://graph.instagram.com/v26.0/<IG_ID>/messages`. The repo adapter uses `/me/messages` on v25.0 (checked at `instagram-graph-adapter.ts:35`). | [Messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md) |
| Formats/limits: audio aac/m4a/wav/mp4 25 MB; image png/jpeg 8 MB; video mp4/ogg/avi/mov/webm 25 MB; file pdf 25 MB | Confirmed | MP3 and Opus are not listed. | same |
| Permissions `instagram_business_basic` + `instagram_business_manage_messages`; 24 h window; Click-to-Direct up to 7 days; separate 7-day Human Agent window | Confirmed | | same |
| Human Agent JSON for IG Login is unverified | Still **unverifiable** for IG Login, partly supported | The Graph API Page Messages reference (Facebook Login route) documents `messaging_type: "MESSAGE_TAG"` plus `tag: "HUMAN_AGENT"`. It says "Only HUMAN_AGENT is available for Instagram Messaging" and allows sending "within 7 days after a customer's last message". The Instagram Login doc still shows no syntax. | [Page messages ref](https://developers.facebook.com/docs/graph-api/reference/page/messages/) |
| `attachment_id` documented on IG Login only for images | Confirmed | The doc says you "can also mix both `url` and `attachment_id`". Its only example is a collection of images. | [Messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md) |
| Webhook: `attachments[]` with `type` + `payload.url`; types `media`, `audio`, `file`, `image`, `video`, `ig_post`, `story_mention`, `ig_reel`, `reel`, `story`, `ig_story`; `share` deprecated after Feb 2026; `text` only when present; `is_echo`; `is_unsupported` | Confirmed | | [webhook examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md) |
| Inbound URL host `lookaside.fbsbx.com/ig_messaging_cdn/...` | **Unverifiable** (corrected inline) | Meta's example shows only `<URL_FOR_THE_MEDIA>`. The host comes from third-party reports. Meta's docs say nothing about URL expiry (confirmed). | same |
| Native voice-note rendering; whether Meta fetches the URL at send time; `video/mp4` MIME for voice notes | **Unverifiable** | Meta documents none of these. They need a real-account test. | — |

### 4. Hindi support

| Claim | Verdict | Source |
|---|---|---|
| ElevenLabs `eleven_multilingual_v2`, v3, v4, flash_v2_5 (and the deprecated turbo_v2_5) speak Hindi; Scribe transcribes Hindi | Confirmed | [models](https://elevenlabs.io/docs/overview/models), [STT](https://elevenlabs.io/docs/capabilities/speech-to-text) |
| Chatterbox: Hindi | Confirmed through the Hindi Language Pack. Base V3 is ambiguous (see above). | [post](https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages) |
| XTTS-v2, IndicF5, Indic Parler-TTS, Kokoro (grade C) and Voxtral support Hindi | Confirmed | cards linked above |
| F5-TTS, OpenVoice v2, CosyVoice 2/3, Qwen3-TTS, Dia, Spark-TTS, MaskGCT and IndexTTS-2.5 have no Hindi | Confirmed | cards and repos linked above |
| Higgs v2/v3, Fish S2-Pro and OmniVoice: Hindi "not confirmed" | Confirmed: none of them names Hindi | cards and repos linked above |
| Hindi/Hinglish clone quality (speaker similarity / MOS) for any open model | **Unverifiable**: nothing is published | — |

### 5. Other spot checks

- **Sarvam:** IVC at ₹2.00 per 1K characters, beta status, `POST /voices/create` and `POST /voices/clone`, 10–15 s reference, 50 MB, 1,000 characters per REST call and the ₹100 free credits are all **confirmed** ([pricing](https://docs.sarvam.ai/api-reference-docs/pricing), [overview](https://docs.sarvam.ai/api/api-guides-tutorials/voice-cloning/overview)). The page also lists a delete endpoint, `DELETE /voices/delete/{voice_id}`, and states "Voice cloning requires consent." The "launched 26 Sep 2026" date and the "16–24 kHz" range are **unverifiable**: the overview page states neither.
- **Repo facts in §1** are confirmed: `GRAPH_BASE` is v25.0 at `packages/messaging/src/instagram/instagram-graph-adapter.ts:35`, `attachments?: Array<{ type?: string }>` is at line 103, and `contentType` in `packages/db/src/repos/ingestion.ts:11` allows `"audio"`.

**Net effect on the recommendation:** none. ElevenLabs IVC first is still right, and Chatterbox is still the only permissive open model with Hindi and cloning, provided self-hosting uses the Hindi Language Pack checkpoint. Two follow-ups for implementation:
1. Normalize Scribe's ISO 639-3 language codes.
2. Test `eleven_v4` alongside `eleven_multilingual_v2`. It costs the same, and ElevenLabs now labels v2 "previous-generation".
