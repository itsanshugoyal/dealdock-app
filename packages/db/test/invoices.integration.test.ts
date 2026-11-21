import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BillingProfileInput, InvoiceParty } from "@dealdock/core";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("invoices", () => {
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

  const profile: BillingProfileInput = {
    legalName: "Riya Sharma",
    addressLines: ["12 Carter Road", "Bandra West 400050"],
    city: "Mumbai",
    state: "27",
    country: "IN",
    email: "riya@example.test",
    phone: null,
    tax: { kind: "gst_in", number: "27AAPFU0939F1ZV", ratePercent: null, lutArn: null },
    pan: "AAPFU0939F",
    udyamNumber: null,
    sacCode: "998361",
    payment: { upiId: "riya@okhdfcbank", bankName: null, accountName: null, accountNumber: null, ifsc: null, swift: null, iban: null, paymentLink: null },
    invoicePrefix: "RIYA",
  };
  const glow: InvoiceParty = { name: "Glow Co", addressLines: [], city: "Mumbai", state: "27", country: "IN", taxNumber: "27AAACR5055K1Z7" };

  async function setup(suffix: string, tier: "solo" | "roster" = "solo") {
    const nonce = crypto.randomUUID();
    const created = await db.createOrganizationWithCreator({ name: suffix, tier, currencyCode: "INR", timezone: "Asia/Kolkata", creator: { clerkUserId: `${nonce}-${suffix}`, email: `${nonce}-${suffix}@example.test` }, igAccount: { igUserId: `${nonce}-${suffix}`, handle: suffix, accountType: "creator" } });
    orgs.push(created.org.id);
    const org = db.asOrgId(created.org.id);
    const { threadId } = await db.upsertInboundMessage(org, { igAccountId: created.igAccount.id, igThreadId: `${nonce}-t`, participantHandle: "glowbrand", participantIgId: `${nonce}-brand`, igMessageId: `${nonce}-m`, direction: "inbound", text: "Deal! 52.5k for one reel", sentAt: new Date() });
    if (!threadId) throw new Error("message not written");
    const deal = await db.createDeal(org, { threadId, seatId: created.seat.id, title: "Reel for Glow", dealType: "brand", amountMinor: 5_250_000, terms: { advancePercent: 50, paymentDays: 30 }, idempotencyKey: `${nonce}-deal` });
    return { org, seatId: created.seat.id, igAccountId: created.igAccount.id, threadId, nonce, deal };
  }

  it("keeps one workspace profile, numbers from it, and gives creator profiles to Roster only", async () => {
    const { org, seatId, igAccountId } = await setup("billing-a");
    expect(await db.getBillingProfile(org)).toEqual({ profile: null, inherited: false });
    const saved = await db.upsertBillingProfile(org, seatId, undefined, profile);
    expect(saved).toMatchObject({ igAccountId: null, legalName: "Riya Sharma", nextInvoiceNumber: expect.stringMatching(/^RIYA-\d{4}-\d{2}-001$/) });
    expect((await db.upsertBillingProfile(org, seatId, undefined, { ...profile, city: "Bombay" })).city).toBe("Bombay");
    expect(await prisma.billingProfile.count({ where: { orgId: org } })).toBe(1);
    expect(await db.getBillingProfile(org, igAccountId)).toMatchObject({ inherited: true, profile: { igAccountId: null } });
    await expect(db.upsertBillingProfile(org, seatId, igAccountId, { ...profile, invoicePrefix: "AGNT" })).rejects.toMatchObject({ status: 403 });
    expect(await prisma.auditLog.count({ where: { orgId: org, action: "billing.updated" } })).toBe(2);

    const roster = await setup("billing-roster", "roster");
    await db.upsertBillingProfile(roster.org, roster.seatId, undefined, profile);
    await expect(db.upsertBillingProfile(roster.org, roster.seatId, roster.igAccountId, profile)).rejects.toMatchObject({ status: 409 });
    const own = await db.upsertBillingProfile(roster.org, roster.seatId, roster.igAccountId, { ...profile, invoicePrefix: "AGNT" });
    expect(own.igAccountId).toBe(roster.igAccountId);
    expect(await db.getBillingProfile(roster.org, roster.igAccountId)).toMatchObject({ inherited: false, profile: { invoicePrefix: "AGNT" } });
    // The creator's invoices number from the creator's own profile.
    const invoice = await db.createInvoice(roster.org, roster.deal.id, roster.seatId, { kind: "full", billTo: glow });
    expect(invoice.number).toMatch(/^AGNT-\d{4}-\d{2}-001$/);
  });

  it("bills an advance then the balance, records each payment, and pays the deal when they cover the fee", async () => {
    const { org, seatId, deal, nonce } = await setup("invoices-a");
    await expect(db.createInvoice(org, deal.id, seatId, { kind: "advance", billTo: glow })).rejects.toMatchObject({ status: 409 }); // no billing profile yet
    await db.upsertBillingProfile(org, seatId, undefined, profile);

    const advance = await db.createInvoice(org, deal.id, seatId, { kind: "advance", billTo: glow, notes: "Advance before work starts" });
    expect(advance).toMatchObject({
      kind: "advance", status: "issued", title: "Tax invoice", supplyType: "domestic", placeOfSupply: "27",
      subtotalMinor: 2_625_000, taxMinor: 472_500, totalMinor: 3_097_500,
      taxes: [{ kind: "cgst", amountMinor: 236_250 }, { kind: "sgst", amountMinor: 236_250 }],
      lines: [{ description: "Advance (50%): Reel for Glow", sacCode: "998361", amountMinor: 2_625_000 }],
      supplier: { legalName: "Riya Sharma", timezone: "Asia/Kolkata", locale: "en-IN" },
    });
    expect(advance.number).toMatch(/^RIYA-\d{4}-\d{2}-001$/);
    const invoiced = await db.getDeal(org, deal.id);
    expect(invoiced).toMatchObject({ stage: "invoiced", dueAt: advance.dueAt, paidMinor: 0, invoices: [{ id: advance.id }] });

    // A later profile edit never changes an issued invoice.
    await db.upsertBillingProfile(org, seatId, undefined, { ...profile, legalName: "Riya S." });
    expect((await db.getInvoice(org, advance.id))?.supplier.legalName).toBe("Riya Sharma");

    const balance = await db.createInvoice(org, deal.id, seatId, { kind: "balance", billTo: glow });
    expect(balance).toMatchObject({ subtotalMinor: 2_625_000, number: expect.stringMatching(/-002$/) });
    await expect(db.createInvoice(org, deal.id, seatId, { kind: "balance", billTo: glow })).rejects.toMatchObject({ status: 409 });
    await expect(db.createInvoice(org, deal.id, seatId, { kind: "full", billTo: glow })).rejects.toMatchObject({ status: 409 });
    await expect(db.updateDeal(org, deal.id, seatId, { amountMinor: 6_000_000 })).rejects.toMatchObject({ status: 409 });
    await expect(db.markDealPaid(org, deal.id, seatId, { idempotencyKey: `${nonce}-mark` })).rejects.toMatchObject({ status: 409 });

    // TDS on the fee: the brand pays the total less TDS; Revenue counts the fee, not the GST.
    const key = `${nonce}-advance-paid`;
    const first = await db.markInvoicePaid(org, advance.id, seatId, { idempotencyKey: key, tdsMinor: 262_500 });
    expect(first.invoice).toMatchObject({ status: "paid", receivedMinor: 2_835_000, tdsMinor: 262_500 });
    expect(first.deal).toMatchObject({ stage: "invoiced", paidMinor: 2_625_000, dueAt: balance.dueAt });
    expect(await db.markInvoicePaid(org, advance.id, seatId, { idempotencyKey: key, tdsMinor: 262_500 })).toEqual(first);
    await expect(db.markInvoicePaid(org, advance.id, seatId, { idempotencyKey: key, tdsMinor: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(db.markInvoicePaid(org, advance.id, seatId, { idempotencyKey: `${nonce}-again` })).rejects.toMatchObject({ status: 409 });
    await expect(db.voidInvoice(org, advance.id, seatId)).rejects.toMatchObject({ status: 409 });

    const second = await db.markInvoicePaid(org, balance.id, seatId, { idempotencyKey: `${nonce}-balance-paid` });
    expect(second.deal).toMatchObject({ stage: "paid", receivedMinor: 2_835_000 + 3_097_500, tdsMinor: 262_500, paidMinor: 5_250_000 });
    const ledger = await db.getLedger(org);
    expect(ledger.entries.map((e) => e.amountMinor)).toEqual([2_625_000, 2_625_000]);
    expect(ledger.entries.map((e) => e.note).sort()).toEqual([`Reel for Glow · ${advance.number}`, `Reel for Glow · ${balance.number}`]);

    // A refunded balance reopens the invoice and the deal.
    const balanceEntry = await prisma.ledgerEntry.findFirstOrThrow({ where: { orgId: org, invoiceId: balance.id } });
    await db.deleteLedgerEntry(org, balanceEntry.id, seatId);
    expect(await db.getInvoice(org, balance.id)).toMatchObject({ status: "issued", paidAt: null, receivedMinor: null });
    expect(await db.getDeal(org, deal.id)).toMatchObject({ stage: "invoiced", paidMinor: 2_625_000, receivedMinor: null });

    // Voided, the balance leaves "Mark paid" to record what the advance left.
    expect((await db.voidInvoice(org, balance.id, seatId)).status).toBe("void");
    expect((await db.voidInvoice(org, balance.id, seatId)).status).toBe("void");
    const paid = await db.markDealPaid(org, deal.id, seatId, { idempotencyKey: `${nonce}-rest` });
    expect(paid).toMatchObject({ stage: "paid", receivedMinor: 2_835_000 + 2_625_000, tdsMinor: 262_500, paidMinor: 5_250_000 });
    expect(await db.markDealPaid(org, deal.id, seatId, { idempotencyKey: `${nonce}-rest` })).toEqual(paid);
    expect(await prisma.auditLog.count({ where: { orgId: org, action: { in: ["invoice.created", "invoice.paid", "invoice.voided"] } } })).toBe(5);
  });

  it("exports under a LUT without tax, and keeps every invoice inside its org", async () => {
    const a = await setup("invoices-b");
    const foreign = await setup("invoices-foreign");
    await db.upsertBillingProfile(a.org, a.seatId, undefined, { ...profile, tax: { ...profile.tax, lutArn: "AD270326001234X" } });
    const exported = await db.createInvoice(a.org, a.deal.id, a.seatId, { kind: "full", billTo: { name: "Glow Inc", addressLines: [], city: "Austin", state: "TX", country: "US", taxNumber: null } });
    expect(exported).toMatchObject({ title: "Export invoice", supplyType: "export_lut", placeOfSupply: "96", taxMinor: 0, totalMinor: 5_250_000, declaration: expect.stringContaining("AD270326001234X") });
    expect(await db.listDealInvoices(a.org, a.deal.id)).toHaveLength(1);

    expect(await db.getInvoice(foreign.org, exported.id)).toBeNull();
    await expect(db.listDealInvoices(foreign.org, a.deal.id)).rejects.toMatchObject({ status: 404 });
    await expect(db.createInvoice(foreign.org, a.deal.id, foreign.seatId, { kind: "full", billTo: glow })).rejects.toMatchObject({ status: 404 });
    await expect(db.markInvoicePaid(foreign.org, exported.id, foreign.seatId, { idempotencyKey: `${a.nonce}-steal` })).rejects.toMatchObject({ status: 404 });
    await expect(db.voidInvoice(foreign.org, exported.id, foreign.seatId)).rejects.toMatchObject({ status: 404 });

    expect((await db.getInvoiceForDelivery(exported.id))?.number).toBe(exported.number);
    // An unpaid invoice blocks cancelling its deal until it is voided.
    await expect(db.updateDeal(a.org, a.deal.id, a.seatId, { stage: "cancelled" })).rejects.toMatchObject({ status: 409, message: "void_invoices_first" });
    await db.voidInvoice(a.org, exported.id, a.seatId);
    expect((await db.updateDeal(a.org, a.deal.id, a.seatId, { stage: "cancelled" })).stage).toBe("cancelled");
    expect(await db.getInvoiceForDelivery(exported.id)).toBeNull();
    // A deleted deal takes its invoices out of sight.
    await db.deleteDeal(a.org, a.deal.id, a.seatId);
    expect(await db.getInvoice(a.org, exported.id)).toBeNull();
  });
});
