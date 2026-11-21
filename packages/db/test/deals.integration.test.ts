import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("deals", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const orgs: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    vi.resetModules();
    db = await import("../src/index");
    ({ prisma } = await import("../src/client"));
  }, 60000);
  afterAll(async () => {
    for (const id of orgs) await db.hardDeleteOrg(id);
    await prisma?.$disconnect();
  });

  async function setup(suffix: string) {
    const nonce = crypto.randomUUID();
    const created = await db.createOrganizationWithCreator({ name: suffix, currencyCode: "INR", timezone: "Asia/Kolkata", creator: { clerkUserId: `${nonce}-${suffix}`, email: `${nonce}-${suffix}@example.test` }, igAccount: { igUserId: `${nonce}-${suffix}`, handle: suffix, accountType: "creator" } });
    orgs.push(created.org.id);
    const org = db.asOrgId(created.org.id);
    const { threadId } = await db.upsertInboundMessage(org, { igAccountId: created.igAccount.id, igThreadId: `${nonce}-t`, participantHandle: "glowbrand", participantIgId: `${nonce}-brand`, igMessageId: `${nonce}-m`, direction: "inbound", text: "Deal! 50k for one reel", sentAt: new Date() });
    if (!threadId) throw new Error("message not written");
    return { org, seatId: created.seat.id, igAccountId: created.igAccount.id, threadId, nonce };
  }

  it("carries a deal from agreed to paid with one Revenue entry, and reopens it when that entry is deleted", async () => {
    const { org, seatId, igAccountId, threadId, nonce } = await setup("deals-a");
    const input = { threadId, seatId, title: "Reel for Glow", dealType: "brand" as const, amountMinor: 5_000_000, terms: { paymentDays: 30, usage: " Organic only " }, idempotencyKey: `${nonce}-deal` };
    const deal = await db.createDeal(org, input);
    expect(deal).toMatchObject({ stage: "agreed", igAccountId, counterpartyHandle: "glowbrand", channel: "instagram", currencyCode: "INR", dueAt: null, terms: { paymentDays: 30, usage: "Organic only", deliverables: [] } });
    expect((await db.getThreadDetail(org, threadId))?.state).toBe("closed");
    expect(await db.getDealConversation(org, threadId)).toMatchObject({ igAccountId, timezone: "Asia/Kolkata", threadHistory: [{ direction: "inbound", text: "Deal! 50k for one reel", sentAt: expect.any(String) }] });
    expect((await db.createDeal(org, input)).id).toBe(deal.id);
    await expect(db.createDeal(org, { ...input, amountMinor: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await db.listDeals(org, { status: "open" })).map((d) => d.id)).toEqual([deal.id]);

    const invoiced = await db.updateDeal(org, deal.id, seatId, { stage: "invoiced", terms: { notes: "Invoice #12" } });
    expect(invoiced.terms).toMatchObject({ paymentDays: 30, usage: "Organic only", notes: "Invoice #12" });
    expect(Date.parse(invoiced.dueAt!) - Date.parse(invoiced.invoicedAt!)).toBe(30 * 86_400_000);

    const paidKey = `${nonce}-paid-1`;
    const paid = await db.markDealPaid(org, deal.id, seatId, { idempotencyKey: paidKey, tdsMinor: 500_000 });
    expect(paid).toMatchObject({ stage: "paid", receivedMinor: 4_500_000, tdsMinor: 500_000 });
    expect(await db.markDealPaid(org, deal.id, seatId, { idempotencyKey: paidKey, tdsMinor: 500_000 })).toEqual(paid);
    await expect(db.markDealPaid(org, deal.id, seatId, { idempotencyKey: paidKey, tdsMinor: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(db.markDealPaid(org, deal.id, seatId, { idempotencyKey: `${nonce}-paid-2` })).rejects.toMatchObject({ status: 409 });
    await expect(db.updateDeal(org, deal.id, seatId, { amountMinor: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(db.updateDeal(org, deal.id, seatId, { stage: "agreed" })).rejects.toMatchObject({ status: 409 });
    expect((await db.updateDeal(org, deal.id, seatId, { amountMinor: 5_000_000, title: "Reel for Glow (done)" })).title).toBe("Reel for Glow (done)");

    const ledger = await db.getLedger(org);
    expect(ledger.entries).toMatchObject([{ amountMinor: 5_000_000, dealType: "brand", note: "Reel for Glow" }]);
    expect(await prisma.ledgerEntry.count({ where: { orgId: org, dealId: deal.id } })).toBe(1);

    await db.deleteLedgerEntry(org, ledger.entries[0]!.id, seatId);
    expect(await db.getDeal(org, deal.id)).toMatchObject({ stage: "invoiced", paidAt: null, receivedMinor: null, tdsMinor: null });
    await db.markDealPaid(org, deal.id, seatId, { idempotencyKey: `${nonce}-paid-3`, receivedMinor: 4_000_000 });
    expect((await db.getLedger(org)).entries.map((e) => e.amountMinor)).toEqual([4_000_000]);

    await db.deleteDeal(org, deal.id, seatId);
    expect(await db.listDeals(org, { status: "all" })).toEqual([]);
    expect((await db.getLedger(org)).entries).toEqual([]);
    expect((await db.getThreadDetail(org, threadId))?.deals).toEqual([]);
    expect(await prisma.auditLog.count({ where: { orgId: org, action: { in: ["deal.created", "deal.updated", "deal.paid", "deal.deleted"] } } })).toBe(6);
  });

  it("records a paid deal at once and keeps every deal inside its org", async () => {
    const a = await setup("deals-b");
    const foreign = await setup("deals-foreign");
    const sale = await db.createDeal(a.org, { threadId: a.threadId, seatId: a.seatId, title: "Coaching", dealType: "coaching", amountMinor: 200_000, paid: {}, idempotencyKey: `${a.nonce}-sale` });
    expect(sale).toMatchObject({ stage: "paid", receivedMinor: 200_000, tdsMinor: null });
    expect((await db.getLedger(a.org)).entries).toMatchObject([{ amountMinor: 200_000, dealType: "coaching", note: "Coaching" }]);
    expect((await db.getThreadDetail(a.org, a.threadId))?.deals.map((d) => d.id)).toEqual([sale.id]);
    expect(await db.listDeals(a.org, { status: "open" })).toEqual([]);

    expect(await db.getDeal(foreign.org, sale.id)).toBeNull();
    expect(await db.getDealConversation(foreign.org, a.threadId)).toBeNull();
    await expect(db.updateDeal(foreign.org, sale.id, foreign.seatId, { title: "Mine now" })).rejects.toMatchObject({ status: 404 });
    await expect(db.markDealPaid(foreign.org, sale.id, foreign.seatId, { idempotencyKey: `${a.nonce}-foreign-paid` })).rejects.toMatchObject({ status: 404 });
    await expect(db.deleteDeal(foreign.org, sale.id, foreign.seatId)).rejects.toMatchObject({ status: 404 });
    await expect(db.createDeal(foreign.org, { threadId: a.threadId, seatId: foreign.seatId, title: "Not mine", dealType: "brand", amountMinor: 1, idempotencyKey: `${a.nonce}-steal` })).rejects.toMatchObject({ status: 404 });
    await expect(db.createDeal(a.org, { threadId: a.threadId, seatId: foreign.seatId, title: "Foreign seat", dealType: "brand", amountMinor: 1, idempotencyKey: `${a.nonce}-seat` })).rejects.toMatchObject({ status: 404 });
    await expect(db.listDeals(a.org, { status: "all", igAccountId: foreign.igAccountId })).rejects.toMatchObject({ status: 404 });
  });

  it("counts an email inbox's conversations, deals and money for the creator account that owns it", async () => {
    const a = await setup("deals-email");
    const inbox = await prisma.igAccount.create({ data: { orgId: a.org, platform: "email", provider: "gmail", igUserId: `${a.nonce}-inbox`, handle: "me@example.test", accountType: "creator", ownerAccountId: a.igAccountId } });
    const { threadId: mailThreadId } = await db.upsertInboundMessage(a.org, { igAccountId: inbox.id, igThreadId: `${a.nonce}-mail`, participantHandle: "partners@brand.test", participantIgId: "partners@brand.test", igMessageId: `${a.nonce}-mail-1`, direction: "inbound", text: "Please pay the registration fee to join our creator program.", sentAt: new Date() });
    if (!mailThreadId) throw new Error("message not written");

    expect(await db.getThreadDetail(a.org, mailThreadId)).toMatchObject({ channel: "email", igAccountId: a.igAccountId, scamReason: "They're asking you to pay to take part." });
    const emailDeal = await db.createDeal(a.org, { threadId: mailThreadId, seatId: a.seatId, title: "Email deal", dealType: "brand", amountMinor: 10_000, paid: { receivedMinor: 10_000 }, idempotencyKey: `${a.nonce}-email` });
    expect(emailDeal).toMatchObject({ channel: "email", igAccountId: a.igAccountId, counterpartyHandle: "partners@brand.test" });
    // Stored owner-resolved, so creator filters and deletion need no thread.
    expect(await prisma.deal.findUniqueOrThrow({ where: { id: emailDeal.id } })).toMatchObject({ threadId: mailThreadId, igAccountId: a.igAccountId, counterpartyHandle: "partners@brand.test" });
    expect(await prisma.ledgerEntry.findFirstOrThrow({ where: { orgId: a.org, dealId: emailDeal.id } })).toMatchObject({ threadId: mailThreadId, igAccountId: a.igAccountId, counterpartyHandle: "partners@brand.test" });
    expect((await db.listDeals(a.org, { status: "all", igAccountId: a.igAccountId })).map((d) => d.id)).toEqual([emailDeal.id]);
    expect((await db.getLedger(a.org, undefined, a.igAccountId)).entries.map((e) => e.amountMinor)).toEqual([10_000]);
  });
});
