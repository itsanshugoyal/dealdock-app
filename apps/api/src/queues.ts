import { Queue } from "bullmq";
import { QUEUES } from "@dealdock/core";

/** Producer-side queue handles. The API enqueues; it never consumes. */
let ingestionQueue: Queue | null = null;

function redisConnection() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
  };
}

export function getIngestionQueue(): Queue {
  if (!ingestionQueue) {
    ingestionQueue = new Queue(QUEUES.ingestion, { connection: redisConnection() });
  }
  return ingestionQueue;
}
