import { Prisma } from "@prisma/client";
import { DomainError, HIGH_INTENT_LABELS, type ClassificationLabel, type LeakScanSummary } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { minorUnitsToNumber } from "../money";
import { isVoiceMatch, sentEditRatios } from "../voice-match";

/**
 * How long a published leak-scan hand-off may take before the reveal stops
 * waiting for it. A message that will never be classified (its sender was
 * ignored meanwhile, or its job failed for good) must not leave the reveal
 * "running" forever.
 */
const LEAK_SCAN_SETTLE_MS = 10 * 60_000;

type LeakScanTotals = Omit<LeakScanSummary, "status">;

/**
 * Leak Scan reveal numbers (PRD §5.1.6): conservative unanswered commerce
 * value. A thread is one opportunity, even when several backfilled messages
 * were classified commerce; its most recent qualifying message sets the
 * estimate. Unanswered means the creator never replied in that thread.
 */
export async function leakScanTotals(orgId: OrgId): Promise<LeakScanTotals> {
  const [scannedCount, top] = await Promise.all([
    prisma.classification.count({ where: { orgId, source: "leak_scan" } }),
    // One row per thread (DISTINCT ON), then the totals over every such
    // thread (window aggregates run before LIMIT) beside the largest three.
    prisma.$queryRaw<Array<{
      threadId: string;
      handle: string;
      label: ClassificationLabel;
      valueMaxMinor: bigint | null;
      commerceCount: number;
      totalMinMinor: bigint;
    }>>`
      WITH opportunity AS (
        SELECT DISTINCT ON (m."threadId")
          m."threadId", t."participantHandle" AS "handle", c."label"::text AS "label",
          c."valueMinMinor", c."valueMaxMinor", m."sentAt", c."id"
        FROM "Classification" c
        JOIN "Message" m ON m."id" = c."messageId"
        JOIN "Thread" t ON t."id" = m."threadId"
        WHERE c."orgId" = ${orgId} AND c."source" = 'leak_scan' AND c."routedTo" = 'inbox'
          AND c."label"::text IN (${Prisma.join(HIGH_INTENT_LABELS)})
          AND c."valueMinMinor" IS NOT NULL
          AND t."lastOutboundAt" IS NULL
        ORDER BY m."threadId", m."sentAt" DESC, c."id" DESC
      )
      SELECT "threadId", "handle", "label", "valueMaxMinor",
        (count(*) OVER ())::int AS "commerceCount",
        (sum("valueMinMinor") OVER ())::bigint AS "totalMinMinor"
      FROM opportunity
      ORDER BY COALESCE("valueMaxMinor", 0) DESC, "sentAt" DESC, "id" DESC
      LIMIT 3`,
  ]);
  const totalMinMinor = top[0] ? Number(top[0].totalMinMinor) : 0;
  if (!Number.isSafeInteger(totalMinMinor)) throw new Error("leak_scan_total_exceeds_javascript_safe_integer");
  return {
    scannedCount,
    commerceCount: top[0]?.commerceCount ?? 0,
    totalMinMinor,
    topThreads: top.map((row) => ({
      threadId: row.threadId,
      handle: row.handle,
      label: row.label,
      estValueMaxMinor: row.valueMaxMinor === null ? null : minorUnitsToNumber(row.valueMaxMinor, "leak_scan_value"),
    })),
  };
}

/**
 * "idle" until a scan was started; "running" while any started account's
 * scan has not queued all its history yet, or while history it queued is
 * still on its way to a classification (not ingested, or not classified);
 * then "done".
 */
async function leakScanStatus(orgId: OrgId): Promise<LeakScanSummary["status"]> {
  // Prisma binds a Date as timestamptz; AT TIME ZONE 'UTC' compares it with
  // the UTC wall-clock timestamp(3) Prisma stores, whatever the session zone.
  const settled = new Date(Date.now() - LEAK_SCAN_SETTLE_MS);
  const accounts = await prisma.$queryRaw<Array<{ completed: boolean; pending: boolean }>>`
    SELECT a."leakScanCompletedAt" IS NOT NULL AS "completed",
      EXISTS (
        SELECT 1 FROM "OutboxEvent" o
        WHERE o."orgId" = a."orgId"
          AND o."createdAt" >= a."leakScanStartedAt"
          AND o."payload"->>'source' = 'leak_scan'
          AND o."payload"->>'igAccountId' = a."id"
          AND (o."processedAt" IS NULL OR o."processedAt" > (${settled} AT TIME ZONE 'UTC'))
          AND (
            (o."kind" = 'ingestion' AND o."payload"->>'direction' = 'inbound'
              AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."igMessageId" = o."payload"->>'igMessageId'))
            OR (o."kind" = 'classification'
              AND EXISTS (SELECT 1 FROM "Message" m WHERE m."id" = o."payload"->>'messageId' AND m."orgId" = o."orgId")
              AND NOT EXISTS (SELECT 1 FROM "Classification" c WHERE c."messageId" = o."payload"->>'messageId'))
          )
      ) AS "pending"
    FROM "IgAccount" a
    WHERE a."orgId" = ${orgId} AND a."leakScanStartedAt" IS NOT NULL`;
  if (accounts.length === 0) return "idle";
  return accounts.some((account) => !account.completed || account.pending) ? "running" : "done";
}

/** The onboarding reveal (GET /onboarding/leak-scan): the numbers so far and whether they are final. */
export async function getLeakScanSummary(orgId: OrgId): Promise<LeakScanSummary> {
  const [totals, status] = await Promise.all([leakScanTotals(orgId), leakScanStatus(orgId)]);
  // A scan from before its start was recorded has classified history: it finished.
  return { status: status === "idle" && totals.scannedCount > 0 ? "done" : status, ...totals };
}

/** A Leak Scan was queued for this account: the reveal reads "running" until it settles. */
export async function markLeakScanStarted(orgId: OrgId, igAccountId: string) {
  const started = await prisma.igAccount.updateMany({
    where: { id: igAccountId, orgId },
    data: { leakScanStartedAt: new Date(), leakScanCompletedAt: null },
  });
  if (!started.count) throw new DomainError("ig_account_not_in_org", 404);
}

/** The scan has queued all of its history; classification may still be catching up. */
export async function markLeakScanCompleted(orgId: OrgId, igAccountId: string) {
  await prisma.igAccount.updateMany({
    where: { id: igAccountId, orgId, leakScanStartedAt: { not: null } },
    data: { leakScanCompletedAt: new Date() },
  });
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
 * Voice fidelity = share of sends in the creator's voice (voice-match.ts).
 * Classification accuracy = % of reviewed items where the best guess held.
 */
export async function getWeeklyMetrics(orgId: OrgId, since = new Date(Date.now() - 7 * 864e5)) {
  const [sends, reviews, queueDepth, ledgerCount] = await Promise.all([
    prisma.draft.findMany({
      where: { orgId, status: "sent", sentAt: { gte: since }, modelVersion: { not: { startsWith: "heuristic" } } },
      select: { body: true, editDistance: true, editRatio: true, kind: true },
    }),
    prisma.classification.findMany({
      where: { orgId, reviewedAt: { gte: since }, AND: [
        { modelVersion: { not: { startsWith: "heuristic" } } },
        { modelVersion: { notIn: ["classify-error", "content-flag"] } },
      ] },
      select: { reviewOutcome: true, createdAt: true, reviewedAt: true },
    }),
    prisma.classification.count({
      where: { orgId, routedTo: "review_queue", reviewOutcome: null },
    }),
    prisma.ledgerEntry.count({ where: { orgId, closedAt: { gte: since }, deletedAt: null } }),
  ]);

  const ratios = sentEditRatios(sends);
  const confirmed = reviews.filter((r) => r.reviewOutcome === "confirmed");
  const clearanceMs = reviews
    .filter((r) => r.reviewedAt)
    .map((r) => r.reviewedAt!.getTime() - r.createdAt.getTime());

  return {
    since: since.toISOString(),
    sends: sends.length,
    nudgesSent: sends.filter((s) => s.kind === "nudge").length,
    voiceFidelity: ratios.length ? ratios.filter(isVoiceMatch).length / ratios.length : null,
    classificationAccuracy: reviews.length ? confirmed.length / reviews.length : null,
    reviewQueueDepth: queueDepth,
    avgReviewClearanceHours: clearanceMs.length
      ? clearanceMs.reduce((a, b) => a + b, 0) / clearanceMs.length / 36e5
      : null,
    dealsClosed: ledgerCount,
  };
}
