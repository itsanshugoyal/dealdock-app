import { describe, expect, it } from "vitest";
import { isFestivePitchSeason, renewalsDue, type RenewalDeal } from "../src/renewals";

const ZONE = "Asia/Kolkata";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-07T06:30:00Z"); // 12:00 on 7 Nov in Kolkata, outside the festive window

let counter = 0;
function deal(patch: Partial<RenewalDeal> = {}): RenewalDeal {
  counter += 1;
  const paidAt = patch.paidAt === undefined ? new Date(NOW - 70 * DAY).toISOString() : patch.paidAt;
  return {
    id: `deal-${counter}`, igAccountId: "ig-1", counterpartyHandle: "glowco", dealType: "brand", stage: "paid", amountMinor: 50_000_00,
    agreedAt: new Date(NOW - 90 * DAY).toISOString(), createdAt: new Date(NOW - 90 * DAY).toISOString(), paidAt, renewalHandledAt: null, ...patch,
  };
}
const ids = (deals: RenewalDeal[], now = NOW) => renewalsDue(deals, now, ZONE).map((item) => item.deal.id);

describe("renewal prompts", () => {
  it("prompts for a paid brand deal 60 or more days after payment, up to a year", () => {
    const due = deal({ id: "due" });
    expect(ids([due])).toEqual(["due"]);
    expect(ids([deal({ id: "recent", paidAt: new Date(NOW - 59 * DAY).toISOString() })])).toEqual([]);
    expect(ids([deal({ id: "sixty", paidAt: new Date(NOW - 60 * DAY).toISOString() })])).toEqual(["sixty"]);
    expect(ids([deal({ id: "year", paidAt: new Date(NOW - 365 * DAY).toISOString() })])).toEqual(["year"]);
    expect(ids([deal({ id: "old", paidAt: new Date(NOW - 366 * DAY).toISOString() })])).toEqual([]);
  });

  it("skips coaching and other sales, unpaid deals, handled prompts and deals without a payment date", () => {
    expect(ids([deal({ dealType: "coaching" })])).toEqual([]);
    expect(ids([deal({ dealType: "other" })])).toEqual([]);
    expect(ids([deal({ stage: "cancelled" })])).toEqual([]);
    expect(ids([deal({ renewalHandledAt: new Date(NOW - DAY).toISOString() })])).toEqual([]);
    expect(ids([deal({ paidAt: null })])).toEqual([]);
  });

  it("looks only at the latest deal with each brand, per creator account", () => {
    const old = deal({ id: "old", agreedAt: new Date(NOW - 200 * DAY).toISOString(), paidAt: new Date(NOW - 180 * DAY).toISOString() });
    const latest = deal({ id: "latest", paidAt: new Date(NOW - 20 * DAY).toISOString() });
    // The newer payment is too recent, so the older one doesn't prompt either.
    expect(ids([old, latest])).toEqual([]);
    // A newer deal that was cancelled isn't a paid brand deal: no prompt.
    expect(ids([old, deal({ stage: "cancelled", agreedAt: new Date(NOW - 10 * DAY).toISOString() })])).toEqual([]);
    // The same handle typed differently is the same brand.
    expect(ids([deal({ id: "a", counterpartyHandle: "@GlowCo " }), deal({ id: "b", agreedAt: new Date(NOW - 80 * DAY).toISOString() })])).toEqual(["b"]);
    // Another creator account pitches the same brand separately.
    expect(ids([deal({ id: "mine" }), deal({ id: "theirs", igAccountId: "ig-2" })]).sort()).toEqual(["mine", "theirs"]);
  });

  it("never prompts while another deal with the brand is open", () => {
    expect(ids([deal({ id: "paid" }), deal({ stage: "agreed", paidAt: null, agreedAt: new Date(NOW - 100 * DAY).toISOString() })])).toEqual([]);
    expect(ids([deal({ id: "paid" }), deal({ stage: "invoiced", paidAt: null, agreedAt: new Date(NOW - 100 * DAY).toISOString() })])).toEqual([]);
    expect(ids([deal({ id: "paid" }), deal({ stage: "agreed", paidAt: null, counterpartyHandle: "someone.else" })])).toEqual(["paid"]);
  });

  it("puts the biggest past deal first", () => {
    const small = deal({ id: "small", counterpartyHandle: "a", amountMinor: 10_000_00 });
    const big = deal({ id: "big", counterpartyHandle: "b", amountMinor: 90_000_00 });
    expect(ids([small, big])).toEqual(["big", "small"]);
  });

  it("drops the bar to 30 days from 1 September to 15 October, in the org's time zone", () => {
    const sep = Date.parse("2026-09-20T06:30:00Z");
    const paid35 = deal({ id: "paid35", paidAt: new Date(sep - 35 * DAY).toISOString() });
    const paid25 = deal({ id: "paid25", counterpartyHandle: "x", paidAt: new Date(sep - 25 * DAY).toISOString() });
    expect(ids([paid35, paid25], sep)).toEqual(["paid35"]);
    expect(renewalsDue([paid35], sep, ZONE)[0]?.festive).toBe(true);
    expect(renewalsDue([deal()], NOW, ZONE)[0]?.festive).toBe(false);

    // 18:30 UTC on 31 Aug is already 1 Sep in Kolkata, but not yet in New York.
    expect(isFestivePitchSeason(Date.parse("2026-08-31T18:29:59Z"), ZONE)).toBe(false);
    expect(isFestivePitchSeason(Date.parse("2026-08-31T18:30:00Z"), ZONE)).toBe(true);
    expect(isFestivePitchSeason(Date.parse("2026-09-01T03:00:00Z"), "America/New_York")).toBe(false);
    // 15 Oct is the last day; 16 Oct in Kolkata starts at 18:30 UTC on the 15th.
    expect(isFestivePitchSeason(Date.parse("2026-10-15T18:29:00Z"), ZONE)).toBe(true);
    expect(isFestivePitchSeason(Date.parse("2026-10-15T18:30:00Z"), ZONE)).toBe(false);
    expect(isFestivePitchSeason(Date.parse("2026-12-01T00:00:00Z"), ZONE)).toBe(false);
  });

  it("counts calendar days in the org's time zone", () => {
    const now = Date.parse("2026-11-07T19:00:00Z"); // 00:30 on 8 Nov in Kolkata
    // Paid at 23:30 on 9 Sep in Kolkata (18:00 UTC): 60 calendar days before 8 Nov there, though under 60 × 24 hours.
    const late = deal({ id: "late", paidAt: "2026-09-09T18:00:00Z" });
    expect(ids([late], now)).toEqual(["late"]);
    expect(renewalsDue([late], now, ZONE)[0]?.daysSincePaid).toBe(60);
    // In UTC it is still 7 Nov, so only 59 days have passed there.
    expect(renewalsDue([late], now, "UTC")).toEqual([]);
  });
});
