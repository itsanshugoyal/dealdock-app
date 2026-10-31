import { Queue } from "bullmq";
import { QUEUES, parseRedisConnection } from "@dealdock/core";

/** Queue handles shared by API routes; Graph maintenance is API-owned. */
let ingestionQueue: Queue | null = null;

/**
 * Shared Redis parsing keeps TLS, username and database selection intact.
 * Never silently degrade a production URL to a local unauthenticated Redis.
 */
export function redisConnection() {
  const value = process.env.REDIS_URL;
  if (!value) {
    if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required");
    return parseRedisConnection("redis://localhost:6379/0");
  }
  return parseRedisConnection(value);
}

export function getIngestionQueue(): Queue {
  if (!ingestionQueue) {
    ingestionQueue = new Queue(QUEUES.ingestion, { connection: redisConnection() });
  }
  return ingestionQueue;
}
