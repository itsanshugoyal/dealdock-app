import { describe, expect, it } from "vitest";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import { emojiCount, hindiShare, wordCount } from "../src/style-text";
import type { CreatorContext, DraftInput } from "../src/types";

const creator: CreatorContext = {
  businessSummary: "Fitness coach",
  currencyCode: "INR",
  locale: "en-IN",
  typicalBrandDealMinor: null,
  typicalCoachingMinor: null,
  typicalCourseMinor: null,
  styleCard: { greeting: "Hey hey!", signoff: "– R" },
  correctionExamples: [],
};
const pipeline = new HeuristicPipeline();
const draft = (over: Partial<DraftInput> = {}) =>
  pipeline.draft({ kind: "reply", classificationLabel: "brand_deal", threadHistory: [{ direction: "inbound", text: "Paid collab for 2 reels?" }], creator, ...over });

describe("heuristic drafts mirror the v2 voice inputs", () => {
  it("never uses stock AI phrasing", async () => {
    for (const label of ["brand_deal", "coaching_lead", "course_inquiry", "other_commerce", null]) {
      const { body } = await draft({ classificationLabel: label });
      expect(body.toLowerCase()).not.toContain("thanks for reaching out");
      expect(body).not.toContain("—");
    }
  });

  it("follows a greeting rule over the card, and a sign-off rule", async () => {
    const { body } = await draft({
      creator: {
        ...creator,
        voiceRules: [
          { id: "g", key: "greeting:heyy", text: "Open with “Heyy”", scope: "all", status: "active", evidence: 3 },
          { id: "s", key: "signoff:none", text: "Don't add a sign-off", scope: "brand_deal", status: "pinned", evidence: 0 },
        ],
      },
    });
    expect(body.startsWith("Heyy ")).toBe(true);
    expect(body).not.toContain("– R");
  });

  it("honours steering chips", async () => {
    const base = await draft();
    const shorter = await draft({ chips: ["shorter"] });
    expect(wordCount(shorter.body)).toBeLessThan(wordCount(base.body));
    expect(emojiCount((await draft({ chips: ["add_emoji"] })).body)).toBeGreaterThan(0);
    const hinglish = await draft({ chips: ["more_hinglish"] });
    expect(hindiShare(hinglish.body)).toBeGreaterThan(0.15);
    expect((await draft({ chips: ["ask_budget"] })).body).toContain("budget");
  });

  it("replies in Hinglish to a Hinglish DM, and in English when asked", async () => {
    const hinglish = await draft({ threadHistory: [{ direction: "inbound", text: "Bhai collab ka rate kya hai?" }] });
    expect(hindiShare(hinglish.body)).toBeGreaterThan(0.15);
    const english = await draft({ threadHistory: [{ direction: "inbound", text: "Bhai collab ka rate kya hai?" }], chips: ["more_english"] });
    expect(hindiShare(english.body)).toBe(0);
  });

  it("quotes a listed rate and reports missing facts instead of inventing them", async () => {
    const offers = [{ id: "o1", name: "Reel package", dealType: "brand" as const, priceMinMinor: 5_000_000, priceMaxMinor: 5_000_000, link: null, details: null, availability: null }];
    const quoted = await draft({ creator: { ...creator, offers }, chips: ["quote_rate"] });
    expect(quoted.body).toContain("My rate for Reel package is ₹50K.");
    expect(quoted.context?.missingFacts).toEqual([]);
    const missing = await draft({ classificationLabel: "coaching_lead" });
    expect(missing.context?.missingFacts).toEqual(["your coaching price"]);
  });

  it("removes phrases the creator avoids", async () => {
    const { body } = await draft({
      kind: "nudge",
      creator: { ...creator, voiceRules: [{ id: "a", key: "avoid:just circling back on this", text: "x", scope: "nudge", status: "active", evidence: 4 }] },
    });
    expect(body.toLowerCase()).not.toContain("circling back");
  });

  it("returns distinct alternatives when variants are asked for, body first", async () => {
    const result = await draft({ variants: 3 });
    expect(result.alternatives).toHaveLength(3);
    expect(new Set(result.alternatives).size).toBe(3);
    expect(result.alternatives![0]).toBe(result.body);
    expect((await draft()).alternatives).toEqual([]);
  });

  it("reports what it was built from", async () => {
    const result = await draft({
      exemplars: [{ messageId: "e1", text: "Heyy! Send the brief", inboundText: "Collab?", label: "brand_deal" }],
      lessons: ["On a similar brand message you changed “x” → “y”"],
    });
    expect(result.context).toMatchObject({
      exemplars: [{ messageId: "e1", text: "Heyy! Send the brief", inboundText: "Collab?" }],
      lessons: ["On a similar brand message you changed “x” → “y”"],
    });
    expect(result.modelVersion).toBe("heuristic-fallback-1");
  });
});
