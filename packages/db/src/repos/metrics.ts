import { prisma } from "../client";
import type { OrgId } from "../org-id";

const HIGH_INTENT = ["brand_deal", "coaching_lead", "course_inquiry", "other_commerce"];

/** Leak Scan reveal numbers (PRD §5.1.6): conservative unanswered commerce value. */
export async function getLeakScanSummary(orgId: OrgId) {
  const [scanned, commerce] = await Promise.all([
    prisma.classification.count({ where: { orgId, source: "leak_scan" } }),
    prisma.classification.findMany({
      where: {
        orgId,
        source: "leak_scan",
        routedTo: "inbox",
        label: { in: HIGH_INTENT as never },
        valueMinMinor: { not: null },
      },
      include: {
        message: {
          select: {
            thread: {
              select: {
                id: true,
                participantHandle: true,
                lastOutboundAt: true,
                topLabel: true,
                estValueMaxMinor: true,
              },
            },
          },
        },
      },
    }),
  ]);

  // Unanswered = the creator never replied on that thread.
  const unanswered = commerce.filter((c) => c.message.thread.lastOutboundAt === null);
  const totalMinMinor = unanswered.reduce((a, c) => a + Number(c.valueMinMinor ?? 0), 0);
  const topThreads = [...new Map(unanswered.map((c) => [c.message.thread.id, c.message.thread])).values()]
    .sort((a, b) => Number(b.estValueMaxMinor ?? 0) - Number(a.estValueMaxMinor ?? 0))
    .slice(0, 3)
    .map((t) => ({
      threadId: t.id,
      handle: t.participantHandle,
      label: t.topLabel,
      estValueMaxMinor: t.estValueMaxMinor === null ? null : Number(t.estValueMaxMinor),
    }));

  return { scannedCount: scanned, commerceCount: unanswered.length, totalMinMinor, topThreads };
}

/**
 * Load-harness support: ingestion lag (message arrival → classification row)
 * for messages whose platform id starts with the given run prefix.
 */
export async function getIngestionLagsMs(orgId: OrgId, igMessageIdPrefix: string) {
  const rows = await prisma.classification.findMany({
    where: { orgId, message: { igMessageId: { startsWith: igMessageIdPrefix } } },
    select: { createdAt: true, message: { select: { sentAt: true } } },
  });
  return rows.map((r) => r.createdAt.getTime() - r.message.sentAt.getTime());
}

/**
 * Weekly internal metrics (PRD §7.4: real numbers from week 1).
 * Voice fidelity = % of sends with edit ratio < 20% (PRD voice bar).
 * Classification accuracy = % of reviewed items where the best guess held.
 */
export async function getWeeklyMetrics(orgId: OrgId, since = new Date(Date.now() - 7 * 864e5)) {
  const [sends, reviews, queueDepth, ledgerCount] = await Promise.all([
    prisma.draft.findMany({
      where: { orgId, status: "sent", sentAt: { gte: since } },
      select: { body: true, editDistance: true, kind: true },
    }),
    prisma.classification.findMany({
      where: { orgId, reviewedAt: { gte: since } },
      select: { reviewOutcome: true, createdAt: true, reviewedAt: true },
    }),
    prisma.classification.count({
      where: { orgId, routedTo: "review_queue", reviewOutcome: null },
    }),
    prisma.ledgerEntry.count({ where: { orgId, closedAt: { gte: since }, deletedAt: null } }),
  ]);

  const withDistance = sends.filter((s) => s.editDistance !== null);
  const minorEdits = withDistance.filter(
    (s) => (s.editDistance ?? 0) / Math.max(1, s.body.length) < 0.2
  );
  const confirmed = reviews.filter((r) => r.reviewOutcome === "confirmed");
  const clearanceMs = reviews
    .filter((r) => r.reviewedAt)
    .map((r) => r.reviewedAt!.getTime() - r.createdAt.getTime());

  return {
    since: since.toISOString(),
    sends: sends.length,
    nudgesSent: sends.filter((s) => s.kind === "nudge").length,
    voiceFidelity: withDistance.length ? minorEdits.length / withDistance.length : null,
    classificationAccuracy: reviews.length ? confirmed.length / reviews.length : null,
    reviewQueueDepth: queueDepth,
    avgReviewClearanceHours: clearanceMs.length
      ? clearanceMs.reduce((a, b) => a + b, 0) / clearanceMs.length / 36e5
      : null,
    dealsClosed: ledgerCount,
  };
}
