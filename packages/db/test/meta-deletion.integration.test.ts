import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("Meta deauthorize and data deletion", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const orgs: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.TOKEN_ENCRYPTION_KEY ||= "11".repeat(32);
    vi.resetModules();
    db = await import("../src/index");
    ({ prisma } = await import("../src/client"));
  }, 60000);
  afterAll(async () => {
    for (const id of orgs) await db.hardDeleteOrg(id).catch(() => undefined);
    await prisma?.$disconnect();
  });

  /** An org with one Instagram account holding a thread, a voice note, a sent-reply audit row and an outbox payload. */
  async function setup(suffix: string, metaUserId?: string) {
    const nonce = crypto.randomUUID();
    const created = await db.createOrganizationWithCreator({ name: suffix, tier: "roster", currencyCode: "INR", timezone: "Asia/Kolkata", creator: { clerkUserId: `${nonce}-${suffix}`, email: `${nonce}-${suffix}@example.test` }, igAccount: { igUserId: `${nonce}-ig`, handle: suffix, accountType: "creator" } });
    orgs.push(created.org.id);
    const orgId = created.org.id;
    const igAccountId = created.igAccount.id;
    await prisma.igAccount.update({ where: { id: igAccountId }, data: { metaUserId: metaUserId ?? null, accessTokenEnc: "enc", tokenRefreshedAt: new Date(Date.now() - 60_000), status: "active" } });
    const audio = await prisma.audioAsset.create({ data: { orgId, kind: "inbound", mimeType: "audio/mp4", bytes: Buffer.from("voice"), sizeBytes: 5, sha256: "x" } });
    const thread = await prisma.thread.create({ data: { orgId, igAccountId, igThreadId: `t-${nonce}`, participantHandle: "brand", participantIgId: `p-${nonce}`, lastMessageAt: new Date() } });
    const message = await prisma.message.create({ data: { orgId, threadId: thread.id, igMessageId: `m-${nonce}`, direction: "inbound", text: "secret rate", sentAt: new Date(), audioAssetId: audio.id } });
    const draft = await prisma.draft.create({ data: { orgId, threadId: thread.id, body: "reply text", modelVersion: "t", promptVersion: "t" } });
    await prisma.auditLog.create({ data: { orgId, seatId: created.seat.id, action: "message.sent", entityType: "draft", entityId: draft.id, detail: { finalText: "reply text" } } });
    await prisma.auditLog.create({ data: { orgId, seatId: created.seat.id, action: "seat.invited", entityType: "seat", entityId: "unrelated" } });
    await prisma.outboxEvent.create({ data: { orgId, kind: "ingestion", dedupeKey: `ingest-${nonce}`, payload: { igAccountId, text: "secret rate" } } });
    return { orgId, igAccountId, igUserId: `${nonce}-ig`, threadId: thread.id, messageId: message.id, audioId: audio.id };
  }

  it("deauthorize matches metaUserId or igUserId, drops tokens and audits without a seat", async () => {
    const byMeta = await setup("meta-deauth", "990001");
    const byIg = await setup("meta-deauth-ig");
    expect(await db.deauthorizeMetaUser("990001")).toBe(1);
    expect(await db.deauthorizeMetaUser(byIg.igUserId)).toBe(1);
    for (const s of [byMeta, byIg]) {
      const account = await prisma.igAccount.findUniqueOrThrow({ where: { id: s.igAccountId } });
      expect(account).toMatchObject({ status: "disconnected", accessTokenEnc: null, refreshTokenEnc: null });
      expect(await prisma.auditLog.count({ where: { orgId: s.orgId, action: "ig.deauthorized", seatId: null } })).toBe(1);
    }
    expect(await db.deauthorizeMetaUser("990001")).toBe(0); // already disconnected
    expect(await db.deauthorizeMetaUser("123456789")).toBe(0); // not ours
  });

  it("a deletion request deletes the account's data, keeps the org, and leaves other accounts alone", async () => {
    const target = await setup("meta-delete", "990002");
    const bystander = await setup("meta-delete-other", "990003");
    const { confirmationCode } = await db.createMetaDeletionRequest("990002");
    expect(confirmationCode).toMatch(/^[0-9a-f]{32}$/);
    expect(await db.getMetaDeletionStatus(confirmationCode)).toMatchObject({ status: "pending", completedAt: null });

    const run = await db.processPendingMetaDeletions();
    expect(run.accountsDeleted).toBeGreaterThanOrEqual(1);
    expect(await db.getMetaDeletionStatus(confirmationCode)).toMatchObject({ status: "completed" });

    expect(await prisma.igAccount.count({ where: { id: target.igAccountId } })).toBe(0);
    expect(await prisma.thread.count({ where: { id: target.threadId } })).toBe(0);
    expect(await prisma.message.count({ where: { id: target.messageId } })).toBe(0);
    expect(await prisma.audioAsset.count({ where: { id: target.audioId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { orgId: target.orgId, action: "message.sent" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { orgId: target.orgId, action: "seat.invited" } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { orgId: target.orgId } })).toBe(0);
    const summary = await prisma.auditLog.findFirstOrThrow({ where: { orgId: target.orgId, action: "ig.data_deleted" } });
    expect(summary.detail).toEqual({ deletedThreads: 1, deletedMessages: 1 });
    expect(await prisma.organization.count({ where: { id: target.orgId } })).toBe(1);

    for (const id of [bystander.igAccountId]) expect(await prisma.igAccount.count({ where: { id } })).toBe(1);
    expect(await prisma.message.count({ where: { id: bystander.messageId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { orgId: bystander.orgId } })).toBe(1);
  });

  it("an account reconnected after the request is not deleted", async () => {
    const s = await setup("meta-reconnected", "990004");
    const { confirmationCode } = await db.createMetaDeletionRequest("990004");
    await prisma.igAccount.update({ where: { id: s.igAccountId }, data: { status: "active", tokenRefreshedAt: new Date(Date.now() + 60_000) } });
    await db.processPendingMetaDeletions();
    expect(await prisma.igAccount.count({ where: { id: s.igAccountId } })).toBe(1);
    expect(await db.getMetaDeletionStatus(confirmationCode)).toMatchObject({ status: "completed" });
  });

  it("connectGraphAccount stores the Meta user id on connect and keeps it on a reconnect without one", async () => {
    const s = await setup("meta-connect");
    const org = db.asOrgId(s.orgId);
    await db.connectGraphAccount(org, { igUserId: s.igUserId, handle: "meta-connect", accountType: "creator", accessToken: "t", metaUserId: "990005" });
    expect((await prisma.igAccount.findUniqueOrThrow({ where: { id: s.igAccountId } })).metaUserId).toBe("990005");
    await db.connectGraphAccount(org, { igUserId: s.igUserId, handle: "meta-connect", accountType: "creator", accessToken: "t2" });
    expect((await prisma.igAccount.findUniqueOrThrow({ where: { id: s.igAccountId } })).metaUserId).toBe("990005");
  });
});
