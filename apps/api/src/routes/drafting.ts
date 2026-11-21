import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DRAFT_CHIPS, isDealOpen, type ClassificationLabel, type DraftChip, type DraftDto, type DraftKind, type DraftPurpose } from "@dealdock/core";
import { chipEvidence, createPipeline, draftScope, generationContextOf, planRuleUpdates, retrieveVoiceContext } from "@dealdock/ai";
import {
  applyVoiceLearning,
  chooseDraftAlternative,
  createDraft,
  getCreatorContext,
  getDeal,
  getDealConversation,
  getDraftThreadContext,
  getDraftVoiceContext,
  getInvoice,
  isIgnoredHandle,
  recordDraftFeedback,
  resolveDraftContext,
  type DraftThreadContext,
  type OrgId,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { DRAFT_PURPOSES, toDraftDto } from "../dto/draft";
import { requirePermission, requireWritable } from "../guards";

const DraftBody = z
  .object({
    chips: z.array(z.enum(DRAFT_CHIPS)).max(4).optional(),
    instruction: z.string().trim().max(200).optional(),
    variants: z.number().int().min(1).max(3).optional(),
    purpose: z.enum(DRAFT_PURPOSES).optional(),
    dealId: z.string().min(1).max(64).optional(),
    invoiceId: z.string().min(1).max(64).optional(),
  })
  .refine((body) => !body.purpose || body.dealId !== undefined, { message: "dealId is required with purpose", path: ["dealId"] })
  .refine((body) => (body.purpose === "invoice") === (body.invoiceId !== undefined), { message: "invoiceId goes with purpose invoice", path: ["invoiceId"] });

/** A recap answers the conversation; a payment reminder or an invoice cover note follows up on it. */
const PURPOSE_KIND = { recap: "reply", payment_reminder: "nudge", invoice: "nudge", usage_renewal: "nudge", renewal: "nudge" } as const satisfies Record<DraftPurpose, DraftKind>;
const ChooseBody = z.object({ draftId: z.string().min(1), alternative: z.number().int().min(0).max(2) });
const FeedbackBody = z
  .object({ chips: z.array(z.enum(DRAFT_CHIPS)).max(DRAFT_CHIPS.length), note: z.string().trim().max(280).optional() })
  .refine((body) => body.chips.length > 0 || Boolean(body.note), "chips or a note is required");

/** Labels that give a reply a meaningful structure; anything else gets the neutral one. */
const STRUCTURED = new Set<ClassificationLabel>(["brand_deal", "coaching_lead", "course_inquiry", "other_commerce", "fan", "personal"]);

/**
 * The label a draft is written for: the thread's top label, else its latest
 * inbound message's (when that gives a reply a structure). Never a silent
 * brand_deal default.
 */
function draftLabel(thread: DraftThreadContext): ClassificationLabel | null {
  const inbound = thread.latestInbound?.label;
  return thread.topLabel ?? (inbound && STRUCTURED.has(inbound) ? inbound : null);
}

/** Style chips are rule evidence (source "feedback"); situational and fact chips are not. */
async function learnFromChips(orgId: OrgId, feedback: Awaited<ReturnType<typeof recordDraftFeedback>>, chips: DraftChip[]) {
  const evidence = chipEvidence(chips, {
    scope: draftScope({ kind: feedback.draft.kind, label: feedback.draft.label }),
    draftBody: feedback.draft.body,
    draftId: feedback.draft.id,
    threadId: feedback.draft.threadId,
    seatRole: feedback.seatRole,
  });
  if (evidence.length === 0) return;
  const now = new Date();
  await applyVoiceLearning(orgId, feedback.draft.igAccountId, { plan: (rules) => planRuleUpdates(rules, evidence, now) }, now);
}

export async function draftingRoutes(app: FastifyInstance) {
  const sendWrite = { preHandler: [requireAuth, requireWritable, requirePermission("send")] };

  /**
   * On-demand (re)generation — the <5s path (PRD §7.3). Chips/instruction
   * steer it (and count as feedback on the draft they replace); up to 3
   * versions on one row. Labelled by the thread's top label (else the latest
   * message's), never a silent brand_deal default.
   */
  app.post("/threads/:id/draft", sendWrite, async (req, reply) => {
    const parsed = DraftBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    const auth = req.auth!;
    const thread = await getDraftThreadContext(auth.orgId, id);
    if (!thread) return reply.code(404).send({ error: "not_found" });

    const { chips = [], instruction, variants = 1, purpose, dealId, invoiceId } = parsed.data;
    // The remaining reads are independent; retrieval reuses the consent the
    // creator context already loaded instead of reading the profile again.
    const now = new Date();
    const creatorLoad = getCreatorContext(auth.orgId, thread.igAccountId);
    const [creator, ignored, pools, deal, conversation, invoice] = await Promise.all([
      creatorLoad,
      isIgnoredHandle(auth.orgId, thread.igAccountId, thread.participantHandle),
      creatorLoad.then((loaded) => getDraftVoiceContext(auth.orgId, thread.igAccountId, now, loaded)),
      purpose && dealId ? getDeal(auth.orgId, dealId) : null,
      // Recaps and reminders name dates: they read when each message was sent, on the org's calendar.
      purpose ? getDealConversation(auth.orgId, thread.id) : null,
      invoiceId ? getInvoice(auth.orgId, invoiceId) : null,
    ]);
    // Recaps, reminders and cover notes go into the deal's conversation; a deal agreed elsewhere has none.
    if (deal?.threadId === null) return reply.code(409).send({ error: "deal_has_no_conversation" });
    if (purpose && deal?.threadId !== thread.id) return reply.code(404).send({ error: "not_found" });
    if (invoiceId && invoice?.dealId !== dealId) return reply.code(404).send({ error: "not_found" });
    // A cover note goes with an invoice still owed: never one that was paid or withdrawn.
    if (invoice && invoice.status !== "issued") return reply.code(409).send({ error: "invoice_not_open" });
    // A renewal pitches a brand that already paid; usage rights outlast the payment, so a usage note fits any deal not cancelled; every other job is for money still open.
    const fits = (open: NonNullable<typeof deal>) => (purpose === "renewal" ? open.stage === "paid" : purpose === "usage_renewal" ? open.stage !== "cancelled" : isDealOpen(open));
    if (deal && !fits(deal)) return reply.code(409).send({ error: purpose === "renewal" ? "deal_not_paid" : "deal_not_open" });
    if (!creator.voiceEnabled) return reply.code(409).send({ error: "voice_modeling_disabled" });
    if (ignored) return reply.code(409).send({ error: "handle_ignored" });
    if (thread.liveDraft?.status === "sending") return reply.code(409).send({ error: "draft_send_in_flight" });

    if (thread.liveDraft && (chips.length > 0 || instruction)) {
      const feedback = await recordDraftFeedback(auth.orgId, { draftId: thread.liveDraft.id, seatId: auth.seatId, chips, note: instruction });
      await learnFromChips(auth.orgId, feedback, chips);
    }

    const label = draftLabel(thread);
    const kind = purpose ? PURPOSE_KIND[purpose] : thread.liveDraft?.kind === "nudge" ? "nudge" : "reply";
    const query = { inboundText: thread.latestInbound?.text ?? "", scope: draftScope({ kind, label }), now, excludeThreadId: thread.id };
    const result = await createPipeline().draft({
      kind,
      classificationLabel: label,
      threadHistory:
        conversation?.threadHistory ??
        thread.messages.map((m) => ({ direction: m.direction, text: m.text, contentType: m.contentType, transcript: m.transcript, sentAt: m.sentAt.toISOString() })),
      channel: thread.channel,
      subject: thread.subject,
      creator,
      ...retrieveVoiceContext(query, pools),
      chips,
      instruction,
      variants,
      purpose,
      deal: deal ?? undefined,
      invoice: invoice ?? undefined,
      now,
      timezone: conversation?.timezone ?? thread.timezone,
      // A brand reply must not accept work that breaks an exclusivity this creator agreed elsewhere.
      exclusivities: thread.exclusivities,
    });

    const draft = await createDraft(auth.orgId, {
      threadId: thread.id,
      replyToMessageId: kind === "reply" ? thread.latestInbound?.id : undefined,
      kind,
      body: result.body,
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
      expectedVoiceVersion: creator.voiceVersion,
      label,
      instruction: instruction || null,
      chips,
      alternatives: result.alternatives ?? [],
      // DraftDto.purpose is read back from here, so a reloaded draft keeps its job.
      // The job and its deal are read back from here (DraftDto.purpose, dealId), and a sent renewal marks its deal.
      generationContext: purpose ? { ...generationContextOf(result), purpose, dealId } : generationContextOf(result),
      invoiceId: invoice?.id ?? null,
    });
    // Same mapping as GET /threads/:id, so a new draft and a reloaded one are identical.
    return toDraftDto(draft, await resolveDraftContext(auth.orgId, draft.generationContext)) satisfies DraftDto;
  });

  /** "Take 2": the chosen version becomes the body the creator edits and sends. */
  app.post("/threads/:id/draft/choose", sendWrite, async (req, reply) => {
    const parsed = ChooseBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const auth = req.auth!;
    const draft = await chooseDraftAlternative(auth.orgId, { threadId: id, draftId: parsed.data.draftId, alternative: parsed.data.alternative });
    return toDraftDto(draft, await resolveDraftContext(auth.orgId, draft.generationContext)) satisfies DraftDto;
  });

  /** Chips/note without regenerating ("thumbs down"); style chips teach the voice. */
  app.post("/drafts/:id/feedback", sendWrite, async (req, reply) => {
    const parsed = FeedbackBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const auth = req.auth!;
    const feedback = await recordDraftFeedback(auth.orgId, { draftId: id, seatId: auth.seatId, chips: parsed.data.chips, note: parsed.data.note });
    await learnFromChips(auth.orgId, feedback, parsed.data.chips);
    return { ok: true as const };
  });
}
