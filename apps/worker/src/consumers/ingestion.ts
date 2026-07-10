import { Queue, Worker, type Job } from "bullmq";
import { IngestionJob, QUEUES } from "@dealdock/core";
import { asOrgId, touchWebhookCheckpoint, upsertInboundMessage } from "@dealdock/db";
import { redisConnection } from "../connection";

/**
 * Ingestion consumer: webhook/backfill events → Thread + Message rows
 * (idempotent via igMessageId — ARCHITECTURE.md §4.3), then inbound messages
 * are handed to the classification queue.
 */
export function startIngestionWorker() {
  const classificationQueue = new Queue(QUEUES.classification, {
    connection: redisConnection(),
  });

  const worker = new Worker(
    QUEUES.ingestion,
    async (job: Job) => {
      const data = IngestionJob.parse(job.data);
      const orgId = asOrgId(data.orgId);

      const result = await upsertInboundMessage(orgId, {
        igAccountId: data.igAccountId,
        igThreadId: data.igThreadId,
        participantHandle: data.participantHandle,
        participantIgId: data.participantIgId,
        igMessageId: data.igMessageId,
        direction: data.direction,
        contentType: data.contentType,
        text: data.text,
        sentAt: new Date(data.sentAt),
        raw: data.raw,
      });

      await touchWebhookCheckpoint(orgId, data.igAccountId);

      if ("messageId" in result && data.direction === "inbound") {
        await classificationQueue.add("classify", {
          orgId: data.orgId,
          igAccountId: data.igAccountId,
          messageId: result.messageId,
          source: data.source,
        });
      }
      return result;
    },
    {
      connection: redisConnection(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    // Message bodies never enter logs (ARCHITECTURE.md §8).
    console.error(`ingestion job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
