import { Worker, type Job } from "bullmq";
import { z } from "zod";
import { HIGH_INTENT_LABELS, QUEUES, REVIEW_CONFIDENCE_THRESHOLD } from "@dealdock/core";
import { createPipeline } from "@dealdock/ai";
import {
  asOrgId,
  getClassifyContext,
  getMessageForClassification,
  saveClassification,
  isIgnoredHandle,
} from "@dealdock/db";
import { pipelineQueue, redisConnection } from "../connection";
import { replyDraftJobOptions } from "./drafting";

export const ClassificationJob = z.object({
  orgId: z.string(),
  igAccountId: z.string(),
  messageId: z.string(),
  source: z.enum(["live", "leak_scan"]).default("live"),
});
export type ClassificationJob = z.infer<typeof ClassificationJob>;

/**
 * HIGH_VALUE_NOTIFY_MIN_MINOR, when set, replaces every account's high-value
 * push bar (minor units, whatever the org's currency). Unset, each account's
 * bar is core highValueThresholdMinor: its lowest active brand offer price,
 * else the currency's default.
 */
function notifyMinOverride(): number | null {
  const value = process.env.HIGH_VALUE_NOTIFY_MIN_MINOR?.trim();
  if (!value) return null;
  const minor = Number(value);
  if (Number.isSafeInteger(minor) && minor >= 0) return minor;
  console.warn("HIGH_VALUE_NOTIFY_MIN_MINOR is not a whole number of minor units; using each account's threshold");
  return null;
}

/**
 * Classification consumer (ARCHITECTURE.md §5.1): one pipeline call per inbound
 * message → confidence gate → persist → conditionally hand to drafting.
 * The <0.80 → Review Queue rule lives HERE, not in the model.
 */
export function startClassificationWorker() {
  const pipeline = createPipeline();
  const draftingQueue = pipelineQueue(QUEUES.drafting);
  const notificationsQueue = pipelineQueue(QUEUES.notifications);
  const notifyMinFromEnv = notifyMinOverride();

  const worker = new Worker(
    QUEUES.classification,
    async (job: Job) => {
      const data = ClassificationJob.parse(job.data);
      const orgId = asOrgId(data.orgId);

      const message = await getMessageForClassification(orgId, data.messageId);
      if (!message) return { skipped: "message_gone" };
      if (message.igAccountId !== data.igAccountId) throw new Error("classification_account_mismatch");
      if (await isIgnoredHandle(orgId, data.igAccountId, message.participantHandle)) return {skipped:"ignored"};
      // A transcribed voice note is classified on its transcript (F8), under
      // the same confidence gate as any text message.
      const transcript = message.contentType === "audio" ? message.transcript?.trim() ?? "" : "";
      if (message.contentType !== "text" && !transcript) {
        // Audio/attachments can't be read by the text model, so they are
        // confidence-0 and MUST route to the Review Queue like any other
        // sub-threshold item (PRD §6.2 / §7.4) — never straight to the inbox.
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
          routedTo: "review_queue",
          source: data.source,
        });
        return { flagged: message.contentType };
      }

      const creator = await getClassifyContext(orgId, data.igAccountId);

      // If classification fails (model/API/validation error), the message must
      // NOT be silently dropped — persist a low-confidence Review Queue row so a
      // human still sees it. A thrown, un-persisted job would leave the DM
      // invisible in both inbox and review queue (F2).
      let result;
      try {
        result = await pipeline.classify({
          messageText: transcript || message.text,
          senderHandle: message.participantHandle,
          creator,
        });
      } catch (err) {
        await saveClassification(orgId, {
          messageId: message.id,
          label: "uncertain",
          confidence: 0,
          language: "en",
          valueMinMinor: null,
          valueMaxMinor: null,
          rationale: "Couldn't auto-classify this one — needs your eyes.",
          modelVersion: "classify-error",
          promptVersion: "n/a",
          routedTo: "review_queue",
          source: data.source,
        });
        // Re-throw so BullMQ records the failure for observability, but the
        // message is already safely parked in the review queue (idempotent
        // upsert means a retry that succeeds later just overwrites nothing).
        throw err instanceof Error ? err : new Error("classify failed");
      }

      const routedTo =
        result.label !== "uncertain" && result.confidence >= REVIEW_CONFIDENCE_THRESHOLD ? "inbox" : "review_queue";

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
      // A burst of messages in one thread shares a single draft job.
      const isHighIntent = HIGH_INTENT_LABELS.includes(result.label);
      if (
        data.source === "live" &&
        routedTo === "inbox" &&
        isHighIntent &&
        creator.voiceEnabled
      ) {
        await draftingQueue.add(
          "draft",
          {
            orgId: data.orgId,
            igAccountId: data.igAccountId,
            threadId: message.threadId,
            label: result.label,
          },
          replyDraftJobOptions(message.threadId),
        );
      }

      // High-value push (PRD §6.8): live, confident, commerce, at or above the account's bar.
      const notifyMin = notifyMinFromEnv ?? creator.highValueThresholdMinor;
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
