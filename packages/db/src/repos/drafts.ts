import { Prisma } from "@prisma/client";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { DomainError, editRatio, type ClassificationLabel } from "@dealdock/core";
import { writeAudit } from "../audit-log";
import { requireSeatInOrg } from "../seat-scope";
import { advanceThreadClocks, lockThread } from "../thread-writes";
import { lockConsentedVoiceProfile } from "../voice-consent";
import { measureEdit } from "../voice-match";
import { VOICE_LEARN_OUTBOX_KIND } from "./voice";

export async function createDraft(
  orgId: OrgId,
  input: {
    threadId: string;
    replyToMessageId?: string;
    kind?: "reply" | "nudge";
    body: string;
    modelVersion: string;
    promptVersion: string;
    /** The label this draft was written for (the thread's top label drifts later). */
    label?: ClassificationLabel | null;
    /** The creator's free-text steering for this generation (≤ 200 chars). */
    instruction?: string | null;
    chips?: string[];
    /** Every generated version, body first (one row keeps the one-live-draft invariant). */
    alternatives?: string[];
    /** "Why this draft": the DraftContextSummary (+ promptVersion, lintViolations). */
    generationContext?: Record<string, unknown> | null;
  }
) {
  // Read-discard-create must be atomic (F9): otherwise two concurrent draft
  // generations for the same thread (e.g. a live classification job racing the
  // nudge scheduler) can both read the same prior version and both insert a
  // "ready" draft with an identical version number, leaving ambiguous state.
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: { id: input.threadId, orgId },
      select: { id: true, igAccountId: true },
    });
    if (!thread) throw new DomainError("thread not in org", 404);
    await lockThread(tx, thread.id);
    // Coordinate model generation with explicit consent revocation. A shared
    // lock means revocation either commits first (then this fresh read rejects)
    // or waits and discards any ready draft generated under prior consent.
    await lockConsentedVoiceProfile(tx, orgId, thread.igAccountId, "share");

    // A human-approved message is in flight and must not be replaced by a
    // late generation job. It is reconciled as a SendIntent, never discarded.
    const sending = await tx.draft.findFirst({
      where: { orgId, threadId: input.threadId, status: "sending" },
      select: { id: true },
    });
    if (sending) throw new DomainError("draft_send_in_flight", 409);
    const prior = await tx.draft.findFirst({
      where: { orgId, threadId: input.threadId, status: { in: ["ready", "edited"] } },
      orderBy: { version: "desc" },
    });
    if (prior) {
      await tx.draft.update({
        where: { id: prior.id },
        data: { status: "discarded" },
      });
    }

    const latest = await tx.draft.findFirst({
      where: { orgId, threadId: input.threadId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return tx.draft.create({
      data: {
        orgId,
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
        kind: input.kind ?? "reply",
        body: input.body,
        version: (latest?.version ?? 0) + 1,
        modelVersion: input.modelVersion,
        promptVersion: input.promptVersion,
        label: input.label ?? null,
        instruction: input.instruction?.slice(0, 200) || null,
        chips: input.chips ?? [],
        alternatives: (input.alternatives ?? []).slice(0, 3),
        ...(input.generationContext ? { generationContext: input.generationContext as Prisma.InputJsonValue } : {}),
      },
    });
  });
}

/**
 * Pick one of the generated versions ("Take 2"): it becomes the body the
 * creator edits and sends, so edit distance is measured against what they saw.
 * Conditional on the draft still being live — never rewrites a claimed send.
 */
export async function chooseDraftAlternative(orgId: OrgId, input: { threadId: string; draftId: string; alternative: number }) {
  const draft = await prisma.draft.findFirst({
    where: { id: input.draftId, orgId, threadId: input.threadId },
    select: { id: true, alternatives: true },
  });
  if (!draft) throw new DomainError("draft_not_found", 404);
  const body = draft.alternatives[input.alternative];
  if (body === undefined) throw Object.assign(new DomainError("alternative_out_of_range", 400), { statusCode: 400 });
  const updated = await prisma.draft.updateMany({
    where: { id: draft.id, orgId, status: { in: ["ready", "edited"] } },
    data: { body, chosenAlternative: input.alternative, status: "edited" },
  });
  if (!updated.count) throw new DomainError("draft_not_live_conflict", 409);
  return prisma.draft.findUniqueOrThrow({ where: { id: draft.id } });
}

/**
 * Chips/note on a draft (DraftFeedback). Voice-derived data, so it needs
 * consent on the draft's account (revocation deletes these rows). Returns
 * what the caller needs to turn style chips into rule evidence.
 */
export async function recordDraftFeedback(orgId: OrgId, input: { draftId: string; seatId: string; chips: string[]; note?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const seat = await requireSeatInOrg(orgId, input.seatId, tx);
    const draft = await tx.draft.findFirst({
      where: { id: input.draftId, orgId },
      select: { id: true, threadId: true, kind: true, label: true, body: true, thread: { select: { igAccountId: true } } },
    });
    if (!draft) throw new DomainError("draft_not_found", 404);
    await lockConsentedVoiceProfile(tx, orgId, draft.thread.igAccountId, "share");
    const feedback = await tx.draftFeedback.create({
      data: { orgId, draftId: draft.id, seatId: seat.id, chips: input.chips, note: input.note?.slice(0, 280) || null },
      select: { id: true },
    });
    return {
      feedbackId: feedback.id,
      seatRole: seat.role,
      draft: { id: draft.id, threadId: draft.threadId, igAccountId: draft.thread.igAccountId, kind: draft.kind, label: draft.label, body: draft.body },
    };
  });
}

/** A sent draft with everything the learner needs (body vs final, label, approving seat, what shaped it). */
export async function getDraftForLearning(orgId: OrgId, draftId: string) {
  return prisma.draft.findFirst({
    where: { id: draftId, orgId },
    select: {
      id: true,
      threadId: true,
      kind: true,
      label: true,
      body: true,
      finalText: true,
      status: true,
      editRatio: true,
      learnedAt: true,
      generationContext: true,
      sentBy: { select: { role: true } },
      thread: { select: { igAccountId: true } },
    },
  });
}

/** Human-edited sends (0.05 ≤ edit ratio ≤ 0.8) since the last distillation — the batch trigger is ≥ 5. */
export async function countEditedSendsSince(orgId: OrgId, igAccountId: string, since: Date | null) {
  return prisma.draft.count({
    where: { orgId, status: "sent", thread: { igAccountId }, editRatio: { gte: 0.05, lte: 0.8 }, ...(since ? { sentAt: { gt: since } } : {}) },
  });
}

/** Newest ≤ `limit` edited sends since the last distillation, with the inbound each one answered. */
export async function listDistillationBatch(orgId: OrgId, igAccountId: string, since: Date | null, limit = 10) {
  const drafts = await prisma.draft.findMany({
    where: { orgId, status: "sent", thread: { igAccountId }, editRatio: { gte: 0.05, lte: 0.8 }, finalText: { not: null }, ...(since ? { sentAt: { gt: since } } : {}) },
    orderBy: { sentAt: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      kind: true,
      label: true,
      body: true,
      finalText: true,
      replyToMessageId: true,
      editSignals: true,
      sentBy: { select: { role: true } },
    },
  });
  const inbound = await inboundTexts(orgId, drafts.map((d) => d.replyToMessageId));
  return drafts.map((d) => ({ ...d, finalText: d.finalText ?? "", inboundText: d.replyToMessageId ? (inbound.get(d.replyToMessageId) ?? null) : null }));
}

/** Text (or voice-note transcript) of the given inbound messages, org-scoped. */
export async function inboundTexts(orgId: OrgId, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const rows = await prisma.message.findMany({ where: { orgId, id: { in: wanted } }, select: { id: true, text: true, transcript: true } });
  return new Map(rows.map((m) => [m.id, m.text.trim() || m.transcript || ""]));
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

export interface SendIntentClaim {
  intentId: string;
  draftId: string;
  status: "pending" | "remote_accepted" | "persisted" | "unknown";
  claimed: boolean;
}

/**
 * Persist human approval before the remote call. A network timeout after the
 * platform may have accepted the message is deliberately recoverable only by
 * reconciliation/echo -- never by automatically sending the draft again.
 */
export async function createSendIntentClaim(
  orgId: OrgId,
  input: {
    draftId: string;
    seatId: string;
    finalText: string;
    idempotencyKey: string;
    /** Voice-note send: the approved text is synthesized into this AudioAsset (F9). */
    asVoice?: boolean;
    audioAssetId?: string | null;
  },
): Promise<SendIntentClaim> {
  if (!input.finalText.trim()) throw new DomainError("send_text_required", 400);
  if (!input.idempotencyKey.trim()) throw new DomainError("idempotency_key_required", 400);
  return prisma.$transaction(async (tx) => {
    await requireSeatInOrg(orgId, input.seatId, tx, "send_seat_not_in_org");
    const draft = await tx.draft.findFirst({
      where: { id: input.draftId, orgId },
      select: { id: true },
    });
    if (!draft) throw new DomainError("draft_not_in_org", 404);
    const existing = await tx.sendIntent.findFirst({
      where: { orgId, OR: [{ draftId: input.draftId }, { idempotencyKey: input.idempotencyKey }] },
      select: { id: true, draftId: true, status: true, finalText: true, seatId: true },
    });
    if (existing) {
      if (existing.draftId !== input.draftId || existing.finalText !== input.finalText || existing.seatId !== input.seatId) {
        throw new DomainError("send_idempotency_key_conflict", 409);
      }
      return { intentId: existing.id, draftId: existing.draftId, status: existing.status, claimed: false };
    }

    const claim = await tx.draft.updateMany({
      where: { id: input.draftId, orgId, status: { in: ["ready", "edited"] } },
      data: { status: "sending" },
    });
    if (!claim.count) {
      // The concurrent request may have committed its intent after our first
      // lookup and before it claimed the draft. Re-read so an exact HTTP retry
      // receives that durable intent, not a misleading conflict/retry signal.
      const concurrent = await tx.sendIntent.findFirst({
        where: { orgId, OR: [{ draftId: input.draftId }, { idempotencyKey: input.idempotencyKey }] },
        select: { id: true, draftId: true, status: true, finalText: true, seatId: true },
      });
      if (concurrent) {
        if (concurrent.draftId !== input.draftId || concurrent.finalText !== input.finalText || concurrent.seatId !== input.seatId) {
          throw new DomainError("send_idempotency_key_conflict", 409);
        }
        return { intentId: concurrent.id, draftId: concurrent.draftId, status: concurrent.status, claimed: false };
      }
      throw new DomainError("draft_not_sendable_or_already_claimed", 409);
    }
    const intent = await tx.sendIntent.create({
      data: {
        orgId,
        draftId: input.draftId,
        seatId: input.seatId,
        finalText: input.finalText,
        idempotencyKey: input.idempotencyKey,
        asVoice: input.asVoice ?? false,
        audioAssetId: input.audioAssetId ?? null,
      },
      select: { id: true, draftId: true, status: true },
    });
    return { intentId: intent.id, draftId: intent.draftId, status: intent.status, claimed: true };
  });
}

export async function markSendIntentRemoteAccepted(
  orgId: OrgId,
  intentId: string,
  platformMessageId?: string,
  sentAt?: Date,
) {
  const updated = await prisma.sendIntent.updateMany({
    where: { id: intentId, orgId, status: "pending" },
    data: {
      status: "remote_accepted",
      ...(platformMessageId ? { platformMessageId } : {}),
      ...(sentAt ? { platformSentAt: sentAt } : {}),
      lastError: null,
    },
  });
  if (updated.count) return { updated: true as const };
  const intent = await prisma.sendIntent.findFirst({ where: { id: intentId, orgId }, select: { status: true } });
  if (!intent) throw new DomainError("send_intent_not_in_org", 404);
  return { updated: false as const, status: intent.status };
}

/** Mark an ambiguous network outcome. It intentionally does not release the draft. */
export async function markSendIntentUnknown(orgId: OrgId, intentId: string, error: string) {
  const updated = await prisma.sendIntent.updateMany({
    where: { id: intentId, orgId, status: { in: ["pending", "remote_accepted"] } },
    data: { status: "unknown", lastError: error.slice(0, 500) },
  });
  if (!updated.count) {
    const intent = await prisma.sendIntent.findFirst({ where: { id: intentId, orgId }, select: { id: true } });
    if (!intent) throw new DomainError("send_intent_not_in_org", 404);
  }
}

/** System-context reconciliation queue for ambiguous sends; consumers may inspect remote history only. */
export async function listSendIntentsNeedingReconciliation(limit = 100) {
  return prisma.sendIntent.findMany({
    where: { status: { in: ["unknown", "remote_accepted"] } },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, orgId: true, draftId: true, status: true, platformMessageId: true, platformSentAt: true },
  });
}

/**
 * Resolve a remote acknowledgement or a webhook echo into exactly one local
 * outbound message. This is safe if the echo won the race and inserted the
 * message before the send response returned: either way the row ends up
 * origin "dealdock" (never mistaken for the creator's native voice), and a
 * voice-note send records its audio. The first persistence also queues the
 * "voice.learn" outbox event in the same transaction (crash-safe learning).
 * Returns the edit distance and ratio it recorded, so callers never re-measure.
 */
export async function persistSendIntent(
  orgId: OrgId,
  input: { intentId: string; platformMessageId: string; sentAt: Date },
) {
  if (!input.platformMessageId.trim() || !Number.isFinite(input.sentAt.getTime())) throw new Error("invalid_send_receipt");
  // Which conversation to lock, and the edit to record: Levenshtein runs once,
  // here, before the transaction holds any row lock.
  const approved = await prisma.sendIntent.findFirst({
    where: { id: input.intentId, orgId },
    select: { finalText: true, draft: { select: { threadId: true, body: true } } },
  });
  if (!approved) throw new DomainError("send_intent_not_in_org", 404);
  const measured = measureEdit(approved.draft.body, approved.finalText);
  return prisma.$transaction(async (tx) => {
    // Serialize send-response and echo reconciliation for this conversation.
    // The lock also makes two response/echo persistence attempts deterministic.
    await lockThread(tx, approved.draft.threadId);
    const intent = await tx.sendIntent.findFirstOrThrow({
      where: { id: input.intentId, orgId },
      include: { draft: { select: { id: true, threadId: true, body: true, status: true } } },
    });
    // A claimed draft's body and approved text do not change; re-measure only if they somehow did.
    const edit = intent.draft.body === approved.draft.body && intent.finalText === approved.finalText
      ? measured
      : measureEdit(intent.draft.body, intent.finalText);
    if (intent.platformMessageId && intent.platformMessageId !== input.platformMessageId) throw new DomainError("send_receipt_conflict", 409);
    const voiceNote = intent.asVoice;
    const asset = voiceNote && intent.audioAssetId
      ? await tx.audioAsset.findFirst({ where: { id: intent.audioAssetId, orgId }, select: { id: true, durationMs: true } })
      : null;
    const audio = voiceNote
      ? { contentType: "audio" as const, transcript: intent.finalText, ...(asset ? { audioAssetId: asset.id, mediaStatus: "ready", durationMs: asset.durationMs } : {}) }
      : null;
    const message = await tx.message.upsert({
      where: { igMessageId: input.platformMessageId },
      create: {
        orgId,
        threadId: intent.draft.threadId,
        igMessageId: input.platformMessageId,
        direction: "outbound",
        text: intent.finalText,
        sentAt: input.sentAt,
        origin: "dealdock",
        ...(audio ?? {}),
      },
      // Provenance is set below, only after the echo is proven to be ours: an
      // id collision with an inbound row must fail the check, not a constraint.
      update: {},
      select: { id: true, orgId: true, threadId: true, direction: true, text: true, origin: true, contentType: true, audioAssetId: true },
    });
    // An id collision must never silently mark this draft sent. An echo is
    // valid only if it is the exact outbound on this draft's conversation. An
    // audio echo carries no text, so a voice note is matched on everything else.
    if (
      message.orgId !== orgId ||
      message.threadId !== intent.draft.threadId ||
      message.direction !== "outbound" ||
      (!voiceNote && message.text !== intent.finalText)
    ) {
      throw new Error("platform_message_collision_or_mismatched_echo");
    }
    const audioUpdate = audio && (message.contentType !== "audio" || (asset && message.audioAssetId !== asset.id)) ? audio : {};
    if (message.origin !== "dealdock" || Object.keys(audioUpdate).length) {
      await tx.message.update({ where: { id: message.id }, data: { origin: "dealdock", ...audioUpdate } });
    }
    const sent = await tx.draft.updateMany({
      where: { id: intent.draft.id, orgId, status: "sending" },
      data: {
        status: "sent",
        sentAt: input.sentAt,
        sentBySeatId: intent.seatId,
        sentMessageId: message.id,
        finalText: intent.finalText,
        editDistance: edit.editDistance,
        editRatio: edit.editRatio,
      },
    });
    await tx.sendIntent.update({
      where: { id: intent.id },
      data: { status: "persisted", platformMessageId: input.platformMessageId, platformSentAt: input.sentAt, lastError: null },
    });
    await advanceThreadClocks(tx, intent.draft.threadId, "outbound", input.sentAt);
    if (sent.count) {
      await writeAudit(tx, {
        orgId,
        seatId: intent.seatId,
        action: "message.sent",
        entityType: "draft",
        entityId: intent.draft.id,
        detail: { originalDraft: intent.draft.body, finalText: intent.finalText, editDistance: edit.editDistance, intentId: intent.id, asVoice: intent.asVoice },
      });
      // Learn from this edit asynchronously; the worker re-checks consent and pause.
      const dedupeKey = `${VOICE_LEARN_OUTBOX_KIND}:${intent.draft.id}`;
      await tx.outboxEvent.upsert({
        where: { dedupeKey },
        create: { orgId, kind: VOICE_LEARN_OUTBOX_KIND, dedupeKey, payload: { orgId, draftId: intent.draft.id } },
        update: {},
      });
    }
    return { messageId: message.id, persistedNow: sent.count === 1, editDistance: edit.editDistance, editRatio: edit.editRatio };
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
    await requireSeatInOrg(orgId, input.seatId, tx, "send_seat_not_in_org");
    const draft = await tx.draft.findFirst({
      where: { id: input.draftId, orgId, status: "sending" },
      select: { id: true, threadId: true, body: true },
    });
    if (!draft) throw new DomainError("draft_not_in_org_or_not_claimed", 404);

    const message = await tx.message.upsert({
      where: { igMessageId: input.platformMessageId },
      create: {
        orgId, threadId: draft.threadId, igMessageId: input.platformMessageId,
        direction: "outbound", text: input.finalText, sentAt: input.sentAt, origin: "dealdock",
      },
      update: {},
      select: { id: true, orgId: true, threadId: true, direction: true, text: true, origin: true },
    });
    if (message.orgId !== orgId || message.threadId !== draft.threadId || message.direction !== "outbound" || message.text !== input.finalText) {
      throw new Error("platform_message_collision_or_mismatched_echo");
    }
    if (message.origin !== "dealdock") await tx.message.update({ where: { id: message.id }, data: { origin: "dealdock" } });

    const persisted = await tx.draft.updateMany({
      where: { id: draft.id, orgId, status: "sending" },
      data: {
        status: "sent",
        sentAt: input.sentAt,
        sentBySeatId: input.seatId,
        sentMessageId: message.id,
        finalText: input.finalText,
        editDistance: input.editDistance,
        editRatio: editRatio(draft.body, input.finalText),
      },
    });
    if (!persisted.count) throw new Error("draft_not_sendable_or_already_persisted");
    const updated = await tx.draft.findUniqueOrThrow({ where: { id: draft.id } });

    await tx.thread.update({
      where: { id: draft.threadId },
      data: { lastMessageAt: input.sentAt, lastOutboundAt: input.sentAt },
    });

    // Audit: original draft, final text, edit distance (PRD §7.5).
    await writeAudit(tx, {
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
    });

    return { draft: updated, messageId: message.id };
  });
}
