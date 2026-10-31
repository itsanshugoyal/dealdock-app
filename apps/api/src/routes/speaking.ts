import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { VOICE_CLIP_LIMITS, acknowledgesVoiceConsent, type AudioPreviewResponse, type SpeakingVoiceDto } from "@dealdock/core";
import {
  completeSpeakingVoice,
  getReadySpeakingVoice,
  getSpeakingVoiceSummary,
  revokeSpeakingVoice,
  setSpeakingVoiceDisclosure,
  settleVendorVoiceDeletion,
  startSpeakingVoice,
  type OrgId,
} from "@dealdock/db";
import {
  SpeechProviderError,
  createSpeechProvider,
  validateVoiceClip,
  type SpeechProvider,
} from "@dealdock/speech";
import { requireAuth } from "../auth";
import { AccountRef, IgAccountId, requireIgAccount, requirePermission, requireWritable } from "../guards";
import { synthesizeVoiceClip } from "../voice-clip";

/**
 * Speaking voice (F9): the creator's cloned voice for voice-note replies.
 * Consent is its own record — the creator reads a consent statement aloud
 * as take 1 — and only the creator's own seat may create, change or revoke
 * it (manage_voice). Sending a voice note stays behind the human send gate
 * (threads.ts). Audio and text never enter logs; vendor failures log their
 * code only.
 */

/** Three base64 WAV takes (~90 s) fit comfortably; nothing larger is accepted. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const TAKE_BOUNDS = { minMs: VOICE_CLIP_LIMITS.takeMinMs, maxMs: VOICE_CLIP_LIMITS.takeMaxMs };
const PREVIEW_TTL_SECONDS = 60 * 60;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const WAV_MIME = /^audio\/(?:wav|wave|x-wav|vnd\.wave)$/i;

const Clip = z.object({
  base64: z.string().min(1).max(MAX_BODY_BYTES),
  mimeType: z.string().max(100),
  durationMs: z.number().int().nonnegative().max(10 * 60_000),
});

const CreateBody = z.object({
  igAccountId: IgAccountId.optional(),
  consentStatement: z.string().trim().min(20).max(1000),
  consentClip: Clip,
  /** Takes 2 and 3 (English and Hinglish reads); take 1 is the consent clip. */
  samples: z.array(Clip).length(2),
});

const SettingsBody = z.object({
  igAccountId: IgAccountId.optional(),
  disclosureEnabled: z.boolean(),
});

const PreviewBody = z.object({
  igAccountId: IgAccountId.optional(),
  text: z.string().trim().min(1).max(VOICE_CLIP_LIMITS.previewMaxChars),
});

/** Strict base64 (no data: URL, no whitespace) so a malformed upload fails loudly. */
function decodeBase64(value: string): Buffer | null {
  return value.length % 4 === 0 && BASE64.test(value) ? Buffer.from(value, "base64") : null;
}

const CLONE_ERRORS = {
  auth: "provider_auth_failed",
  quota: "provider_quota_exceeded",
  validation: "provider_rejected_samples",
  transient: "provider_unavailable",
} as const;

/** Best-effort vendor deletion; true when the vendor no longer holds the voice. */
async function deleteVendorVoice(provider: SpeechProvider | null, externalVoiceId: string, log: FastifyBaseLogger) {
  if (!provider) {
    log.warn("speaking voice vendor not configured; vendor copy not deleted");
    return false;
  }
  try {
    await provider.deleteVoice(externalVoiceId);
    return true;
  } catch (error) {
    log.warn({ code: error instanceof SpeechProviderError ? error.code : "delete_error" }, "speaking voice vendor deletion failed");
    return false;
  }
}

/**
 * Revoke an account's cloned voice: unusable at once and recordings deleted,
 * then the vendor copy deleted. False when the vendor copy still awaits
 * deletion — the row keeps the vendor id, so revoking again retries.
 */
export async function revokeSpeakingVoiceFully(orgId: OrgId, igAccountId: string, seatId: string, log: FastifyBaseLogger) {
  const revoked = await revokeSpeakingVoice(orgId, igAccountId, seatId);
  if (!revoked?.externalVoiceId) return true;
  const deleted = await deleteVendorVoice(createSpeechProvider({ kind: revoked.provider }), revoked.externalVoiceId, log);
  await settleVendorVoiceDeletion(orgId, revoked.voiceId, revoked.externalVoiceId, deleted);
  return deleted;
}

export async function speakingRoutes(app: FastifyInstance) {
  // Team seats may not record, change or revoke a creator's voice (research 03 §5): manage_voice is creator-only.
  const creatorWrite = { preHandler: [requireAuth, requireWritable, requirePermission("manage_voice")] };

  /** Create (or re-record) the voice from in-app takes: take 1 is the spoken consent. */
  app.post("/voice/speaking", { ...creatorWrite, bodyLimit: MAX_BODY_BYTES }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = CreateBody.safeParse(req.body);
    // Never echo validation detail: it would carry recorded audio.
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const body = parsed.data;
    if (!acknowledgesVoiceConsent(body.consentStatement)) {
      return reply.code(400).send({
        error: "consent_statement_invalid",
        hint: "Read the consent statement exactly: it must say you are over 18 and consent to an AI copy of your voice.",
      });
    }
    const provider = createSpeechProvider();
    if (!provider) return reply.code(409).send({ error: "speech_unavailable" });
    const account = await requireIgAccount(auth.orgId, body.igAccountId, reply);
    if (!account) return reply;
    const igAccountId = account.id;

    const takes: Array<{ bytes: Buffer; mimeType: string; durationMs: number }> = [];
    for (const [index, clip] of [body.consentClip, ...body.samples].entries()) {
      const bytes = WAV_MIME.test(clip.mimeType.split(";")[0]!.trim()) ? decodeBase64(clip.base64) : null;
      const check = bytes ? validateVoiceClip(bytes, TAKE_BOUNDS) : ({ ok: false, problem: "not_wav" } as const);
      if (!check.ok) return reply.code(400).send({ error: "invalid_voice_clip", take: index + 1, problem: check.problem });
      takes.push({ bytes: bytes!, mimeType: "audio/wav", durationMs: check.info.durationMs });
    }
    const totalMs = takes.reduce((sum, take) => sum + take.durationMs, 0);
    if (totalMs < VOICE_CLIP_LIMITS.totalMinMs || totalMs > VOICE_CLIP_LIMITS.totalMaxMs) {
      return reply.code(400).send({ error: "invalid_voice_clip", problem: totalMs < VOICE_CLIP_LIMITS.totalMinMs ? "total_too_short" : "total_too_long" });
    }

    const started = await startSpeakingVoice(auth.orgId, {
      igAccountId,
      seatId: auth.seatId,
      provider: provider.kind,
      consentStatement: body.consentStatement,
      consentTake: takes[0]!,
      sampleTakes: takes.slice(1),
    });

    let externalVoiceId: string | undefined;
    let error: string | undefined;
    try {
      const clone = await provider.cloneVoice({
        name: `dealdock-${started.voiceId}-${Date.now().toString(36)}`,
        description: "DealDock creator voice, recorded in-app with spoken consent",
        clips: takes.map((take, i) => ({ ...take, filename: i === 0 ? "consent.wav" : `sample-${i}.wav` })),
      });
      if (clone.requiresVerification) {
        // No verification flow exists here; an unusable vendor voice must not linger.
        error = "provider_requires_verification";
        await deleteVendorVoice(provider, clone.externalVoiceId, req.log);
      } else {
        externalVoiceId = clone.externalVoiceId;
      }
    } catch (failure) {
      error = failure instanceof SpeechProviderError ? CLONE_ERRORS[failure.kind] : "provider_unavailable";
      req.log.warn({ code: failure instanceof SpeechProviderError ? failure.code : "clone_error" }, "speaking voice clone failed");
    }

    const completed = await completeSpeakingVoice(auth.orgId, {
      voiceId: started.voiceId,
      seatId: auth.seatId,
      assetIds: started.assetIds,
      externalVoiceId,
      error,
    });
    // A newer recording or a revocation won the race: this vendor voice must not linger.
    if (!completed.applied && externalVoiceId) await deleteVendorVoice(provider, externalVoiceId, req.log);
    // Re-recording replaced an earlier vendor voice.
    if (started.previous) {
      await deleteVendorVoice(createSpeechProvider({ kind: started.previous.provider }), started.previous.externalVoiceId, req.log);
    }
    return (await getSpeakingVoiceSummary(auth.orgId, igAccountId)) satisfies SpeakingVoiceDto;
  });

  /** Revoke: provider voice + recordings deleted; idempotent, and retries a pending vendor deletion. */
  app.delete("/voice/speaking", creatorWrite, async (req, reply) => {
    const auth = req.auth!;
    const parsed = AccountRef.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    const vendorDeleted = await revokeSpeakingVoiceFully(auth.orgId, account.id, auth.seatId, req.log);
    return vendorDeleted
      ? { revoked: true }
      : { revoked: true, hint: "Your voice is off and its recordings are deleted. Removing the copy at the speech provider failed; delete again to retry." };
  });

  /** AI-voice disclosure text after each voice note (on by default). */
  app.put("/voice/speaking/settings", creatorWrite, async (req, reply) => {
    const auth = req.auth!;
    const parsed = SettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    await setSpeakingVoiceDisclosure(auth.orgId, account.id, auth.seatId, parsed.data.disclosureEnabled);
    return (await getSpeakingVoiceSummary(auth.orgId, account.id)) satisfies SpeakingVoiceDto;
  });

  /**
   * "Listen in your voice": synthesize a short text for the creator or an
   * approver to hear before sending. The clip expires in an hour; nothing is sent.
   */
  app.post("/voice/speaking/preview", { preHandler: [requireAuth, requireWritable, requirePermission("send")] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = PreviewBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const provider = createSpeechProvider();
    if (!provider) return reply.code(409).send({ error: "speech_unavailable" });
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    const voice = await getReadySpeakingVoice(auth.orgId, account.id, provider.kind);
    if (!voice) return reply.code(409).send({ error: "speaking_voice_not_ready" });
    const clip = await synthesizeVoiceClip(auth.orgId, provider, {
      externalVoiceId: voice.externalVoiceId,
      text: parsed.data.text,
      keepMs: PREVIEW_TTL_SECONDS * 1000,
      linkTtlSeconds: PREVIEW_TTL_SECONDS,
      publicLink: false,
    });
    if ("failed" in clip) {
      req.log.warn({ code: clip.failed }, "voice preview failed");
      return reply.code(502).send({ error: "speech_synthesis_failed" });
    }
    return { url: clip.url, mimeType: clip.mimeType, expiresAt: clip.expiresAt.toISOString() } satisfies AudioPreviewResponse;
  });
}
