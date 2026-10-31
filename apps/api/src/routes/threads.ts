import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  closeDeal,
  dismissNudge,
  getConnectedAccount,
  getDraftForSend,
  markTokenExpired,
  createSendIntentClaim,
  markSendIntentRemoteAccepted,
  markSendIntentUnknown,
  persistSendIntent,
  setThreadState,
} from "@dealdock/db";
import {
  MockInstagramAdapter,
  RateBudgetExceededError,
  TokenExpiredError,
  type MessagingProvider,
} from "@dealdock/messaging";
import { DEAL_TYPES, computeReplyWindow, needsHumanAgentTag, type SendResponse } from "@dealdock/core";
import { summarizeLearnedSignals } from "@dealdock/ai";
import { attachVoiceNoteToMessage, getReadySpeakingVoice, recordVoiceNoteDisclosure } from "@dealdock/db";
import { createSpeechProvider } from "@dealdock/speech";
import type { SendReceipt } from "@dealdock/messaging";
import { requireAuth } from "../auth";
import { requirePermission, requireWritable } from "../guards";
import { getGraphAdapter } from "../graph";
import { isHumanAgentEnabled } from "../feature-flags";
import { synthesizeVoiceClip } from "../voice-clip";

/** One adapter instance per provider — the graph adapter keeps rate buckets. */
const mockAdapter = new MockInstagramAdapter();

function providerFor(kind: string): MessagingProvider {
  if (kind === "mock") return mockAdapter;
  if (kind === "instagram_graph") return getGraphAdapter();
  throw new Error(`unknown provider ${kind}`);
}

/** A voice note stays about a minute long at most (F9). */
const MAX_VOICE_TEXT = 1000;
/** Meta fetches the clip when the note is sent; an hour leaves room for its retries. */
const VOICE_URL_TTL_SECONDS = 60 * 60;
/** Generated clips are short-lived copies; the thread keeps the approved words. */
const VOICE_CLIP_TTL_MS = 24 * 60 * 60_000;
/** Labels synthetic audio after each voice note unless the creator turned it off (research 03 §5). */
const VOICE_NOTE_DISCLOSURE = "🎙️ AI voice note in my voice";

const SendBody = z.object({
  draftId: z.string(),
  finalText: z.string().min(1).max(4000),
  /** Kept in the body for native/PWA clients that cannot set a header. */
  idempotencyKey: z.string().min(16).max(200).optional(),
  /** Send the approved text as a voice note in the creator's cloned voice (F9). */
  asVoice: z.boolean().optional(),
});

const CloseBody = z.object({
  amountMinor: z.number().int().positive().safe(),
  dealType: z.enum(DEAL_TYPES),
  note: z.string().max(500).optional(),
});

function requestIdempotencyKey(req: { headers: Record<string, string | string[] | undefined> }, bodyKey?: string) {
  const raw = req.headers["idempotency-key"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const value = header ?? bodyKey;
  return value && /^[A-Za-z0-9._:-]{16,200}$/.test(value) ? value : null;
}

const StateBody = z.object({
  state: z.enum(["open", "waiting", "closed"]),
});

export async function threadRoutes(app: FastifyInstance) {
  // GET /threads/:id lives in ./thread-detail (the ThreadDetail DTO).
  // POST /threads/:id/draft (+ /draft/choose, /drafts/:id/feedback) live in ./drafting.

  /**
   * THE SEND GATE (ARCHITECTURE.md §6.2). Requires ALL of:
   *  1. an authenticated seat (requireAuth),
   *  2. a live draft whose final text the human echoes back,
   *  3. an active account within the platform reply window (24h, or 7 days
   *     with Meta's HUMAN_AGENT tag when this app holds that permission).
   * Edit distance is computed server-side; the audit row is written in the
   * same transaction as the outbound message. Never auto-send — structurally.
   * asVoice sends the same approved text as a voice note in the creator's
   * cloned voice (F9); the clip is made before the approval is claimed.
   */
  app.post("/threads/:id/send", { preHandler: [requireAuth, requireWritable, requirePermission("send")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = req.auth!;

    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    }
    const { draftId, finalText } = parsed.data;
    // Checked here, before any voice note is synthesized; the claim refuses blank text too.
    if (!finalText.trim()) return reply.code(400).send({ error: "send_text_required" });
    const asVoice = parsed.data.asVoice === true;
    const idempotencyKey = requestIdempotencyKey(req, parsed.data.idempotencyKey);
    if (!idempotencyKey) {
      return reply.code(400).send({
        error: "idempotency_key_required",
        hint: "Provide a stable Idempotency-Key for this explicit human-approved send.",
      });
    }
    if (asVoice && finalText.length > MAX_VOICE_TEXT) {
      return reply.code(400).send({
        error: "voice_text_too_long",
        hint: `A voice note can say up to ${MAX_VOICE_TEXT} characters. Shorten the reply or send it as text.`,
      });
    }

    const draft = await getDraftForSend(auth.orgId, draftId);
    if (!draft || draft.thread.id !== id) {
      return reply.code(404).send({ error: "draft_not_found_or_already_sent" });
    }
    if (draft.thread.igAccount.status !== "active") {
      return reply.code(409).send({ error: "account_not_active" });
    }

    // Reply-window pre-check for the real platform — reject before spending a
    // Graph call; the adapter maps Meta's own rejection as the backstop.
    const graph = draft.thread.igAccount.provider === "instagram_graph";
    const replyWindow = computeReplyWindow(draft.thread.lastInboundAt, new Date(), isHumanAgentEnabled());
    if (graph && replyWindow.status !== "open" && replyWindow.status !== "extended") {
      return reply.code(409).send({
        error: "send_window_closed",
        hint: "This thread's reply window has closed — reply from Instagram directly.",
      });
    }
    const humanAgentTag = graph && needsHumanAgentTag(replyWindow);

    // Voice-note preconditions, all before anything is synthesized or claimed.
    const speech = asVoice ? createSpeechProvider() : null;
    let voice: Awaited<ReturnType<typeof getReadySpeakingVoice>> = null;
    if (asVoice) {
      if (!speech) return reply.code(409).send({ error: "speech_unavailable" });
      voice = await getReadySpeakingVoice(auth.orgId, draft.thread.igAccount.id, speech.kind);
      if (!voice) return reply.code(409).send({ error: "speaking_voice_not_ready" });
      // Meta fetches the clip itself, so the API must publish it on a public https origin.
      if (graph && !/^https:\/\//.test(process.env.PUBLIC_API_URL ?? "")) {
        return reply.code(409).send({ error: "public_media_url_unconfigured" });
      }
    }

    const connected = await getConnectedAccount(auth.orgId, draft.thread.igAccount.id);
    if (!connected) return reply.code(409).send({ error: "account_not_active" });

    // Synthesize before the durable approval: a vendor failure leaves nothing
    // claimed, so the human simply tries again. The link is signed here too,
    // so no configuration error can strand a claimed intent.
    let audio: { assetId: string; url: string } | null = null;
    if (speech && voice) {
      const clip = await synthesizeVoiceClip(auth.orgId, speech, {
        externalVoiceId: voice.externalVoiceId,
        text: finalText,
        keepMs: VOICE_CLIP_TTL_MS,
        linkTtlSeconds: VOICE_URL_TTL_SECONDS,
        // Mock accounts never fetch the clip, so they need no public origin.
        publicLink: graph,
      });
      if ("failed" in clip) {
        req.log.warn({ code: clip.failed }, "voice note synthesis failed");
        return reply.code(502).send({
          error: "speech_synthesis_failed",
          hint: "Couldn't make the voice note. Nothing was sent — try again or send it as text.",
        });
      }
      audio = { assetId: clip.assetId, url: clip.url };
    }

    // A durable intent is created *before* Graph I/O. If the TCP response is
    // lost, its result remains unknown and this endpoint will never resend on
    // the caller's behalf. The reconciliation workflow can later match a
    // webhook echo or require a human decision.
    const intent = await createSendIntentClaim(auth.orgId, {
      draftId,
      seatId: auth.seatId,
      finalText,
      idempotencyKey,
      asVoice: audio !== null,
      audioAssetId: audio?.assetId ?? null,
    });
    if (!intent.claimed) {
      return reply.code(202).send({
        status: intent.status,
        intentId: intent.intentId,
        hint: "This approved send is already being processed or was previously recorded.",
      });
    }

    const provider = providerFor(draft.thread.igAccount.provider);
    const account = {
      accountId: connected.accountId,
      platformUserId: connected.platformUserId,
      handle: connected.handle,
      accessToken: connected.accessToken,
    };
    const target = {
      platformThreadId: draft.thread.igThreadId,
      recipientPlatformId: draft.thread.participantIgId,
    };
    let receipt;
    try {
      receipt = audio
        ? await provider.sendAudio(account, target, audio.url, { humanAgentTag })
        : await provider.sendMessage(account, target, finalText, { humanAgentTag });
    } catch (err) {
      // A provider error can be a response lost after a successful send. Do
      // not release/retry it automatically: retain an ambiguous durable intent.
      await markSendIntentUnknown(auth.orgId, intent.intentId, (err as Error).message);
      if ((err as Error).name === "SendWindowClosedError") {
        return reply.code(202).send({ error: "send_result_ambiguous", status: "unknown", intentId: intent.intentId });
      }
      if (err instanceof TokenExpiredError) {
        await markTokenExpired(auth.orgId, draft.thread.igAccount.id);
        return reply.code(202).send({ error: "send_result_ambiguous", status: "unknown", intentId: intent.intentId, hint: "Instagram needs reconnecting; DealDock will not retry this send automatically." });
      }
      if (err instanceof RateBudgetExceededError) {
        return reply.code(202).send({ error: "send_result_ambiguous", status: "unknown", intentId: intent.intentId });
      }
      throw err;
    }

    await markSendIntentRemoteAccepted(auth.orgId, intent.intentId, receipt.platformMessageId, receipt.sentAt);
    const result = await persistSendIntent(auth.orgId, {
      intentId: intent.intentId,
      platformMessageId: receipt.platformMessageId,
      sentAt: receipt.sentAt,
    });

    let hint: string | undefined;
    if (audio) {
      // The note is sent; showing it as audio in the thread is best effort.
      await attachVoiceNoteToMessage(auth.orgId, result.messageId, audio.assetId)
        .catch(() => req.log.warn("sent voice note not linked to its message"));
      if (voice?.disclosureEnabled) {
        // Same human approval: label the synthetic audio. Best effort — a
        // failure is reported, and the voice note itself is never resent.
        let disclosed: SendReceipt | undefined;
        try {
          disclosed = await provider.sendMessage(account, target, VOICE_NOTE_DISCLOSURE, { humanAgentTag });
        } catch (err) {
          if (err instanceof TokenExpiredError) await markTokenExpired(auth.orgId, draft.thread.igAccount.id);
          hint = "Voice note sent. The AI-voice label couldn't be sent — add it in Instagram if you want it.";
        }
        if (disclosed) {
          await recordVoiceNoteDisclosure(auth.orgId, {
            threadId: draft.thread.id,
            platformMessageId: disclosed.platformMessageId,
            text: VOICE_NOTE_DISCLOSURE,
            sentAt: disclosed.sentAt,
          }).catch(() => req.log.warn("voice note disclosure sent but not recorded"));
        }
      }
    }

    return {
      status: "accepted",
      sent: true,
      intentId: intent.intentId,
      messageId: result.messageId,
      // Measured once, when the send was persisted.
      editDistance: result.editDistance,
      learned: summarizeLearnedSignals(draft.body, finalText),
      ...(hint ? { hint } : {}),
    } satisfies SendResponse;
  });

  /** Mark closed for [amount] → LedgerEntry (PRD §5.4). */
  app.post("/threads/:id/close", { preHandler: [requireAuth, requireWritable, requirePermission("close")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CloseBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    }
    const idempotencyKey = requestIdempotencyKey(req);
    if (!idempotencyKey) return reply.code(400).send({ error: "idempotency_key_required" });
    const entry = await closeDeal(req.auth!.orgId, {
      threadId: id,
      seatId: req.auth!.seatId,
      idempotencyKey,
      ...parsed.data,
    });
    return { entryId: entry.id, amountMinor: entry.amountMinor };
  });

  /** Keep waiting, silence this nudge; clock resets (PRD §6.5). */
  app.post("/threads/:id/nudge/dismiss", { preHandler: [requireAuth, requireWritable, requirePermission("close")] }, async (req) => {
    const { id } = req.params as { id: string };
    await dismissNudge(req.auth!.orgId, id, req.auth!.seatId);
    return { dismissed: true };
  });

  /** open ↔ waiting ↔ closed; waiting starts the nudge clock (PRD §6.5). */
  app.patch("/threads/:id", { preHandler: [requireAuth, requireWritable, requirePermission("close")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const updated = await setThreadState(req.auth!.orgId, {
      threadId: id,
      seatId: req.auth!.seatId,
      state: parsed.data.state,
    });
    return { state: updated.state, waitingSince: updated.waitingSince };
  });
}
