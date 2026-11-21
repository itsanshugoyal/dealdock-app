import type { DealDto } from "@dealdock/core";
import { describe, expect, it } from "vitest";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import { buildDraftPrompt } from "../src/prompts";
import { lintDraft } from "../src/style-learning";
import type { CreatorContext, DraftInput, OfferContext } from "../src/types";

const reel: OfferContext = { id: "o1", name: "a brand reel", dealType: "brand", priceMinMinor: 6_000_000, priceMaxMinor: 6_000_000, link: null, details: null, availability: null };
const coaching: OfferContext = { id: "o2", name: "1:1 coaching", dealType: "coaching", priceMinMinor: 2_400_000, priceMaxMinor: 2_400_000, link: null, details: null, availability: null };
const creator: CreatorContext = {
  businessSummary: "Fitness creator",
  currencyCode: "INR",
  locale: "en-IN",
  typicalBrandDealMinor: null,
  typicalCoachingMinor: null,
  typicalCourseMinor: null,
  styleCard: { greeting: "Heyy!", signoff: "– D" },
  correctionExamples: [],
  offers: [coaching],
};
const deal = {
  id: "deal-1", threadId: "t1", igAccountId: "ig1", counterpartyHandle: "urbanroots.in", counterpartyName: "Urban Roots", channel: "instagram",
  title: "Monsoon reel + 2 stories", dealType: "brand", amountMinor: 6_000_000, currencyCode: "INR", stage: "paid",
  terms: { deliverables: [], usage: null, exclusivity: null, revisionsIncluded: null, advancePercent: null, paymentDays: null, notes: null },
  agreedAt: "2026-06-20T00:00:00Z", dueAt: null, invoicedAt: null, paidAt: "2026-07-05T07:30:00Z",
  receivedMinor: 6_000_000, tdsMinor: null, createdAt: "2026-06-20T00:00:00Z", updatedAt: "2026-07-05T07:30:00Z",
} as DealDto;
const input = (over: Partial<DraftInput> = {}): DraftInput => ({
  kind: "nudge", classificationLabel: "brand_deal", threadHistory: [{ direction: "inbound", text: "Received the reel, thank you!" }], creator,
  purpose: "renewal", deal, now: new Date("2026-11-07T06:30:00Z"), timezone: "Asia/Kolkata", ...over,
});
const draft = (over: Partial<DraftInput> = {}) => new HeuristicPipeline().draft(input(over));

describe("renewal pitches", () => {
  it("names the past collaboration, proposes working together again and states no money without a brand offer", async () => {
    const { body, lintViolations } = await draft();
    expect(body).toBe("Heyy! Loved working with you on Monsoon reel + 2 stories! I'd love to team up again. Anything coming up that we could work on together?\n– D");
    expect(body).not.toMatch(/₹|60,000|festive/i);
    expect(lintViolations).toEqual([]);
  });

  it("gives the model the past work and no money to quote", () => {
    const prompt = buildDraftPrompt(input());
    expect(prompt.deal?.renewal).toEqual({ paidOn: "5 Jul", festive: false, rates: [] });
    expect(prompt.user).toContain("Past collaboration: Monsoon reel + 2 stories");
    expect(prompt.user).toContain("Delivered and paid: 5 Jul");
    expect(prompt.user).toContain("The creator's current brand rate: not set");
    expect(prompt.user).toContain("Never state a price or fee.");
    expect(prompt.user).not.toContain("₹60,000");
    // The old fee is not an amount the draft may state.
    expect(prompt.lint.amounts?.allowedMinor).toEqual([]);
    expect(lintDraft("Loved it! Same ₹60,000 as last time?", prompt.lint)).toContain("Don't state any amount of money");
  });

  it("quotes the creator's current brand offer exactly, and only that", async () => {
    const withRate = { creator: { ...creator, offers: [coaching, reel] } };
    const { body, lintViolations } = await draft(withRate);
    expect(body).toContain("My current rate for a brand reel is ₹60,000.");
    expect(lintViolations).toEqual([]);
    const prompt = buildDraftPrompt(input(withRate));
    expect(prompt.user).toContain("The creator's current brand rates: a brand reel: ₹60,000");
    expect(prompt.user).toContain("State a rate only as <deal> lists it, exactly.");
    expect(prompt.lint.amounts?.allowedMinor).toEqual([6_000_000]);
    expect(lintDraft("My rate is ₹24,000 now.", prompt.lint)).toHaveLength(1);
  });

  it("mentions the festive season between 1 September and 15 October", async () => {
    const festive = { now: new Date("2026-09-20T06:30:00Z") };
    expect((await draft(festive)).body).toContain("With festive campaigns being planned now");
    const prompt = buildDraftPrompt(input(festive));
    expect(prompt.user).toContain("Timing: brands are setting their festive (October to December) budgets now");
    expect(prompt.user).toContain("mention that brands are planning festive campaigns now");
    expect(buildDraftPrompt(input()).user).not.toContain("festive");
  });

  it("goes Hinglish when the conversation did", async () => {
    const { body } = await draft({ threadHistory: [{ direction: "inbound", text: "Payment kar diya hai, thank you!" }] });
    expect(body).toContain("saath kaam karke bahut maza aaya");
  });
});
