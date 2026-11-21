import { describe, expect, it } from "vitest";
import {
  addOnPrice,
  addOnsAsked,
  EMPTY_DEAL_TERMS,
  exclusivitiesAgainst,
  invoiceProof,
  isExclusivityActive,
  isStoryDeliverable,
  metricsLine,
  normalizeDealTerms,
  normalizeOfferAddOns,
  resultsDue,
  usageReminderDue,
} from "../src";
import type { DealDto, DealTerms } from "../src";

const DAY = 86_400_000;
const NOW = Date.parse("2026-03-01T10:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();
const terms = (patch: Partial<DealTerms>): DealTerms => ({ ...EMPTY_DEAL_TERMS, ...patch });
const deal = (patch: Partial<DealDto> = {}): DealDto => ({
  id: "deal_1", threadId: "thread_1", igAccountId: "ig_1", counterpartyHandle: "glowco", counterpartyName: null, channel: "instagram",
  title: "1 reel", dealType: "brand", amountMinor: 50_000_00, currencyCode: "INR", stage: "paid", terms: EMPTY_DEAL_TERMS,
  agreedAt: iso(NOW - 60 * DAY), dueAt: null, invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null, createdAt: iso(NOW - 60 * DAY), updatedAt: iso(NOW - 60 * DAY),
  ...patch,
});

describe("usage-rights reminder window", () => {
  const ending = (days: number, patch: Partial<DealDto> = {}) => deal({ terms: terms({ usage: "Paid ads, 3 months", usageEndsAt: iso(NOW + days * DAY) }), ...patch });

  it("shows from 14 days before the end until 7 days after", () => {
    expect(usageReminderDue(ending(15), NOW)).toBe(false);
    expect(usageReminderDue(ending(14), NOW)).toBe(true);
    expect(usageReminderDue(ending(0), NOW)).toBe(true);
    expect(usageReminderDue(ending(-7), NOW)).toBe(true);
    expect(usageReminderDue(ending(-8), NOW)).toBe(false);
  });

  it("stops once handled, for a cancelled deal, and without an end date", () => {
    expect(usageReminderDue(ending(3, { usageHandledAt: iso(NOW - DAY) }), NOW)).toBe(false);
    expect(usageReminderDue(ending(3, { stage: "cancelled" }), NOW)).toBe(false);
    expect(usageReminderDue(deal({ terms: terms({ usage: "Organic only" }) }), NOW)).toBe(false);
    // Open and paid deals both get it: rights usually outlast the payment.
    expect(usageReminderDue(ending(3, { stage: "agreed" }), NOW)).toBe(true);
  });
});

describe("exclusivity", () => {
  const exclusive = (patch: Partial<DealTerms>, extra: Partial<DealDto> = {}) => deal({ terms: terms({ exclusivity: "No other skincare brands", exclusivityEndsAt: iso(NOW + 10 * DAY), ...patch }), ...extra });

  it("is active with words and an end date still ahead, on a deal that isn't cancelled", () => {
    expect(isExclusivityActive(exclusive({}), NOW)).toBe(true);
    expect(isExclusivityActive(exclusive({ exclusivityEndsAt: iso(NOW - 1) }), NOW)).toBe(false);
    expect(isExclusivityActive(exclusive({ exclusivityEndsAt: null }), NOW)).toBe(false);
    expect(isExclusivityActive(exclusive({ exclusivity: null }), NOW)).toBe(false);
    expect(isExclusivityActive(exclusive({ exclusivity: "None" }), NOW)).toBe(false);
    expect(isExclusivityActive(exclusive({}, { stage: "cancelled" }), NOW)).toBe(false);
  });

  it("warns only another brand's conversation on the same creator account", () => {
    const deals = [
      exclusive({}, { id: "glow", counterpartyHandle: "glowco" }),
      exclusive({ exclusivity: "No other tea brands", exclusivityEndsAt: iso(NOW + 3 * DAY) }, { id: "elsewhere", threadId: null, counterpartyHandle: "Tea House", counterpartyName: "Tea House" }),
      exclusive({}, { id: "other-creator", igAccountId: "ig_2", counterpartyHandle: "rivalco" }),
    ];
    const notes = exclusivitiesAgainst(deals, { igAccountId: "ig_1", counterpartyHandle: "kesarandclay" }, NOW);
    // Soonest ending first; another creator's exclusivity never shows.
    expect(notes.map((note) => note.dealId)).toEqual(["elsewhere", "glow"]);
    expect(notes[1]).toEqual({ dealId: "glow", threadId: "thread_1", counterpartyHandle: "glowco", counterpartyName: null, exclusivity: "No other skincare brands", endsAt: iso(NOW + 10 * DAY) });
    // The brand it was agreed with is not warned about itself, however its handle is written.
    expect(exclusivitiesAgainst(deals, { igAccountId: "ig_1", counterpartyHandle: "@GlowCo" }, NOW).map((note) => note.dealId)).toEqual(["elsewhere"]);
  });
});

describe("results due", () => {
  const posted = (label: string, daysAgo: number, metrics: DealTerms["deliverables"][number]["metrics"] = null) =>
    ({ id: label, label, dueAt: null, done: true, postUrl: "https://www.instagram.com/reel/abc/", postedAt: iso(NOW - daysAgo * DAY), metrics, metricsAt: null });

  it("asks 7 days after posting, a story after 1, until results are added", () => {
    const due = resultsDue(deal({ terms: terms({ deliverables: [posted("1 reel", 7), posted("1 carousel", 6), posted("2 stories", 1), { id: "x", label: "1 post", dueAt: null, done: true }] }) }), NOW);
    expect(due.map((item) => item.label)).toEqual(["1 reel", "2 stories"]);
    const counted = posted("1 reel", 9, { views: 100, reach: null, likes: null, comments: null, shares: null, saves: null });
    expect(resultsDue(deal({ terms: terms({ deliverables: [counted] }) }), NOW)).toEqual([]);
    // Every number empty still counts as no results.
    const empty = posted("1 reel", 9, { views: null, reach: null, likes: null, comments: null, shares: null, saves: null });
    expect(resultsDue(deal({ terms: terms({ deliverables: [empty] }) }), NOW)).toHaveLength(1);
    expect(resultsDue(deal({ stage: "cancelled", terms: terms({ deliverables: [posted("1 reel", 9)] }) }), NOW)).toEqual([]);
  });

  it("knows a story by its label", () => {
    expect(["2 stories", "1 IG story", "Story"].every(isStoryDeliverable)).toBe(true);
    expect(["1 reel", "History deep-dive video"].some(isStoryDeliverable)).toBe(false);
  });

  it("puts each posted deliverable and the ticked disclosure on the invoice", () => {
    const metrics = { views: 12_400, reach: 9_800, likes: null, comments: null, shares: null, saves: 210 };
    const proof = invoiceProof(terms({ deliverables: [posted("1 reel", 9, metrics), { id: "s", label: "2 stories", dueAt: null, done: false }], disclosure: ["paid_partnership", "brand_tagged"] }));
    expect(proof?.posts).toEqual([{ label: "1 reel", postUrl: "https://www.instagram.com/reel/abc/", postedAt: iso(NOW - 9 * DAY), metrics, metricsAt: null }]);
    expect(proof?.disclosure).toEqual(["“Paid partnership” label turned on", "Brand tagged"]);
    expect(metricsLine(metrics)).toBe("12,400 views · 9,800 reach · 210 saves");
    expect(invoiceProof(EMPTY_DEAL_TERMS)).toBeNull();
  });
});

describe("deal terms keep older deals valid", () => {
  it("reads a deal saved before dates, posts and disclosure existed", () => {
    const stored = { deliverables: [{ id: "d1", label: "1 reel", dueAt: null, done: true }], usage: "Organic only", exclusivity: null, revisionsIncluded: 1, advancePercent: null, paymentDays: 30, notes: null };
    const read = normalizeDealTerms(stored);
    expect(read).toMatchObject({ usageEndsAt: null, exclusivityEndsAt: null, disclosure: [] });
    expect(read.deliverables[0]).toEqual({ id: "d1", label: "1 reel", dueAt: null, done: true });
    // A base from an older session lacking the keys still comes back complete.
    expect(normalizeDealTerms({ notes: "x" }, stored as unknown as DealTerms)).toMatchObject({ usageEndsAt: null, disclosure: [] });
  });

  it("accepts https post links and whole counts, and drops unknown checklist items", () => {
    const item = { id: "d1", label: "1 reel", dueAt: null, done: true, postUrl: "https://www.instagram.com/reel/abc/", postedAt: iso(NOW), metrics: { views: 1, reach: 2, likes: 3, comments: 4, shares: 5, saves: 6 }, metricsAt: iso(NOW) };
    expect(normalizeDealTerms({ deliverables: [item], disclosure: ["brand_tagged", "brand_tagged", "retired_item"] })).toMatchObject({ deliverables: [item], disclosure: ["brand_tagged"] });
    for (const bad of [{ ...item, postUrl: "http://instagram.com/p/x" }, { ...item, postUrl: `https://x.co/${"a".repeat(500)}` }, { ...item, metrics: { ...item.metrics, views: -1 } }, { ...item, metrics: { ...item.metrics, likes: 1.5 } }]) {
      expect(() => normalizeDealTerms({ deliverables: [bad] })).toThrow();
    }
    expect(() => normalizeDealTerms({ usageEndsAt: "3 March" })).toThrow();
  });
});

describe("add-on prices", () => {
  it("keeps whole non-negative prices, fills the rest with null and is null when none is set", () => {
    expect(normalizeOfferAddOns({ usagePerMonthMinor: 15_000_00, rushMinor: 0 })).toEqual({
      usagePerMonthMinor: 15_000_00, partnershipAdsPerMonthMinor: null, exclusivityPerMonthMinor: null, extraRevisionMinor: null, rushMinor: 0, rawFootageMinor: null,
    });
    expect(normalizeOfferAddOns({ usagePerMonthMinor: null })).toBeNull();
    expect(normalizeOfferAddOns(null)).toBeNull();
    for (const bad of [{ usagePerMonthMinor: -1 }, { rushMinor: 10.5 }, { rawFootageMinor: Number.MAX_SAFE_INTEGER + 1 }, { usagePerMonthMinor: "15000" }]) {
      expect(() => normalizeOfferAddOns(bad)).toThrow();
    }
  });

  it("knows which add-ons a brand asks about", () => {
    expect(addOnsAsked("Love it! Can we whitelist the reel and run it as ads? Also need usage rights for 3 months.")).toEqual(["usagePerMonthMinor", "partnershipAdsPerMonthMinor"]);
    expect(addOnsAsked("We'd need category exclusivity, a rush turnaround and the raw footage")).toEqual(["exclusivityPerMonthMinor", "rushMinor", "rawFootageMinor"]);
    expect(addOnsAsked("Could we get one more round of edits?")).toEqual(["extraRevisionMinor"]);
    expect(addOnsAsked("What are your rates for a reel?")).toEqual([]);
  });

  it("takes the first brand offer that sets the price", () => {
    const offers = [
      { dealType: "coaching", addOns: { usagePerMonthMinor: 1 } as never },
      { dealType: "brand", addOns: null },
      { dealType: "brand", addOns: normalizeOfferAddOns({ usagePerMonthMinor: 15_000_00 }) },
    ];
    expect(addOnPrice(offers, "usagePerMonthMinor")).toBe(15_000_00);
    expect(addOnPrice(offers, "rushMinor")).toBeNull();
  });
});
