import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DRAFT_CHIPS, type ClassificationLabel, type DraftChip, type DraftDto } from "@dealdock/core";
import { chipEvidence, createPipeline, draftScope, generationContextOf, planRuleUpdates, retrieveVoiceContext } from "@dealdock/ai";
import {
  applyVoiceLearning,
  chooseDraftAlternative,
  createDraft,
  getCreatorContext,
  getDraftThreadContext,
  getDraftVoiceContext,
  isIgnoredHandle,
  recordDraftFeedback,
  resolveDraftContext,
  type DraftThreadContext,
  type OrgId,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { toDraftDto } from "../dto/draft";
import { requirePermission, requireWritable } from "../guards";

const DraftBody = z.object({
  chips: z.array(z.enum(DRAFT_CHIPS)).max(4).optional(),
  instruction: z.string().trim().max(200).optional(),
  variants: z.number().int().min(1).max(3).optional(),
});
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

    // The remaining reads are independent; retrieval reuses the consent the
    // creator context already loaded instead of reading the profile again.
    const now = new Date();
    const creatorLoad = getCreatorContext(auth.orgId, thread.igAccountId);
    const [creator, ignored, pools] = await Promise.all([
      creatorLoad,
      isIgnoredHandle(auth.orgId, thread.igAccountId, thread.participantHandle),
      creatorLoad.then((loaded) => getDraftVoiceContext(auth.orgId, thread.igAccountId, now, loaded)),
    ]);
    if (!creator.voiceEnabled) return reply.code(409).send({ error: "voice_modeling_disabled" });
    if (ignored) return reply.code(409).send({ error: "handle_ignored" });
    if (thread.liveDraft?.status === "sending") return reply.code(409).send({ error: "draft_send_in_flight" });

    const { chips = [], instruction, variants = 1 } = parsed.data;
    if (thread.liveDraft && (chips.length > 0 || instruction)) {
      const feedback = await recordDraftFeedback(auth.orgId, { draftId: thread.liveDraft.id, seatId: auth.seatId, chips, note: instruction });
      await learnFromChips(auth.orgId, feedback, chips);
    }

    const label = draftLabel(thread);
    const kind = thread.liveDraft?.kind === "nudge" ? "nudge" : "reply";
    const query = { inboundText: thread.latestInbound?.text ?? "", scope: draftScope({ kind, label }), now, excludeThreadId: thread.id };
    const result = await createPipeline().draft({
      kind,
      classificationLabel: label,
      threadHistory: thread.messages.map((m) => ({ direction: m.direction, text: m.text, contentType: m.contentType, transcript: m.transcript })),
      creator,
      ...retrieveVoiceContext(query, pools),
      chips,
      instruction,
      variants,
    });

    const draft = await createDraft(auth.orgId, {
      threadId: thread.id,
      replyToMessageId: kind === "reply" ? thread.latestInbound?.id : undefined,
      kind,
      body: result.body,
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
      label,
      instruction: instruction || null,
      chips,
      alternatives: result.alternatives ?? [],
      generationContext: generationContextOf(result),
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
