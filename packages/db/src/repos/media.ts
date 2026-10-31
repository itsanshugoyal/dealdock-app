import { createHash } from "node:crypto";
import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { advanceThreadClocks } from "../thread-writes";

/**
 * Audio clips (F8 voice notes in, F9 voice notes out). Bytes live in
 * AudioAsset (pilot scale; object storage later) and leave the database only
 * through GET /media/a/:id. Content is never logged.
 */

/** Instagram's audio cap; the AudioAsset_size_cap CHECK enforces the same bound. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface AudioClipInput {
  kind: "voice_sample" | "consent" | "tts" | "inbound";
  bytes: Uint8Array;
  mimeType: string;
  durationMs?: number | null;
  /** TTS source text or transcript snapshot. */
  text?: string | null;
  expiresAt?: Date | null;
}

export function audioAssetData(orgId: OrgId, clip: AudioClipInput) {
  if (!clip.bytes.length || clip.bytes.length > MAX_AUDIO_BYTES) throw new DomainError("audio_size_out_of_bounds", 400);
  return {
    orgId,
    kind: clip.kind,
    mimeType: clip.mimeType,
    // Prisma accepts any Uint8Array view at runtime; its Bytes type is the narrower ArrayBuffer-backed one.
    bytes: clip.bytes as Uint8Array<ArrayBuffer>,
    sizeBytes: clip.bytes.length,
    durationMs: clip.durationMs ?? null,
    text: clip.text ?? null,
    sha256: createHash("sha256").update(clip.bytes).digest("hex"),
    expiresAt: clip.expiresAt ?? null,
  };
}

/** Store one clip (TTS reply or preview); returns metadata, never bytes. */
export async function createAudioAsset(orgId: OrgId, clip: AudioClipInput) {
  return prisma.audioAsset.create({
    data: audioAssetData(orgId, clip),
    select: { id: true, mimeType: true, sizeBytes: true, durationMs: true, sha256: true, expiresAt: true },
  });
}

/**
 * SYSTEM-CONTEXT (no org claim): GET /media/a/:id hands a clip to Meta's
 * fetcher or an <audio> element. The HMAC-signed, expiring link checked by
 * the API before this read IS the capability; expired clips are never served.
 */
export async function getAudioAssetForDelivery(assetId: string, now = new Date()) {
  return prisma.audioAsset.findFirst({
    where: { id: assetId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { mimeType: true, bytes: true, sizeBytes: true },
  });
}

export type InboundMediaOutcome =
  | { status: "ready"; audio: { bytes: Uint8Array; mimeType: string; durationMs?: number | null }; transcript?: string | null; transcriptLanguage?: string | null }
  | { status: "failed" | "unavailable" };

/**
 * Settle a voice note the worker just processed: keep the clip (kind
 * inbound, no expiry — it lives and dies with its message through retention
 * and org deletion), link it, record the transcript, and release the held
 * classification hand-off in the same transaction so the classifier reads
 * the transcript. Idempotent: only a message still "pending" is settled.
 */
export async function completeInboundMedia(orgId: OrgId, messageId: string, outcome: InboundMediaOutcome) {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: messageId, orgId, direction: "inbound" },
      select: { id: true, igMessageId: true, mediaStatus: true },
    });
    if (!message) throw new DomainError("message_not_in_org", 404);
    if (message.mediaStatus !== "pending") return { settled: false as const };
    const asset = outcome.status === "ready"
      ? await tx.audioAsset.create({ data: audioAssetData(orgId, { kind: "inbound", ...outcome.audio }), select: { id: true } })
      : null;
    await tx.message.update({
      where: { id: message.id },
      data: outcome.status === "ready"
        ? {
            mediaStatus: "ready",
            audioAssetId: asset!.id,
            durationMs: outcome.audio.durationMs ?? null,
            transcript: outcome.transcript?.trim() || null,
            transcriptLanguage: outcome.transcriptLanguage ?? null,
          }
        : { mediaStatus: outcome.status },
    });
    // Release only a hold no dispatcher has claimed yet, so it is never published twice.
    await tx.outboxEvent.updateMany({
      where: { orgId, kind: "classification", dedupeKey: `classification:${message.igMessageId}`, processedAt: null, leasedAt: null },
      data: { leaseExpiresAt: null },
    });
    return { settled: true as const, audioAssetId: asset?.id ?? null };
  });
}

/** Show a sent voice note as audio in the thread: link the approved TTS clip to its outbound message. */
export async function attachVoiceNoteToMessage(orgId: OrgId, messageId: string, audioAssetId: string) {
  const asset = await prisma.audioAsset.findFirst({
    where: { id: audioAssetId, orgId, kind: "tts" },
    select: { id: true, durationMs: true },
  });
  if (!asset) throw new DomainError("audio_asset_not_in_org", 404);
  await prisma.message.updateMany({
    where: { id: messageId, orgId, direction: "outbound", audioAssetId: null },
    data: { contentType: "audio", audioAssetId: asset.id, mediaStatus: "ready", durationMs: asset.durationMs, origin: "dealdock" },
  });
}

/**
 * The AI-voice disclosure text sent right after a voice note under the same
 * human approval: an outbound DealDock message, never creator style
 * evidence. If the platform echo got here first (as "native"), correct it.
 */
export async function recordVoiceNoteDisclosure(
  orgId: OrgId,
  input: { threadId: string; platformMessageId: string; text: string; sentAt: Date }
) {
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({ where: { id: input.threadId, orgId }, select: { id: true } });
    if (!thread) throw new DomainError("thread_not_in_org", 404);
    const message = await tx.message.upsert({
      where: { igMessageId: input.platformMessageId },
      create: {
        orgId,
        threadId: thread.id,
        igMessageId: input.platformMessageId,
        direction: "outbound",
        text: input.text,
        sentAt: input.sentAt,
        origin: "dealdock",
      },
      update: {},
      select: { id: true, orgId: true, threadId: true, direction: true, origin: true },
    });
    if (message.orgId !== orgId || message.threadId !== thread.id || message.direction !== "outbound") {
      throw new DomainError("platform_message_collision_conflict", 409);
    }
    if (message.origin !== "dealdock") await tx.message.update({ where: { id: message.id }, data: { origin: "dealdock" } });
    await advanceThreadClocks(tx, thread.id, "outbound", input.sentAt);
    return { messageId: message.id };
  });
}
