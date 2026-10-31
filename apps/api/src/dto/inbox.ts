import { computeReplyWindow, type InboxRow } from "@dealdock/core";
import type { InboxRow as InboxRecord } from "@dealdock/db";
import { iso, toParticipant, toSource } from "./thread";

/** One Revenue Inbox row; the reply window is computed per request (it ticks). */
export function toInboxRow(row: InboxRecord, now: Date, humanAgentEnabled: boolean): InboxRow {
  return {
    threadId: row.threadId,
    igAccountId: row.igAccountId,
    participantHandle: row.participantHandle,
    participant: toParticipant(row.participant),
    state: row.state,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastInboundAt: iso(row.lastInboundAt),
    topLabel: row.topLabel,
    estValueMinMinor: row.estValueMinMinor,
    estValueMaxMinor: row.estValueMaxMinor,
    estCurrencyCode: row.estCurrencyCode,
    preview: row.preview,
    previewOutbound: row.previewOutbound,
    messageCount: row.messageCount,
    unreplied: row.unreplied,
    waitingSince: iso(row.waitingSince),
    nudgeDue: row.nudgeDue,
    draftReady: row.draftReady,
    hasAudio: row.hasAudio,
    dealSignal: row.dealSignal,
    source: toSource(row.source),
    replyWindow: computeReplyWindow(row.lastInboundAt, now, humanAgentEnabled),
  };
}
