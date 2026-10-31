import type { AuditAction } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { minorUnitsToNumber } from "../money";
import { nudgeDueAt, weeklyDigestSlot } from "../schedule-rules";

/** Process readiness only; never returns tenant data. */
export async function checkDatabaseReadiness() {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

/** Explicit process shutdown for local gates; callers never access Prisma. */
export async function disconnectDatabase() { await prisma.$disconnect(); }
export async function requireUtf8Database() {
  const rows = await prisma.$queryRaw<Array<{server_encoding:string}>>`SHOW server_encoding`;
  if (rows[0]?.server_encoding !== "UTF8") throw new Error("Test database must use UTF8 for Instagram messages and multilingual fixtures");
}

/**
 * SYSTEM-CONTEXT queries — the only repo functions that scan across orgs.
 * Used exclusively by worker schedulers (nudges, retention, billing gates).
 * They return work-items grouped per org; every downstream job they enqueue
 * is org-scoped again. Nothing here ever assembles prompt context (ADR-7 note).
 */

const DAY_MS = 86_400_000;
const NUDGE_SCAN_BATCH = 500;
/** Audit actions doubling as once-only markers for scheduled pushes. */
export const NUDGE_FIRED_ACTION = "nudge.due" satisfies AuditAction;
export const WEEKLY_DIGEST_ACTION = "digest.weekly_sent" satisfies AuditAction;

export interface NudgeCandidate {
  orgId: string;
  threadId: string;
  igAccountId: string;
  participantHandle: string;
  topLabel: string | null;
  waitingSince: Date;
  estValueMaxMinor: number | null;
  currencyCode: string;
  /** When this follow-up cycle fell due; one nudge (draft + push) per cycle. */
  dueAt: Date;
}

/**
 * Waiting threads whose follow-up cycle is due (schedule-rules.ts) and has
 * not produced its nudge yet (PRD §6.5). Sending the nudge, dismissing it or
 * having drafting skipped no longer re-fires every tick: a cycle fires once,
 * and a new cycle starts only from a later outbound message or a dismissal.
 */
export async function listNudgeCandidates(now = new Date()): Promise<NudgeCandidate[]> {
  const orgs = new Map<string, { nudgeDelayDays: number; currencyCode: string }>();
  const due: NudgeCandidate[] = [];
  let after: string | undefined;
  for (;;) {
    // Delays are ≥ 1 day, so younger waits can't be due; scan in id order so
    // already-fired threads can never crowd due ones out of a fixed window.
    const batch = await prisma.thread.findMany({
      where: {
        state: "waiting",
        waitingSince: { not: null, lte: new Date(now.getTime() - DAY_MS) },
        drafts: { none: { kind: "nudge", status: { in: ["ready", "edited", "sending"] } } },
        ...(after ? { id: { gt: after } } : {}),
      },
      select: {
        id: true,
        orgId: true,
        igAccountId: true,
        participantHandle: true,
        state: true,
        topLabel: true,
        waitingSince: true,
        lastOutboundAt: true,
        nudgeDismissedAt: true,
        estValueMaxMinor: true,
      },
      orderBy: { id: "asc" },
      take: NUDGE_SCAN_BATCH,
    });
    const missing = [...new Set(batch.map((t) => t.orgId))].filter((id) => !orgs.has(id));
    if (missing.length) {
      for (const org of await prisma.organization.findMany({
        where: { id: { in: missing } },
        select: { id: true, nudgeDelayDays: true, currencyCode: true },
      })) {
        orgs.set(org.id, org);
      }
    }
    for (const t of batch) {
      const org = orgs.get(t.orgId);
      const dueAt = org ? nudgeDueAt(t, org.nudgeDelayDays) : null;
      if (!org || !dueAt || dueAt > now) continue;
      due.push({
        orgId: t.orgId,
        threadId: t.id,
        igAccountId: t.igAccountId,
        participantHandle: t.participantHandle,
        topLabel: t.topLabel,
        waitingSince: t.waitingSince!,
        estValueMaxMinor: t.estValueMaxMinor === null ? null : minorUnitsToNumber(t.estValueMaxMinor),
        currencyCode: org.currencyCode,
        dueAt,
      });
    }
    if (batch.length < NUDGE_SCAN_BATCH) break;
    after = batch[batch.length - 1]!.id;
  }
  if (due.length === 0) return [];

  const fired = await prisma.auditLog.findMany({
    where: {
      action: NUDGE_FIRED_ACTION,
      entityType: "thread",
      orgId: { in: [...new Set(due.map((d) => d.orgId))] },
      entityId: { in: due.map((d) => d.threadId) },
      createdAt: { gte: new Date(due.reduce((min, d) => Math.min(min, d.dueAt.getTime()), Infinity)) },
    },
    select: { entityId: true, createdAt: true },
  });
  const lastFired = new Map<string, Date>();
  for (const row of fired) {
    const seen = lastFired.get(row.entityId);
    if (!seen || seen < row.createdAt) lastFired.set(row.entityId, row.createdAt);
  }
  return due.filter((c) => {
    const firedAt = lastFired.get(c.threadId);
    return !firedAt || firedAt < c.dueAt;
  });
}

/** Marks this cycle's nudge as produced, after its draft + push jobs are queued. */
export async function recordNudgeFired(orgId: OrgId, threadId: string, dueAt: Date) {
  const thread = await prisma.thread.findFirst({ where: { id: threadId, orgId }, select: { id: true } });
  if (!thread) return;
  await writeAudit(prisma, { orgId, action: NUDGE_FIRED_ACTION, entityType: "thread", entityId: thread.id, detail: { dueAt: dueAt.toISOString() } });
}

export interface WeeklyDigestCandidate {
  orgId: string;
  isoWeek: string;
}

/**
 * Orgs whose weekly-digest slot is open now (Monday 09:00 local onwards,
 * outside quiet hours), not yet sent this ISO week, with at least one device
 * that wants it. Orgs pending deletion get nothing.
 */
export async function listWeeklyDigestCandidates(now = new Date()): Promise<WeeklyDigestCandidate[]> {
  const orgs = await prisma.organization.findMany({
    where: { deletionRequestedAt: null, seats: { some: { pushSubs: { some: { notifyWeeklySummary: true } } } } },
    select: { id: true, timezone: true },
  });
  const open = orgs.flatMap((org) => {
    try {
      const slot = weeklyDigestSlot(now, org.timezone);
      return slot ? [{ orgId: org.id, isoWeek: slot.isoWeek }] : [];
    } catch {
      return []; // an unusable timezone must not stall every other org's digest
    }
  });
  if (open.length === 0) return [];

  const sent = await prisma.auditLog.findMany({
    where: {
      action: WEEKLY_DIGEST_ACTION,
      orgId: { in: open.map((o) => o.orgId) },
      createdAt: { gte: new Date(now.getTime() - 8 * DAY_MS) },
    },
    select: { orgId: true, detail: true },
  });
  const done = new Set(
    sent.map((row) => `${row.orgId}|${(row.detail as { isoWeek?: unknown } | null)?.isoWeek}`),
  );
  return open.filter((o) => !done.has(`${o.orgId}|${o.isoWeek}`));
}

/** Records this ISO week's digest as sent so later ticks skip the org. */
export async function recordWeeklyDigestSent(orgId: OrgId, isoWeek: string) {
  await writeAudit(prisma, { orgId, action: WEEKLY_DIGEST_ACTION, entityType: "organization", entityId: orgId, detail: { isoWeek } });
}
