import { checkScam, REVIEW_CONFIDENCE_THRESHOLD, type ClassificationResult } from "@dealdock/core";

/**
 * Where one classified message goes. A likely scam (fee to join, outside login,
 * locked file…) never reaches the inbox as money: it waits in Check as spam,
 * with the reason, and gets no estimate, draft or push.
 */
export function routeClassification(result: ClassificationResult, text: string): { result: ClassificationResult; routedTo: "inbox" | "review_queue" } {
  const scam = checkScam(text);
  if (scam.likely) {
    return {
      result: { ...result, label: "spam", confidence: Math.min(result.confidence, 0.5), valueRange: null, rationale: scam.reason ?? result.rationale },
      routedTo: "review_queue",
    };
  }
  return { result, routedTo: result.label !== "uncertain" && result.confidence >= REVIEW_CONFIDENCE_THRESHOLD ? "inbox" : "review_queue" };
}
