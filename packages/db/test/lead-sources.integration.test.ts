import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ParsedLeadEvent } from "@dealdock/core";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("coach pipeline and renewals", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const orgs: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.TOKEN_ENCRYPTION_KEY ??= "11".repeat(32);
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
    const message = await db.upsertInboundMessage(org, { igAccountId: created.igAccount.id, igThreadId: `${nonce}-t`, participantHandle: "rhea.runs", participantIgId: `${nonce}-rhea`, igMessageId: `${nonce}-m`, direction: "inbound", text: "What does coaching cost?", sentAt: new Date() });
    await prisma.thread.update({ where: { id: message.threadId! }, data: { participantName: "Rhea Sharma", topLabel: "coaching_lead" } });
    return { org, seatId: created.seat.id, igAccountId: created.igAccount.id, threadId: message.threadId!, nonce };
  }
  const paid = (patch: Partial<ParsedLeadEvent> = {}): ParsedLeadEvent => ({ kind: "paid", externalId: "pay_1", ref: null, amountMinor: 2_400_000, currencyCode: "INR", payerName: null, occurredAt: new Date().toISOString(), ...patch });

  it("stores a report once, matches it by reference or by name, and only moves the stage forward", async () => {
    const { org, seatId, threadId } = await setup("pipeline-a");
    const foreign = await setup("pipeline-foreign");
    const token = randomBytes(32).toString("base64url");
    const source = await db.createLeadSource(org, seatId, { provider: "razorpay", label: null, token, secret: "whsec_drill" });
    const resolved = await db.resolveLeadSource(token);
    expect(resolved).toMatchObject({ id: source.id, orgId: org, provider: "razorpay", secret: "whsec_drill", orgCurrency: "INR" });
    expect(await prisma.leadSource.findUniqueOrThrow({ where: { id: source.id } })).not.toMatchObject({ tokenHash: token, secretEnc: "whsec_drill" });
    expect(await db.resolveLeadSource(randomBytes(32).toString("base64url"))).toBeNull();

    // A redelivery is stored once; the payer's name finds the one conversation with it.
    const first = await db.recordLeadEvents(org, source, [paid({ payerName: "rhea sharma" })]);
    const again = await db.recordLeadEvents(org, source, [paid({ payerName: "rhea sharma" })]);
    expect([first.stored, again.stored, again.duplicates]).toEqual([1, 0, 1]);
    expect(first.matchedPayments).toEqual([{ threadId, handle: "rhea.runs", amountMinor: 2_400_000, currencyCode: "INR" }]);
    expect(await prisma.leadEvent.count({ where: { sourceId: source.id } })).toBe(1);
    expect(await db.getThreadDetail(org, threadId)).toMatchObject({ leadStage: "paid", leadPayments: [{ provider: "razorpay", amountMinor: 2_400_000, currencyCode: "INR" }] });

    // A later booking never moves a paid conversation back.
    await db.recordLeadEvents(org, source, [{ ...paid({ externalId: "bk_1", ref: `dd_${threadId}` }), kind: "booked", amountMinor: null, currencyCode: null }]);
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).leadStage).toBe("paid");
    // By hand, any stage.
    expect(await db.setLeadStage(org, seatId, threadId, "qualified")).toEqual({ leadStage: "qualified" });

    // Another org's conversation is never matched by reference; it stays unmatched until the creator matches it.
    const stray = await db.recordLeadEvents(org, source, [paid({ externalId: "pay_2", ref: `dd_${foreign.threadId}` })]);
    expect(stray.matchedPayments).toEqual([]);
    const unmatched = (await db.listLeadSources(org)).unmatched;
    expect(unmatched).toHaveLength(1);
    await expect(db.matchLeadEvent(org, seatId, unmatched[0]!.id, foreign.threadId)).rejects.toMatchObject({ status: 404 });
    expect(await db.matchLeadEvent(org, seatId, unmatched[0]!.id, threadId)).toMatchObject({ threadId });
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).leadStage).toBe("paid");

    // Recording the sale handles its payment; dismiss handles another.
    const [payment, second] = (await db.getThreadDetail(org, threadId))!.leadPayments;
    await db.createDeal(org, { threadId, seatId, title: "Coaching", dealType: "coaching", amountMinor: 2_400_000, paid: {}, idempotencyKey: `deal-${threadId}`, leadEventId: second!.id });
    await db.dismissLeadEvent(org, seatId, payment!.id);
    expect((await db.getThreadDetail(org, threadId))!.leadPayments).toEqual([]);

    await db.deleteLeadSource(org, seatId, source.id);
    expect(await db.resolveLeadSource(token)).toBeNull();
    expect(await prisma.leadEvent.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it("offers a renewal for a paid brand deal and takes it away on Not now", async () => {
    const { org, seatId, igAccountId, nonce } = await setup("renewals-a");
    const deal = await db.createDeal(org, { igAccountId, counterpartyHandle: "@glowco", seatId, title: "Reel", dealType: "brand", amountMinor: 5_000_000, paid: { paidAt: new Date(Date.now() - 70 * 86_400_000).toISOString() }, idempotencyKey: `${nonce}-renewal` });
    expect((await db.listRenewals(org)).map((item) => item.deal.id)).toEqual([deal.id]);
    expect(await db.handleRenewal(org, deal.id, seatId, "not_now")).toMatchObject({ renewalHandledAt: expect.any(String) });
    expect(await db.listRenewals(org)).toEqual([]);
  });
});
