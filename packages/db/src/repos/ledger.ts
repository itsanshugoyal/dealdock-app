import type { DealType } from "@prisma/client";
import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";
import { minorUnitsToNumber, requireMinorUnits } from "../money";
import { zonedMonthKey } from "../zoned-time";
import { channelOf, creatorAccountId } from "./deals";

/** One-tap "Mark closed for [amount]" (PRD §5.4) — entry + thread close + audit. */
export async function closeDeal(
  orgId: OrgId,
  input: {
    threadId: string;
    seatId: string;
    amountMinor: number;
    dealType: "brand" | "coaching" | "course" | "other";
    /** Caller-generated request key; retries must resolve to the same close-out. */
    idempotencyKey: string;
    note?: string;
  }
) {
  await requireSeatInOrg(orgId, input.seatId);
  return prisma.$transaction(async (tx) => {
    const [thread, org] = await Promise.all([
      tx.thread.findFirst({
        where: { id: input.threadId, orgId },
        select: { id: true, igAccountId: true, participantHandle: true, igAccount: { select: { ownerAccountId: true } } },
      }),
      tx.organization.findUnique({ where: { id: orgId }, select: { currencyCode: true } }),
    ]);
    if (!thread || !org) throw new DomainError("thread not in org", 404);

    const amountMinor = requireMinorUnits(input.amountMinor);
    if (!input.idempotencyKey.trim()) throw new DomainError("idempotency_key_required", 400);
    // createMany + the compound unique index makes a request retry a true
    // no-op, rather than a second ledger row and duplicate audit entry.
    const created = await tx.ledgerEntry.createMany({
      data: [{
        orgId,
        threadId: thread.id,
        igAccountId: creatorAccountId(thread),
        counterpartyHandle: thread.participantHandle,
        dealType: input.dealType,
        amountMinor,
        currencyCode: org.currencyCode, // frozen at write time (ADR-9)
        idempotencyKey: input.idempotencyKey,
        note: input.note,
        createdBySeatId: input.seatId,
      }],
      skipDuplicates: true,
    });
    const entry = await tx.ledgerEntry.findUniqueOrThrow({
      where: { orgId_idempotencyKey: { orgId, idempotencyKey: input.idempotencyKey } },
    });
    if (created.count === 0) {
      if (entry.threadId !== input.threadId || entry.amountMinor !== amountMinor || entry.dealType !== input.dealType || (entry.note ?? "") !== (input.note ?? "")) throw new DomainError("close_idempotency_key_conflict", 409);
      return { ...entry, amountMinor: minorUnitsToNumber(entry.amountMinor) };
    }

    await tx.thread.update({
      where: { id: thread.id },
      data: { state: "closed", waitingSince: null },
    });

    await writeAudit(tx, {
      orgId,
      seatId: input.seatId,
      action: "ledger.created",
      entityType: "ledger_entry",
      entityId: entry.id,
      detail: { amountMinor: input.amountMinor, dealType: input.dealType },
    });

    return { ...entry, amountMinor: minorUnitsToNumber(entry.amountMinor) };
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
  await requireSeatInOrg(orgId, input.seatId);
  const entry = await prisma.ledgerEntry.findFirst({
    where: { id: input.entryId, orgId, deletedAt: null },
  });
  if (!entry) throw new DomainError("ledger entry not in org", 404);

  if (input.amountMinor !== undefined) requireMinorUnits(input.amountMinor);
  const updated = await prisma.ledgerEntry.update({
    where: { id: entry.id },
    data: {
      ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
      ...(input.dealType ? { dealType: input.dealType } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  });

  await writeAudit(prisma, {
    orgId,
    seatId: input.seatId,
    action: "ledger.updated",
    entityType: "ledger_entry",
    entityId: entry.id,
    detail: { amountMinor: input.amountMinor, dealType: input.dealType },
  });

  return { ...updated, amountMinor: minorUnitsToNumber(updated.amountMinor) };
}

/**
 * Soft delete (refunds — PRD §6.7). A deal's payment entry reopens that deal,
 * and an invoice's reopens the invoice too: the money no longer stands.
 */
export async function deleteLedgerEntry(orgId: OrgId, entryId: string, seatId: string) {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const entry = await tx.ledgerEntry.findFirst({
      where: { id: entryId, orgId, deletedAt: null },
      select: { id: true, dealId: true, invoiceId: true },
    });
    if (!entry) throw new DomainError("ledger entry not in org", 404);

    // Unlinked so the reopened invoice can be paid again (invoiceId is unique, deleted rows included).
    await tx.ledgerEntry.update({
      where: { id: entry.id },
      data: { deletedAt: new Date(), dealId: null, invoiceId: null },
    });
    if (entry.invoiceId) {
      await tx.invoice.updateMany({
        where: { id: entry.invoiceId, orgId, status: "paid" },
        data: { status: "issued", paidAt: null, receivedMinor: null, tdsMinor: null },
      });
    }
    const deal = entry.dealId
      ? await tx.deal.findFirst({ where: { id: entry.dealId, orgId, stage: "paid", deletedAt: null }, select: { id: true, invoicedAt: true } })
      : null;
    if (deal) {
      await tx.deal.update({
        where: { id: deal.id },
        data: { stage: deal.invoicedAt ? "invoiced" : "agreed", paidAt: null, receivedMinor: null, tdsMinor: null },
      });
    }
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "ledger.deleted",
      entityType: "ledger_entry",
      entityId: entry.id,
      ...(entry.dealId ? { detail: { dealId: entry.dealId, ...(entry.invoiceId ? { invoiceId: entry.invoiceId } : {}) } } : {}),
    });
  });
}

export interface LedgerMonth {
  month: string; // "2026-07"
  totalMinor: number;
  count: number;
}

/** Ledger view: month rollups + entries for the selected month (PRD §6.7). */
export async function getLedger(orgId: OrgId, month?: string, igAccountId?: string) {
  if (igAccountId !== undefined) await requireIgAccountInOrg(orgId, igAccountId);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { currencyCode: true, timezone: true },
  });
  if (!org) throw new DomainError("org_not_found", 404);
  const entries = await prisma.ledgerEntry.findMany({
    where: { orgId, deletedAt: null, ...(igAccountId !== undefined ? { igAccountId } : {}) },
    orderBy: { closedAt: "desc" },
    include: { thread: { select: { participantHandle: true, igAccount: { select: { platform: true } } } } },
  });

  // Each close-out's org-local month, computed once (zoned-time caches the formatter).
  const keyed = entries.map((e) => ({ ...e, month: zonedMonthKey(e.closedAt, org.timezone) }));
  const byMonth = new Map<string, { totalMinor: number; count: number }>();
  for (const e of keyed) {
    const key = e.month;
    const agg = byMonth.get(key) ?? { totalMinor: 0, count: 0 };
    const amount = minorUnitsToNumber(e.amountMinor);
    if (!Number.isSafeInteger(agg.totalMinor + amount)) {
      throw new Error("ledger_total_exceeds_javascript_safe_integer");
    }
    agg.totalMinor += amount;
    agg.count += 1;
    byMonth.set(key, agg);
  }

  const months: LedgerMonth[] = [...byMonth.entries()]
    .map(([m, v]) => ({ month: m, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const selected = month ?? zonedMonthKey(new Date(), org.timezone);
  const monthEntries = keyed.filter((e) => e.month === selected);

  const amounts = monthEntries.map((e) => minorUnitsToNumber(e.amountMinor));
  const total = amounts.reduce((sum, amount) => {
    if (!Number.isSafeInteger(sum + amount)) {
      throw new Error("ledger_total_exceeds_javascript_safe_integer");
    }
    return sum + amount;
  }, 0);

  return {
    months,
    selectedMonth: selected,
    timezone: org.timezone,
    currencyCode: org.currencyCode,
    totalMinor: total,
    biggestMinor: amounts.length ? Math.max(...amounts) : 0,
    avgMinor: amounts.length ? Math.round(total / amounts.length) : 0,
    byType: monthEntries.reduce<Record<string, number>>((acc, e) => {
      const next = (acc[e.dealType] ?? 0) + minorUnitsToNumber(e.amountMinor);
      if (!Number.isSafeInteger(next)) throw new Error("ledger_total_exceeds_javascript_safe_integer");
      acc[e.dealType] = next;
      return acc;
    }, {}),
    entries: monthEntries.map(toEntry),
    /** The selected month's five biggest sales (ties: newest first). */
    topDeals: [...monthEntries]
      .sort((a, b) => (a.amountMinor === b.amountMinor ? b.closedAt.getTime() - a.closedAt.getTime() : a.amountMinor > b.amountMinor ? -1 : 1))
      .slice(0, 5)
      .map(toEntry),
  };
}

function toEntry(e: {
  id: string;
  closedAt: Date;
  threadId: string | null;
  counterpartyHandle: string;
  thread: { participantHandle: string; igAccount: { platform: string } } | null;
  dealType: DealType;
  amountMinor: bigint;
  currencyCode: string;
  note: string | null;
}) {
  return {
    id: e.id,
    closedAt: e.closedAt,
    // Money from a deal agreed outside DealDock has no conversation; its stored counterparty names it.
    handle: e.thread?.participantHandle ?? e.counterpartyHandle,
    threadId: e.threadId,
    channel: e.thread ? channelOf(e.thread.igAccount.platform) : null,
    dealType: e.dealType,
    amountMinor: minorUnitsToNumber(e.amountMinor),
    currencyCode: e.currencyCode,
    note: e.note,
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
      where: { orgId, state: "open", hasPendingReview: false, estValueMaxMinor: { not: null } },
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

  const [year, calendarMonth] = ledger.selectedMonth.split("-").map(Number);
  const previous = new Date(Date.UTC(year!, calendarMonth! - 2, 1));
  const prevMonthKey = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
  const prev = ledger.months.find((m) => m.month === prevMonthKey);

  return {
    org,
    mtdRecoveredMinor: ledger.totalMinor,
    mtdDealCount: ledger.entries.length,
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
