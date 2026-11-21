/**
 * Server-side capability flags. Feature flags live in the one registry in
 * @dealdock/core (FEATURE_FLAGS, see AGENTS.md); these helpers keep the
 * existing call sites short. The web learns the same answers from the API.
 */
import { isFeatureEnabled } from "@dealdock/core";

export { featureFlags, isFeatureEnabled } from "@dealdock/core";

export const isHumanAgentEnabled = (): boolean => isFeatureEnabled("humanAgent");
export const isInsightsEnabled = (): boolean => isFeatureEnabled("insights");
export const isCommentLeadsEnabled = (): boolean => isFeatureEnabled("commentLeads");
export const isUnifiedLoginEnabled = (): boolean => isFeatureEnabled("unifiedLogin");

/** The answer every invoice entry point gives while FEATURE_INVOICES_ENABLED is off. */
export const FEATURE_DISABLED = { error: "feature_disabled" } as const;

/**
 * The configured speech provider (null when voice cloning / transcription is
 * unavailable). The env rules live in @dealdock/speech so the API and the
 * worker can never disagree; the mock provider is refused in production.
 */
export { speechProviderKind, isSpeechConfigured, type SpeechProviderKind } from "@dealdock/speech";
