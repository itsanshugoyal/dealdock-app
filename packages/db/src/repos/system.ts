import { prisma } from "../client";

/**
 * SYSTEM-CONTEXT queries — the only repo functions that scan across orgs.
 * Used exclusively by worker schedulers (nudges, retention, billing gates).
 * They return work-items grouped per org; every downstream job they enqueue
 * is org-scoped again. Nothing here ever assembles prompt context (ADR-7 note).
 */

export interface NudgeCandidate {
  orgId: string;
  threadId: string;
  igAccountId: string;
  participantHandle: string;
  topLabel: string | null;
  waitingSince: Date;
  estValueMaxMinor: number | null;
  currencyCode: string;
}

/**
 * Waiting threads that have gone silent past their org's nudge delay, not
 * dismissed, with no live nudge draft yet (PRD §6.5).
 */
export async function listNudgeCandidates(now = new Date()): Promise<NudgeCandidate[]> {
  const threads = await prisma.thread.findMany({
    where: {
      state: "waiting",
      waitingSince: { not: null },
      nudgeDismissedAt: null,
      drafts: { none: { kind: "nudge", status: { in: ["ready", "edited"] } } },
    },
    select: {
      id: true,
      orgId: true,
      igAccountId: true,
      participantHandle: true,
      topLabel: true,
      waitingSince: true,
      lastInboundAt: true,
      estValueMaxMinor: true,
    },
    take: 500,
  });
  if (threads.length === 0) return [];

  const orgIds = [...new Set(threads.map((t) => t.orgId))];
  const orgs = await prisma.organization.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, nudgeDelayDays: true, currencyCode: true },
  });
  const delayByOrg = new Map(orgs.map((o) => [o.id, o.nudgeDelayDays]));
  const currencyByOrg = new Map(orgs.map((o) => [o.id, o.currencyCode]));

  return threads
    .filter((t) => {
      const delayDays = delayByOrg.get(t.orgId) ?? 3;
      const dueAt = new Date(t.waitingSince!.getTime() + delayDays * 24 * 60 * 60_000);
      // Silent = the counterparty hasn't replied since we started waiting
      // (a fresh inbound flips the thread back to open at ingestion anyway).
      return now >= dueAt;
    })
    .map((t) => ({
      orgId: t.orgId,
      threadId: t.id,
      igAccountId: t.igAccountId,
      participantHandle: t.participantHandle,
      topLabel: t.topLabel,
      waitingSince: t.waitingSince!,
      estValueMaxMinor: t.estValueMaxMinor === null ? null : Number(t.estValueMaxMinor),
      currencyCode: currencyByOrg.get(t.orgId) ?? "INR",
    }));
}
