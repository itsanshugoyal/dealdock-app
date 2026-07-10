import { Queue, Worker, type Job } from "bullmq";
import { QUEUES } from "@dealdock/core";
import { hardDeleteOrg, listOrgsDueHardDelete } from "@dealdock/db";
import { redisConnection } from "../connection";

/**
 * Retention consumer (PRD §6.11, §5.7): daily tick hard-deletes orgs past
 * their 7-day deletion grace or 30 days past cancellation. Irreversible by
 * design — the grace window IS the undo.
 */
export function startRetentionScheduler() {
  const queue = new Queue(QUEUES.retention, { connection: redisConnection() });
  void queue.upsertJobScheduler("retention-tick", { every: 24 * 60 * 60_000 });

  const worker = new Worker(
    QUEUES.retention,
    async (_job: Job) => {
      const due = await listOrgsDueHardDelete();
      const results: Array<{ orgId: string; reason: string }> = [];
      for (const d of due) {
        const wiped = await hardDeleteOrg(d.orgId);
        // Org id + counts only — never names or content in logs.
        console.log(
          `retention: hard-deleted org ${d.orgId} (${d.reason}) — ${wiped.deletedMessages} messages, ${wiped.deletedLedgerEntries} ledger entries`
        );
        results.push({ orgId: d.orgId, reason: d.reason });
      }
      return { deleted: results.length };
    },
    { connection: redisConnection(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`retention tick ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
