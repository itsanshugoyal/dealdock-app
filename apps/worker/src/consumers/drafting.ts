import { Worker, type Job, type JobsOptions } from "bullmq";
import { z } from "zod";
import { ClassificationLabel, QUEUES } from "@dealdock/core";
import { createPipeline, draftScope, generationContextOf, retrieveVoiceContext } from "@dealdock/ai";
import {
  asOrgId,
  createDraft,
  getCreatorContext,
  getDraftThreadContext,
  getDraftVoiceContext,
  isIgnoredHandle,
} from "@dealdock/db";
import { redisConnection } from "../connection";

export const DraftingJob = z.object({
  orgId: z.string(),
  igAccountId: z.string(),
  threadId: z.string(),
  /** The label the job was queued for; the thread's top label wins when it has one. */
  label: z.string(),
  kind: z.enum(["reply", "nudge"]).default("reply"),
});
export type DraftingJob = z.infer<typeof DraftingJob>;

/** Long enough for the rest of a burst of DMs to be classified, short beside a creator opening the thread. */
const REPLY_DRAFT_DELAY_MS = 5_000;

/**
 * Queue options for a live reply draft: one job per thread. Messages that
 * arrive while it waits are covered by it, since it drafts against the thread
 * as it is when it runs. Messages that arrive while it is drafting queue
 * exactly one more run after it, so every message is still answered. (A
 * fixed jobId would instead drop those, and block the thread for an hour
 * after a failed job.)
 */
export function replyDraftJobOptions(threadId: string): JobsOptions {
  return { delay: REPLY_DRAFT_DELAY_MS, deduplication: { id: `reply-draft-${threadId}`, keepLastIfActive: true } };
}

/**
 * Drafting consumer: voice-matched reply pre-generation for high-intent
 * threads (ARCHITECTURE.md §5.1 stage 5) and follow-up nudges. Each draft is
 * built from the creator's rules, measured habits, offers, their most similar
 * past replies and edit lessons (research 04 §4.4–4.5), and records what it
 * used for "Why this draft". Drafts only — this process cannot send (the
 * send gate lives in apps/api).
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
        getDraftThreadContext(orgId, data.threadId),
      ]);
      if (!thread) return { skipped: "thread_gone" };
      if (thread.igAccountId !== data.igAccountId) throw new Error("drafting_account_mismatch");
      if (await isIgnoredHandle(orgId, data.igAccountId, thread.participantHandle)) return {skipped:"ignored"};
      if (!creator.voiceEnabled) return { skipped: "voice_disabled" };

      // As in the API's draft route: the thread's top label, then the job's.
      const label = thread.topLabel ?? ClassificationLabel.safeParse(data.label).data ?? null;
      const now = new Date();
      // The creator context already carries consent and excluded samples, so VoiceProfile is read once.
      const pools = await getDraftVoiceContext(orgId, data.igAccountId, now, creator);
      // Nudges retrieve nudge exemplars and apply the "nudge"-scope rules.
      const query = { inboundText: thread.latestInbound?.text ?? "", scope: draftScope({ kind: data.kind, label }), now, excludeThreadId: thread.id };
      const result = await pipeline.draft({
        kind: data.kind,
        classificationLabel: label,
        threadHistory: thread.messages.map((m) => ({ direction: m.direction, text: m.text, contentType: m.contentType, transcript: m.transcript })),
        creator,
        ...retrieveVoiceContext(query, pools),
      });

      const draft = await createDraft(orgId, {
        threadId: data.threadId,
        // A reply answers the newest inbound message, which may be newer than the one that queued the job.
        replyToMessageId: data.kind === "reply" ? thread.latestInbound?.id : undefined,
        kind: data.kind,
        body: result.body,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
        label,
        generationContext: generationContextOf(result),
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
