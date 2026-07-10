import { prisma } from "../client";
import type { OrgId } from "../org-id";

export async function getThreadDetail(orgId: OrgId, threadId: string) {
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, orgId },
    include: {
      igAccount: { select: { handle: true, provider: true, igUserId: true, id: true } },
      messages: {
        orderBy: { sentAt: "asc" },
        include: {
          classification: {
            select: {
              label: true,
              confidence: true,
              valueMinMinor: true,
              valueMaxMinor: true,
              rationale: true,
              routedTo: true,
            },
          },
        },
      },
      drafts: {
        where: { status: { in: ["ready", "edited"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      ledger: { where: { deletedAt: null } },
    },
  });
  if (!thread) return null;

  return {
    id: thread.id,
    participantHandle: thread.participantHandle,
    state: thread.state,
    waitingSince: thread.waitingSince,
    topLabel: thread.topLabel,
    estValueMaxMinor:
      thread.estValueMaxMinor === null ? null : Number(thread.estValueMaxMinor),
    igAccountId: thread.igAccount.id,
    igThreadRemoteId: thread.igThreadId,
    messages: thread.messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      contentType: m.contentType,
      text: m.text,
      sentAt: m.sentAt,
      classification: m.classification
        ? {
            label: m.classification.label,
            confidence: m.classification.confidence,
            rationale: m.classification.rationale,
            valueMinMinor:
              m.classification.valueMinMinor === null
                ? null
                : Number(m.classification.valueMinMinor),
            valueMaxMinor:
              m.classification.valueMaxMinor === null
                ? null
                : Number(m.classification.valueMaxMinor),
          }
        : null,
    })),
    currentDraft: thread.drafts[0]
      ? {
          id: thread.drafts[0].id,
          body: thread.drafts[0].body,
          kind: thread.drafts[0].kind,
          status: thread.drafts[0].status,
          version: thread.drafts[0].version,
        }
      : null,
    closedDeals: thread.ledger.map((l) => ({
      id: l.id,
      amountMinor: Number(l.amountMinor),
      dealType: l.dealType,
      closedAt: l.closedAt,
    })),
  };
}

/** Dismiss a due nudge: thread stays waiting, the clock resets, draft discarded. */
export async function dismissNudge(orgId: OrgId, threadId: string, seatId: string) {
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: { id: threadId, orgId },
      select: { id: true },
    });
    if (!thread) throw new Error("thread not in org");

    await tx.thread.update({
      where: { id: thread.id },
      data: { nudgeDismissedAt: new Date() },
    });
    await tx.draft.updateMany({
      where: { orgId, threadId, kind: "nudge", status: { in: ["ready", "edited"] } },
      data: { status: "discarded" },
    });
    await tx.auditLog.create({
      data: {
        orgId,
        seatId,
        action: "nudge.dismissed",
        entityType: "thread",
        entityId: thread.id,
      },
    });
  });
}

/** Thread state machine: open ↔ waiting → closed. Waiting starts the nudge clock (PRD §6.5). */
export async function setThreadState(
  orgId: OrgId,
  input: { threadId: string; seatId: string; state: "open" | "waiting" | "closed" }
) {
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: { id: input.threadId, orgId },
      select: { id: true, state: true },
    });
    if (!thread) throw new Error("thread not in org");

    const updated = await tx.thread.update({
      where: { id: thread.id },
      data: {
        state: input.state,
        waitingSince: input.state === "waiting" ? new Date() : null,
        ...(input.state !== "waiting" ? { nudgeDismissedAt: null } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        orgId,
        seatId: input.seatId,
        action: "thread.state_changed",
        entityType: "thread",
        entityId: thread.id,
        detail: { from: thread.state, to: input.state },
      },
    });

    return updated;
  });
}
