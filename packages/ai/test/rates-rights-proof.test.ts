import { normalizeOfferAddOns, type DealDto, type ExclusivityNote, type InvoiceDto } from "@dealdock/core";
import { describe, expect, it } from "vitest";
import { mergeDealSuggestion, suggestDealHeuristically } from "../src/deal-suggestion";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import { buildDraftPrompt, buildVoiceSystem, dealFacts, mergeMissingFacts } from "../src/prompts";
import { lintDraft } from "../src/style-learning";
import type { CreatorContext, DealSuggestionInput, DraftInput, OfferContext } from "../src/types";

const reel: OfferContext = {
  id: "offer-reel", name: "Reel + 2 stories", dealType: "brand", priceMinMinor: 60_000_00, priceMaxMinor: 90_000_00, link: null, details: null, availability: null,
  addOns: normalizeOfferAddOns({ usagePerMonthMinor: 15_000_00, rushMinor: 10_000_00 }),
};
const creator: CreatorContext = {
  businessSummary: "Skincare creator", currencyCode: "INR", locale: "en-IN", typicalBrandDealMinor: null, typicalCoachingMinor: null, typicalCourseMinor: null,
  styleCard: { greeting: "Hey hey!", signoff: "– R" }, correctionExamples: [], offers: [reel],
};
const unpriced: CreatorContext = { ...creator, offers: [{ ...reel, addOns: null }] };
const reply = (text: string, over: Partial<DraftInput> = {}): DraftInput => ({
  kind: "reply", classificationLabel: "brand_deal", threadHistory: [{ direction: "inbound", text }], creator, timezone: "Asia/Kolkata", ...over,
});

describe("add-on prices in drafts", () => {
  it("lists only the add-ons the creator priced, exactly, and the rate-card link", () => {
    const system = buildVoiceSystem({ ...creator, rateCardUrl: "https://app.dealdock.example/rates/abc" });
    expect(system).toContain("add-ons: usage rights ₹15,000 per month, rush delivery ₹10,000");
    expect(system).not.toMatch(/partnership ads|raw footage/);
    expect(system).toContain("Rate card link, to share when they ask for your rates, rate card or media kit: https://app.dealdock.example/rates/abc");
    expect(buildVoiceSystem(unpriced)).not.toContain("add-ons:");
    expect(buildVoiceSystem(creator)).not.toContain("Rate card link");
  });

  it("quotes a priced add-on when a brand asks, and flags the ones without a price", async () => {
    const ask = "Love it! What do you charge for usage rights and the raw footage?";
    const priced = await new HeuristicPipeline().draft(reply(ask));
    expect(priced.body).toContain("Usage rights are ₹15,000 per month.");
    expect(priced.body).not.toMatch(/raw footage is/i);
    expect(priced.context?.missingFacts).toEqual(["your raw-footage price"]);

    const none = await new HeuristicPipeline().draft(reply(ask, { creator: unpriced }));
    expect(none.body).not.toMatch(/₹/);
    expect(none.context?.missingFacts).toEqual(["your usage-rights price per month", "your raw-footage price"]);
    // A message that asks about no add-on flags nothing, and only brand replies are checked.
    expect(buildDraftPrompt(reply("What are your rates for a reel?", { creator: unpriced })).context.missingFacts).toEqual([]);
    expect(buildDraftPrompt(reply("Do you allow usage rights?", { creator: unpriced, classificationLabel: "coaching_lead" })).context.missingFacts).toEqual([]);
  });

  it("keeps the flags first when a model adds its own", () => {
    expect(mergeMissingFacts(["your usage-rights price per month"], ["your usage-rights price per month", "the shoot date"])).toEqual(["your usage-rights price per month", "the shoot date"]);
  });
});

const NOW = new Date("2026-02-20T06:30:00Z");
const paid: DealDto = {
  id: "deal-glow", threadId: "t1", igAccountId: "ig1", counterpartyHandle: "glowco", counterpartyName: "Glow Co", channel: "instagram",
  title: "Winter reel", dealType: "brand", amountMinor: 50_000_00, currencyCode: "INR", stage: "paid",
  terms: {
    deliverables: [{ id: "d1", label: "1 reel", dueAt: null, done: true, postUrl: "https://www.instagram.com/reel/Cx1/", postedAt: "2025-12-01T10:00:00Z", metrics: null, metricsAt: null }],
    usage: "Paid ads, 3 months", usageEndsAt: "2026-03-03T18:29:59.000Z", exclusivity: null, exclusivityEndsAt: null, revisionsIncluded: null, advancePercent: null, paymentDays: null, notes: null, disclosure: [],
  },
  agreedAt: "2025-11-20T00:00:00Z", dueAt: null, invoicedAt: null, paidAt: "2025-12-10T00:00:00Z", receivedMinor: 50_000_00, tdsMinor: null, createdAt: "2025-11-20T00:00:00Z", updatedAt: "2025-12-10T00:00:00Z",
};
const renewal = (over: Partial<DraftInput> = {}): DraftInput => reply("Thanks!", { kind: "nudge", purpose: "usage_renewal", deal: paid, now: NOW, ...over });

describe("usage-rights renewal drafts", () => {
  it("names the end date and the extension price per month, the only amount it may state", async () => {
    const facts = dealFacts(renewal())!;
    expect(facts.usageRights).toEqual({ content: "1 reel", endsOn: "3 Mar", perMonth: "₹15,000" });
    expect(facts.allowedMinor).toEqual([15_000_00]);
    expect(facts.missing).toEqual([]);
    const prompt = buildDraftPrompt(renewal());
    expect(prompt.user).toContain("Usage rights end: 3 Mar");
    expect(prompt.user).toContain("Price to extend the usage rights: ₹15,000 per month");
    expect(prompt.user).toMatch(/no threats and no legal language/);
    expect(prompt.user).not.toContain("₹50,000");

    const { body, lintViolations, context } = await new HeuristicPipeline().draft(renewal());
    expect(body).toBe(
      "Hey hey! A quick heads-up: the usage rights for 1 reel end on 3 Mar. If you'd like to keep running it, I can extend them at ₹15,000 per month. " +
        "Otherwise, please stop using the content after that date. Let me know which works!\n– R",
    );
    expect(lintViolations).toEqual([]);
    expect(context?.missingFacts).toEqual([]);
    // The money check refuses any other amount, the old fee included.
    expect(lintDraft("Extend at ₹45,000 for 3 months?", prompt.lint)).toContainEqual(expect.stringContaining("₹15,000"));
    expect(lintDraft("The fee was ₹50,000.", prompt.lint)).toHaveLength(1);
  });

  it("without a usage price, asks how long and never names an amount, and flags the price", async () => {
    const prompt = buildDraftPrompt(renewal({ creator: unpriced }));
    expect(prompt.deal?.allowedMinor).toEqual([]);
    expect(prompt.user).toContain("Price to extend the usage rights: not set");
    expect(prompt.user).toContain("never state a price or any amount");
    expect(prompt.context.missingFacts).toEqual(["your usage-rights price per month"]);
    const { body, lintViolations, context } = await new HeuristicPipeline().draft(renewal({ creator: unpriced }));
    expect(body).toContain("how long would you like to extend for? I'll confirm the price.");
    expect(body).not.toMatch(/₹/);
    expect(lintViolations).toEqual([]);
    expect(context?.missingFacts).toEqual(["your usage-rights price per month"]);
    expect(lintDraft("I can extend at ₹10,000.", prompt.lint)).toEqual(["Don't state any amount of money"]);
  });
});

describe("exclusivity in brand replies", () => {
  const glow: ExclusivityNote = { dealId: "deal-glow", threadId: "t1", counterpartyHandle: "glowco", counterpartyName: "Glow Co", exclusivity: "No other skincare brands", endsAt: "2026-03-03T18:29:59.000Z" };

  it("tells the draft not to accept a possibly competing deal, and flags it for the creator", () => {
    const prompt = buildDraftPrompt(reply("We're a skincare brand, can you do 2 reels next week?", { exclusivities: [glow] }));
    expect(prompt.user).toContain("<exclusivity>");
    expect(prompt.user).toContain('- With @glowco until 3 Mar: "No other skincare brands"');
    expect(prompt.user).toContain("never accept the collaboration or agree dates or terms");
    expect(prompt.context.missingFacts).toEqual(["check this brand doesn't compete with your exclusivity with @glowco (until 3 Mar)"]);
    // A deal agreed elsewhere is named as typed.
    expect(buildDraftPrompt(reply("Hi!", { exclusivities: [{ ...glow, threadId: null, counterpartyHandle: "Glow Co", counterpartyName: "Glow Co" }] })).user).toContain("With Glow Co until 3 Mar");
  });

  it("stays out of replies that aren't to a brand, and out of purpose drafts", () => {
    expect(buildDraftPrompt(reply("Is coaching open?", { classificationLabel: "coaching_lead", exclusivities: [glow] })).user).not.toContain("<exclusivity>");
    expect(buildDraftPrompt(renewal({ exclusivities: [glow] })).user).not.toContain("<exclusivity>");
  });
});

describe("proof with payment drafts", () => {
  const owed: DealDto = { ...paid, stage: "invoiced", dueAt: "2026-02-10T18:29:59.000Z" };

  it("lets a payment reminder share the live post links, never results numbers", () => {
    const prompt = buildDraftPrompt(reply("Thanks!", { kind: "nudge", purpose: "payment_reminder", deal: owed, now: NOW }));
    expect(prompt.user).toContain("Live posts: https://www.instagram.com/reel/Cx1/");
    expect(prompt.user).toContain("never state views, reach or any other results number");
  });

  it("lets a cover note say the PDF has the post links and results", () => {
    const invoice = { id: "inv-1", dealId: owed.id, kind: "full", number: "RV-2026-27-001", status: "issued", totalMinor: 59_000_00, subtotalMinor: 50_000_00, taxMinor: 9_000_00, dueAt: "2026-02-25T18:29:59.000Z" } as InvoiceDto;
    const prompt = buildDraftPrompt(reply("Thanks!", { kind: "nudge", purpose: "invoice", deal: owed, invoice, now: NOW }));
    expect(prompt.user).toContain("The PDF also lists the live post links and their results");
    expect(prompt.user).toContain("You may say the PDF also includes the post links and their results");
    const plain = buildDraftPrompt(reply("Thanks!", { kind: "nudge", purpose: "invoice", deal: { ...owed, terms: { ...owed.terms, deliverables: [] } }, invoice, now: NOW }));
    expect(plain.user).not.toContain("post links");
  });
});

describe("usage and exclusivity end dates read from a conversation", () => {
  /** Wednesday 4 Nov 2026, noon in India. */
  const today = new Date("2026-11-04T06:30:00Z");
  const read = (text: string): DealSuggestionInput => ({ threadHistory: [{ direction: "inbound", text }], creator, now: today, timezone: "Asia/Kolkata" });
  const ends = (text: string) => suggestDealHeuristically(read(text), "test").terms;

  it("takes an end date that was stated, or a duration from a stated start", () => {
    expect(ends("1 reel. Usage rights on paid ads till 3 March 2027.").usageEndsAt).toBe("2027-03-03T18:29:59.000Z");
    expect(ends("Paid ads usage for 3 months from 1 Dec.").usageEndsAt).toBe("2027-03-01T18:29:59.000Z");
    expect(ends("No other skincare brands until 15 Jan.").exclusivityEndsAt).toBe("2027-01-15T18:29:59.000Z");
    expect(ends("Exclusivity for 30 days starting 10 Nov.").exclusivityEndsAt).toBe("2026-12-10T18:29:59.000Z");
  });

  it("never guesses one: a duration with no start, a question or a due date gives none", () => {
    const terms = ends("Usage rights for 3 months, and no other skincare brands for 30 days. Reel by Friday.");
    expect([terms.usageEndsAt, terms.exclusivityEndsAt]).toEqual([null, null]);
    expect(ends("Can we have usage till 3 March?").usageEndsAt).toBeNull();
    expect(ends("Post the reel by 3 March, usage is organic only.").usageEndsAt).toBeNull();
  });

  it("takes a model's end date as the end of that day, and keeps the reading for an invalid one", () => {
    const thread = read("Usage till 3 March 2027.");
    const fallback = suggestDealHeuristically(thread, "heuristic");
    expect(mergeDealSuggestion({ usage_end_date: "2027-04-01", exclusivity_end_date: null }, fallback, thread, "m").terms).toMatchObject({ usageEndsAt: "2027-04-01T18:29:59.000Z", exclusivityEndsAt: null });
    expect(mergeDealSuggestion({ usage_end_date: "3 March" }, fallback, thread, "m").terms.usageEndsAt).toBe("2027-03-03T18:29:59.000Z");
  });
});
