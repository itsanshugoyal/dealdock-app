import { Worker, type Job } from "bullmq";
import { z } from "zod";
import { QUEUES } from "@dealdock/core";
import { commentReplyInput, createPipeline, type AiPipeline } from "@dealdock/ai";
import { asOrgId, createCommentLead, getCommentLeadOutboxPayload, getCreatorContext, saveCommentLeadDraft, type OrgId } from "@dealdock/db";
import { redisConnection } from "../connection";

/** The outbox payload the API's comments webhook wrote for one keyword comment. */
export const CommentLeadPayload = z.object({
  igAccountId: z.string().min(1).max(64),
  commentId: z.string().min(1).max(128),
  mediaId: z.string().min(1).max(128),
  commenterIgId: z.string().min(1).max(128),
  commenterHandle: z.string().min(1).max(128),
  text: z.string().min(1).max(2_200),
  keyword: z.string().min(1).max(60),
  commentedAt: z.string().datetime(),
});

/**
 * One keyword comment: its lead, created once (Meta redelivers), then the
 * private reply drafted in the creator's voice from their offers. Drafting
 * follows the DM rule: no voice consent, no draft (the lead still shows).
 * Drafts only; the API's send gate sends, after a person approves.
 */
export async function handleCommentLead(orgId: OrgId, payload: unknown, pipeline: AiPipeline) {
  const comment = CommentLeadPayload.parse(payload);
  const lead = await createCommentLead(orgId, { ...comment, commentedAt: new Date(comment.commentedAt) });
  if (!("id" in lead)) return lead;
  if (lead.status !== "new" || lead.draftBody) return { leadId: lead.id, drafted: false };
  const creator = await getCreatorContext(orgId, comment.igAccountId);
  if (!creator.voiceEnabled) return { leadId: lead.id, drafted: false };
  const draft = await pipeline.draft(commentReplyInput(creator, comment));
  const drafted = await saveCommentLeadDraft(orgId, lead.id, { body: draft.body, modelVersion: draft.modelVersion, missingFacts: draft.context?.missingFacts ?? [] });
  return { leadId: lead.id, drafted };
}

const JobRef = z.object({ orgId: z.string().min(1), ingressEventId: z.string().min(1) });

export function startCommentLeadWorker() {
  const pipeline = createPipeline();
  const worker = new Worker(
    QUEUES.commentLeads,
    async (job: Job) => {
      // Redis carries a reference; the comment is read from its tenant's outbox row.
      const ref = JobRef.parse(job.data);
      const orgId = asOrgId(ref.orgId);
      const payload = await getCommentLeadOutboxPayload(orgId, ref.ingressEventId);
      if (!payload) return { skipped: "ingress_deleted" };
      return handleCommentLead(orgId, payload, pipeline);
    },
    { connection: redisConnection(), concurrency: 3 },
  );
  // Comment text never enters logs.
  worker.on("failed", (job, err) => console.error(`comment lead job ${job?.id} failed: ${err.message}`));
  return worker;
}
