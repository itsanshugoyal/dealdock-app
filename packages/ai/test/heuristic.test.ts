import { describe, expect, it } from "vitest";
import { REVIEW_CONFIDENCE_THRESHOLD } from "@dealdock/core";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import type { CreatorContext } from "../src/types";

const creator: CreatorContext = {
  businessSummary: "Fitness coach selling a 12-week program",
  currencyCode: "INR",
  typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 }, // ₹1.5L–₹4L
  typicalCoachingMinor: { min: 2_500_000, max: 8_000_000 },
  typicalCourseMinor: { min: 800_000, max: 1_500_000 },
  styleCard: { greeting: "Hey hey!", signoff: "– R" },
  correctionExamples: [],
};

const pipeline = new HeuristicPipeline();

describe("heuristic classify", () => {
  it("labels a brand brief as brand_deal with commerce value range", async () => {
    const r = await pipeline.classify({
      messageText:
        "Hi! We'd love to discuss a paid collaboration for our campaign — 3 reels. Budget flexible.",
      senderHandle: "glowherbals.in",
      creator,
    });
    expect(r.label).toBe("brand_deal");
    expect(r.confidence).toBeGreaterThanOrEqual(REVIEW_CONFIDENCE_THRESHOLD);
    expect(r.valueRange).toEqual({ minMinor: 15_000_000, maxMinor: 40_000_000 });
    expect(r.rationale.length).toBeGreaterThan(0);
    expect(r.modelVersion).toBe("heuristic-fallback-1");
  });

  it("detects Hinglish", async () => {
    const r = await pipeline.classify({
      messageText: "Bhai aapke program ke baare mein jaanna hai, charges kya hain?",
      senderHandle: "rahul_j92",
      creator,
    });
    expect(r.language).toBe("hinglish");
    expect(r.label).toBe("coaching_lead");
  });

  it("routes ambiguity to uncertain below the review threshold — never fakes confidence", async () => {
    const r = await pipeline.classify({
      messageText: "Hello sir. Message me back when free. Important.",
      senderHandle: "wellness.collab.hub",
      creator,
    });
    expect(r.label).toBe("uncertain");
    expect(r.confidence).toBeLessThan(REVIEW_CONFIDENCE_THRESHOLD);
  });

  it("gives fan/spam no value range", async () => {
    const fan = await pipeline.classify({
      messageText: "Love your content bhai!! 🔥",
      senderHandle: "rohan_fan123",
      creator,
    });
    expect(fan.label).toBe("fan");
    expect(fan.valueRange).toBeNull();
  });
});

describe("heuristic draft", () => {
  it("uses the style card greeting and signoff", async () => {
    const d = await pipeline.draft({
      kind: "reply",
      classificationLabel: "brand_deal",
      threadHistory: [{ direction: "inbound", text: "Paid collab?" }],
      creator,
    });
    expect(d.body).toContain("Hey hey!");
    expect(d.body).toContain("– R");
  });

  it("drafts nudges distinctly", async () => {
    const d = await pipeline.draft({
      kind: "nudge",
      classificationLabel: "brand_deal",
      threadHistory: [],
      creator,
    });
    expect(d.body.toLowerCase()).toContain("circling back");
  });
});
