import { prisma } from "../client";
import type { OrgId } from "../org-id";

export async function createDraft(
  orgId: OrgId,
  input: {
    threadId: string;
    replyToMessageId?: string;
    kind?: "reply" | "nudge";
    body: string;
    modelVersion: string;
    promptVersion: string;
  }
) {
  const thread = await prisma.thread.findFirst({
    where: { id: input.threadId, orgId },
    select: { id: true },
  });
  if (!thread) throw new Error("thread not in org");

  // Supersede any prior live draft on the thread; keep history via versions.
  const prior = await prisma.draft.findFirst({
    where: { orgId, threadId: input.threadId, status: { in: ["ready", "edited"] } },
    orderBy: { version: "desc" },
  });
  if (prior) {
    await prisma.draft.update({
      where: { id: prior.id },
      data: { status: "discarded" },
    });
  }

  return prisma.draft.create({
    data: {
      orgId,
      threadId: input.threadId,
      replyToMessageId: input.replyToMessageId,
      kind: input.kind ?? "reply",
      body: input.body,
      version: (prior?.version ?? 0) + 1,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
    },
  });
}

export async function getDraftForSend(orgId: OrgId, draftId: string) {
  return prisma.draft.findFirst({
    where: { id: draftId, orgId, status: { in: ["ready", "edited"] } },
    include: {
      thread: {
        select: {
          id: true,
          igThreadId: true,
          participantIgId: true,
          lastInboundAt: true,
          igAccount: {
            select: { id: true, igUserId: true, handle: true, provider: true, status: true },
          },
        },
      },
    },
  });
}

/**
 * Double-send lock (M5 security audit): atomically claim the draft before the
 * platform call. Two concurrent sends race on this updateMany — exactly one
 * sees count=1; the loser gets `claimed: false` and never reaches the platform.
 */
export async function claimDraftForSend(orgId: OrgId, draftId: string) {
  const result = await prisma.draft.updateMany({
    where: { id: draftId, orgId, status: { in: ["ready", "edited"] } },
    data: { status: "sending" },
  });
  return { claimed: result.count === 1 };
}

/** Release the claim when the platform send fails — the draft becomes editable again. */
export async function releaseDraftClaim(orgId: OrgId, draftId: string) {
  await prisma.draft.updateMany({
    where: { id: draftId, orgId, status: "sending" },
    data: { status: "edited" },
  });
}

/**
 * Marks a draft sent and records the outbound message + audit row in ONE
 * transaction — the persistence half of the send gate (ARCHITECTURE.md §6.2).
 */
export async function recordSend(
  orgId: OrgId,
  input: {
    draftId: string;
    seatId: string;
    finalText: string;
    editDistance: number;
    platformMessageId: string;
    sentAt: Date;
  }
) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.draft.findFirst({
      where: { id: input.draftId, orgId },
      select: { id: true, threadId: true, body: true },
    });
    if (!draft) throw new Error("draft not in org");

    const message = await tx.message.create({
      data: {
        orgId,
        threadId: draft.threadId,
        igMessageId: input.platformMessageId,
        direction: "outbound",
        text: input.finalText,
        sentAt: input.sentAt,
      },
    });

    const updated = await tx.draft.update({
      where: { id: draft.id },
      data: {
        status: "sent",
        sentAt: input.sentAt,
        sentBySeatId: input.seatId,
        sentMessageId: message.id,
        finalText: input.finalText,
        editDistance: input.editDistance,
      },
    });

    await tx.thread.update({
      where: { id: draft.threadId },
      data: { lastMessageAt: input.sentAt, lastOutboundAt: input.sentAt },
    });

    // Audit: original draft, final text, edit distance (PRD §7.5).
    await tx.auditLog.create({
      data: {
        orgId,
        seatId: input.seatId,
        action: "message.sent",
        entityType: "draft",
        entityId: draft.id,
        detail: {
          originalDraft: draft.body,
          finalText: input.finalText,
          editDistance: input.editDistance,
        },
      },
    });

    return { draft: updated, messageId: message.id };
  });
}
