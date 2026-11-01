import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("creator-scoped ledger", () => {
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
  it("filters totals and month rollups before aggregation and rejects a foreign creator", async () => {
    const nonce = crypto.randomUUID();
    const create = async (suffix: string) => {
      const result = await db.createOrganizationWithCreator({ name: suffix, currencyCode: "INR", timezone: "Asia/Kolkata", creator: { clerkUserId: `${nonce}-${suffix}`, email: `${nonce}-${suffix}@example.test` }, igAccount: { igUserId: `${nonce}-${suffix}`, handle: suffix, accountType: "creator" } });
      orgs.push(result.org.id); return result;
    };
    const a = await create("ledger-a");
    const foreign = await create("ledger-foreign");
    const b = await prisma.igAccount.create({ data: { orgId: a.org.id, igUserId: `${nonce}-b`, handle: "ledger_b", accountType: "creator" } });
    const org = db.asOrgId(a.org.id);
    for (const [account, amount, key] of [[a.igAccount.id, 12345, "a"], [b.id, 67890, "b"]] as const) {
      const message = await db.upsertInboundMessage(org, { igAccountId: account, igThreadId: `${nonce}-${key}`, participantHandle: key, participantIgId: key, igMessageId: `${nonce}-${key}`, direction: "inbound", text: "buy", sentAt: new Date() });
      if (!("threadId" in message)) throw new Error("message not written");
      const entry = await db.closeDeal(org, { threadId: message.threadId, seatId: a.seat.id, amountMinor: amount, dealType: "brand", idempotencyKey: `${nonce}-${key}` });
      await prisma.ledgerEntry.update({ where: { id: entry.id }, data: { closedAt: new Date("2026-01-15T00:00:00Z") } });
    }
    const all = await db.getLedger(org, "2026-01");
    const scopedA = await db.getLedger(org, "2026-01", a.igAccount.id);
    const scopedB = await db.getLedger(org, "2026-01", b.id);
    expect(all.totalMinor).toBe(80235);
    expect(scopedA).toMatchObject({ totalMinor: 12345, months: [{ month: "2026-01", totalMinor: 12345, count: 1 }], entries: [{ handle: "a", currencyCode: "INR" }] });
    expect(scopedB).toMatchObject({ totalMinor: 67890, months: [{ month: "2026-01", totalMinor: 67890, count: 1 }], entries: [{ handle: "b", currencyCode: "INR" }] });
    await expect(db.getLedger(org, "2026-01", foreign.igAccount.id)).rejects.toMatchObject({ status: 404 });
  });
});
