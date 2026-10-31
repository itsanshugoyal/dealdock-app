import { HIGH_INTENT_LABELS } from "@dealdock/core";
import { prisma } from "./client";
import type { OrgId } from "./org-id";
import { minorUnitsToNumber } from "./money";

/**
 * Read-model helpers shared by the inbox list and the thread detail, so both
 * pick the same "top" estimate, show the same sender card and compute the
 * same per-sender revenue in bulk.
 */

/** What a message says: its text, or the voice-note transcript when it has none. */
export function messageBody(message: { text: string; transcript: string | null }): string {
  return message.text.trim() ? message.text : message.transcript ?? "";
}

/**
 * The classification behind a thread's denormalized estimate, also used to
 * write it (refreshThreadClassificationState in classifications.ts):
 * inbox-routed commerce, highest max value first (nulls last), then newest.
 */
export function pickTopClassification<T extends { label: string; routedTo: string; valueMaxMinor: bigint | null; createdAt: Date }>(
  rows: T[],
): T | null {
  const candidates = rows.filter((row) => row.routedTo === "inbox" && (HIGH_INTENT_LABELS as readonly string[]).includes(row.label));
  candidates.sort((a, b) => {
    if (a.valueMaxMinor === null && b.valueMaxMinor !== null) return 1;
    if (a.valueMaxMinor !== null && b.valueMaxMinor === null) return -1;
    if (a.valueMaxMinor !== null && b.valueMaxMinor !== null && a.valueMaxMinor !== b.valueMaxMinor) {
      return a.valueMaxMinor > b.valueMaxMinor ? -1 : 1;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  return candidates[0] ?? null;
}

/** A sender is one Instagram-scoped user on one connected account (IGSIDs are per account). */
export interface SenderKey {
  igAccountId: string;
  participantIgId: string;
}

export function senderKey(sender: SenderKey): string {
  return `${sender.igAccountId}|${sender.participantIgId}`;
}

export interface InboxParticipant {
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  followerCount: number | null;
  verified: boolean | null;
  followsYou: boolean | null;
  closedTotalMinor: number;
  closedDeals: number;
  fetchedAt: Date | null;
}

/** The thread columns behind a sender card. */
export interface ParticipantColumns extends SenderKey {
  participantHandle: string;
  participantName: string | null;
  participantAvatarUrl: string | null;
  participantFollowerCount: number | null;
  participantVerified: boolean | null;
  participantFollowsYou: boolean | null;
  profileFetchedAt: Date | null;
}

/**
 * The sender card on an inbox row and a thread: the cached profile snapshot
 * plus the sender's lifetime confirmed revenue (`totals` from senderLedger).
 */
export function participantOf(
  thread: ParticipantColumns,
  totals: ReadonlyMap<string, { closedTotalMinor: number; closedDeals: number }>,
): InboxParticipant {
  const sender = totals.get(senderKey(thread)) ?? { closedTotalMinor: 0, closedDeals: 0 };
  return {
    handle: thread.participantHandle,
    name: thread.participantName,
    avatarUrl: thread.participantAvatarUrl,
    followerCount: thread.participantFollowerCount,
    verified: thread.participantVerified,
    followsYou: thread.participantFollowsYou,
    closedTotalMinor: sender.closedTotalMinor,
    closedDeals: sender.closedDeals,
    fetchedAt: thread.profileFetchedAt,
  };
}

/**
 * Lifetime confirmed revenue per sender across all their threads, and each
 * thread's latest recorded close — one query for any number of rows.
 */
export async function senderLedger(orgId: OrgId, senders: SenderKey[]) {
  const totals = new Map<string, { closedTotalMinor: number; closedDeals: number }>();
  const lastClosedAt = new Map<string, Date>();
  const unique = [...new Map(senders.map((sender) => [senderKey(sender), sender])).values()];
  if (unique.length === 0) return { totals, lastClosedAt };

  const entries = await prisma.ledgerEntry.findMany({
    where: {
      orgId,
      deletedAt: null,
      thread: {
        orgId,
        OR: unique.map((sender) => ({ igAccountId: sender.igAccountId, participantIgId: sender.participantIgId })),
      },
    },
    select: {
      threadId: true,
      amountMinor: true,
      closedAt: true,
      thread: { select: { igAccountId: true, participantIgId: true } },
    },
  });
  for (const entry of entries) {
    const key = senderKey(entry.thread);
    const sum = totals.get(key) ?? { closedTotalMinor: 0, closedDeals: 0 };
    const next = sum.closedTotalMinor + minorUnitsToNumber(entry.amountMinor);
    if (!Number.isSafeInteger(next)) throw new Error("ledger_total_exceeds_javascript_safe_integer");
    totals.set(key, { closedTotalMinor: next, closedDeals: sum.closedDeals + 1 });
    const last = lastClosedAt.get(entry.threadId);
    if (!last || last < entry.closedAt) lastClosedAt.set(entry.threadId, entry.closedAt);
  }
  return { totals, lastClosedAt };
}
