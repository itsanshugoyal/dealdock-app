import { describe, expect, it } from "vitest";
import { dealMissing, mergeDealSuggestion, suggestDealHeuristically } from "../src/deal-suggestion";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import { buildDealPrompt } from "../src/prompts";
import type { CreatorContext, DealSuggestionInput } from "../src/types";

const inr: CreatorContext = { businessSummary: "Skincare creator", currencyCode: "INR", locale: "en-IN", typicalBrandDealMinor: null, typicalCoachingMinor: null, typicalCourseMinor: null, styleCard: null, correctionExamples: [] };
const usd: CreatorContext = { ...inr, currencyCode: "USD", locale: "en-US" };
/** Wednesday 4 Nov 2026, noon in India. */
const NOW = new Date("2026-11-04T06:30:00Z");
type Line = ["them" | "me", string];
const input = (lines: Line[], over: Partial<DealSuggestionInput> = {}): DealSuggestionInput => ({
  threadHistory: lines.map(([who, text]) => ({ direction: who === "them" ? "inbound" : "outbound", text })),
  creator: inr,
  now: NOW,
  timezone: "Asia/Kolkata",
  ...over,
});
const suggest = (lines: Line[], over: Partial<DealSuggestionInput> = {}) => suggestDealHeuristically(input(lines, over), "test");
/** End of that day in India (UTC+5:30). */
const ist = (date: string) => `${date}T18:29:59.000Z`;

describe("heuristic deal suggestion", () => {
  it("reads every amount format in the org currency, as exact minor units", () => {
    const cases: Array<[string, CreatorContext, number]> = [
      ["₹50,000", inr, 5_000_000], ["50k", inr, 5_000_000], ["50K", inr, 5_000_000], ["Rs 50000", inr, 5_000_000],
      ["Rs. 50000", inr, 5_000_000], ["₹1,20,000", inr, 12_000_000], ["1.5L", inr, 15_000_000], ["1.5 lakh", inr, 15_000_000],
      ["50 hazaar", inr, 5_000_000], ["$500", usd, 50_000], ["USD 500", usd, 50_000], ["$1,299.50", usd, 129_950],
    ];
    for (const [amount, creator, minor] of cases) {
      const result = suggest([["them", `We can do ${amount} for 1 reel.`], ["me", "Deal! Let's do it."]], { creator });
      expect(result.amountMinor, amount).toBe(minor);
    }
  });

  it("never converts another currency or reads an amount nobody agreed", () => {
    expect(suggest([["them", "We can do $500 for 1 reel."], ["me", "Let's do it."]]).amountMinor).toBeNull();
    const negotiating = suggest([["them", "Budget is ₹40,000 for 1 reel."], ["me", "My rate for that is ₹55,000."], ["them", "Can you do ₹45,000?"]]);
    expect(negotiating.amountMinor).toBeNull();
    expect(negotiating.missing).toContain("fee");
    // A range has no midpoint; an older quote doesn't leak past it.
    expect(suggest([["me", "My rate is ₹60k."], ["them", "Budget is 30-40k for a reel"], ["me", "Let's do it!"]]).amountMinor).toBeNull();
    expect(suggest([["them", "₹40k for the reel, or ₹60k with 2 stories"], ["me", "Let's do it"]]).amountMinor).toBeNull();
    // "let me check" is not a yes.
    expect(suggest([["me", "My rate is ₹50k."], ["them", "Sounds good, let me check with the team"]]).amountMinor).toBeNull();
  });

  it("takes an accepted offer or a confirmed quote, but not one the conversation reopened", () => {
    expect(suggest([["them", "Our budget is ₹40,000 for 1 reel."], ["me", "Works for me, let's do it!"]]).amountMinor).toBe(4_000_000);
    expect(suggest([["me", "₹50,000 with 50% advance (₹25,000)."], ["them", "Approved. Let's proceed."]]).amountMinor).toBe(5_000_000);
    const reopened = suggest([["me", "₹50,000 for 1 reel."], ["them", "Let's proceed!"], ["them", "Actually can we do ₹45,000 instead?"]]);
    expect(reopened.amountMinor).toBeNull();
  });

  it("reads the full English deal", () => {
    const result = suggest([
      ["them", "Hi! We'd love 1 reel + 2 stories for our Diwali launch. Budget is ₹40,000."],
      ["me", "Thanks! My rate for that is ₹50,000 with 50% advance."],
      ["them", "Done, let's proceed! Reel by Friday, stories next week. Payment within 30 days of invoice. Usage rights for 3 months on paid ads, and no other skincare brands for 30 days. 2 rounds of revisions included."],
    ]);
    expect(result).toEqual({
      title: "1 reel + 2 stories",
      dealType: "brand",
      amountMinor: 5_000_000,
      dueAt: null,
      terms: {
        deliverables: [
          { id: "d1", label: "1 reel", dueAt: ist("2026-11-06"), done: false },
          { id: "d2", label: "2 stories", dueAt: ist("2026-11-15"), done: false },
        ],
        usage: "Paid ads, 3 months",
        usageEndsAt: null,
        exclusivity: "No other skincare brands, 30 days",
        exclusivityEndsAt: null,
        revisionsIncluded: 2,
        advancePercent: 50,
        paymentDays: 30,
        notes: null,
        disclosure: [],
      },
      missing: [],
      modelVersion: "test",
    });
  });

  it("reads a Hinglish deal: counts, advance, payment days and dates", () => {
    const result = suggest([
      ["them", "Hi! Humein ek reel aur do stories chahiye, budget 50k hai."],
      ["me", "Done, 50k chalega. 50% advance chahiye, baaki payment 30 din mein."],
      ["them", "Theek hai, pakka. Reel Friday tak aur stories agle hafte."],
    ]);
    expect(result.title).toBe("1 reel + 2 stories");
    expect(result.amountMinor).toBe(5_000_000);
    expect(result.terms).toMatchObject({ advancePercent: 50, paymentDays: 30 });
    expect(result.terms.deliverables.map((d) => d.dueAt)).toEqual([ist("2026-11-06"), ist("2026-11-15")]);
    expect(result.missing).toEqual(["usage rights"]);
    // "do" is only a number in Hinglish.
    expect(suggest([["them", "Can you do stories? Also 1 reel."]]).terms.deliverables.map((d) => d.label)).toEqual(["1 reel"]);
  });

  it("resolves relative dates against now in the org time zone", () => {
    const due = (text: string, timezone = "Asia/Kolkata") => suggest([["them", text]], { timezone }).terms.deliverables[0]?.dueAt;
    expect(due("1 reel by Friday")).toBe(ist("2026-11-06"));
    expect(due("1 reel by next Friday")).toBe(ist("2026-11-13"));
    expect(due("1 reel kal tak")).toBe(ist("2026-11-05"));
    expect(due("1 reel by the 15th")).toBe(ist("2026-11-15"));
    expect(due("1 reel by the 2nd")).toBe(ist("2026-12-02"));
    expect(due("1 reel on 20 Nov")).toBe(ist("2026-11-20"));
    expect(due("1 reel by Jan 5")).toBe(ist("2027-01-05"));
    expect(due("1 reel by 15/11")).toBe(ist("2026-11-15"));
    expect(due("1 reel in 3 days")).toBe(ist("2026-11-07"));
    expect(due("1 reel by end of month")).toBe(ist("2026-11-30"));
    expect(due("1 reel by Friday", "America/New_York")).toBe("2026-11-07T04:59:59.000Z");
    expect(due("1 reel, available 24/7")).toBeNull();
  });

  it("counts relative dates from the day their message was sent, in the org's zone", () => {
    const monday = new Date("2026-11-09T06:30:00Z");
    const fiveDaysAgo = "2026-11-04T06:30:00Z"; // Wednesday
    const read = (text: string, sentAt?: string) =>
      suggestDealHeuristically({ threadHistory: [{ direction: "inbound", text, sentAt }], creator: inr, now: monday, timezone: "Asia/Kolkata" }, "test");
    const due = (text: string, sentAt?: string) => read(text, sentAt).terms.deliverables[0]?.dueAt;
    expect(due("1 reel by Friday", fiveDaysAgo)).toBe(ist("2026-11-06"));
    expect(due("1 reel by Friday")).toBe(ist("2026-11-13"));
    expect(due("1 reel kal tak", fiveDaysAgo)).toBe(ist("2026-11-05"));
    expect(due("1 reel in 3 days", fiveDaysAgo)).toBe(ist("2026-11-07"));
    expect(due("1 reel next week", fiveDaysAgo)).toBe(ist("2026-11-15"));
    expect(read("1 reel. Payment by Friday", fiveDaysAgo).dueAt).toBe(ist("2026-11-06"));
    // 8 pm UTC on 4 Nov is already Thursday 5 Nov in India.
    expect(due("1 reel kal tak", "2026-11-04T20:00:00Z")).toBe(ist("2026-11-06"));
    expect(due("1 reel by Friday", "not a date")).toBe(ist("2026-11-13"));
  });

  it("shows the model when each message was sent", () => {
    const prompt = buildDealPrompt({
      threadHistory: [{ direction: "inbound", text: "1 reel by Friday", sentAt: "2026-11-04T20:00:00Z" }, { direction: "outbound", text: "Done!" }],
      creator: inr, now: NOW, timezone: "Asia/Kolkata",
    });
    expect(prompt.user).toContain("THEM (sent Thursday, 2026-11-05): 1 reel by Friday");
    expect(prompt.user).toContain("CREATOR: Done!");
    expect(prompt.system).toContain("from the day their message was sent");
  });

  it("matches each date to its deliverable and keeps payment dates apart", () => {
    const result = suggest([["them", "1 reel, 2 stories and 1 post. Reel by Friday and stories next week, post kal. Payment by the 30th."]]);
    expect(result.terms.deliverables.map((d) => [d.label, d.dueAt])).toEqual([
      ["1 reel", ist("2026-11-06")],
      ["2 stories", ist("2026-11-15")],
      ["1 post", ist("2026-11-05")],
    ]);
    expect(result.dueAt).toBe(ist("2026-11-30"));
    expect(result.terms.paymentDays).toBeNull();
    // A date before the deliverable, and a date about content in general.
    expect(suggest([["them", "By Friday for the reel please"], ["them", "1 reel"]]).terms.deliverables[0]!.dueAt).toBe(ist("2026-11-06"));
    expect(suggest([["them", "1 reel and 2 stories. Everything live by the 20th."]]).terms.deliverables.every((d) => d.dueAt === ist("2026-11-20"))).toBe(true);
    // "Paid collab" describes the deal; it is not a payment date.
    const paidCollab = suggest([["them", "Paid collab: 1 reel by Friday"]]);
    expect([paidCollab.terms.deliverables[0]!.dueAt, paidCollab.dueAt]).toEqual([ist("2026-11-06"), null]);
    const payment = suggest([["them", "1 reel. Payment by Friday for the reel"]]);
    expect([payment.terms.deliverables[0]!.dueAt, payment.dueAt]).toEqual([null, ist("2026-11-06")]);
  });

  it("lists what is unsettled, in plain words", () => {
    expect(suggest([["them", "Hey, loved your page!"]]).missing).toEqual(["fee", "deliverables", "due dates", "payment terms", "usage rights"]);
    const coaching = suggest([["them", "I want the 12-week coaching, 8 sessions. ₹30,000 works, let's proceed. Net 15."]]);
    expect(coaching.dealType).toBe("coaching");
    expect(coaching.amountMinor).toBe(3_000_000);
    expect(coaching.terms.paymentDays).toBe(15);
    expect(coaching.missing).toEqual(["due dates"]);
  });

  it("ignores terms that are only asked about", () => {
    const result = suggest([["them", "Would you want usage rights for 3 months? Is 50% advance ok?"]]);
    expect(result.terms.usage).toBeNull();
    expect(result.terms.advancePercent).toBeNull();
  });

  it("is what the heuristic pipeline returns, stamped as the fallback", async () => {
    const result = await new HeuristicPipeline().suggestDeal(input([["them", "1 reel for ₹20,000, let's proceed"]]));
    expect(result.amountMinor).toBe(2_000_000);
    expect(result.modelVersion).toBe("heuristic-fallback-1");
  });
});

describe("model answers, field by field", () => {
  const thread = input([["me", "₹50,000 for 1 reel + 2 stories."], ["them", "Let's proceed. Reel by Friday."]]);
  const fallback = suggestDealHeuristically(thread, "heuristic");
  const answer = {
    title: "Diwali launch", dealType: "brand", amount_major: 50000, payment_due_date: "2026-11-30",
    deliverables: [{ label: "1 reel", due_date: "2026-11-06" }, { label: "2 stories", due_date: null }],
    usage: "Organic only", exclusivity: null, revisionsIncluded: 1, advancePercent: 50, paymentDays: null, notes: null,
  };

  it("keeps valid fields, converts dates to the end of the org's day and recomputes missing", () => {
    const merged = mergeDealSuggestion(answer, fallback, thread, "groq:test");
    expect(merged).toMatchObject({ title: "Diwali launch", dealType: "brand", amountMinor: 5_000_000, dueAt: ist("2026-11-30"), modelVersion: "groq:test" });
    expect(merged.terms).toEqual({
      deliverables: [
        { id: "d1", label: "1 reel", dueAt: ist("2026-11-06"), done: false },
        { id: "d2", label: "2 stories", dueAt: null, done: false },
      ],
      usage: "Organic only", usageEndsAt: null, exclusivity: null, exclusivityEndsAt: null, revisionsIncluded: 1, advancePercent: 50, paymentDays: null, notes: null, disclosure: [],
    });
    expect(merged.missing).toEqual(["due dates"]);
  });

  it("falls back to the heuristic for invalid fields, and for amounts the conversation never names", () => {
    const merged = mergeDealSuggestion(
      { ...answer, title: "", dealType: "sponsorship", amount_major: 55000, payment_due_date: "next Friday", advancePercent: 150, deliverables: [{ label: "1 reel", due_date: "2026-02-30" }] },
      fallback,
      thread,
      "groq:test",
    );
    expect(merged.title).toBe(fallback.title);
    expect(merged.dealType).toBe(fallback.dealType);
    expect(merged.amountMinor).toBe(5_000_000);
    expect(merged.dueAt).toBe(fallback.dueAt);
    expect(merged.terms.advancePercent).toBe(fallback.terms.advancePercent);
    expect(merged.terms.deliverables).toEqual(fallback.terms.deliverables);
    expect(mergeDealSuggestion({ ...answer, amount_major: null }, fallback, thread, "m").amountMinor).toBeNull();
    expect(mergeDealSuggestion("not an object", fallback, thread, "m")).toEqual({ ...fallback, modelVersion: "m" });
  });

  it("names missing terms in a fixed order", () => {
    const terms = { deliverables: [], usage: null, usageEndsAt: null, exclusivity: null, exclusivityEndsAt: null, revisionsIncluded: null, advancePercent: null, paymentDays: null, notes: null, disclosure: [] };
    expect(dealMissing({ amountMinor: 1, dealType: "course", dueAt: "2026-11-30T00:00:00Z", terms })).toEqual(["deliverables", "due dates"]);
  });
});
