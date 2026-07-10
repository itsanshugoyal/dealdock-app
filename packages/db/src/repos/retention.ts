import { prisma } from "../client";

/**
 * SYSTEM-CONTEXT retention queries (PRD §6.11, §5.7 — the privacy promises
 * as code, verified by the M5 deletion drill):
 *  - account deletion: 7-day grace after deletionRequestedAt → hard delete
 *  - post-cancellation: ledger read-only 30 days after currentPeriodEnd → hard delete
 * Hard delete = the Organization row cascades through every child table
 * (seats, accounts, threads, messages, classifications, drafts, ledger,
 * voice profiles, audit logs, subscriptions, push subscriptions).
 */

export async function listOrgsDueHardDelete(now = new Date()) {
  const graceCutoff = new Date(now.getTime() - 7 * 864e5);
  const postCancelCutoff = new Date(now.getTime() - 30 * 864e5);

  const [requested, expired] = await Promise.all([
    prisma.organization.findMany({
      where: { deletionRequestedAt: { lte: graceCutoff } },
      select: { id: true, name: true, deletionRequestedAt: true },
    }),
    prisma.organization.findMany({
      where: {
        deletionRequestedAt: null,
        subscription: {
          status: "cancelled",
          currentPeriodEnd: { lte: postCancelCutoff },
        },
      },
      select: { id: true, name: true },
    }),
  ]);

  return [
    ...requested.map((o) => ({ orgId: o.id, reason: "deletion_requested" as const })),
    ...expired.map((o) => ({ orgId: o.id, reason: "post_cancel_expiry" as const })),
  ];
}

/** Irreversible. Cascades wipe every org-scoped row. */
export async function hardDeleteOrg(orgId: string) {
  const counts = await Promise.all([
    prisma.message.count({ where: { orgId } }),
    prisma.ledgerEntry.count({ where: { orgId } }),
  ]);
  await prisma.organization.delete({ where: { id: orgId } });
  return { deletedMessages: counts[0], deletedLedgerEntries: counts[1] };
}

/** DRILL-ONLY: backdate a deletion request to simulate the grace elapsing. */
export async function backdateDeletionRequest(orgId: string, daysAgo: number) {
  await prisma.organization.update({
    where: { id: orgId },
    data: { deletionRequestedAt: new Date(Date.now() - daysAgo * 864e5) },
  });
}

/** Drill support: prove-it's-gone check after a hard delete. */
export async function countOrgResidue(orgId: string) {
  const [org, threads, messages, classifications, drafts, ledger, audit, subs] =
    await Promise.all([
      prisma.organization.count({ where: { id: orgId } }),
      prisma.thread.count({ where: { orgId } }),
      prisma.message.count({ where: { orgId } }),
      prisma.classification.count({ where: { orgId } }),
      prisma.draft.count({ where: { orgId } }),
      prisma.ledgerEntry.count({ where: { orgId } }),
      prisma.auditLog.count({ where: { orgId } }),
      prisma.subscription.count({ where: { orgId } }),
    ]);
  return { org, threads, messages, classifications, drafts, ledger, audit, subs };
}
