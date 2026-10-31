import { Prisma, type ClassificationLabel, type ThreadState } from "@prisma/client";
import { DEAL_SIGNAL_LOOKBACK, DomainError, findDealSignal, HIGH_INTENT_LABELS } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { minorUnitsToNumber } from "../money";
import { isNudgeDue } from "../schedule-rules";
import { messageBody, participantOf, pickTopClassification, senderLedger, type InboxParticipant } from "../sender-context";

export type { InboxParticipant };

/**
 * Messages per thread the row reads: core findDealSignal looks for a
 * confirmation among a thread's last DEAL_SIGNAL_LOOKBACK, so the row and the
 * thread banner see the same window. The newest is the preview.
 */
const RECENT_MESSAGES = DEAL_SIGNAL_LOOKBACK;

export interface InboxRow {
  threadId: string;
  igAccountId: string;
  participantHandle: string;
  participant: InboxParticipant;
  state: ThreadState;
  lastMessageAt: Date;
  lastInboundAt: Date | null;
  topLabel: ClassificationLabel | null;
  estValueMinMinor: number | null;
  estValueMaxMinor: number | null;
  estCurrencyCode: string | null;
  preview: string;
  /** The preview is our own outbound message (the creator replied last). */
  previewOutbound: boolean;
  messageCount: number;
  unreplied: boolean;
  waitingSince: Date | null;
  nudgeDue: boolean;
  draftReady: boolean;
  hasAudio: boolean;
  dealSignal: boolean;
  source: string | null;
}

export interface InboxQuery {
  state?: ThreadState;
  label?: ClassificationLabel;
  /** Case-insensitive match on handle, profile name or any message text/transcript. */
  q?: string;
  limit?: number;
  /** Opaque value from a previous page's nextCursor. */
  cursor?: string;
  now?: Date;
}

type Cursor = { value: string | null; at: number; id: string };

function encodeCursor(row: { estValueMaxMinor: bigint | null; lastMessageAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.estValueMaxMinor?.toString() ?? null, row.lastMessageAt.getTime(), row.id])).toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 3) {
      const [value, at, id] = parsed as unknown[];
      if (
        (value === null || (typeof value === "string" && /^\d{1,19}$/.test(value))) &&
        Number.isSafeInteger(at) &&
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 64
      ) {
        return { value, at: at as number, id };
      }
    }
  } catch {
    // fall through: any malformed cursor is the caller's error
  }
  throw Object.assign(new DomainError("invalid_cursor", 400), { statusCode: 400 });
}

function groupByThread<T extends { threadId: string }>(rows: T[]): Map<string, T[]> {
  const byThread = new Map<string, T[]>();
  for (const row of rows) {
    const list = byThread.get(row.threadId);
    if (list) list.push(row);
    else byThread.set(row.threadId, [row]);
  }
  return byThread;
}

/** Rows strictly after the cursor in (estValueMaxMinor desc nulls last, lastMessageAt desc, id desc). */
function afterCursor(cursor: Cursor): Prisma.ThreadWhereInput {
  const at = new Date(cursor.at);
  const sameValueAfter = { OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: cursor.id } }] };
  if (cursor.value === null) return { AND: [{ estValueMaxMinor: null }, sameValueAfter] };
  const value = BigInt(cursor.value);
  return {
    OR: [
      { estValueMaxMinor: { lt: value } },
      { estValueMaxMinor: null },
      { AND: [{ estValueMaxMinor: value }, sameValueAfter] },
    ],
  };
}

/**
 * Revenue Inbox v2 (PRD §6.3): commerce threads by money then recency, with
 * state/label filters, search and a stable keyset cursor. Threads holding an
 * unreviewed item stay out entirely (the Review Queue owns them). Every row
 * field is computed in a fixed number of queries, whatever the page size.
 */
export async function listInboxPage(orgId: OrgId, query: InboxQuery = {}): Promise<{ rows: InboxRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
  const where: Prisma.ThreadWhereInput[] = [
    {
      orgId,
      state: query.state ?? "open",
      hasPendingReview: false,
      topLabel: query.label ?? { not: null },
    },
  ];
  const q = query.q?.trim();
  if (q) {
    where.push({
      OR: [
        { participantHandle: { contains: q, mode: "insensitive" } },
        { participantName: { contains: q, mode: "insensitive" } },
        {
          messages: {
            some: { orgId, OR: [{ text: { contains: q, mode: "insensitive" } }, { transcript: { contains: q, mode: "insensitive" } }] },
          },
        },
      ],
    });
  }
  if (query.cursor) where.push(afterCursor(decodeCursor(query.cursor)));

  const threads = await prisma.thread.findMany({
    where: { AND: where },
    orderBy: [{ estValueMaxMinor: { sort: "desc", nulls: "last" } }, { lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      igAccountId: true,
      participantHandle: true,
      participantIgId: true,
      participantName: true,
      participantAvatarUrl: true,
      participantFollowerCount: true,
      participantVerified: true,
      participantFollowsYou: true,
      profileFetchedAt: true,
      source: true,
      state: true,
      lastMessageAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      waitingSince: true,
      nudgeDismissedAt: true,
      topLabel: true,
      estValueMaxMinor: true,
      estCurrencyCode: true,
      _count: { select: { messages: true } },
    },
  });
  const page = threads.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = threads.length > limit && last ? encodeCursor(last) : null;
  if (page.length === 0) return { rows: [], nextCursor: null };

  const ids = page.map((thread) => thread.id);
  const [org, recent, classifications, liveDrafts, audio, ledger] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { nudgeDelayDays: true, currencyCode: true } }),
    // Each thread's last RECENT_MESSAGES messages through the (orgId, threadId,
    // sentAt) index, oldest first within a thread.
    prisma.$queryRaw<Array<{ id: string; threadId: string; direction: string; text: string; transcript: string | null; sentAt: Date }>>`
      SELECT m."id", m."threadId", m."direction"::text AS "direction", m."text", m."transcript", m."sentAt"
      FROM unnest(${ids}::text[]) AS t("threadId")
      CROSS JOIN LATERAL (
        SELECT "id", "threadId", "direction", "text", "transcript", "sentAt"
        FROM "Message"
        WHERE "orgId" = ${orgId} AND "threadId" = t."threadId"
        ORDER BY "sentAt" DESC, "id" DESC
        LIMIT ${RECENT_MESSAGES}::int
      ) m
      ORDER BY m."threadId", m."sentAt", m."id"`,
    prisma.classification.findMany({
      where: { orgId, routedTo: "inbox", label: { in: [...HIGH_INTENT_LABELS] }, message: { threadId: { in: ids } } },
      select: { label: true, routedTo: true, valueMinMinor: true, valueMaxMinor: true, createdAt: true, message: { select: { threadId: true } } },
    }),
    prisma.draft.groupBy({ by: ["threadId"], where: { orgId, threadId: { in: ids }, status: { in: ["ready", "edited"] } } }),
    prisma.message.groupBy({ by: ["threadId"], where: { orgId, threadId: { in: ids }, contentType: "audio" } }),
    senderLedger(orgId, page),
  ]);
  if (!org) throw new DomainError("org_not_found", 404);

  const now = query.now ?? new Date();
  const recentBy = groupByThread(recent);
  const draftReady = new Set(liveDrafts.map((row) => row.threadId));
  const withAudio = new Set(audio.map((row) => row.threadId));
  const classificationsBy = groupByThread(classifications.map((row) => ({ ...row, threadId: row.message.threadId })));

  const rows = page.map((thread): InboxRow => {
    const top = pickTopClassification(classificationsBy.get(thread.id) ?? []);
    const messages = recentBy.get(thread.id) ?? [];
    const latestMessage = messages[messages.length - 1];
    const lastClosedAt = ledger.lastClosedAt.get(thread.id);
    return {
      threadId: thread.id,
      igAccountId: thread.igAccountId,
      participantHandle: thread.participantHandle,
      participant: participantOf(thread, ledger.totals),
      state: thread.state,
      lastMessageAt: thread.lastMessageAt,
      lastInboundAt: thread.lastInboundAt,
      topLabel: thread.topLabel,
      estValueMinMinor: top?.valueMinMinor == null ? null : minorUnitsToNumber(top.valueMinMinor),
      estValueMaxMinor: thread.estValueMaxMinor === null ? null : minorUnitsToNumber(thread.estValueMaxMinor),
      estCurrencyCode: thread.estCurrencyCode,
      preview: latestMessage ? messageBody(latestMessage) : "",
      previewOutbound: latestMessage?.direction === "outbound",
      messageCount: thread._count.messages,
      unreplied: thread.lastInboundAt !== null && (thread.lastOutboundAt === null || thread.lastInboundAt > thread.lastOutboundAt),
      waitingSince: thread.waitingSince,
      nudgeDue: isNudgeDue(thread, org.nudgeDelayDays, now),
      draftReady: draftReady.has(thread.id),
      hasAudio: withAudio.has(thread.id),
      // A sale recorded at/after the confirmation hides it; the latest close-out decides that.
      dealSignal:
        findDealSignal({
          messages: messages.map((message) => ({ id: message.id, direction: message.direction, text: messageBody(message), sentAt: message.sentAt })),
          state: thread.state,
          label: thread.topLabel,
          currencyCode: org.currencyCode,
          recordedAt: lastClosedAt ? [lastClosedAt] : [],
        }) !== null,
      source: thread.source,
    };
  });
  return { rows, nextCursor };
}

/** First inbox page as plain rows (scripts and tests; the API pages with listInboxPage). */
export async function listInboxThreads(
  orgId: OrgId,
  opts: { limit?: number; state?: ThreadState; label?: ClassificationLabel } = {},
): Promise<InboxRow[]> {
  return (await listInboxPage(orgId, { ...opts, limit: opts.limit ?? 50 })).rows;
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
