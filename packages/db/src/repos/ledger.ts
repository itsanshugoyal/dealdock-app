import { prisma } from "../client";
import type { OrgId } from "../org-id";

/** One-tap "Mark closed for [amount]" (PRD §5.4) — entry + thread close + audit. */
export async function closeDeal(
  orgId: OrgId,
  input: {
    threadId: string;
    seatId: string;
    amountMinor: number;
    dealType: "brand" | "coaching" | "course" | "other";
    note?: string;
  }
) {
  return prisma.$transaction(async (tx) => {
    const [thread, org] = await Promise.all([
      tx.thread.findFirst({ where: { id: input.threadId, orgId }, select: { id: true } }),
      tx.organization.findUnique({ where: { id: orgId }, select: { currencyCode: true } }),
    ]);
    if (!thread || !org) throw new Error("thread not in org");

    const entry = await tx.ledgerEntry.create({
      data: {
        orgId,
        threadId: thread.id,
        dealType: input.dealType,
        amountMinor: BigInt(input.amountMinor),
        currencyCode: org.currencyCode, // frozen at write time (ADR-9)
        note: input.note,
        createdBySeatId: input.seatId,
      },
    });

    await tx.thread.update({
      where: { id: thread.id },
      data: { state: "closed", waitingSince: null },
    });

    await tx.auditLog.create({
      data: {
        orgId,
        seatId: input.seatId,
        action: "ledger.created",
        entityType: "ledger_entry",
        entityId: entry.id,
        detail: { amountMinor: input.amountMinor, dealType: input.dealType },
      },
    });

    return { ...entry, amountMinor: Number(entry.amountMinor) };
  });
}

export async function updateLedgerEntry(
  orgId: OrgId,
  input: {
    entryId: string;
    seatId: string;
    amountMinor?: number;
    dealType?: "brand" | "coaching" | "course" | "other";
    note?: string;
  }
) {
  const entry = await prisma.ledgerEntry.findFirst({
    where: { id: input.entryId, orgId, deletedAt: null },
  });
  if (!entry) throw new Error("ledger entry not in org");

  const updated = await prisma.ledgerEntry.update({
    where: { id: entry.id },
    data: {
      ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
      ...(input.dealType ? { dealType: input.dealType } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      orgId,
      seatId: input.seatId,
      action: "ledger.updated",
      entityType: "ledger_entry",
      entityId: entry.id,
      detail: { amountMinor: input.amountMinor, dealType: input.dealType },
    },
  });

  return { ...updated, amountMinor: Number(updated.amountMinor) };
}

/** Soft delete (refunds — PRD §6.7). */
export async function deleteLedgerEntry(orgId: OrgId, entryId: string, seatId: string) {
  const entry = await prisma.ledgerEntry.findFirst({
    where: { id: entryId, orgId, deletedAt: null },
  });
  if (!entry) throw new Error("ledger entry not in org");

  await prisma.ledgerEntry.update({
    where: { id: entry.id },
    data: { deletedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      orgId,
      seatId,
      action: "ledger.deleted",
      entityType: "ledger_entry",
      entityId: entry.id,
    },
  });
}

export interface LedgerMonth {
  month: string; // "2026-07"
  totalMinor: number;
  count: number;
}

/** Ledger view: month rollups + entries for the selected month (PRD §6.7). */
export async function getLedger(orgId: OrgId, month?: string) {
  const entries = await prisma.ledgerEntry.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { closedAt: "desc" },
    include: { thread: { select: { id: true, participantHandle: true } } },
  });

  const byMonth = new Map<string, { totalMinor: number; count: number }>();
  for (const e of entries) {
    const key = e.closedAt.toISOString().slice(0, 7);
    const agg = byMonth.get(key) ?? { totalMinor: 0, count: 0 };
    agg.totalMinor += Number(e.amountMinor);
    agg.count += 1;
    byMonth.set(key, agg);
  }

  const months: LedgerMonth[] = [...byMonth.entries()]
    .map(([m, v]) => ({ month: m, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const selected = month ?? new Date().toISOString().slice(0, 7);
  const monthEntries = entries.filter(
    (e) => e.closedAt.toISOString().slice(0, 7) === selected
  );

  const amounts = monthEntries.map((e) => Number(e.amountMinor));
  const total = amounts.reduce((a, b) => a + b, 0);

  return {
    months,
    selectedMonth: selected,
    totalMinor: total,
    biggestMinor: amounts.length ? Math.max(...amounts) : 0,
    avgMinor: amounts.length ? Math.round(total / amounts.length) : 0,
    byType: monthEntries.reduce<Record<string, number>>((acc, e) => {
      acc[e.dealType] = (acc[e.dealType] ?? 0) + Number(e.amountMinor);
      return acc;
    }, {}),
    entries: monthEntries.map((e) => ({
      id: e.id,
      closedAt: e.closedAt,
      handle: e.thread.participantHandle,
      threadId: e.thread.id,
      dealType: e.dealType,
      amountMinor: Number(e.amountMinor),
      note: e.note,
    })),
  };
}

/** Dashboard tile: month-to-date recovered + supporting numbers (PRD §5.2.2). */
export async function getDashboard(orgId: OrgId) {
  const [org, ledger, openHighValue, reviewCount] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true, locale: true, name: true },
    }),
    getLedger(orgId),
    prisma.thread.findMany({
      where: { orgId, state: "open", estValueMaxMinor: { not: null } },
      orderBy: { estValueMaxMinor: "desc" },
      take: 3,
      select: {
        id: true,
        participantHandle: true,
        topLabel: true,
        estValueMaxMinor: true,
        lastMessageAt: true,
      },
    }),
    prisma.classification.count({
      where: { orgId, routedTo: "review_queue", reviewOutcome: null },
    }),
  ]);

  const prevMonthKey = new Date(new Date().setMonth(new Date().getMonth() - 1))
    .toISOString()
    .slice(0, 7);
  const prev = ledger.months.find((m) => m.month === prevMonthKey);

  return {
    org,
    mtdRecoveredMinor: ledger.totalMinor,
    prevMonthMinor: prev?.totalMinor ?? 0,
    biggestMinor: ledger.biggestMinor,
    avgMinor: ledger.avgMinor,
    needsYou: openHighValue.map((t) => ({
      threadId: t.id,
      handle: t.participantHandle,
      label: t.topLabel,
      estValueMaxMinor: t.estValueMaxMinor === null ? null : Number(t.estValueMaxMinor),
      lastMessageAt: t.lastMessageAt,
    })),
    reviewQueueCount: reviewCount,
  };
}
