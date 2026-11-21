import { describe, expect, it } from "vitest";
import { daysOverdue, isDealOverdue, owedTotals, type DealDto } from "@dealdock/core";
import { dealNextStep, dealPrimaryAction, dealStage, dueWords, endOfDayIso } from "../src/lib/deals";
import { replyWindowInfo } from "../src/lib/format";
import { dealDraft, DEMO_MONEY, suggestDealFrom } from "../src/lib/demo-data";
import { demoStore } from "../src/lib/demo-store";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T06:30:00Z"); // Wednesday, 12:00 in Kolkata
const ZONE = "Asia/Kolkata";
const iso = (at: number) => new Date(at).toISOString();

function deal(patch: Partial<DealDto> = {}): DealDto {
  return {
    id: "deal-1", threadId: "t-1", igAccountId: "ig-1", counterpartyHandle: "brand", counterpartyName: "Brand", channel: "instagram",
    title: "1 reel + 2 stories", dealType: "brand", amountMinor: 60_000_00, currencyCode: "INR", stage: "agreed",
    terms: { deliverables: [], usage: null, usageEndsAt: null, exclusivity: null, exclusivityEndsAt: null, revisionsIncluded: null, advancePercent: null, paymentDays: null, notes: null, disclosure: [] },
    agreedAt: iso(NOW - 3 * DAY), dueAt: null, invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null,
    createdAt: iso(NOW - 3 * DAY), updatedAt: iso(NOW - 3 * DAY), ...patch,
  };
}

describe("deal words", () => {
  it("names the stage, with overdue in the warning tone", () => {
    expect(dealStage(deal(), NOW)).toEqual({ text: "Agreed", tone: "neutral" });
    expect(dealStage(deal({ stage: "invoiced", dueAt: iso(NOW + DAY) }), NOW)).toEqual({ text: "Payment requested", tone: "neutral" });
    expect(dealStage(deal({ stage: "invoiced", dueAt: iso(NOW - 6 * DAY - 3_600_000) }), NOW)).toEqual({ text: "Overdue 6 days", tone: "waiting" });
    expect(dealStage(deal({ stage: "invoiced", dueAt: iso(NOW - 3_600_000) }), NOW).text).toBe("Overdue 1 day");
    expect(dealStage(deal({ stage: "paid", dueAt: iso(NOW - 9 * DAY) }), NOW)).toEqual({ text: "Paid", tone: "money" });
    expect(dealStage(deal({ stage: "cancelled" }), NOW).text).toBe("Cancelled");
  });

  it("says dates the way people do, in the org's zone", () => {
    expect(dueWords(NOW + 3_600_000, NOW, "en-IN", ZONE)).toBe("today");
    expect(dueWords(NOW + DAY, NOW, "en-IN", ZONE)).toBe("tomorrow");
    expect(dueWords(NOW + 2 * DAY, NOW, "en-IN", ZONE)).toBe("Fri");
    expect(dueWords(Date.parse("2026-12-12T10:00:00Z"), NOW, "en-IN", ZONE)).toBe("12 Dec");
    // 23:00 UTC on the 4th is already the 5th in Kolkata.
    expect(dueWords(Date.parse("2026-11-04T23:00:00Z"), NOW, "en-IN", ZONE)).toBe("tomorrow");
  });

  it("puts the next step in plain words", () => {
    const reel = { id: "d1", label: "1 reel", dueAt: iso(NOW + 2 * DAY), done: false };
    const stories = { id: "d2", label: "2 stories", dueAt: null, done: false };
    expect(dealNextStep(deal({ terms: { ...deal().terms, deliverables: [stories, reel] } }), NOW, "en-IN", ZONE)).toBe("Reel due Fri");
    expect(dealNextStep(deal({ terms: { ...deal().terms, deliverables: [{ ...reel, done: true }, stories] } }), NOW, "en-IN", ZONE)).toBe("2 stories to deliver");
    expect(dealNextStep(deal({ terms: { ...deal().terms, deliverables: [{ ...reel, done: true }] } }), NOW, "en-IN", ZONE)).toBe("Delivered · ask for payment");
    expect(dealNextStep(deal({ stage: "invoiced", dueAt: iso(Date.parse("2026-12-12T10:00:00Z")) }), NOW, "en-IN", ZONE)).toBe("Payment due 12 Dec");
    expect(dealNextStep(deal({ stage: "invoiced" }), NOW, "en-IN", ZONE)).toBe("Payment requested");
    expect(dealNextStep(deal({ stage: "invoiced", dueAt: iso(NOW - 6 * DAY - 60_000) }), NOW, "en-IN", ZONE)).toBe("Overdue 6 days");
    expect(dealNextStep(deal(), NOW, "en-IN", ZONE)).toBe("Agreed");
  });

  it("leads each card with one next step", () => {
    const silent = () => false;
    const wrote = () => true;
    expect(dealPrimaryAction(deal(), NOW, silent)).toBe("recap");
    // Once the recap is out, the next step is the invoice ("Ask for payment" waits in the menu).
    expect(dealPrimaryAction(deal(), NOW, wrote)).toBe("invoice");
    expect(dealPrimaryAction(deal({ stage: "invoiced", dueAt: iso(NOW + DAY) }), NOW, silent)).toBe("paid");
    expect(dealPrimaryAction(deal({ stage: "invoiced", dueAt: iso(NOW - 2 * DAY) }), NOW, wrote)).toBe("remind");
    // A payment date set while still agreed can lapse too.
    expect(dealPrimaryAction(deal({ dueAt: iso(NOW - 2 * DAY) }), NOW, silent)).toBe("remind");
  });

  it("turns a date input into the end of that day in the org's zone", () => {
    expect(endOfDayIso("2026-11-12", ZONE)).toBe("2026-11-12T18:29:59.000Z");
    expect(endOfDayIso("2026-11-12", "UTC")).toBe("2026-11-12T23:59:59.000Z");
    expect(endOfDayIso("2026-02-31", ZONE)).toBeNull();
    expect(endOfDayIso("", ZONE)).toBeNull();
    // Due on the 12th is not late during the 12th, and late right after it.
    const due = endOfDayIso("2026-11-12", ZONE)!;
    expect(isDealOverdue(deal({ stage: "invoiced", dueAt: due }), Date.parse("2026-11-12T18:00:00Z"))).toBe(false);
    expect(isDealOverdue(deal({ stage: "invoiced", dueAt: due }), Date.parse("2026-11-12T18:31:00Z"))).toBe(true);
  });

  it("lets email send at any time and never shows it a countdown", () => {
    const none = { status: "none" as const, lastInboundAt: iso(NOW - 40 * DAY), standardClosesAt: null, extendedClosesAt: null, humanAgentEnabled: false };
    expect(replyWindowInfo(none, NOW, "header")).toMatchObject({ visible: false, closed: false, canSend: true });
    expect(replyWindowInfo(none, NOW, "row")).toMatchObject({ visible: false, canSend: true });
    const open = { status: "open" as const, lastInboundAt: iso(NOW - 3_600_000), standardClosesAt: iso(NOW + 23 * 3_600_000), extendedClosesAt: null, humanAgentEnabled: false };
    expect(replyWindowInfo(open, NOW, "row")).toMatchObject({ visible: false, canSend: true });
    expect(replyWindowInfo({ ...open, status: "closed" }, NOW, "header")).toMatchObject({ closed: true, canSend: false });
    expect(replyWindowInfo({ ...open, status: "unknown" }, NOW, "header").canSend).toBe(false);
  });
});

describe("demo deal engines", () => {
  it("reads amounts, deliverables, advance and payment days from a chat", () => {
    const kesar = suggestDealFrom(["Our Diwali campaign needs 2 reels + 3 stories in the first week of November. What are your rates?"], "brand_deal");
    expect(kesar).toMatchObject({ title: "2 reels + 3 stories", dealType: "brand", amountMinor: null });
    expect(kesar.terms.deliverables.map((item) => item.label)).toEqual(["2 reels", "3 stories"]);
    expect(kesar.missing).toEqual(["the fee", "when they'll pay", "usage rights"]);

    const agreed = suggestDealFrom(["Budget is around ₹75,000.", "Done: 1 reel + 2 stories for ₹80,000, 50% advance, net 30. Usage: organic only."], "brand_deal");
    expect(agreed).toMatchObject({ amountMinor: 80_000_00, terms: { advancePercent: 50, paymentDays: 30 } });
    expect(agreed.missing).toEqual([]);

    // A range is still a negotiation, not an agreed fee; an advance with no share is flagged.
    const range = suggestDealFrom(["My rate for a reel + 2 stories is ₹60,000–₹90,000.", "Sending the advance once we sign."], "brand_deal");
    expect(range.amountMinor).toBeNull();
    expect(range.missing).toContain("how much is paid upfront");
    expect(suggestDealFrom(["₹1.2L works, payable in 15 days"], "other_commerce")).toMatchObject({ amountMinor: 120_000_00, dealType: "other", terms: { paymentDays: 15 } });
  });

  it("writes recaps and reminders with the exact amount, firmer the later it is", () => {
    const terms = { ...deal().terms, deliverables: [{ id: "d1", label: "1 reel", dueAt: iso(Date.parse("2026-11-06T18:29:59Z")), done: false }], advancePercent: 50, paymentDays: 15 };
    const recap = dealDraft("recap", deal({ terms }), DEMO_MONEY, ZONE, NOW);
    expect(recap).toContain("1 reel + 2 stories: ₹60,000");
    expect(recap).toContain("• 1 reel by 6 Nov");
    expect(recap).toContain("• 50% advance");
    expect(recap).toContain("• Payment within 15 days of the invoice");
    const late = (days: number) => dealDraft("payment_reminder", deal({ stage: "invoiced", dueAt: iso(NOW - days * DAY - 60_000) }), DEMO_MONEY, ZONE, NOW);
    expect(late(6)).toMatch(/^Heyy! .*quick nudge on the ₹60,000/);
    expect(late(10)).toMatch(/^Hi! Following up on the ₹60,000 .*10 days late/);
    expect(late(30)).toMatch(/^Hi, this is my final reminder about the ₹60,000 .*30 days late/);
  });
});

describe("demo deal lifecycle", () => {
  it("seeds an agreed, an overdue and a paid deal that matches Revenue", async () => {
    await demoStore.init();
    const all = (await demoStore.loadDeals({ status: "all" })) ?? [];
    const byId = Object.fromEntries(all.map((item) => [item.id, item]));
    const now = Date.now();
    const founders = byId["deal-founders"]!;
    expect(founders.stage).toBe("agreed");
    const sessionDue = Date.parse(founders.terms.deliverables[0]!.dueAt!) - now;
    expect(sessionDue).toBeGreaterThan(2 * DAY);
    expect(sessionDue).toBeLessThan(3 * DAY);
    expect(daysOverdue(byId["deal-tealeaf"]!, now)).toBe(6);
    const glowtonic = byId["deal-glowtonic"]!;
    const sale = demoStore.getSnapshot().ledger.find((entry) => entry.threadId === glowtonic.threadId);
    expect(glowtonic.stage).toBe("paid");
    expect((glowtonic.receivedMinor ?? 0) + (glowtonic.tdsMinor ?? 0)).toBe(sale?.amountMinor);
    // Recording the agreed deal closed its conversation.
    expect(demoStore.getSnapshot().threads.some((thread) => thread.id === "t-founders")).toBe(false);
  });

  it("goes from agreed to owed, overdue and paid, then deletes without touching Revenue", async () => {
    await demoStore.init();
    const now = Date.now();
    const ledgerBefore = demoStore.getSnapshot().ledger.length;
    const owedBefore = owedTotals((await demoStore.loadDeals({ status: "open" })) ?? [], now);

    const request = { threadId: "t-kesar", title: "2 reels + 3 stories", dealType: "brand" as const, amountMinor: 120_000_00, terms: { deliverables: [{ id: "d1", label: "2 reels", dueAt: null, done: false }] }, idempotencyKey: "lifecycle-1" };
    const created = await demoStore.createDeal(request);
    expect(created).toMatchObject({ stage: "agreed", counterpartyHandle: "kesarandclay", igAccountId: "ig-demo-diya", amountMinor: 120_000_00 });
    expect((await demoStore.createDeal(request)).id).toBe(created.id);
    // Recording a deal closes the conversation and leaves Revenue alone until it's paid.
    expect(demoStore.getSnapshot().threads.some((thread) => thread.id === "t-kesar")).toBe(false);
    expect(demoStore.getSnapshot().ledger).toHaveLength(ledgerBefore);
    expect((await demoStore.loadThread("t-kesar"))?.deals.map((item) => item.id)).toContain(created.id);

    let owed = owedTotals((await demoStore.loadDeals({ status: "open" })) ?? [], now);
    expect(owed.owedMinor - owedBefore.owedMinor).toBe(120_000_00);
    expect(owed.overdueMinor).toBe(owedBefore.overdueMinor);
    expect(await demoStore.loadDeals({ status: "open", igAccountId: "ig-demo-rohan" })).not.toContainEqual(expect.objectContaining({ id: created.id }));

    const invoiced = await demoStore.updateDeal(created.id, { stage: "invoiced", dueAt: new Date(now - 2 * DAY).toISOString() });
    expect(invoiced.invoicedAt).not.toBeNull();
    expect(daysOverdue(invoiced, now)).toBe(2);
    owed = owedTotals((await demoStore.loadDeals({ status: "open" })) ?? [], now);
    expect(owed.overdueMinor - owedBefore.overdueMinor).toBe(120_000_00);

    const reminder = await demoStore.generateDraft("t-kesar", { purpose: "payment_reminder", dealId: created.id });
    expect(reminder).toMatchObject({ purpose: "payment_reminder", kind: "nudge" });
    expect(reminder.body).toContain("₹1,20,000");
    await expect(demoStore.generateDraft("t-kesar", { purpose: "recap", dealId: "deal-founders" })).rejects.toMatchObject({ status: 404 });

    const paid = await demoStore.markDealPaid(created.id, { tdsMinor: 12_000_00, idempotencyKey: "lifecycle-paid" });
    expect(paid).toMatchObject({ stage: "paid", receivedMinor: 108_000_00, tdsMinor: 12_000_00 });
    const sales = () => demoStore.getSnapshot().ledger.filter((item) => item.threadId === "t-kesar");
    expect(sales()).toEqual([expect.objectContaining({ amountMinor: 120_000_00, dealType: "brand", note: "2 reels + 3 stories", dealId: created.id })]);
    // One Revenue entry per deal, as the API: the same payment retried returns the deal, another is refused.
    expect((await demoStore.markDealPaid(created.id, { tdsMinor: 12_000_00, idempotencyKey: "lifecycle-paid" })).stage).toBe("paid");
    await expect(demoStore.markDealPaid(created.id, { idempotencyKey: "lifecycle-paid-again" })).rejects.toMatchObject({ status: 409, code: "deal_already_paid" });
    expect(sales()).toHaveLength(1);
    expect((await demoStore.loadDeals({ status: "open" }))?.some((item) => item.id === created.id)).toBe(false);
    await expect(demoStore.updateDeal(created.id, { amountMinor: 1 })).rejects.toMatchObject({ status: 409, code: "deal_not_open" });
    await expect(demoStore.updateDeal(created.id, { stage: "agreed" })).rejects.toMatchObject({ status: 409, code: "deal_stage_change_not_allowed" });

    // As the API: deleting a paid deal takes its Revenue entry with it.
    await demoStore.deleteDeal(created.id);
    expect((await demoStore.loadDeals({ status: "all" }))?.some((item) => item.id === created.id)).toBe(false);
    expect(sales()).toHaveLength(0);
    const actions = ((await demoStore.loadAudit(500)) ?? []).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["deal.created", "deal.updated", "deal.paid", "deal.deleted", "ledger.deleted"]));
  });

  it("follows the API's stage rules: invoicing dates the payment, and deleting the sale reopens the deal", async () => {
    await demoStore.init();
    const deal = await demoStore.createDeal({ threadId: "t-castiron", title: "1 reel + 2 stories", dealType: "brand", amountMinor: 60_000_00, terms: { paymentDays: 30 }, idempotencyKey: "rules-1" });
    const invoiced = await demoStore.updateDeal(deal.id, { stage: "invoiced" });
    expect(Date.parse(invoiced.dueAt!) - Date.parse(invoiced.invoicedAt!)).toBe(30 * DAY);
    expect((await demoStore.updateDeal(deal.id, { stage: "agreed" })).invoicedAt).toBeNull();
    await demoStore.updateDeal(deal.id, { stage: "invoiced" });
    await demoStore.markDealPaid(deal.id, { idempotencyKey: "rules-paid" });
    const sale = demoStore.getSnapshot().ledger.find((entry) => entry.dealId === deal.id)!;
    await demoStore.deleteLedger(sale.id);
    const reopened = (await demoStore.loadDeals({ status: "open" }))?.find((item) => item.id === deal.id);
    expect(reopened).toMatchObject({ stage: "invoiced", paidAt: null, receivedMinor: null });
    await demoStore.updateDeal(deal.id, { stage: "cancelled" });
    await expect(demoStore.updateDeal(deal.id, { stage: "invoiced" })).rejects.toMatchObject({ code: "deal_stage_change_not_allowed" });
    await expect(demoStore.markDealPaid(deal.id, { idempotencyKey: "rules-paid-2" })).rejects.toMatchObject({ code: "deal_not_open" });
  });

  it("fills a deal from the conversation without saving anything", async () => {
    const before = (await demoStore.loadDeals({ status: "all" }))?.length;
    const suggestion = await demoStore.suggestDeal("t-brightleaf");
    expect(suggestion).toMatchObject({ title: "1 reel + 2 stories", amountMinor: 75_000_00, dealType: "brand" });
    expect((await demoStore.loadDeals({ status: "all" }))?.length).toBe(before);
  });
});
