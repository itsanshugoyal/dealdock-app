import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import { QUEUES } from "@dealdock/core";
import {
  claimOutboxEvent,
  completeOutboxEvent,
  listRecoverableOutboxEvents,
  purgeProcessedOutbox,
  releaseOutboxEvent,
  VOICE_LEARN_OUTBOX_KIND,
  VOICE_REFRESH_OUTBOX_KIND,
} from "@dealdock/db";
import { PIPELINE_JOB_OPTIONS, redisConnection } from "../connection";

const OUTBOX_KINDS = ["ingestion", "classification", VOICE_LEARN_OUTBOX_KIND, VOICE_REFRESH_OUTBOX_KIND] as const;

/** Events listed per pass, oldest first across every kind. */
const BATCH_SIZE = 100;
/** Poll interval while events flow; an empty outbox doubles it up to IDLE_POLL_MS. */
const POLL_MS = 1_000;
const IDLE_POLL_MS = 2_000;
/**
 * Published rows are spent: the message tables, not the outbox, dedupe a
 * redelivery. A day is far beyond the leak scan's 10-minute settle window
 * and the seconds before a published ingestion job reads its row.
 */
const PURGE_AFTER_MS = 24 * 60 * 60_000;
const PURGE_EVERY_MS = 60 * 60_000;

/**
 * Database outbox publisher. Redis is deliberately never the source of truth:
 * an event is leased in PostgreSQL, published to BullMQ, and marked complete
 * only after BullMQ acknowledges the enqueue. A process death at any point is
 * recovered by the next scan without needing Graph credentials.
 */
export function startOutboxDispatcher() {
  const ingestion = new Queue(QUEUES.ingestion, { connection: redisConnection() });
  const classification = new Queue(QUEUES.classification, { connection: redisConnection() });
  const voiceLearning = new Queue(QUEUES.voiceLearning, { connection: redisConnection() });
  let closing = false;
  let pass: Promise<void> | undefined;
  let purging: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let idleWait = POLL_MS;

  /** True once this dispatcher published the event; false when another holds it or the enqueue failed. */
  const publish = async (row: { id: string }) => {
    const leased = await claimOutboxEvent(row.id);
    if (!leased) return false;
    try {
      const queue = leased.kind === "ingestion" ? ingestion : leased.kind === "classification" ? classification : voiceLearning;
      // The row's tenant is authoritative. BullMQ forbids ':' in custom
      // ids, so hash the durable key rather than dropping deduplication.
      const payload = leased.kind === "ingestion"
        ? {orgId:leased.orgId,ingressEventId:leased.id}
        : {...(leased.payload as object),orgId:leased.orgId};
      await queue.add(leased.kind, payload, {
        jobId: createHash("sha256").update(leased.dedupeKey).digest("hex"),
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
        // Learning is a side effect of a send that already happened: retry transient failures.
        ...(queue === voiceLearning ? { attempts: PIPELINE_JOB_OPTIONS.attempts, backoff: PIPELINE_JOB_OPTIONS.backoff } : {}),
      });
      await completeOutboxEvent(leased.id);
      return true;
    } catch (error) {
      await releaseOutboxEvent(leased.id, error instanceof Error ? error.message : "outbox publish failed");
      return false;
    }
  };

  const dispatch = async () => {
    const rows = await listRecoverableOutboxEvents(OUTBOX_KINDS, BATCH_SIZE);
    let published = 0;
    // Bound database pressure while avoiding a serial round-trip bottleneck.
    // The conditional lease remains authoritative across dispatch replicas.
    for (let offset = 0; offset < rows.length; offset += 5) {
      const results = await Promise.all(rows.slice(offset, offset + 5).map(publish));
      published += results.filter(Boolean).length;
    }
    return { listed: rows.length, published };
  };

  const loop = async () => {
    let wait = POLL_MS;
    try {
      const { listed, published } = await dispatch();
      if (listed === 0) {
        wait = idleWait;
        idleWait = Math.min(idleWait * 2, IDLE_POLL_MS);
      } else {
        idleWait = POLL_MS;
        // A full batch that all went out leaves more waiting: take it at once.
        if (listed === BATCH_SIZE && published === listed) wait = 0;
      }
    } catch (error) {
      console.error(`outbox dispatch failed: ${error instanceof Error ? error.message : "unknown error"}`);
      wait = idleWait;
      idleWait = Math.min(idleWait * 2, IDLE_POLL_MS);
    }
    if (closing) return;
    timer = setTimeout(() => { pass = loop(); }, wait);
    timer.unref();
  };
  pass = loop();

  const purge = async () => {
    try {
      const { purgedOutboxEvents } = await purgeProcessedOutbox(new Date(Date.now() - PURGE_AFTER_MS));
      if (purgedOutboxEvents) console.log(`outbox: purged ${purgedOutboxEvents} published events`);
    } catch (error) {
      console.error(`outbox purge failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };
  // The first sweep waits an hour: after an outage, ingestion jobs published
  // before it still read their rows as the backlog drains.
  const purgeTimer = setInterval(() => { purging = purge(); }, PURGE_EVERY_MS);
  purgeTimer.unref();

  return {
    async close() {
      closing = true;
      clearTimeout(timer);
      clearInterval(purgeTimer);
      await Promise.allSettled([pass, purging]);
      await Promise.all([ingestion.close(), classification.close(), voiceLearning.close()]);
    },
  };
}
