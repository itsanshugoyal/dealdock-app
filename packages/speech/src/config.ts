import { ElevenLabsProvider } from "./elevenlabs";
import { MockSpeechProvider } from "./mock";
import type { SpeechProvider, SpeechProviderKind } from "./provider";
import { SelfHostedProvider } from "./self-hosted";

type Env = Record<string, string | undefined>;

const KINDS: readonly SpeechProviderKind[] = ["elevenlabs", "self_hosted", "mock"];

function isConfigured(kind: SpeechProviderKind, env: Env): boolean {
  if (kind === "elevenlabs") return Boolean(env.ELEVENLABS_API_KEY);
  if (kind === "self_hosted") return Boolean(env.SELF_HOSTED_SPEECH_URL);
  return env.NODE_ENV !== "production"; // the mock fabricates audio; never in production
}

/** The configured speech provider (SPEECH_PROVIDER + its credentials), or null when speech is off. */
export function speechProviderKind(env: Env = process.env): SpeechProviderKind | null {
  const kind = KINDS.find((candidate) => candidate === env.SPEECH_PROVIDER);
  return kind && isConfigured(kind, env) ? kind : null;
}

export function isSpeechConfigured(env: Env = process.env): boolean {
  return speechProviderKind(env) !== null;
}

/**
 * Build a provider from the environment. `kind` defaults to SPEECH_PROVIDER;
 * pass a stored kind (SpeakingVoice.provider) to reach the vendor that holds
 * an existing voice, e.g. to delete it after the deployment switched vendors.
 */
export function createSpeechProvider(
  opts: { env?: Env; kind?: string | null; fetchImpl?: typeof fetch } = {}
): SpeechProvider | null {
  const env = opts.env ?? process.env;
  const requested = opts.kind === undefined ? env.SPEECH_PROVIDER : opts.kind;
  const kind = KINDS.find((candidate) => candidate === requested);
  if (!kind || !isConfigured(kind, env)) return null;
  if (kind === "elevenlabs") {
    return new ElevenLabsProvider({
      apiKey: env.ELEVENLABS_API_KEY!,
      baseUrl: env.ELEVENLABS_BASE_URL,
      ttsModel: env.ELEVENLABS_TTS_MODEL,
      sttModel: env.ELEVENLABS_STT_MODEL,
      fetchImpl: opts.fetchImpl,
    });
  }
  if (kind === "self_hosted") {
    return new SelfHostedProvider({
      baseUrl: env.SELF_HOSTED_SPEECH_URL!,
      apiKey: env.SELF_HOSTED_SPEECH_API_KEY,
      voiceUploadPath: env.SELF_HOSTED_SPEECH_VOICE_UPLOAD_PATH,
      ttsModel: env.SELF_HOSTED_SPEECH_TTS_MODEL,
      sttModel: env.SELF_HOSTED_SPEECH_STT_MODEL,
      fetchImpl: opts.fetchImpl,
    });
  }
  return new MockSpeechProvider(env);
}
