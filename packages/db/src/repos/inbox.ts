import { prisma } from "../client";
import type { OrgId } from "../org-id";

export interface InboxRow {
  threadId: string;
  participantHandle: string;
  state: string;
  lastMessageAt: Date;
  topLabel: string | null;
  estValueMaxMinor: number | null;
  preview: string | null;
  messageCount: number;
}

/**
 * Revenue Inbox query (PRD §6.3): value-desc default sort over denormalized
 * thread fields; sort + label/unreplied filters.
 */
export async function listInboxThreads(
  orgId: OrgId,
  opts: {
    limit?: number;
    state?: "open" | "waiting" | "closed";
    label?: string;
    unrepliedOnly?: boolean;
    sort?: "value" | "recent" | "oldest_unread";
  } = {}
): Promise<InboxRow[]> {
  const orderBy =
    opts.sort === "recent"
      ? [{ lastMessageAt: "desc" as const }]
      : opts.sort === "oldest_unread"
        ? [{ lastMessageAt: "asc" as const }]
        : [
            { estValueMaxMinor: { sort: "desc" as const, nulls: "last" as const } },
            { lastMessageAt: "desc" as const },
          ];

  const threads = await prisma.thread.findMany({
    where: {
      orgId,
      state: opts.state ?? "open",
      ...(opts.label ? { topLabel: opts.label as never } : {}),
      ...(opts.unrepliedOnly ? { lastOutboundAt: null } : {}),
    },
    orderBy,
    take: opts.limit ?? 50,
    include: {
      messages: {
        orderBy: { sentAt: "desc" },
        take: 1,
        select: { text: true },
      },
      _count: { select: { messages: true } },
    },
  });

  return threads.map((t) => ({
    threadId: t.id,
    participantHandle: t.participantHandle,
    state: t.state,
    lastMessageAt: t.lastMessageAt,
    topLabel: t.topLabel,
    estValueMaxMinor:
      t.estValueMaxMinor === null ? null : Number(t.estValueMaxMinor),
    preview: t.messages[0]?.text ?? null,
    messageCount: t._count.messages,
  }));
}

export async function countMessages(orgId: OrgId) {
  return prisma.message.count({ where: { orgId } });
}

export async function countClassifications(orgId: OrgId) {
  const [total, review, drafts] = await Promise.all([
    prisma.classification.count({ where: { orgId } }),
    prisma.classification.count({ where: { orgId, routedTo: "review_queue" } }),
    prisma.draft.count({ where: { orgId } }),
  ]);
  return { total, review, drafts };
}
