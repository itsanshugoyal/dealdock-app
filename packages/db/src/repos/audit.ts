import type { AuditRow } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";

type ThreadRef = { id: string; participantHandle: string };
type Party = { threadId: string | null; handle: string };

const ofThread = (thread: ThreadRef): Party => ({ threadId: thread.id, handle: thread.participantHandle });
/** Deals and their money can come from outside DealDock: then the stored counterparty names them. */
const ofDeal = (row: { counterpartyHandle: string; thread: ThreadRef | null }): Party =>
  row.thread ? ofThread(row.thread) : { threadId: null, handle: row.counterpartyHandle };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Audit trail, newest first (F11, PRD §7.5): who sent what — the drafted text,
 * what was actually sent, the edit distance and whether it went as a voice
 * note — plus every other recorded action with the send fields empty. Each
 * row is linked to its conversation when the entity belongs to one; deals,
 * invoices and money name their counterparty even without one.
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
  const party = { counterpartyHandle: true, thread } as const;
  const [drafts, threads, ledger, classifications, deals, invoices] = await Promise.all([
    prisma.draft.findMany({ where: { orgId, id: { in: idsOf("draft") } }, select: { id: true, thread } }),
    prisma.thread.findMany({ where: { orgId, id: { in: idsOf("thread") } }, select: { id: true, participantHandle: true } }),
    prisma.ledgerEntry.findMany({ where: { orgId, id: { in: idsOf("ledger_entry") } }, select: { id: true, ...party } }),
    prisma.classification.findMany({
      where: { orgId, id: { in: idsOf("classification") } },
      select: { id: true, message: { select: { thread } } },
    }),
    prisma.deal.findMany({ where: { orgId, id: { in: idsOf("deal") } }, select: { id: true, ...party } }),
    prisma.invoice.findMany({ where: { orgId, id: { in: idsOf("invoice") } }, select: { id: true, deal: { select: party } } }),
  ]);
  const partyOf = new Map<string, Party>([
    ...drafts.map((d) => [`draft|${d.id}`, ofThread(d.thread)] as const),
    ...threads.map((t) => [`thread|${t.id}`, ofThread(t)] as const),
    ...ledger.map((l) => [`ledger_entry|${l.id}`, ofDeal(l)] as const),
    ...classifications.map((c) => [`classification|${c.id}`, ofThread(c.message.thread)] as const),
    ...deals.map((d) => [`deal|${d.id}`, ofDeal(d)] as const),
    ...invoices.map((i) => [`invoice|${i.id}`, ofDeal(i.deal)] as const),
  ]);
  // A private reply to a comment names its commenter (an Instagram handle, so "@"); there is no conversation until they answer.
  const leadIds = idsOf("comment_lead");
  for (const lead of leadIds.length ? await prisma.commentLead.findMany({ where: { orgId, id: { in: leadIds } }, select: { id: true, commenterHandle: true } }) : []) {
    partyOf.set(`comment_lead|${lead.id}`, { threadId: null, handle: `@${lead.commenterHandle}` });
  }

  return rows.map((row) => {
    const detail = isRecord(row.detail) ? row.detail : {};
    const send = row.action === "message.sent";
    const ref = partyOf.get(`${row.entityType}|${row.entityId}`);
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      action: row.action,
      actor: row.seat ? { seatId: row.seat.id, name: row.seat.user.name ?? row.seat.user.email, role: row.seat.role } : null,
      threadId: ref?.threadId ?? null,
      handle: ref?.handle ?? null,
      editDistance: send && typeof detail.editDistance === "number" ? detail.editDistance : null,
      originalDraft: send && typeof detail.originalDraft === "string" ? detail.originalDraft : null,
      finalText: send && typeof detail.finalText === "string" ? detail.finalText : null,
      asVoice: detail.asVoice === true,
    };
  });
}
