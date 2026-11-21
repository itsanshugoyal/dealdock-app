import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { COMMENT_REPLY_WINDOW_MS } from "@dealdock/core";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("comment leads", () => {
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
    for (const id of orgs) await db.hardDeleteOrg(id).catch(() => undefined);
    await prisma?.$disconnect();
  });

  async function setup(suffix: string) {
    const nonce = crypto.randomUUID();
    const created = await db.createOrganizationWithCreator({ name: suffix, tier: "roster", currencyCode: "INR", timezone: "Asia/Kolkata", creator: { clerkUserId: `${nonce}-${suffix}`, email: `${nonce}-${suffix}@example.test` }, igAccount: { igUserId: `${nonce}-${suffix}`, handle: suffix, accountType: "creator" } });
    orgs.push(created.org.id);
    return { org: db.asOrgId(created.org.id), seatId: created.seat.id, igAccountId: created.igAccount.id, nonce };
  }
  const comment = (igAccountId: string, commentId: string, over: Partial<import("../src/index").CommentLeadInput> = {}) => ({
    igAccountId, commentId, mediaId: "m1", commenterIgId: `ig-${commentId}`, commenterHandle: `fan_${commentId}`, text: "PRICE?", keyword: "PRICE", commentedAt: new Date(), ...over,
  });

  it("stores trimmed keywords per creator, only for this org's Instagram accounts", async () => {
    const { org, seatId, igAccountId } = await setup("cl-keywords");
    const foreign = await setup("cl-keywords-foreign");
    expect(await db.setCommentKeywords(org, seatId, igAccountId, ["  PRICE ", "price", "how   much"])).toEqual(["PRICE", "how much"]);
    expect(await db.listCommentKeywords(org)).toEqual([{ igAccountId, keywords: ["PRICE", "how much"] }]);
    await expect(db.setCommentKeywords(org, seatId, foreign.igAccountId, ["PRICE"])).rejects.toMatchObject({ status: 404 });
    await expect(db.setCommentKeywords(org, seatId, igAccountId, Array.from({ length: 11 }, (_, i) => `k${i}`))).rejects.toMatchObject({ status: 400, code: "too_many_keywords" });
    expect(await prisma.auditLog.count({ where: { orgId: org, action: "settings.comment_keywords_changed" } })).toBe(1);
  });

  it("creates one lead per comment, never for skipped people or comments past 7 days", async () => {
    const { org, seatId, igAccountId } = await setup("cl-create");
    const first = await db.createCommentLead(org, comment(igAccountId, "c1"));
    const again = await db.createCommentLead(org, comment(igAccountId, "c1", { text: "redelivered" }));
    expect("id" in first && "id" in again && again.id === first.id).toBe(true);
    expect(await prisma.commentLead.count({ where: { orgId: org } })).toBe(1);

    await db.setIgnoreList(org, seatId, ["cousin.aarav"]);
    expect(await db.createCommentLead(org, comment(igAccountId, "c2", { commenterHandle: "Cousin.Aarav" }))).toEqual({ skipped: "ignored" });
    expect(await db.createCommentLead(org, comment(igAccountId, "c3", { commentedAt: new Date(Date.now() - COMMENT_REPLY_WINDOW_MS - 1000) }))).toEqual({ skipped: "too_late" });
    const foreign = await setup("cl-create-foreign");
    await expect(db.createCommentLead(org, comment(foreign.igAccountId, "c4"))).rejects.toMatchObject({ status: 404 });
    expect(await prisma.commentLead.count({ where: { orgId: org } })).toBe(1);
  });

  it("claims a lead for sending exactly once, even when sends race", async () => {
    const { org, seatId, igAccountId } = await setup("cl-claim");
    const lead = await db.createCommentLead(org, comment(igAccountId, "c1"));
    if (!("id" in lead)) throw new Error("lead not created");
    await db.saveCommentLeadDraft(org, lead.id, { body: "Heyy! It's ₹7,999.", modelVersion: "test", missingFacts: [] });

    const claims = await Promise.all(Array.from({ length: 5 }, () => db.claimCommentLeadSend(org, lead.id, seatId)));
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.claimed).map((claim) => !claim.claimed && claim.reason)).toEqual(["sending", "sending", "sending", "sending"]);
    // A draft never lands on a lead being sent.
    expect(await db.saveCommentLeadDraft(org, lead.id, { body: "late draft", modelVersion: "test", missingFacts: [] })).toBe(false);

    // A failed send frees it; the next one claims it again and completes.
    await db.releaseCommentLeadSend(org, lead.id);
    expect((await db.claimCommentLeadSend(org, lead.id, seatId)).claimed).toBe(true);
    const sentAt = new Date();
    const sent = await db.completeCommentLeadSend(org, lead.id, { seatId, text: "Heyy! It's ₹7,999. Link below.", sentAt });
    expect(sent).toMatchObject({ status: "sent", draftBody: "Heyy! It's ₹7,999. Link below.", sentAt });
    expect(await db.claimCommentLeadSend(org, lead.id, seatId)).toEqual({ claimed: false, reason: "sent" });
    expect(await prisma.commentLead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ sentBySeatId: seatId });
    expect(await prisma.auditLog.findFirst({ where: { orgId: org, action: "comment_lead.sent", entityId: lead.id } })).toMatchObject({ seatId, detail: { igAccountId, keyword: "PRICE", edited: true } });
    // Another org can't claim or even see it.
    const foreign = await setup("cl-claim-foreign");
    expect(await db.claimCommentLeadSend(foreign.org, lead.id, foreign.seatId)).toEqual({ claimed: false, reason: "not_found" });
    expect(await db.getCommentLead(foreign.org, lead.id)).toBeNull();
    // Nor can another org's seat send for this one.
    await expect(db.claimCommentLeadSend(org, lead.id, foreign.seatId)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to send after the comment's 7 days, then clears what is too late", async () => {
    const { org, seatId, igAccountId } = await setup("cl-late");
    const fresh = await db.createCommentLead(org, comment(igAccountId, "fresh"));
    const late = await db.createCommentLead(org, comment(igAccountId, "late"));
    if (!("id" in fresh) || !("id" in late)) throw new Error("leads not created");
    // Seven days pass for one of them.
    await prisma.commentLead.update({ where: { id: late.id }, data: { commentedAt: new Date(Date.now() - COMMENT_REPLY_WINDOW_MS - 60_000) } });
    expect(await db.claimCommentLeadSend(org, late.id, seatId)).toEqual({ claimed: false, reason: "too_late" });
    expect((await db.listCommentLeads(org)).map((lead) => lead.id).sort()).toEqual([fresh.id, late.id].sort());

    expect(await db.clearExpiredCommentLeads(org, seatId)).toBe(1);
    expect((await db.listCommentLeads(org)).map((lead) => lead.id)).toEqual([fresh.id]);
  });

  it("skips a lead once, hides it, and keeps 'sent' and 'sentAt' together", async () => {
    const { org, seatId, igAccountId } = await setup("cl-skip");
    const lead = await db.createCommentLead(org, comment(igAccountId, "c1"));
    if (!("id" in lead)) throw new Error("lead not created");
    await db.skipCommentLead(org, seatId, lead.id);
    await expect(db.skipCommentLead(org, seatId, lead.id)).rejects.toMatchObject({ status: 409, code: "comment_lead_not_open" });
    expect(await db.listCommentLeads(org)).toEqual([]);
    expect(await db.claimCommentLeadSend(org, lead.id, seatId)).toEqual({ claimed: false, reason: "skipped" });
    await expect(prisma.commentLead.update({ where: { id: lead.id }, data: { status: "sent" } })).rejects.toThrow();
  });

  it("exports leads with the account's data and deletes them with it", async () => {
    const { org, igAccountId } = await setup("cl-privacy");
    const lead = await db.createCommentLead(org, comment(igAccountId, "c1"));
    if (!("id" in lead)) throw new Error("lead not created");
    const archive = (await db.exportOrgArchive(org)) as { commentLeads: Array<{ id: string; text: string }> };
    expect(archive.commentLeads).toMatchObject([{ id: lead.id, text: "PRICE?" }]);
    await db.hardDeleteOrg(org);
    expect((await db.countOrgResidue(org)).commentLeads).toBe(0);
  });
});
