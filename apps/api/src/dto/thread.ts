import {
  computeReplyWindow,
  type AudioAttachment,
  type DraftContextSummary,
  type MessageSource,
  type ParticipantProfile,
  type ThreadDetail,
} from "@dealdock/core";
import type { getThreadDetail, InboxParticipant } from "@dealdock/db";
import { signMediaPath } from "../media-sign";
import { toDraftDto } from "./draft";

type Detail = NonNullable<Awaited<ReturnType<typeof getThreadDetail>>>;
type DetailMessage = Detail["messages"][number];

const SOURCES = new Set<string>(["dm", "story", "reel", "ad", "link"] satisfies MessageSource[]);
const MEDIA_STATUSES = new Set<string>(["ready", "pending", "unavailable", "failed"] satisfies AudioAttachment["status"][]);

export function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

export function toSource(source: string | null): MessageSource | null {
  return source !== null && SOURCES.has(source) ? (source as MessageSource) : null;
}

export function toParticipant(participant: InboxParticipant): ParticipantProfile {
  return {
    handle: participant.handle,
    name: participant.name,
    avatarUrl: participant.avatarUrl,
    followerCount: participant.followerCount,
    verified: participant.verified,
    followsYou: participant.followsYou,
    closedTotalMinor: participant.closedTotalMinor,
    closedDeals: participant.closedDeals,
    fetchedAt: iso(participant.fetchedAt),
  };
}

function toAudio(message: DetailMessage): AudioAttachment | null {
  if (message.contentType !== "audio" && !message.audioAssetId) return null;
  // No recorded status: a stored clip is playable; a legacy voice note was never fetched.
  const status = MEDIA_STATUSES.has(message.mediaStatus ?? "")
    ? (message.mediaStatus as AudioAttachment["status"])
    : message.audioAssetId
      ? "ready"
      : "unavailable";
  return {
    url: status === "ready" && message.audioAssetId ? signMediaPath(message.audioAssetId) : null,
    mimeType: message.audioMimeType,
    durationMs: message.durationMs,
    transcript: message.transcript,
    transcriptLanguage: message.transcriptLanguage,
    status,
  };
}

/** GET /threads/:id — the repo read model plus request-time facts the API owns. */
export function toThreadDetail(
  detail: Detail,
  ctx: { now: Date; humanAgentEnabled: boolean; canSendVoice: boolean; draftContext: DraftContextSummary | null },
): ThreadDetail {
  return {
    id: detail.id,
    igAccountId: detail.igAccountId,
    participantHandle: detail.participantHandle,
    participant: toParticipant(detail.participant),
    state: detail.state,
    waitingSince: iso(detail.waitingSince),
    nudgeDue: detail.nudgeDue,
    topLabel: detail.topLabel,
    estValueMinMinor: detail.estValueMinMinor,
    estValueMaxMinor: detail.estValueMaxMinor,
    estCurrencyCode: detail.estCurrencyCode,
    rationale: detail.rationale,
    lastInboundAt: iso(detail.lastInboundAt),
    replyWindow: computeReplyWindow(detail.lastInboundAt, ctx.now, ctx.humanAgentEnabled),
    source: toSource(detail.source),
    messages: detail.messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      contentType: message.contentType,
      text: message.text,
      sentAt: message.sentAt.toISOString(),
      origin: message.origin,
      audio: toAudio(message),
      classification: message.classification
        ? { ...message.classification, reviewedAt: iso(message.classification.reviewedAt) }
        : null,
    })),
    sendInFlight: detail.sendInFlight,
    currentDraft: detail.currentDraft ? toDraftDto(detail.currentDraft, ctx.draftContext) : null,
    closedDeals: detail.closedDeals.map((deal) => ({ ...deal, closedAt: deal.closedAt.toISOString() })),
    dealSignal: detail.dealSignal,
    canSendVoice: ctx.canSendVoice,
  };
}
