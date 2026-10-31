import type { AuditRow } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";

type ThreadRef = { id: string; participantHandle: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Audit trail, newest first (F11, PRD §7.5): who sent what — the drafted text,
 * what was actually sent, the edit distance and whether it went as a voice
 * note — plus every other recorded action with the send fields empty. Each
 * row is linked to its conversation when the entity belongs to one.
 */
export async function listAuditRows(orgId: OrgId, limit = 50): Promise<AuditRow[]> {
  const rows = await prisma.auditLog.findMany({
    where: { orgId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(Math.trunc(limit), 1), 200),
    select: {
      id: true,
      createdAt: true,
      action: true,
      entityType: true,
      entityId: true,
      detail: true,
      seat: { select: { id: true, role: true, user: { select: { name: true, email: true } } } },
    },
  });
  const idsOf = (entityType: string) => [...new Set(rows.filter((row) => row.entityType === entityType).map((row) => row.entityId))];
  const thread = { select: { id: true, participantHandle: true } } as const;
  const [drafts, threads, ledger, classifications] = await Promise.all([
    prisma.draft.findMany({ where: { orgId, id: { in: idsOf("draft") } }, select: { id: true, thread } }),
    prisma.thread.findMany({ where: { orgId, id: { in: idsOf("thread") } }, select: { id: true, participantHandle: true } }),
    prisma.ledgerEntry.findMany({ where: { orgId, id: { in: idsOf("ledger_entry") } }, select: { id: true, thread } }),
    prisma.classification.findMany({
      where: { orgId, id: { in: idsOf("classification") } },
      select: { id: true, message: { select: { thread } } },
    }),
  ]);
  const threadOf = new Map<string, ThreadRef>([
    ...drafts.map((d) => [`draft|${d.id}`, d.thread] as const),
    ...threads.map((t) => [`thread|${t.id}`, t] as const),
    ...ledger.map((l) => [`ledger_entry|${l.id}`, l.thread] as const),
    ...classifications.map((c) => [`classification|${c.id}`, c.message.thread] as const),
  ]);

  return rows.map((row) => {
    const detail = isRecord(row.detail) ? row.detail : {};
    const send = row.action === "message.sent";
    const ref = threadOf.get(`${row.entityType}|${row.entityId}`);
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      action: row.action,
      actor: row.seat ? { seatId: row.seat.id, name: row.seat.user.name ?? row.seat.user.email, role: row.seat.role } : null,
      threadId: ref?.id ?? null,
      handle: ref?.participantHandle ?? null,
      editDistance: send && typeof detail.editDistance === "number" ? detail.editDistance : null,
      originalDraft: send && typeof detail.originalDraft === "string" ? detail.originalDraft : null,
      finalText: send && typeof detail.finalText === "string" ? detail.finalText : null,
      asVoice: detail.asVoice === true,
    };
  });
}
