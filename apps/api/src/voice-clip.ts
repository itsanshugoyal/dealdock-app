import { createAudioAsset, type OrgId } from "@dealdock/db";
import { SpeechProviderError, type SpeechProvider } from "@dealdock/speech";
import { publicMediaUrl, signMediaPath } from "./media-sign";

export interface VoiceClip {
  assetId: string;
  /** Signed link: an absolute https URL when `publicLink`, else the in-app path. */
  url: string;
  mimeType: string;
  /** When the stored clip expires. */
  expiresAt: Date;
}

/**
 * Speak approved text in a creator's cloned voice and keep the clip as a
 * short-lived AudioAsset behind a signed link — shared by "Listen in your
 * voice" and the voice-note send. A vendor failure comes back as
 * `{ failed: code }` for the caller to log and answer; the code is safe to
 * log, the text and audio never are.
 */
export async function synthesizeVoiceClip(
  orgId: OrgId,
  speech: SpeechProvider,
  request: { externalVoiceId: string; text: string; keepMs: number; linkTtlSeconds: number; publicLink: boolean },
): Promise<VoiceClip | { failed: string }> {
  let audio;
  try {
    audio = await speech.synthesize({ externalVoiceId: request.externalVoiceId, text: request.text });
  } catch (failure) {
    return { failed: failure instanceof SpeechProviderError ? failure.code : "synthesize_error" };
  }
  const expiresAt = new Date(Date.now() + request.keepMs);
  const asset = await createAudioAsset(orgId, {
    kind: "tts",
    bytes: audio.bytes,
    mimeType: audio.mimeType,
    durationMs: audio.durationMs,
    text: request.text,
    expiresAt,
  });
  const url = request.publicLink ? publicMediaUrl(asset.id, request.linkTtlSeconds) : signMediaPath(asset.id, request.linkTtlSeconds);
  return { assetId: asset.id, url, mimeType: audio.mimeType, expiresAt };
}
