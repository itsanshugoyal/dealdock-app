import { Queue, Worker, type Job } from "bullmq";
import { QUEUES } from "@dealdock/core";
import { asOrgId, listNudgeCandidates, recordNudgeFired } from "@dealdock/db";
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

  // Repeatable tick every 30 minutes. Each follow-up cycle fires once: the
  // candidates query skips cycles already recorded by recordNudgeFired.
  void nudgeQueue.upsertJobScheduler("nudge-tick", { every: 30 * 60_000 });

  const worker = new Worker(
    QUEUES.nudges,
    async (_job: Job) => {
      const candidates = await listNudgeCandidates();
      for (const c of candidates) {
        // Deterministic ids: a tick retried after a partial run cannot queue the
        // same cycle twice; the cycle is recorded only once both jobs exist.
        const cycle = `${c.threadId}-${c.dueAt.getTime()}`;
        await draftingQueue.add(
          "nudge-draft",
          {
            orgId: c.orgId,
            igAccountId: c.igAccountId,
            threadId: c.threadId,
            label: c.topLabel ?? "brand_deal",
            kind: "nudge",
          },
          { jobId: `nudge-draft-${cycle}` },
        );
        await notificationsQueue.add(
          "nudge-due",
          {
            orgId: c.orgId,
            kind: "nudge",
            threadId: c.threadId,
            handle: c.participantHandle,
            valueMaxMinor: c.estValueMaxMinor ?? undefined,
            currencyCode: c.currencyCode,
          },
          { jobId: `nudge-due-${cycle}` },
        );
        await recordNudgeFired(asOrgId(c.orgId), c.threadId, c.dueAt);
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
