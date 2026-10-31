/**
 * Server-side capability flags derived from configuration. Shared by routes
 * so the web always learns the same answer (GET /settings, /voice, thread DTOs).
 */

/** Meta must approve the HUMAN_AGENT tag for this app before it may be set. */
export function isHumanAgentEnabled(): boolean {
  return process.env.META_HUMAN_AGENT_ENABLED === "true";
}

/**
 * The configured speech provider (null when voice cloning / transcription is
 * unavailable). The env rules live in @dealdock/speech so the API and the
 * worker can never disagree; the mock provider is refused in production.
 */
export { speechProviderKind, isSpeechConfigured, type SpeechProviderKind } from "@dealdock/speech";
