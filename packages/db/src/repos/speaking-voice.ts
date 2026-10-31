import { DomainError, type SpeakingVoiceDto } from "@dealdock/core";
import type { Prisma } from "@prisma/client";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";
import { audioAssetData } from "./media";

/**
 * Cloned speaking voice (F9). Read helpers shared by the voice studio, thread
 * DTOs and the send gate; creation/revocation live beside them (BE media owner).
 * Consent is separate from writing-style consent: the creator reads a consent
 * statement aloud, and revocation deletes the vendor voice and recordings.
 */

export async function getSpeakingVoice(orgId: OrgId, igAccountId: string) {
  return prisma.speakingVoice.findFirst({ where: { orgId, igAccountId } });
}

/** The DTO every surface shows; "none" when the account never recorded a voice. */
export async function getSpeakingVoiceSummary(orgId: OrgId, igAccountId: string): Promise<SpeakingVoiceDto> {
  const voice = await getSpeakingVoice(orgId, igAccountId);
  if (!voice) {
    return { status: "none", provider: null, consentedAt: null, sampleSeconds: 0, disclosureEnabled: true, lastError: null, createdAt: null };
  }
  return {
    status: voice.status,
    provider: voice.provider,
    consentedAt: voice.consentedAt.toISOString(),
    sampleSeconds: voice.sampleSeconds,
    disclosureEnabled: voice.disclosureEnabled,
    lastError: voice.lastError,
    createdAt: voice.createdAt.toISOString(),
  };
}

/**
 * The voice a voice note may be sent with, or null: ready, unrevoked, held by
 * a vendor (externalVoiceId). Pass the deployment's provider kind to also
 * require that this vendor holds it (switching SPEECH_PROVIDER strands voices
 * cloned elsewhere); a null provider matches no voice.
 */
export async function getReadySpeakingVoice(orgId: OrgId, igAccountId: string, provider?: string | null) {
  const voice = await getSpeakingVoice(orgId, igAccountId);
  if (!voice || voice.status !== "ready" || voice.revokedAt || !voice.externalVoiceId) return null;
  if (provider !== undefined && voice.provider !== provider) return null;
  return { ...voice, externalVoiceId: voice.externalVoiceId };
}

/** A voice note may be sent only with a voice getReadySpeakingVoice returns. */
export async function isSpeakingVoiceReady(orgId: OrgId, igAccountId: string, provider?: string | null): Promise<boolean> {
  return (await getReadySpeakingVoice(orgId, igAccountId, provider)) !== null;
}

export interface RecordedTake {
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
}

/** Lock the account row so (re)recordings and revocations of one voice never interleave. */
async function lockAccount(tx: Prisma.TransactionClient, orgId: OrgId, igAccountId: string) {
  const account = await requireIgAccountInOrg(orgId, igAccountId, tx);
  await tx.$queryRaw`SELECT "id" FROM "IgAccount" WHERE "id" = ${account.id} FOR UPDATE`;
  return account.id;
}

/**
 * Begin (re)creating an account's cloned voice: store the spoken consent and
 * the sample takes, and mark the voice "pending" with the statement the
 * creator read aloud. Earlier recordings are replaced; the earlier vendor
 * voice (if any) is returned so the caller deletes it at the vendor.
 */
export async function startSpeakingVoice(
  orgId: OrgId,
  input: {
    igAccountId: string;
    seatId: string;
    provider: string;
    consentStatement: string;
    consentTake: RecordedTake;
    sampleTakes: RecordedTake[];
  }
) {
  return prisma.$transaction(async (tx) => {
    const seat = await requireSeatInOrg(orgId, input.seatId, tx);
    // Only the account owner may clone their own voice (research 03 §5).
    if (seat.role !== "creator") throw Object.assign(new DomainError("creator_seat_required", 403), { statusCode: 403 });
    const igAccountId = await lockAccount(tx, orgId, input.igAccountId);
    const previous = await tx.speakingVoice.findFirst({ where: { orgId, igAccountId } });
    const takes = [
      { kind: "consent" as const, ...input.consentTake },
      ...input.sampleTakes.map((take) => ({ kind: "voice_sample" as const, ...take })),
    ];
    // sampleAssetIds lists every recording of this voice, the consent take first.
    const assetIds: string[] = [];
    for (const take of takes) {
      const asset = await tx.audioAsset.create({ data: audioAssetData(orgId, take), select: { id: true } });
      assetIds.push(asset.id);
    }
    if (previous?.sampleAssetIds.length) {
      await tx.audioAsset.deleteMany({ where: { orgId, id: { in: previous.sampleAssetIds } } });
    }
    const data = {
      provider: input.provider,
      externalVoiceId: null,
      status: "pending" as const,
      consentStatement: input.consentStatement,
      consentedAt: new Date(),
      consentSeatId: input.seatId,
      sampleSeconds: Math.round(takes.reduce((sum, take) => sum + take.durationMs, 0) / 100) / 10,
      sampleAssetIds: assetIds,
      lastError: null,
      revokedAt: null,
    };
    const voice = await tx.speakingVoice.upsert({
      where: { igAccountId },
      create: { orgId, igAccountId, ...data },
      update: data, // keeps the creator's disclosure choice
      select: { id: true },
    });
    return {
      voiceId: voice.id,
      assetIds,
      previous: previous?.externalVoiceId ? { provider: previous.provider, externalVoiceId: previous.externalVoiceId } : null,
    };
  });
}

/**
 * Record the vendor's answer for the attempt identified by its recordings.
 * A newer recording or a revocation in the meantime wins: nothing is written
 * and the caller must delete the vendor voice it just created.
 */
export async function completeSpeakingVoice(
  orgId: OrgId,
  input: { voiceId: string; seatId: string; assetIds: string[]; externalVoiceId?: string; error?: string }
) {
  return prisma.$transaction(async (tx) => {
    const ready = Boolean(input.externalVoiceId) && !input.error;
    const updated = await tx.speakingVoice.updateMany({
      where: { id: input.voiceId, orgId, status: "pending", sampleAssetIds: { equals: input.assetIds } },
      data: ready
        ? { status: "ready", externalVoiceId: input.externalVoiceId, lastError: null }
        : { status: "failed", externalVoiceId: null, lastError: input.error ?? "clone_failed" },
    });
    if (!updated.count) return { applied: false as const };
    await writeAudit(tx, {
      orgId,
      seatId: input.seatId,
      action: ready ? "voice.clone_created" : "voice.clone_failed",
      entityType: "speaking_voice",
      entityId: input.voiceId,
      detail: ready ? { recordings: input.assetIds.length } : { error: input.error ?? "clone_failed" },
    });
    return { applied: true as const };
  });
}

/**
 * Revoke the cloned voice: unusable at once, recordings deleted, audit row.
 * The vendor id is kept until settleVendorVoiceDeletion confirms the vendor
 * deleted it, so a failed vendor call is retried by revoking again. Null when
 * the account never had a speaking voice.
 */
export async function revokeSpeakingVoice(orgId: OrgId, igAccountId: string, seatId: string) {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const accountId = await lockAccount(tx, orgId, igAccountId);
    const voice = await tx.speakingVoice.findFirst({ where: { orgId, igAccountId: accountId } });
    if (!voice) return null;
    if (voice.sampleAssetIds.length) {
      await tx.audioAsset.deleteMany({ where: { orgId, id: { in: voice.sampleAssetIds } } });
    }
    if (voice.status !== "revoked") {
      await tx.speakingVoice.update({
        where: { id: voice.id },
        data: { status: "revoked", revokedAt: new Date(), sampleAssetIds: [], lastError: null },
      });
      await writeAudit(tx, { orgId, seatId, action: "voice.clone_revoked", entityType: "speaking_voice", entityId: voice.id });
    }
    return { voiceId: voice.id, provider: voice.provider, externalVoiceId: voice.externalVoiceId };
  });
}

/** After the vendor call on a revoked voice: forget the vendor id once deleted, else flag it for a retry. */
export async function settleVendorVoiceDeletion(orgId: OrgId, voiceId: string, externalVoiceId: string, deleted: boolean) {
  await prisma.speakingVoice.updateMany({
    where: { id: voiceId, orgId, status: "revoked", externalVoiceId },
    data: deleted ? { externalVoiceId: null, lastError: null } : { lastError: "provider_delete_pending" },
  });
}

/** Accounts whose voice still needs revoking or vendor deletion (account deletion sweep). */
export async function listSpeakingVoicesToRevoke(orgId: OrgId) {
  return prisma.speakingVoice.findMany({
    where: { orgId, OR: [{ status: { not: "revoked" } }, { externalVoiceId: { not: null } }] },
    select: { igAccountId: true },
  });
}

/** The AI-voice disclosure (on by default) sent after each voice note. */
export async function setSpeakingVoiceDisclosure(orgId: OrgId, igAccountId: string, seatId: string, enabled: boolean) {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const voice = await tx.speakingVoice.findFirst({ where: { orgId, igAccountId }, select: { id: true } });
    if (!voice) throw new DomainError("speaking_voice_not_found", 404);
    await tx.speakingVoice.update({ where: { id: voice.id }, data: { disclosureEnabled: enabled } });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: enabled ? "voice.disclosure_enabled" : "voice.disclosure_disabled",
      entityType: "speaking_voice",
      entityId: voice.id,
    });
  });
}
