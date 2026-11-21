import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DEAL_TERMS, normalizeOfferAddOns, type DealDto, type OfferDto } from "@dealdock/core";
import { contentOf, resultsReminderText, resultsText, usageNoteText, usagePriceFor, usageReminderText } from "../src/lib/deals";
import { dealDraft, DEMO_MONEY } from "../src/lib/demo-data";
import { demoStore } from "../src/lib/demo-store";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T06:30:00Z");
const ZONE = "Asia/Kolkata";
const iso = (at: number) => new Date(at).toISOString();
const deal = (patch: Partial<DealDto> = {}): DealDto => ({
  id: "deal-1", threadId: "t-1", igAccountId: "ig-1", counterpartyHandle: "glowco", counterpartyName: "Glow Co", channel: "instagram",
  title: "Winter reel", dealType: "brand", amountMinor: 50_000_00, currencyCode: "INR", stage: "paid",
  terms: { ...EMPTY_DEAL_TERMS, deliverables: [{ id: "d1", label: "1 reel", dueAt: null, done: true }], usage: "Paid ads, 3 months", usageEndsAt: iso(NOW + 5 * DAY) },
  agreedAt: iso(NOW - 60 * DAY), dueAt: null, invoicedAt: null, paidAt: iso(NOW - 30 * DAY), receivedMinor: 50_000_00, tdsMinor: null, createdAt: iso(NOW - 60 * DAY), updatedAt: iso(NOW - 60 * DAY),
  ...patch,
});
const offer = (patch: Partial<OfferDto>): OfferDto => ({
  id: "o", igAccountId: null, name: "Reel", dealType: "brand", priceMinMinor: 60_000_00, priceMaxMinor: null, currencyCode: "INR", link: null, details: null, availability: null, active: true, sortOrder: 0, updatedAt: iso(NOW), ...patch,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usage and results words", () => {
  it("names what the rights cover and when they end, or ended", () => {
    expect(usageReminderText(deal(), NOW, "en-IN", ZONE)).toBe("@glowco's usage rights on 1 reel end 9 Nov");
    expect(usageReminderText(deal({ terms: { ...deal().terms, usageEndsAt: iso(NOW - 2 * DAY) } }), NOW, "en-IN", ZONE)).toBe("@glowco's usage rights on 1 reel ended 2 Nov");
    expect(contentOf(deal({ terms: { ...deal().terms, deliverables: [] } }))).toBe("Winter reel");
  });

  it("asks for results, stories first since they last a day", () => {
    const reel = { id: "d1", label: "1 reel", dueAt: null, done: true };
    const stories = { id: "d2", label: "2 stories", dueAt: null, done: true };
    expect(resultsReminderText(deal(), [reel])).toBe("Add results for 1 reel for @glowco");
    expect(resultsReminderText(deal(), [reel, stories])).toBe("Story results are easiest to grab now: 2 stories for @glowco");
  });

  it("writes a copyable usage note with the usage price, or a question when none is set", () => {
    expect(usageNoteText(deal(), 15_000_00, DEMO_MONEY, "en-IN", ZONE)).toBe(
      "Hi! A quick heads-up: the usage rights for 1 reel end on 9 Nov. If you'd like to keep running it, I can extend them at ₹15,000 per month. " +
        "Otherwise, please stop using the content after that date. Let me know which works!",
    );
    expect(usageNoteText(deal(), null, DEMO_MONEY, "en-IN", ZONE)).toContain("how long would you like to extend for? I'll confirm the price.");
    expect(usageNoteText(deal(), null, DEMO_MONEY, "en-IN", ZONE)).not.toMatch(/₹/);
  });

  it("takes the usage price from the creator's own or shared active brand offers", () => {
    const priced = normalizeOfferAddOns({ usagePerMonthMinor: 15_000_00 });
    expect(usagePriceFor(deal(), [offer({ id: "theirs", igAccountId: "ig-2", addOns: priced }), offer({ id: "paused", active: false, addOns: priced })])).toBeNull();
    expect(usagePriceFor(deal(), [offer({ id: "shared", addOns: priced })])).toBe(15_000_00);
  });

  it("copies results as plain text with links, numbers and the disclosure", () => {
    const posted = deal({
      terms: {
        ...deal().terms,
        deliverables: [{ id: "d1", label: "1 reel", dueAt: null, done: true, postUrl: "https://www.instagram.com/reel/Cx1/", postedAt: iso(NOW - 8 * DAY), metrics: { views: 12_400, reach: null, likes: 1_130, comments: null, shares: null, saves: 210 }, metricsAt: iso(NOW) }],
        disclosure: ["paid_partnership"],
      },
    });
    expect(resultsText(posted, "en-IN", ZONE)).toBe(
      "Results for Winter reel\n\n1 reel, posted 27 Oct\nhttps://www.instagram.com/reel/Cx1/\n12,400 views · 1,130 likes · 210 saves (as of 4 Nov)\n\nDisclosure: “Paid partnership” label turned on",
    );
  });
});

describe("the demo store", () => {
  it("keeps add-on prices on brand offers only", async () => {
    await demoStore.init();
    const saved = await demoStore.createOffer({ igAccountId: null, name: "Reel", dealType: "brand", priceMinMinor: 60_000_00, priceMaxMinor: null, link: null, details: null, availability: null, addOns: { ...normalizeOfferAddOns({ rushMinor: 5_000_00 })! }, active: true, sortOrder: 99 });
    expect(saved.addOns?.rushMinor).toBe(5_000_00);
    expect(saved.addOns?.usagePerMonthMinor).toBeNull();
    await expect(demoStore.createOffer({ igAccountId: null, name: "Coaching", dealType: "coaching", priceMinMinor: null, priceMaxMinor: null, link: null, details: null, availability: null, addOns: normalizeOfferAddOns({ rushMinor: 1 }), active: true, sortOrder: 98 }))
      .rejects.toMatchObject({ code: "offer_add_ons_are_for_brand_offers" });
    // Changing the type away from brand clears them, as the API does.
    expect((await demoStore.updateOffer(saved.id, { dealType: "other" })).addOns).toBeNull();
    await demoStore.deleteOffer(saved.id);
  });

  it("serves a rate-card link: public data for that creator only, and nothing once turned off", async () => {
    await demoStore.init();
    const token = await demoStore.setRateCardLink("ig-demo-diya", true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const theirs = await demoStore.createOffer({ igAccountId: "ig-demo-rohan", name: "Rohan's recipe reel", dealType: "brand", priceMinMinor: 40_000_00, priceMaxMinor: null, link: null, details: null, availability: null, addOns: null, active: true, sortOrder: 97 });
    const card = await demoStore.loadPublicRateCard(token!);
    expect(card?.handle).toBe("diya.moves");
    expect(card?.currencyCode).toBe("INR");
    expect(card?.offers.map((item) => item.name)).toContain("Reel + 2 stories");
    expect(card?.offers.map((item) => item.name)).not.toContain("Rohan's recipe reel");
    // Paused offers stay private, and nothing internal goes out.
    expect(card?.offers.map((item) => item.name)).not.toContain("Corporate wellness workshop");
    expect(Object.keys(card!.offers[0]!).sort()).toEqual(["addOns", "availability", "dealType", "details", "link", "name", "priceMaxMinor", "priceMinMinor"]);
    expect(await demoStore.setRateCardLink("ig-demo-diya", false)).toBeNull();
    expect(await demoStore.loadPublicRateCard(token!)).toBeNull();
    await demoStore.deleteOffer(theirs.id);
  });

  it("warns a brand's conversation about the same creator's exclusivity, never another creator's", async () => {
    await demoStore.init();
    await demoStore.updateDeal("deal-tealeaf", { terms: { exclusivity: "No other tea brands", exclusivityEndsAt: iso(Date.now() + 20 * DAY) } });
    expect((await demoStore.loadThread("t-kesar"))?.exclusivities?.map((note) => [note.counterpartyHandle, note.exclusivity])).toEqual([["tealeaf.co", "No other tea brands"]]);
    expect((await demoStore.loadThread("t-saffron"))?.exclusivities).toEqual([]);
    // Not a brand conversation: nothing to warn.
    expect((await demoStore.loadThread("t-rhea"))?.exclusivities).toEqual([]);
    await demoStore.updateDeal("deal-tealeaf", { terms: { exclusivity: null, exclusivityEndsAt: null } });
    expect((await demoStore.loadThread("t-kesar"))?.exclusivities).toEqual([]);
  });

  it("drafts a usage note for a paid deal, flags a missing price, and marks the reminder done", async () => {
    vi.useFakeTimers();
    await demoStore.init();
    const glow = await demoStore.updateDeal("deal-glowtonic", { terms: { usageEndsAt: iso(Date.now() + 5 * DAY) } });
    const drafting = demoStore.generateDraft(glow.threadId!, { purpose: "usage_renewal", dealId: "deal-glowtonic" });
    await vi.advanceTimersByTimeAsync(700);
    const draft = await drafting;
    expect(draft.purpose).toBe("usage_renewal");
    expect(draft.kind).toBe("nudge");
    expect(draft.body).toContain("usage rights for 1 reel and 2 stories end on");
    expect(draft.body).not.toMatch(/₹/);
    expect(draft.context?.missingFacts).toEqual(["your usage-rights price per month"]);

    const handled = await demoStore.setUsageHandled("deal-glowtonic", true);
    expect(handled.usageHandledAt).toBeTruthy();
    expect((await demoStore.setUsageHandled("deal-glowtonic", false)).usageHandledAt).toBeNull();
  });

  it("fetches fixed post results, never for a story or a deliverable not posted", async () => {
    vi.useFakeTimers();
    await demoStore.init();
    const deliverables = [
      { id: "d1", label: "1 reel", dueAt: null, done: true, postUrl: "https://www.instagram.com/reel/Cx1AbC9/", postedAt: iso(Date.now() - 8 * DAY) },
      { id: "d2", label: "2 stories", dueAt: null, done: true, postUrl: "https://www.instagram.com/stories/x/1/", postedAt: iso(Date.now() - 2 * DAY) },
      { id: "d3", label: "1 post", dueAt: null, done: false },
    ];
    await demoStore.updateDeal("deal-tealeaf", { terms: { deliverables } });
    const fetching = demoStore.fetchInsights("deal-tealeaf", "d1");
    await vi.advanceTimersByTimeAsync(600);
    const fetched = await fetching;
    expect(fetched.terms.deliverables[0]!.metrics).toEqual({ views: 12_400, reach: 9_800, likes: 1_130, comments: 84, shares: 40, saves: 210 });
    // Assertions attach before the timers run, so neither refusal goes unhandled.
    const story = expect(demoStore.fetchInsights("deal-tealeaf", "d2")).rejects.toMatchObject({ code: "story_results_not_available" });
    const unposted = expect(demoStore.fetchInsights("deal-tealeaf", "d3")).rejects.toMatchObject({ code: "post_link_required" });
    await vi.advanceTimersByTimeAsync(1_200);
    await story;
    await unposted;
  });

  it("writes the demo's usage note with the creator's usage price when it is set", () => {
    const priced = [offer({ addOns: normalizeOfferAddOns({ usagePerMonthMinor: 15_000_00 }) })];
    expect(dealDraft("usage_renewal", deal({ igAccountId: "ig-demo-diya" }), DEMO_MONEY, ZONE, NOW, undefined, priced)).toBe(
      "Heyy! A quick heads-up: the usage rights for 1 reel end on 9 Nov. If you'd like to keep running it, I can extend them at ₹15,000 per month. Otherwise, please stop using the content after that date 🙏 – D",
    );
  });
});
