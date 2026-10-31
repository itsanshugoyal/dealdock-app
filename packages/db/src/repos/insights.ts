import { DEAL_TYPES, DomainError, HIGH_INTENT_LABELS, type CurrencyCode, type Insights } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { minorUnitsToNumber } from "../money";
import { isNudgeDue } from "../schedule-rules";
import { sentEditRatios, voiceMatchPct } from "../voice-match";
import { daysInZonedMonth, startOfZonedMonth, startOfZonedWeek, zonedMonthKey, zonedMonthKeys } from "../zoned-time";
import { leakScanTotals } from "./metrics";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function addMinor(total: number, amount: number): number {
  const next = total + amount;
  if (!Number.isSafeInteger(next)) throw new Error("ledger_total_exceeds_javascript_safe_integer");
  return next;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

function percent(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 100);
}

/**
 * Today + Revenue numbers (F7), every period in the org's timezone. Money is
 * confirmed ledger revenue only; estimates appear solely as the pipeline.
 */
export async function getInsights(orgId: OrgId, options: { months?: number; now?: Date } = {}): Promise<Insights> {
  const now = options.now ?? new Date();
  const monthCount = Math.min(Math.max(Math.trunc(options.months ?? 6), 1), 12);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { currencyCode: true, locale: true, timezone: true, monthlyGoalMinor: true, createdAt: true, nudgeDelayDays: true },
  });
  if (!org) throw new DomainError("org_not_found", 404);
  const tz = org.timezone;
  const monthStart = startOfZonedMonth(now, tz);
  const prevMonthStart = startOfZonedMonth(now, tz, 1);
  const weekStart = startOfZonedWeek(now, tz);
  const commerceOpen = { orgId, state: "open" as const, hasPendingReview: false, topLabel: { in: [...HIGH_INTENT_LABELS] } };

  const [entries, allTime, open, atRisk, waiting, reviewCount, firstInbound, sent, leak] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { orgId, deletedAt: null, closedAt: { gte: startOfZonedMonth(now, tz, monthCount - 1) } },
      select: { id: true, threadId: true, dealType: true, amountMinor: true, closedAt: true, thread: { select: { participantHandle: true } } },
    }),
    prisma.ledgerEntry.aggregate({ where: { orgId, deletedAt: null }, _sum: { amountMinor: true } }),
    prisma.thread.aggregate({ where: commerceOpen, _count: { _all: true }, _sum: { estValueMaxMinor: true } }),
    // Unreplied, and the standard 24h window closes within 6h (not already closed).
    prisma.thread.aggregate({
      where: {
        ...commerceOpen,
        lastInboundAt: { gt: new Date(now.getTime() - 24 * HOUR_MS), lte: new Date(now.getTime() - 18 * HOUR_MS) },
        OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: prisma.thread.fields.lastInboundAt } }],
      },
      _count: { _all: true },
      _sum: { estValueMaxMinor: true },
    }),
    prisma.thread.findMany({
      where: { orgId, state: "waiting" },
      select: { state: true, waitingSince: true, lastOutboundAt: true, nudgeDismissedAt: true },
    }),
    prisma.classification.count({ where: { orgId, routedTo: "review_queue", reviewOutcome: null } }),
    prisma.message.groupBy({
      by: ["threadId"],
      where: { orgId, direction: "inbound", thread: { orgId, topLabel: { in: [...HIGH_INTENT_LABELS] } } },
      _min: { sentAt: true },
      having: { sentAt: { _min: { gte: prevMonthStart } } },
    }),
    prisma.draft.findMany({
      where: { orgId, status: "sent", sentAt: { gte: startOfZonedWeek(now, tz, 1) } },
      select: { sentAt: true, body: true, editDistance: true, editRatio: true },
    }),
    leakScanTotals(orgId),
  ]);

  // Revenue: zero-filled month series, this month's mix, goal pace, top deals.
  const keys = zonedMonthKeys(now, tz, monthCount);
  const currentKey = keys[keys.length - 1]!;
  const byMonth = new Map(keys.map((key) => [key, { recoveredMinor: 0, deals: 0 }]));
  const byType = new Map(DEAL_TYPES.map((type) => [type, { totalMinor: 0, deals: 0 }]));
  const thisMonth: typeof entries = [];
  for (const entry of entries) {
    const amount = minorUnitsToNumber(entry.amountMinor);
    const key = zonedMonthKey(entry.closedAt, tz);
    const month = byMonth.get(key);
    if (month) byMonth.set(key, { recoveredMinor: addMinor(month.recoveredMinor, amount), deals: month.deals + 1 });
    if (key !== currentKey) continue;
    thisMonth.push(entry);
    const type = byType.get(entry.dealType)!;
    byType.set(entry.dealType, { totalMinor: addMinor(type.totalMinor, amount), deals: type.deals + 1 });
  }
  const mtdMinor = byMonth.get(currentKey)!.recoveredMinor;
  const goalMinor = org.monthlyGoalMinor === null ? null : minorUnitsToNumber(org.monthlyGoalMinor);
  const elapsedDays = (now.getTime() - monthStart.getTime()) / DAY_MS;

  // Speed to lead: first inbound → first outbound on commerce threads.
  const firstInboundAt = new Map(firstInbound.flatMap((row) => (row._min.sentAt ? [[row.threadId, row._min.sentAt] as const] : [])));
  const outbound = firstInboundAt.size
    ? await prisma.message.findMany({
        where: { orgId, direction: "outbound", threadId: { in: [...firstInboundAt.keys()] }, sentAt: { gte: prevMonthStart } },
        select: { threadId: true, sentAt: true },
        orderBy: { sentAt: "asc" },
      })
    : [];
  const firstReplyAt = new Map<string, Date>();
  for (const message of outbound) {
    if (!firstReplyAt.has(message.threadId) && message.sentAt >= firstInboundAt.get(message.threadId)!) {
      firstReplyAt.set(message.threadId, message.sentAt);
    }
  }
  const speedFor = (from: Date, to: Date) => {
    const minutes: number[] = [];
    const tally = { within4h: 0, eligible4h: 0, within24h: 0, eligible24h: 0 };
    for (const [threadId, inboundAt] of firstInboundAt) {
      if (inboundAt < from || inboundAt >= to) continue;
      const replyAt = firstReplyAt.get(threadId);
      const waitedMs = (replyAt ?? now).getTime() - inboundAt.getTime();
      if (replyAt) minutes.push(waitedMs / 60_000);
      // An unanswered thread still inside a window hasn't missed it yet.
      if (replyAt || waitedMs > 4 * HOUR_MS) {
        tally.eligible4h += 1;
        if (replyAt && waitedMs <= 4 * HOUR_MS) tally.within4h += 1;
      }
      if (replyAt || waitedMs > 24 * HOUR_MS) {
        tally.eligible24h += 1;
        if (replyAt && waitedMs <= 24 * HOUR_MS) tally.within24h += 1;
      }
    }
    return { minutes, ...tally };
  };
  const speed = speedFor(monthStart, new Date(now.getTime() + 1));
  const prevSpeed = speedFor(prevMonthStart, monthStart);

  const sentThisWeek = sent.filter((draft) => draft.sentAt && draft.sentAt >= weekStart);
  const sentLastWeek = sent.filter((draft) => draft.sentAt && draft.sentAt < weekStart);

  return {
    currencyCode: org.currencyCode as CurrencyCode,
    locale: org.locale,
    timezone: tz,
    goal: {
      monthlyGoalMinor: goalMinor,
      mtdMinor,
      pct: goalMinor ? Math.floor((mtdMinor * 100) / goalMinor) : null,
      // Straight-line pace is noise in the first days of a month.
      projectedMinor: elapsedDays > 5 ? Math.round((mtdMinor * daysInZonedMonth(now, tz)) / elapsedDays) : null,
    },
    months: keys.map((month) => ({ month, ...byMonth.get(month)! })),
    byType: DEAL_TYPES.map((dealType) => ({ dealType, ...byType.get(dealType)! })),
    pipeline: {
      openCommerceThreads: open._count._all,
      openValueMaxMinor: minorUnitsToNumber(open._sum.estValueMaxMinor ?? 0n),
      atRiskThreads: atRisk._count._all,
      atRiskValueMaxMinor: minorUnitsToNumber(atRisk._sum.estValueMaxMinor ?? 0n),
      nudgesDue: waiting.filter((thread) => isNudgeDue(thread, org.nudgeDelayDays, now)).length,
      reviewCount,
    },
    speed: {
      medianFirstReplyMinutes: median(speed.minutes),
      prevMedianFirstReplyMinutes: median(prevSpeed.minutes),
      within4hPct: percent(speed.within4h, speed.eligible4h),
      within24hPct: percent(speed.within24h, speed.eligible24h),
      sampleSize: speed.minutes.length,
    },
    voice: {
      voiceMatchPct: voiceMatchPct(sentEditRatios(sentThisWeek)),
      prevVoiceMatchPct: voiceMatchPct(sentEditRatios(sentLastWeek)),
      sentThisWeek: sentThisWeek.length,
    },
    leak: {
      baselineMinMinor: leak.scannedCount > 0 ? leak.totalMinMinor : null,
      recoveredSinceJoinMinor: minorUnitsToNumber(allTime._sum.amountMinor ?? 0n),
      joinedAt: org.createdAt.toISOString(),
    },
    topDeals: thisMonth
      .sort((a, b) => (a.amountMinor === b.amountMinor ? b.closedAt.getTime() - a.closedAt.getTime() : a.amountMinor > b.amountMinor ? -1 : 1))
      .slice(0, 5)
      .map((entry) => ({
        id: entry.id,
        threadId: entry.threadId,
        handle: entry.thread.participantHandle,
        dealType: entry.dealType,
        amountMinor: minorUnitsToNumber(entry.amountMinor),
        closedAt: entry.closedAt.toISOString(),
      })),
  };
}

/**
 * Last ISO week (org timezone) for the Monday digest push: confirmed revenue,
 * replies sent through DealDock and voice match.
 */
export async function getWeeklyDigestSummary(orgId: OrgId, now = new Date()) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { timezone: true, currencyCode: true, locale: true },
  });
  if (!org) throw new DomainError("org_not_found", 404);
  const thisWeek = startOfZonedWeek(now, org.timezone);
  const lastWeek = startOfZonedWeek(now, org.timezone, 1);
  const [recovered, sent] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      where: { orgId, deletedAt: null, closedAt: { gte: lastWeek, lt: thisWeek } },
      _sum: { amountMinor: true },
    }),
    prisma.draft.findMany({
      where: { orgId, status: "sent", sentAt: { gte: lastWeek, lt: thisWeek } },
      select: { body: true, editDistance: true, editRatio: true },
    }),
  ]);
  return {
    currencyCode: org.currencyCode as CurrencyCode,
    locale: org.locale,
    recoveredMinor: minorUnitsToNumber(recovered._sum.amountMinor ?? 0n),
    replies: sent.length,
    voiceMatchPct: voiceMatchPct(sentEditRatios(sent)),
  };
}
