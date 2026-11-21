import { describe, expect, it } from "vitest";
import { byDealUrgency, daysOverdue, dealRevenueMinor, defaultReceivedMinor, dueFromPaymentDays, EMPTY_DEAL_TERMS, isDealOverdue, nextDeliverable, normalizeDealTerms, owedTotals, reminderTone } from "../src/deals";
import { noReplyWindow } from "../src/reply-window";

const NOW = Date.parse("2026-11-04T10:00:00Z");
const deal = (patch: Record<string, unknown> = {}) => ({ stage: "agreed" as const, dueAt: null as string | null, agreedAt: "2026-11-01T00:00:00Z", amountMinor: 50_000_00, ...patch });

describe("deal rules", () => {
  it("normalizes partial terms and rejects invalid values", () => {
    expect(normalizeDealTerms({ usage: "  Organic only ", notes: " " })).toEqual({ ...EMPTY_DEAL_TERMS, usage: "Organic only", notes: null });
    expect(normalizeDealTerms({ advancePercent: 50 }, { ...EMPTY_DEAL_TERMS, usage: "Paid ads" })).toMatchObject({ usage: "Paid ads", advancePercent: 50 });
    expect(normalizeDealTerms({ usage: null }, { ...EMPTY_DEAL_TERMS, usage: "Paid ads" }).usage).toBeNull();
    expect(() => normalizeDealTerms({ advancePercent: 150 })).toThrow();
    expect(() => normalizeDealTerms({ deliverables: [{ id: "d1", label: "", dueAt: null, done: false }] })).toThrow();
  });

  it("is overdue only while open and past its due date", () => {
    expect(isDealOverdue(deal({ dueAt: "2026-11-01T00:00:00Z" }), NOW)).toBe(true);
    expect(daysOverdue(deal({ dueAt: "2026-11-01T00:00:00Z" }), NOW)).toBe(3);
    expect(isDealOverdue(deal({ dueAt: "2026-11-05T00:00:00Z" }), NOW)).toBe(false);
    expect(isDealOverdue(deal({ stage: "paid", dueAt: "2026-11-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isDealOverdue(deal(), NOW)).toBe(false);
    expect(daysOverdue(deal({ dueAt: "2026-11-04T09:00:00Z" }), NOW)).toBe(1);
  });

  it("totals what is owed and overdue across open deals only", () => {
    const totals = owedTotals([
      deal({ dueAt: "2026-11-01T00:00:00Z" }),
      deal({ stage: "invoiced", dueAt: "2026-12-01T00:00:00Z", amountMinor: 20_000_00 }),
      deal({ stage: "paid", amountMinor: 99_000_00 }),
      deal({ stage: "cancelled", amountMinor: 1_000_00 }),
    ], NOW);
    expect(totals).toEqual({ owedMinor: 70_000_00, overdueMinor: 50_000_00, openCount: 2, overdueCount: 1 });
  });

  it("orders by due date, undated last, newest agreed first among equals", () => {
    const list = [
      deal({ id: "undated-old", agreedAt: "2026-10-01T00:00:00Z" }),
      deal({ id: "later", dueAt: "2026-12-01T00:00:00Z" }),
      deal({ id: "overdue", dueAt: "2026-10-20T00:00:00Z" }),
      deal({ id: "undated-new", agreedAt: "2026-11-02T00:00:00Z" }),
    ];
    expect(list.sort(byDealUrgency).map((item) => item.id)).toEqual(["overdue", "later", "undated-new", "undated-old"]);
  });

  it("records the gross in Revenue and defaults what arrived to the amount less TDS", () => {
    expect(dealRevenueMinor({ amountMinor: 50_000_00, receivedMinor: 45_000_00, tdsMinor: 5_000_00 })).toBe(50_000_00);
    expect(dealRevenueMinor({ amountMinor: 50_000_00, receivedMinor: null, tdsMinor: null })).toBe(50_000_00);
    expect(defaultReceivedMinor(50_000_00, 5_000_00)).toBe(45_000_00);
    expect(defaultReceivedMinor(1_000, 5_000)).toBe(0);
  });

  it("finds the next deliverable and the payment date", () => {
    const terms = { deliverables: [
      { id: "a", label: "Story", dueAt: null, done: false },
      { id: "b", label: "Reel", dueAt: "2026-11-10T00:00:00Z", done: false },
      { id: "c", label: "Draft", dueAt: "2026-11-05T00:00:00Z", done: true },
    ] };
    expect(nextDeliverable(terms)?.id).toBe("b");
    expect(nextDeliverable({ deliverables: [] })).toBeNull();
    expect(dueFromPaymentDays("2026-11-01T00:00:00.000Z", 30)).toBe("2026-12-01T00:00:00.000Z");
  });

  it("firms up reminders the later the payment is", () => {
    expect([1, 6, 7, 20, 21].map(reminderTone)).toEqual(["gentle", "gentle", "firm", "firm", "final"]);
  });

  it("gives email a reply window that never blocks", () => {
    expect(noReplyWindow("2026-11-01T00:00:00Z")).toMatchObject({ status: "none", standardClosesAt: null, humanAgentEnabled: false });
    expect(noReplyWindow(null).lastInboundAt).toBeNull();
  });
});

describe("dealOwedMinor", () => {
  const invoice = (status: "issued" | "paid" | "void", subtotalMinor: number, totalMinor: number) => ({ status, subtotalMinor, totalMinor }) as never;
  it("counts unpaid invoices with their tax plus the part not invoiced yet", async () => {
    const { dealOwedMinor } = await import("../src/deals");
    // ₹60,000 fee; 30% advance (₹18,000 + 18% GST) paid; balance not invoiced yet.
    expect(dealOwedMinor({ amountMinor: 60_000_00, paidMinor: 18_000_00, invoices: [invoice("paid", 18_000_00, 21_240_00)] })).toBe(42_000_00);
    // Balance invoiced: ₹42,000 + GST is what the brand owes now.
    expect(dealOwedMinor({ amountMinor: 60_000_00, paidMinor: 18_000_00, invoices: [invoice("paid", 18_000_00, 21_240_00), invoice("issued", 42_000_00, 49_560_00)] })).toBe(49_560_00);
    // Advance issued but unpaid, balance not invoiced: both are owed.
    expect(dealOwedMinor({ amountMinor: 60_000_00, invoices: [invoice("issued", 18_000_00, 21_240_00)] })).toBe(21_240_00 + 42_000_00);
    // A void invoice no longer counts; nothing invoiced means the fee less payments.
    expect(dealOwedMinor({ amountMinor: 60_000_00, invoices: [invoice("void", 60_000_00, 70_800_00)] })).toBe(60_000_00);
  });
});

