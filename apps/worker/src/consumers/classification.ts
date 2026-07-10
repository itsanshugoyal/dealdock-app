import { Queue, Worker, type Job } from "bullmq";
import { z } from "zod";
import { HIGH_INTENT_LABELS, QUEUES, REVIEW_CONFIDENCE_THRESHOLD } from "@dealdock/core";
import { createPipeline } from "@dealdock/ai";
import {
  asOrgId,
  getCreatorContext,
  getMessageForClassification,
  saveClassification,
} from "@dealdock/db";
import { redisConnection } from "../connection";

export const ClassificationJob = z.object({
  orgId: z.string(),
  igAccountId: z.string(),
  messageId: z.string(),
  source: z.enum(["live", "leak_scan"]).default("live"),
});
export type ClassificationJob = z.infer<typeof ClassificationJob>;

/**
 * Classification consumer (ARCHITECTURE.md §5.1): one pipeline call per inbound
 * message → confidence gate → persist → conditionally hand to drafting.
 * The <0.80 → Review Queue rule lives HERE, not in the model.
 */
export function startClassificationWorker() {
  const pipeline = createPipeline();
  const draftingQueue = new Queue(QUEUES.drafting, { connection: redisConnection() });
  const notificationsQueue = new Queue(QUEUES.notifications, { connection: redisConnection() });

  const worker = new Worker(
    QUEUES.classification,
    async (job: Job) => {
      const data = ClassificationJob.parse(job.data);
      const orgId = asOrgId(data.orgId);

      const message = await getMessageForClassification(orgId, data.messageId);
      if (!message) return { skipped: "message_gone" };
      if (message.contentType !== "text") {
        // Audio/attachments surface flagged, never silently classified (PRD §6.2).
        await saveClassification(orgId, {
          messageId: message.id,
          label: "uncertain",
          confidence: 0,
          language: "en",
          valueMinMinor: null,
          valueMaxMinor: null,
          rationale: "Voice note / attachment — needs your ear.",
          modelVersion: "content-flag",
          promptVersion: "n/a",
          routedTo: "inbox",
          source: data.source,
        });
        return { flagged: message.contentType };
      }

      const creator = await getCreatorContext(orgId, data.igAccountId);
      const result = await pipeline.classify({
        messageText: message.text,
        senderHandle: message.participantHandle,
        creator,
      });

      const routedTo =
        result.confidence >= REVIEW_CONFIDENCE_THRESHOLD ? "inbox" : "review_queue";

      await saveClassification(orgId, {
        messageId: message.id,
        label: result.label,
        confidence: result.confidence,
        language: result.language,
        valueMinMinor: result.valueRange?.minMinor ?? null,
        valueMaxMinor: result.valueRange?.maxMinor ?? null,
        rationale: result.rationale,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
        routedTo,
        source: data.source,
      });

      // Pre-generate drafts for confident high-intent messages (<5s SLA path).
      // Leak-scan backfill gets no drafts (PRD §6.2 — scan measures, doesn't draft).
      const isHighIntent = (HIGH_INTENT_LABELS as readonly string[]).includes(result.label);
      if (
        data.source === "live" &&
        routedTo === "inbox" &&
        isHighIntent &&
        creator.voiceEnabled
      ) {
        await draftingQueue.add("draft", {
          orgId: data.orgId,
          igAccountId: data.igAccountId,
          threadId: message.threadId,
          replyToMessageId: message.id,
          label: result.label,
        });
      }

      // High-value push (PRD §6.8): live, confident, commerce, above threshold.
      const notifyMin = Number(process.env.HIGH_VALUE_NOTIFY_MIN_MINOR ?? 50_000_00);
      if (
        data.source === "live" &&
        routedTo === "inbox" &&
        isHighIntent &&
        (result.valueRange?.maxMinor ?? 0) >= notifyMin
      ) {
        await notificationsQueue.add("high-value", {
          orgId: data.orgId,
          kind: "high_value",
          threadId: message.threadId,
          handle: message.participantHandle,
          valueMaxMinor: result.valueRange?.maxMinor,
          currencyCode: creator.currencyCode,
        });
      }

      return { label: result.label, routedTo };
    },
    { connection: redisConnection(), concurrency: 5 }
  );

  worker.on("failed", (job, err) => {
    console.error(`classification job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
