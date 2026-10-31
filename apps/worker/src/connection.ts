import { Queue, type ConnectionOptions, type DefaultJobOptions } from "bullmq";
import { parseRedisConnection } from "@dealdock/core";

export function redisConnection(): ConnectionOptions {
  const value = process.env.REDIS_URL;
  if (!value) {
    if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required");
    return parseRedisConnection("redis://localhost:6379/0");
  }
  return parseRedisConnection(value);
}

/**
 * Pipeline jobs retry transient failures (Claude/DB blips) with backoff before
 * giving up — so a momentary error doesn't immediately park a DM in the review
 * queue (F2). Completed/failed jobs are trimmed so Redis doesn't grow unbounded.
 */
export const PIPELINE_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: {age:3600,count:1000},
};

/** Queue factory with the shared retry/backoff defaults applied. */
export function pipelineQueue(name: string): Queue {
  return new Queue(name, {
    connection: redisConnection(),
    defaultJobOptions: PIPELINE_JOB_OPTIONS,
  });
}
