import { Worker, type Job } from "bullmq";
import { z } from "zod";
import { QUEUES } from "@dealdock/core";
import { createPipeline } from "@dealdock/ai";
import { asOrgId, createDraft, getCreatorContext, getThreadDetail } from "@dealdock/db";
import { redisConnection } from "../connection";

export const DraftingJob = z.object({
  orgId: z.string(),
  igAccountId: z.string(),
  threadId: z.string(),
  replyToMessageId: z.string().optional(),
  label: z.string(),
  kind: z.enum(["reply", "nudge"]).default("reply"),
});
export type DraftingJob = z.infer<typeof DraftingJob>;

/**
 * Drafting consumer: voice-matched reply pre-generation for high-intent
 * threads (ARCHITECTURE.md §5.1 stage 5). Drafts only — this process cannot
 * send (the send gate lives in apps/api).
 */
export function startDraftingWorker() {
  const pipeline = createPipeline();

  const worker = new Worker(
    QUEUES.drafting,
    async (job: Job) => {
      const data = DraftingJob.parse(job.data);
      const orgId = asOrgId(data.orgId);

      const [creator, thread] = await Promise.all([
        getCreatorContext(orgId, data.igAccountId),
        getThreadDetail(orgId, data.threadId),
      ]);
      if (!thread) return { skipped: "thread_gone" };
      if (!creator.voiceEnabled) return { skipped: "voice_disabled" };

      const result = await pipeline.draft({
        kind: data.kind,
        classificationLabel: data.label,
        threadHistory: thread.messages.map((m) => ({
          direction: m.direction as "inbound" | "outbound",
          text: m.text,
        })),
        creator,
      });

      const draft = await createDraft(orgId, {
        threadId: data.threadId,
        replyToMessageId: data.replyToMessageId,
        kind: data.kind,
        body: result.body,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
      });

      return { draftId: draft.id, version: draft.version };
    },
    { connection: redisConnection(), concurrency: 3 }
  );

  worker.on("failed", (job, err) => {
    console.error(`drafting job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
