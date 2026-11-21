/**
 * Server-side capability flags derived from configuration. Shared by routes
 * so the web always learns the same answer (GET /settings, /voice, thread DTOs).
 */

/** Meta must approve the HUMAN_AGENT tag for this app before it may be set. */
export function isHumanAgentEnabled(): boolean {
  return process.env.META_HUMAN_AGENT_ENABLED === "true";
}

/**
 * "Fetch from Instagram" for post results needs the
 * instagram_business_manage_insights permission, which Meta grants through
 * App Review: off until then, and Instagram connections don't ask for it.
 */
export function isInsightsEnabled(): boolean {
  return process.env.META_INSIGHTS_ENABLED === "true";
}

/**
 * Comment leads need Meta to approve instagram_business_manage_comments for
 * this app. On: the OAuth scope, the comments webhook subscription and its
 * processing, and GET /comment-leads reporting the feature as available.
 */
export function isCommentLeadsEnabled(): boolean {
  return process.env.META_COMMENTS_ENABLED === "true";
}

/**
 * The configured speech provider (null when voice cloning / transcription is
 * unavailable). The env rules live in @dealdock/speech so the API and the
 * worker can never disagree; the mock provider is refused in production.
 */
export { speechProviderKind, isSpeechConfigured, type SpeechProviderKind } from "@dealdock/speech";
