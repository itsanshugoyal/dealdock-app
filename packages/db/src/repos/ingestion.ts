import { prisma } from "../client";
import type { OrgId } from "../org-id";

export interface InboundMessageInput {
  igAccountId: string;
  igThreadId: string;
  participantHandle: string;
  participantIgId: string;
  igMessageId: string;
  direction: "inbound" | "outbound";
  contentType?: "text" | "audio" | "attachment";
  text: string;
  sentAt: Date;
  raw?: unknown;
}

/**
 * Idempotent ingestion write: upserts the thread, inserts the message unless
 * its igMessageId was already seen (Meta redelivers; unique constraint is the
 * dedup — ARCHITECTURE.md §4.3).
 */
export async function upsertInboundMessage(orgId: OrgId, input: InboundMessageInput) {
  return prisma.$transaction(async (tx) => {
    const account = await tx.igAccount.findFirst({
      where: { id: input.igAccountId, orgId },
      select: { id: true, status: true },
    });
    if (!account) throw new Error(`IgAccount ${input.igAccountId} not in org ${orgId}`);
    // Disconnect stops ingestion immediately (PRD §6.1).
    if (account.status !== "active") return { skipped: "account_inactive" as const };

    const thread = await tx.thread.upsert({
      where: {
        igAccountId_igThreadId: {
          igAccountId: input.igAccountId,
          igThreadId: input.igThreadId,
        },
      },
      create: {
        orgId,
        igAccountId: input.igAccountId,
        igThreadId: input.igThreadId,
        participantHandle: input.participantHandle,
        participantIgId: input.participantIgId,
        lastMessageAt: input.sentAt,
        lastInboundAt: input.direction === "inbound" ? input.sentAt : null,
      },
      update: {
        lastMessageAt: input.sentAt,
        ...(input.direction === "inbound"
          ? { lastInboundAt: input.sentAt }
          : { lastOutboundAt: input.sentAt }),
      },
    });

    const existing = await tx.message.findUnique({
      where: { igMessageId: input.igMessageId },
      select: { id: true },
    });
    if (existing) return { skipped: "duplicate" as const, threadId: thread.id };

    const message = await tx.message.create({
      data: {
        orgId,
        threadId: thread.id,
        igMessageId: input.igMessageId,
        direction: input.direction,
        contentType: input.contentType ?? "text",
        text: input.text,
        sentAt: input.sentAt,
        raw: input.raw as never,
      },
    });

    // A fresh inbound message reopens a waiting thread — the counterparty replied.
    if (input.direction === "inbound" && thread.state === "waiting") {
      await tx.thread.update({
        where: { id: thread.id },
        data: { state: "open", waitingSince: null, nudgeDismissedAt: null },
      });
    }

    return { threadId: thread.id, messageId: message.id };
  });
}

/** Fetch a message with the context the classification consumer needs. */
export async function getMessageForClassification(orgId: OrgId, messageId: string) {
  const m = await prisma.message.findFirst({
    where: { id: messageId, orgId, direction: "inbound" },
    include: { thread: { select: { id: true, participantHandle: true } } },
  });
  if (!m) return null;
  return {
    id: m.id,
    threadId: m.thread.id,
    participantHandle: m.thread.participantHandle,
    contentType: m.contentType,
    text: m.text,
  };
}

export async function recordWebhookEvent(provider: string, payload: unknown) {
  return prisma.webhookEvent.create({
    data: { provider, payload: payload as never },
  });
}

export async function markWebhookProcessed(id: string, error?: string) {
  return prisma.webhookEvent.update({
    where: { id },
    data: { processedAt: new Date(), error },
  });
}

export async function touchWebhookCheckpoint(orgId: OrgId, igAccountId: string) {
  return prisma.ingestionCheckpoint.updateMany({
    where: { orgId, igAccountId },
    data: { lastWebhookAt: new Date() },
  });
}
