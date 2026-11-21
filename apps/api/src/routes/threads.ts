import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  closeDeal,
  dismissNudge,
  getConnectedAccount,
  getDraftForSend,
  findSendIntentForRetry,
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
import { DEAL_TYPES, computeReplyWindow, needsHumanAgentTag, withSpokenDisclosure, type SendResponse } from "@dealdock/core";
import { summarizeLearnedSignals } from "@dealdock/ai";
import { attachVoiceNoteToMessage, getInvoice, getReadySpeakingVoice } from "@dealdock/db";
import { createSpeechProvider } from "@dealdock/speech";
import { requireAuth } from "../auth";
import { requirePermission, requireWritable } from "../guards";
import { getGraphAdapter } from "../graph";
import { getGmailProvider, gmailAccount } from "../gmail";
import { isHumanAgentEnabled } from "../feature-flags";
import { synthesizeVoiceClip } from "../voice-clip";
import { invoiceFileName, renderInvoicePdf } from "../invoice-pdf";
import { publicInvoiceUrl, signInvoicePath } from "../media-sign";

/** One adapter instance per provider — the graph and Gmail providers keep rate buckets. */
const mockAdapter = new MockInstagramAdapter();

function providerFor(kind: string): MessagingProvider {
  if (kind === "mock") return mockAdapter;
  if (kind === "instagram_graph") return getGraphAdapter();
  if (kind === "gmail") return getGmailProvider();
  throw new Error(`unknown provider ${kind}`);
}

/** A voice note stays about a minute long at most (F9). */
const MAX_VOICE_TEXT = 1000;
/** Meta fetches the clip when the note is sent; an hour leaves room for its retries. */
const VOICE_URL_TTL_SECONDS = 60 * 60;
/** Meta fetches an invoice PDF when it is sent; an hour leaves room for its retries. */
const INVOICE_URL_TTL_SECONDS = 60 * 60;
/** Generated clips are short-lived copies; the thread keeps the approved words. */
const VOICE_CLIP_TTL_MS = 24 * 60 * 60_000;
/** Labels synthetic audio after each voice note unless the creator turned it off (research 03 §5). */

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
   *     with Meta's HUMAN_AGENT tag when this app holds that permission);
   *     email has no window and sends a threaded Gmail reply, text only.
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

    const approval = { threadId: id, draftId, seatId: auth.seatId, finalText, idempotencyKey, asVoice };
    const retryResponse = (intent: { status: string; intentId: string }) => ({
      status: intent.status,
      intentId: intent.intentId,
      hint: "This approved send is already being processed or was previously recorded.",
    });
    const previous = await findSendIntentForRetry(auth.orgId, approval);
    if (previous) return reply.code(202).send(retryResponse(previous));

    const draft = await getDraftForSend(auth.orgId, draftId);
    if (!draft || draft.thread.id !== id) {
      // A concurrent request may have claimed the draft since the first lookup.
      const concurrent = await findSendIntentForRetry(auth.orgId, approval);
      if (concurrent) return reply.code(202).send(retryResponse(concurrent));
      return reply.code(404).send({ error: "draft_not_found_or_already_sent" });
    }
    if (draft.thread.igAccount.status !== "active") {
      return reply.code(409).send({ error: "account_not_active" });
    }
    const email = draft.thread.igAccount.provider === "gmail";
    if (email && asVoice) {
      return reply.code(409).send({ error: "voice_not_supported", hint: "Email replies are sent as text." });
    }
    // An invoice cover note sends the invoice PDF too, so the invoice must still be owed.
    const invoice = draft.invoiceId ? await getInvoice(auth.orgId, draft.invoiceId) : null;
    if (draft.invoiceId && invoice?.status !== "issued") {
      return reply.code(409).send({ error: "invoice_not_open", hint: "This invoice was paid or withdrawn. Draft a new note to send." });
    }
    if (invoice && asVoice) {
      return reply.code(409).send({ error: "voice_not_supported", hint: "An invoice goes as text with its PDF." });
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

    // Gmail's hour-long access token is refreshed here, before anything is claimed.
    const connected = email
      ? await gmailAccount(auth.orgId, draft.thread.igAccount.id)
      : await getConnectedAccount(auth.orgId, draft.thread.igAccount.id);
    if (!connected) {
      return reply.code(409).send({ error: "account_not_active", ...(email ? { hint: "Reconnect this Gmail inbox in Settings → Email." } : {}) });
    }

    // Synthesize before the durable approval: a vendor failure leaves nothing
    // claimed, so the human simply tries again. The link is signed here too,
    // so no configuration error can strand a claimed intent.
    let audio: { assetId: string; url: string } | null = null;
    if (speech && voice) {
      const clip = await synthesizeVoiceClip(auth.orgId, speech, {
        externalVoiceId: voice.externalVoiceId,
        // The disclosure is part of the audio itself, so it can't be lost on its own.
        text: voice.disclosureEnabled ? withSpokenDisclosure(finalText) : finalText,
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

    // The PDF is rendered (email) or its link signed (DM) before the approval
    // is claimed, so a failure here (e.g. Meta needs PUBLIC_API_URL on https
    // to fetch it, 409 public_media_url_unconfigured) leaves nothing claimed.
    const attachment = invoice && email
      ? { filename: invoiceFileName(invoice), contentType: "application/pdf", bytes: await renderInvoicePdf(invoice) }
      : null;
    const fileUrl = invoice && !email
      ? (graph ? publicInvoiceUrl : signInvoicePath)(invoice.id, invoiceFileName(invoice), INVOICE_URL_TTL_SECONDS)
      : null;

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
      return reply.code(202).send(retryResponse(intent));
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
        : await provider.sendMessage(account, target, finalText, { humanAgentTag, ...(attachment ? { attachments: [attachment] } : {}) });
    } catch (err) {
      // A provider error can be a response lost after a successful send. Do
      // not release/retry it automatically: retain an ambiguous durable intent.
      await markSendIntentUnknown(auth.orgId, intent.intentId, err instanceof Error ? err.message : "unknown_provider_error");
      if (err instanceof Error && err.name === "SendWindowClosedError") {
        return reply.code(202).send({ error: "send_result_ambiguous", status: "unknown", intentId: intent.intentId });
      }
      if (err instanceof TokenExpiredError) {
        await markTokenExpired(auth.orgId, draft.thread.igAccount.id);
        return reply.code(202).send({ error: "send_result_ambiguous", status: "unknown", intentId: intent.intentId, hint: `${email ? "Gmail" : "Instagram"} needs reconnecting; DealDock will not retry this send automatically.` });
      }
      if (err instanceof RateBudgetExceededError) {
        return reply.code(202).send({ error: "send_result_ambiguous", status: "unknown", intentId: intent.intentId });
      }
      return reply.code(202).send({ error: "send_result_ambiguous", status: "unknown", intentId: intent.intentId });
    }

    await markSendIntentRemoteAccepted(auth.orgId, intent.intentId, receipt.platformMessageId, receipt.sentAt);
    const result = await persistSendIntent(auth.orgId, {
      intentId: intent.intentId,
      platformMessageId: receipt.platformMessageId,
      sentAt: receipt.sentAt,
    });

    if (audio) {
      // The note is sent; showing it as audio in the thread is best effort.
      await attachVoiceNoteToMessage(auth.orgId, result.messageId, audio.assetId)
        .catch(() => req.log.warn("sent voice note not linked to its message"));
    }

    // Instagram takes the PDF as its own message after the text. If it refuses, the text still stands.
    const attachmentSent = attachment
      ? true
      : fileUrl
        ? await provider.sendFile(account, target, fileUrl, { humanAgentTag }).then(
            () => true,
            (err: unknown) => {
              req.log.warn({ code: err instanceof Error ? err.name : "unknown" }, "invoice pdf not attached");
              return false;
            },
          )
        : undefined;

    return {
      status: "accepted",
      sent: true,
      intentId: intent.intentId,
      messageId: result.messageId,
      // Measured once, when the send was persisted.
      editDistance: result.editDistance,
      learned: summarizeLearnedSignals(draft.body, finalText),
      ...(attachmentSent === undefined ? {} : { attachmentSent }),
      ...(attachmentSent === false && invoice
        ? { hint: `Instagram didn't take the PDF. Download ${invoiceFileName(invoice)} and share it in the chat.` }
        : {}),
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
