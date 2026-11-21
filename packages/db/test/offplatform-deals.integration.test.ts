import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BillingProfileInput, InvoiceParty } from "@dealdock/core";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("deals agreed outside DealDock", () => {
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
    addressLines: ["12 Carter Road"],
    city: "Mumbai",
    state: "27",
    country: "IN",
    email: null,
    phone: null,
    tax: { kind: "gst_in", number: "27AAPFU0939F1ZV", ratePercent: null, lutArn: null },
    pan: null,
    udyamNumber: null,
    sacCode: "998361",
    payment: { upiId: "riya@okhdfcbank", bankName: null, accountName: null, accountNumber: null, ifsc: null, swift: null, iban: null, paymentLink: null },
    invoicePrefix: "RIYA",
  };
  const glow: InvoiceParty = { name: "Glow Co", addressLines: [], city: "Mumbai", state: "27", country: "IN", taxNumber: null };

  /** A Roster workspace: a creator account, its email inbox (with tokens), and an open Instagram conversation. */
  async function setup(suffix: string) {
    const nonce = crypto.randomUUID();
    const created = await db.createOrganizationWithCreator({ name: suffix, tier: "roster", currencyCode: "INR", timezone: "Asia/Kolkata", creator: { clerkUserId: `${nonce}-${suffix}`, email: `${nonce}-${suffix}@example.test` }, igAccount: { igUserId: `${nonce}-${suffix}`, handle: suffix, accountType: "creator" } });
    orgs.push(created.org.id);
    const org = db.asOrgId(created.org.id);
    const inbox = await prisma.igAccount.create({ data: { orgId: org, platform: "email", provider: "gmail", igUserId: `${nonce}@example.test`, handle: `${nonce}@example.test`, accountType: "creator", ownerAccountId: created.igAccount.id, accessTokenEnc: `${nonce}-token`, refreshTokenEnc: `${nonce}-token` } });
    const message = await db.upsertInboundMessage(org, { igAccountId: created.igAccount.id, igThreadId: `${nonce}-t`, participantHandle: "glowco", participantIgId: `${nonce}-glow`, igMessageId: `${nonce}-m`, direction: "inbound", text: "Loved your reel!", sentAt: new Date() });
    if (!message.threadId) throw new Error("message not written");
    return { org, seatId: created.seat.id, creatorId: created.igAccount.id, inboxId: inbox.id, threadId: message.threadId, nonce };
  }

  it("records, invoices and pays a deal without a conversation, and every read names its counterparty", async () => {
    const { org, seatId, creatorId, inboxId, threadId, nonce } = await setup("offplatform-a");
    const foreign = await setup("offplatform-foreign");
    const input = { igAccountId: creatorId, counterpartyHandle: " @glowco ", counterpartyName: "Glow Co", seatId, title: "Reel agreed on a call", dealType: "brand" as const, amountMinor: 5_000_000, terms: { advancePercent: 50, paymentDays: 15 }, idempotencyKey: `${nonce}-deal` };
    const deal = await db.createDeal(org, input);
    expect(deal).toMatchObject({ threadId: null, channel: null, igAccountId: creatorId, counterpartyHandle: "@glowco", counterpartyName: "Glow Co", stage: "agreed" });
    expect(await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).toMatchObject({ threadId: null, igAccountId: creatorId, counterpartyHandle: "@glowco" });
    // No conversation is touched: a missing thread id must never read as "any thread".
    expect(await db.getThreadDetail(org, threadId)).toMatchObject({ state: "open", deals: [] });
    expect((await db.createDeal(org, input)).id).toBe(deal.id);
    const other = await prisma.igAccount.create({ data: { orgId: org, igUserId: `${nonce}-other`, handle: "other_creator", accountType: "creator" } });
    await expect(db.createDeal(org, { ...input, igAccountId: other.id })).rejects.toMatchObject({ status: 409, code: "deal_idempotency_key_conflict" });

    // Only this org's creator accounts, never an email inbox, and always a counterparty.
    await expect(db.createDeal(org, { ...input, igAccountId: inboxId, idempotencyKey: `${nonce}-inbox` })).rejects.toMatchObject({ status: 400, code: "creator_account_required" });
    await expect(db.createDeal(org, { ...input, igAccountId: foreign.creatorId, idempotencyKey: `${nonce}-foreign` })).rejects.toMatchObject({ status: 404 });
    await expect(db.createDeal(org, { ...input, counterpartyHandle: "  ", idempotencyKey: `${nonce}-blank` })).rejects.toMatchObject({ status: 400, code: "counterparty_required" });
    await expect(db.createDeal(org, { ...input, igAccountId: undefined, idempotencyKey: `${nonce}-none` })).rejects.toMatchObject({ status: 400, code: "ig_account_required" });
    expect(await prisma.deal.count({ where: { orgId: org } })).toBe(1);

    expect((await db.listDeals(org, { status: "open", igAccountId: creatorId })).map((d) => d.id)).toEqual([deal.id]);
    expect(await db.listDeals(org, { status: "all", igAccountId: other.id })).toEqual([]);
    expect(await db.listDeals(org, { status: "all", threadId })).toEqual([]);

    // Invoices work without a conversation; they just can't be sent through DealDock.
    await db.upsertBillingProfile(org, seatId, undefined, profile);
    const advance = await db.createInvoice(org, deal.id, seatId, { kind: "advance", billTo: glow });
    expect(advance).toMatchObject({ dealId: deal.id, subtotalMinor: 2_500_000, taxMinor: 450_000 });
    const first = await db.markInvoicePaid(org, advance.id, seatId, { idempotencyKey: `${nonce}-advance` });
    expect(first.deal).toMatchObject({ threadId: null, stage: "invoiced", paidMinor: 2_500_000 });
    const balance = await db.createInvoice(org, deal.id, seatId, { kind: "balance", billTo: glow });
    expect((await db.voidInvoice(org, balance.id, seatId)).status).toBe("void");
    expect(await db.markDealPaid(org, deal.id, seatId, { idempotencyKey: `${nonce}-rest` })).toMatchObject({ stage: "paid", paidMinor: 5_000_000 });

    const ledger = await db.getLedger(org, undefined, creatorId);
    expect(ledger.totalMinor).toBe(5_000_000);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries.every((entry) => entry.threadId === null && entry.channel === null && entry.handle === "@glowco")).toBe(true);
    expect(await prisma.ledgerEntry.count({ where: { orgId: org, igAccountId: creatorId, threadId: null, counterpartyHandle: "@glowco" } })).toBe(2);
    expect((await db.getLedger(org, undefined, other.id)).entries).toEqual([]);

    expect((await db.getInsights(org)).topDeals).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: null, handle: "@glowco", amountMinor: 2_500_000 })]));
    expect((await db.getRosterOverview(org)).find((row) => row.igAccountId === creatorId)?.mtdRecoveredMinor).toBe(5_000_000);
    expect((await db.getDashboard(org)).mtdRecoveredMinor).toBe(5_000_000);
    // A sender card counts money from its own conversations only.
    expect((await db.getThreadDetail(org, threadId))?.participant.closedTotalMinor).toBe(0);

    const audit = await db.listAuditRows(org, 200);
    for (const action of ["deal.created", "deal.paid", "invoice.created", "invoice.paid", "ledger.created"]) {
      const rows = audit.filter((row) => row.action === action);
      expect(rows.length, action).toBeGreaterThan(0);
      expect(rows.every((row) => row.threadId === null && row.handle === "@glowco"), action).toBe(true);
    }
  });

  it("lists and exports deals, invoices, billing profiles and inboxes (never tokens), and deletion leaves none", async () => {
    const { org, seatId, creatorId, inboxId, nonce } = await setup("offplatform-data");
    await db.upsertBillingProfile(org, seatId, undefined, profile);
    const deal = await db.createDeal(org, { igAccountId: creatorId, counterpartyHandle: "Priya Sharma", seatId, title: "Workshop", dealType: "coaching", amountMinor: 1_000_000, paid: {}, idempotencyKey: `${nonce}-deal` });
    const invoice = await db.createInvoice(org, (await db.createDeal(org, { igAccountId: creatorId, counterpartyHandle: "Priya Sharma", seatId, title: "Course", dealType: "course", amountMinor: 200_000, idempotencyKey: `${nonce}-deal-2` })).id, seatId, { kind: "full", billTo: { ...glow, name: "प्रिया शर्मा" } });

    const summary = await db.getDataSummary(org);
    expect(summary).toMatchObject({ deals: 2, invoices: 1, billingProfiles: 1, ledgerEntries: 1, emailInboxes: [{ id: inboxId, status: "active" }] });
    expect(Object.keys(summary.emailInboxes[0]!).sort()).toEqual(["address", "connectedAt", "id", "status"]);

    const archive = await db.exportOrgArchive(org);
    expect(archive.deals).toEqual(expect.arrayContaining([expect.objectContaining({ id: deal.id, threadId: null, igAccountId: creatorId, counterpartyHandle: "Priya Sharma" })]));
    expect(archive.invoices).toMatchObject([{ id: invoice.id, number: invoice.number, supplier: { legalName: "Riya Sharma", locale: "en-IN" }, billTo: { name: "प्रिया शर्मा" } }]);
    expect(archive.billingProfiles).toMatchObject([{ igAccountId: null, legalName: "Riya Sharma" }]);
    expect(archive.emailInboxes).toMatchObject([{ id: inboxId, status: "active" }]);
    expect(archive.ledger).toMatchObject([{ threadId: null, igAccountId: creatorId, counterpartyHandle: "Priya Sharma" }]);
    expect(JSON.stringify(archive)).not.toContain(`${nonce}-token`);

    // Deals and money without a thread go with their creator account.
    await db.hardDeleteOrg(org);
    orgs.splice(orgs.indexOf(org), 1);
    expect(await db.countOrgResidue(org)).toMatchObject({ accounts: 0, threads: 0, deals: 0, invoices: 0, billingProfiles: 0, ledger: 0 });
  });
});
