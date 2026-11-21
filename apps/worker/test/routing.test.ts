import { describe, expect, it } from "vitest";
import type { ClassificationResult } from "@dealdock/core";
import { routeClassification } from "../src/consumers/routing";

const brandDeal: ClassificationResult = {
  label: "brand_deal",
  confidence: 0.95,
  language: "en",
  valueRange: { minMinor: 50_000_00, maxMinor: 80_000_00 },
  rationale: "Brand asking for a reel with a budget.",
  modelVersion: "test",
  promptVersion: "test",
};

describe("routeClassification", () => {
  it("sends a likely scam to Check as spam with no estimate", () => {
    const routed = routeClassification(brandDeal, "Congrats, you're selected as our ambassador! Pay the registration fee of ₹999 to confirm.");
    expect(routed.routedTo).toBe("review_queue");
    expect(routed.result).toMatchObject({ label: "spam", valueRange: null, rationale: "They're asking you to pay to take part." });
    expect(routed.result.confidence).toBeLessThanOrEqual(0.5);
  });

  it("keeps a confident real deal in the inbox, unchanged", () => {
    const routed = routeClassification(brandDeal, "Hi! We'd love to pay you ₹50,000 for 1 reel. Shipping is on us.");
    expect(routed).toEqual({ result: brandDeal, routedTo: "inbox" });
  });

  it("still sends uncertain and low-confidence results to Check", () => {
    expect(routeClassification({ ...brandDeal, confidence: 0.4 }, "maybe a collab?").routedTo).toBe("review_queue");
    expect(routeClassification({ ...brandDeal, label: "uncertain" }, "hmm").routedTo).toBe("review_queue");
  });
});
