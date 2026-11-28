import { randomBytes } from "node:crypto";
import { prisma } from "../client";
import { writeAudit } from "../audit-log";

/**
 * Meta's deauthorize and data-deletion callbacks (App Review requirement).
 * SYSTEM context: a callback carries only Meta's user id, never an org, so these
 * resolve the Instagram accounts it points at. Meta's docs leave open which id
 * arrives (app-scoped vs professional account id, Instagram vs Unified Login),
 * so an account matches on either IgAccount.metaUserId or igUserId.
 */
const accountsFor = (metaUserId: string) => ({ platform: "instagram" as const, OR: [{ metaUserId }, { igUserId: metaUserId }] });

/** The person removed DealDock in Instagram/Facebook: stop syncing and drop the tokens now. Returns accounts changed. */
export async function deauthorizeMetaUser(metaUserId: string): Promise<number> {
  const accounts = await prisma.igAccount.findMany({
    where: { ...accountsFor(metaUserId), status: { not: "disconnected" } },
    select: { id: true, orgId: true },
  });
  for (const account of accounts) {
    await prisma.$transaction([
      prisma.igAccount.update({
        where: { id: account.id },
        data: { status: "disconnected", disconnectedAt: new Date(), accessTokenEnc: null, refreshTokenEnc: null },
      }),
      writeAudit(prisma, { orgId: account.orgId, seatId: null, action: "ig.deauthorized", entityType: "ig_account", entityId: account.id }),
    ]);
  }
  return accounts.length;
}

/** Records the request Meta's data-deletion callback answers for; the worker's retention job carries it out. */
export async function createMetaDeletionRequest(metaUserId: string) {
  return prisma.metaDeletionRequest.create({
    data: { metaUserId, confirmationCode: randomBytes(16).toString("hex") },
    select: { id: true, confirmationCode: true },
  });
}

/** The public status page's view: no ids, names or counts. */
export async function getMetaDeletionStatus(confirmationCode: string) {
  return prisma.metaDeletionRequest.findUnique({
    where: { confirmationCode },
    select: { status: true, createdAt: true, completedAt: true },
  });
}

/**
 * SYSTEM context (retention job): carry out pending requests, oldest first.
 * An account reconnected after the request (fresh token) is left alone: the
 * person chose to use DealDock again. Safe to re-run after a crash, because a
 * deleted account no longer matches.
 */
export async function processPendingMetaDeletions(limit = 50) {
  const pending = await prisma.metaDeletionRequest.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: limit });
  let accountsDeleted = 0;
  for (const request of pending) {
    const accounts = await prisma.igAccount.findMany({
      where: {
        AND: [
          accountsFor(request.metaUserId),
          { OR: [{ status: { not: "active" } }, { tokenRefreshedAt: null }, { tokenRefreshedAt: { lte: request.createdAt } }] },
        ],
      },
      select: { id: true },
    });
    for (const account of accounts) if (await deleteInstagramAccountData(account.id)) accountsDeleted++;
    await prisma.metaDeletionRequest.update({
      where: { id: request.id },
      data: { status: "completed", completedAt: new Date(), accountsDeleted: { increment: accounts.length } },
    });
  }
  return { requests: pending.length, accountsDeleted };
}

/**
 * Irreversible. Deletes one Instagram account and everything DealDock holds
 * from or about it: the account row cascades to its threads, messages, drafts,
 * classifications, deals, invoices, ledger entries, comment leads, offers, voice
 * profile, rules and checkpoint. Removed explicitly first, because nothing
 * cascades to them: audio (voice notes, sent voice clips, voice samples), audit
 * rows about those records (sent-message rows quote the text), and outbox events
 * still carrying this account's messages. The organization, its seats and its
 * other accounts stay. Counts only in the summary audit row.
 */
export async function deleteInstagramAccountData(igAccountId: string) {
  return prisma.$transaction(
    async (tx) => {
      const account = await tx.igAccount.findUnique({ where: { id: igAccountId }, select: { id: true, orgId: true } });
      if (!account) return null;
      const { id, orgId } = account;
      const threads = await tx.thread.count({ where: { igAccountId: id } });
      const messages = await tx.message.count({ where: { thread: { igAccountId: id } } });

      await tx.$executeRaw`
        DELETE FROM "AudioAsset" WHERE "orgId" = ${orgId} AND "id" IN (
          SELECT m."audioAssetId" FROM "Message" m JOIN "Thread" t ON t."id" = m."threadId"
            WHERE t."igAccountId" = ${id} AND m."audioAssetId" IS NOT NULL
          UNION SELECT si."audioAssetId" FROM "SendIntent" si JOIN "Draft" d ON d."id" = si."draftId" JOIN "Thread" t ON t."id" = d."threadId"
            WHERE t."igAccountId" = ${id} AND si."audioAssetId" IS NOT NULL
          UNION SELECT unnest("sampleAssetIds") FROM "SpeakingVoice" WHERE "igAccountId" = ${id}
        )`;
      await tx.$executeRaw`
        DELETE FROM "AuditLog" WHERE "orgId" = ${orgId} AND "entityId" IN (
          SELECT ${id}::text
          UNION SELECT "id" FROM "Thread" WHERE "igAccountId" = ${id}
          UNION SELECT m."id" FROM "Message" m JOIN "Thread" t ON t."id" = m."threadId" WHERE t."igAccountId" = ${id}
          UNION SELECT d."id" FROM "Draft" d JOIN "Thread" t ON t."id" = d."threadId" WHERE t."igAccountId" = ${id}
          UNION SELECT "id" FROM "Deal" WHERE "igAccountId" = ${id}
          UNION SELECT i."id" FROM "Invoice" i JOIN "Deal" dl ON dl."id" = i."dealId" WHERE dl."igAccountId" = ${id}
          UNION SELECT "id" FROM "LedgerEntry" WHERE "igAccountId" = ${id}
          UNION SELECT "id" FROM "CommentLead" WHERE "igAccountId" = ${id}
          UNION SELECT "id" FROM "Offer" WHERE "igAccountId" = ${id}
        )`;
      await tx.$executeRaw`DELETE FROM "OutboxEvent" WHERE "orgId" = ${orgId} AND "payload"->>'igAccountId' = ${id}`;
      await tx.igAccount.delete({ where: { id } });
      await writeAudit(tx, {
        orgId,
        seatId: null,
        action: "ig.data_deleted",
        entityType: "ig_account",
        entityId: id,
        detail: { deletedThreads: threads, deletedMessages: messages },
      });
      return { orgId, deletedThreads: threads, deletedMessages: messages };
    },
    // Large inboxes: allow more than Prisma's 5 s default.
    { timeout: 120_000 },
  );
}
