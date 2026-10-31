import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const shouldRun = process.env.RUN_DB_INTEGRATION === "1";
if (shouldRun && !process.env.TEST_DATABASE_URL) {
  throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
}

describe.runIf(shouldRun && Boolean(process.env.TEST_DATABASE_URL))("Postgres billing event safety", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const organizations: string[] = [];

  async function organization(currencyCode = "INR") {
    const nonce = `billing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await db.createOrganizationWithCreator({
      name: `Billing ${nonce}`,
      currencyCode,
      creator: { clerkUserId: `creator-${nonce}`, email: `${nonce}@example.test` },
      igAccount: { igUserId: `ig-${nonce}`, handle: `handle_${nonce}`, accountType: "creator" },
    });
    organizations.push(created.org.id);
    return created;
  }

  async function subscription(org: Awaited<ReturnType<typeof organization>>, externalId: string) {
    const orgId = db.asOrgId(org.org.id);
    const created = await db.ensureSubscription(orgId, "solo");
    await prisma.subscription.update({
      where: { id: created.id },
      data: { externalId, status: "pending_first_invoice", currentPeriodEnd: null },
    });
    return orgId;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    vi.resetModules();
    db = await import("../src/index");
    ({ prisma } = await import("../src/client"));
  });

  afterAll(async () => {
    for (const orgId of organizations.splice(0)) await db.hardDeleteOrg(orgId).catch(() => undefined);
    await prisma?.$disconnect();
  });

  it("deduplicates receipts and never lets an older event or period regress a newer paid state", async () => {
    const created = await organization("USD");
    const orgId = await subscription(created, `sub-paid-${created.org.id}`);
    const externalId = `sub-paid-${created.org.id}`;
    const newer = new Date("2026-04-03T10:00:00.000Z");
    const periodEnd = new Date("2026-05-01T00:00:00.000Z");
    await expect(db.applyBillingEvent({
      rail: "paddle", eventId: `paid-${created.org.id}`, occurredAt: newer, externalId,
      kind: "charged", currentPeriodEnd: periodEnd,
    })).resolves.toMatchObject({ applied: true, status: "active" });
    await expect(db.applyBillingEvent({
      rail: "paddle", eventId: `old-failure-${created.org.id}`, occurredAt: new Date("2026-04-02T10:00:00.000Z"),
      externalId, kind: "payment_failed", currentPeriodEnd: new Date("2026-04-15T00:00:00.000Z"),
    })).resolves.toMatchObject({ applied: true, ignoredStale: true });
    await expect(db.applyBillingEvent({
      rail: "paddle", eventId: `paid-${created.org.id}`, occurredAt: newer, externalId,
      kind: "charged", currentPeriodEnd: periodEnd,
    })).resolves.toMatchObject({ applied: true, deduplicated: true });
    const saved = await prisma.subscription.findUniqueOrThrow({ where: { orgId: created.org.id } });
    expect(saved.status).toBe("active");
    expect(saved.currentPeriodEnd).toEqual(periodEnd);
    expect(saved.lastEventAt).toEqual(newer);
    expect(await prisma.billingEventReceipt.count({ where: { orgId: created.org.id } })).toBe(2);
  });

  it("keeps cancellation terminal and rejects wrong-rail or forged foreign-org events", async () => {
    const alpha = await organization("USD");
    const beta = await organization("USD");
    const alphaId = await subscription(alpha, `sub-alpha-${alpha.org.id}`);
    await subscription(beta, `sub-beta-${beta.org.id}`);
    const externalId = `sub-alpha-${alpha.org.id}`;
    await db.applyBillingEvent({ rail: "paddle", eventId: `cancel-${alpha.org.id}`, occurredAt: new Date("2026-05-01T00:00:00.000Z"), externalId, kind: "cancelled" });
    await expect(db.applyBillingEvent({
      rail: "paddle", eventId: `resurrect-${alpha.org.id}`, occurredAt: new Date("2026-05-02T00:00:00.000Z"), externalId, kind: "charged",
    })).resolves.toMatchObject({ applied: false, reason: "subscription_cancelled_terminal" });
    await expect(db.applyBillingEvent({
      rail: "razorpay", eventId: `wrong-rail-${alpha.org.id}`, occurredAt: new Date("2026-05-03T00:00:00.000Z"), externalId, kind: "charged",
    })).resolves.toMatchObject({ applied: false, reason: "wrong_billing_rail" });
    await expect(db.applyBillingEvent({
      rail: "paddle", eventId: `forged-tag-${alpha.org.id}`, occurredAt: new Date("2026-05-03T00:00:00.000Z"), externalId, kind: "charged", orgId: beta.org.id,
    })).resolves.toMatchObject({ applied: false, reason: "billing_org_mismatch" });
    expect((await db.getSubscription(alphaId))?.status).toBe("cancelled");
    expect(await prisma.billingEventReceipt.count({ where: { orgId: alpha.org.id, eventId: `forged-tag-${alpha.org.id}` } })).toBe(0);
  });

  it("makes a pending cancellation unclaimable for first invoice and deletes billing receipts with the org", async () => {
    const created = await organization();
    const orgId = await subscription(created, `sub-delete-${created.org.id}`);
    await prisma.subscription.update({
      where: { orgId: created.org.id },
      data: { externalId: null, activeUseStartedAt: new Date(Date.now() - 8 * 864e5), firstInvoiceRequestedAt: null },
    });
    await db.requestCancellation(orgId, created.seat.id);
    expect(await db.claimFirstInvoice(orgId)).toBeNull();
    expect(await db.listSubscriptionsDueFirstInvoice()).not.toContainEqual(expect.objectContaining({ orgId: created.org.id }));

    // A separate active receipt proves deletion cascades through the billing
    // audit table, rather than weakening the pending-cancellation assertion.
    const receiptOrg = await organization();
    await subscription(receiptOrg, `sub-delete-${receiptOrg.org.id}`);
    await db.applyBillingEvent({
      rail: "razorpay", eventId: `receipt-delete-${receiptOrg.org.id}`, occurredAt: new Date(),
      externalId: `sub-delete-${receiptOrg.org.id}`, kind: "charged",
    });
    expect(await prisma.billingEventReceipt.count({ where: { orgId: receiptOrg.org.id } })).toBe(1);
    await db.hardDeleteOrg(receiptOrg.org.id);
    organizations.splice(organizations.indexOf(receiptOrg.org.id), 1);
    expect(await prisma.billingEventReceipt.count({ where: { orgId: receiptOrg.org.id } })).toBe(0);
    expect(await db.countOrgResidue(receiptOrg.org.id)).toMatchObject({ org: 0, billingEvents: 0 });
  });
  it("applies concurrent deliveries of the same event once", async () => {
    const created = await organization("USD");
    await subscription(created, `concurrent-${created.org.id}`);
    const event = {
      rail: "paddle" as const, eventId: `concurrent-event-${created.org.id}`,
      occurredAt: new Date("2026-06-01T00:00:00.000Z"), externalId: `concurrent-${created.org.id}`,
      kind: "charged" as const, currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
    };
    const results = await Promise.all([db.applyBillingEvent(event), db.applyBillingEvent(event)]);
    expect(results.filter((result) => "deduplicated" in result && result.deduplicated)).toHaveLength(1);
    expect(results.every((result) => result.applied)).toBe(true);
    expect(await prisma.billingEventReceipt.count({ where: { orgId: created.org.id, eventId: event.eventId } })).toBe(1);
    const saved = await prisma.subscription.findUniqueOrThrow({ where: { orgId: created.org.id } });
    expect(saved.status).toBe("active");
    expect(saved.currentPeriodEnd).toEqual(event.currentPeriodEnd);
  });

});
