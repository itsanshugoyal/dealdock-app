import { Queue, Worker, type Job } from "bullmq";
import { QUEUES } from "@dealdock/core";
import { listNudgeCandidates } from "@dealdock/db";
import { redisConnection } from "../connection";

/**
 * Nudge scheduler (PRD §6.5): a repeatable job scans for waiting threads that
 * went silent past their org's delay and hands each to the drafting queue as
 * kind=nudge. Drafts only — nudges obey the send gate like everything else.
 */
export function startNudgeScheduler() {
  const nudgeQueue = new Queue(QUEUES.nudges, { connection: redisConnection() });
  const draftingQueue = new Queue(QUEUES.drafting, { connection: redisConnection() });
  const notificationsQueue = new Queue(QUEUES.notifications, { connection: redisConnection() });

  // Repeatable tick every 30 minutes (idempotent — candidates query excludes
  // threads that already have a live nudge draft).
  void nudgeQueue.upsertJobScheduler("nudge-tick", { every: 30 * 60_000 });

  const worker = new Worker(
    QUEUES.nudges,
    async (_job: Job) => {
      const candidates = await listNudgeCandidates();
      for (const c of candidates) {
        await draftingQueue.add("nudge-draft", {
          orgId: c.orgId,
          igAccountId: c.igAccountId,
          threadId: c.threadId,
          label: c.topLabel ?? "brand_deal",
          kind: "nudge",
        });
        await notificationsQueue.add("nudge-due", {
          orgId: c.orgId,
          kind: "nudge",
          threadId: c.threadId,
          handle: c.participantHandle,
          valueMaxMinor: c.estValueMaxMinor ?? undefined,
          currencyCode: c.currencyCode,
        });
      }
      return { enqueued: candidates.length };
    },
    { connection: redisConnection(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`nudge tick ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
