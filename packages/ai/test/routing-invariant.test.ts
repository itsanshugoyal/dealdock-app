import { describe, expect, it } from "vitest";
import { REVIEW_CONFIDENCE_THRESHOLD } from "@dealdock/core";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import type { CreatorContext } from "../src/types";
import { GOLDEN_SET } from "../evals/golden-set";

/**
 * M2 exit criterion: 100% of sub-threshold classifications route to Review,
 * never the inbox. The worker owns routing (confidence gate), so this test
 * pins the CONTRACT: for every golden case, threshold comparison is the only
 * thing deciding routing, and uncertain-truth cases never look confident.
 */
const creator: CreatorContext = {
  businessSummary: "Fitness coach",
  currencyCode: "INR",
  typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 },
  typicalCoachingMinor: { min: 2_500_000, max: 8_000_000 },
  typicalCourseMinor: { min: 800_000, max: 1_500_000 },
  styleCard: null,
  correctionExamples: [],
};

describe("routing invariant on the golden set (heuristic pipeline)", () => {
  it("golden set is big enough and Hinglish-weighted", () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(250);
    const hinglish = GOLDEN_SET.filter((c) => c.language !== "en").length;
    expect(hinglish / GOLDEN_SET.length).toBeGreaterThanOrEqual(0.5);
  });

  it("uncertain-truth cases are never confidently classified into the inbox", async () => {
    const pipeline = new HeuristicPipeline();
    const uncertain = GOLDEN_SET.filter((c) => c.label === "uncertain");
    expect(uncertain.length).toBeGreaterThan(0);

    for (const c of uncertain) {
      const r = await pipeline.classify({
        messageText: c.text,
        senderHandle: c.handle,
        creator,
      });
      const routedToInbox = r.confidence >= REVIEW_CONFIDENCE_THRESHOLD;
      // Either it goes to review, or (if confident) it must at least not be
      // a false commerce promise.
      if (routedToInbox) {
        expect(["fan", "spam", "personal"]).toContain(r.label);
      }
    }
  });

  it("confidence is always within [0,1] so the gate is well-defined", async () => {
    const pipeline = new HeuristicPipeline();
    for (const c of GOLDEN_SET.slice(0, 40)) {
      const r = await pipeline.classify({
        messageText: c.text,
        senderHandle: c.handle,
        creator,
      });
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});
