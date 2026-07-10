import { Queue, Worker, type Job } from "bullmq";
import { QUEUES, type IngestionJob } from "@dealdock/core";
import {
  asOrgId,
  getConnectedAccount,
  listActiveGraphAccounts,
  markTokenExpired,
  updateBackfillCheckpoint,
} from "@dealdock/db";
import { InstagramGraphAdapter, TokenExpiredError } from "@dealdock/messaging";
import { redisConnection } from "../connection";

/**
 * Self-healing backfill (ARCHITECTURE.md §4.3, PRD §7.6): every 15 minutes,
 * walk active Graph accounts, list conversations updated since the last
 * checkpoint (with overlap so nothing falls between ticks), and re-enqueue
 * everything through the idempotent ingestion path. Webhook gaps — ours or
 * Meta's — heal here; igMessageId dedup makes replays free.
 * Token death (190) is detected here too → status token_expired → the web
 * app's reconnect banner.
 */
const OVERLAP_MS = 30 * 60_000;

export function startBackfillScheduler() {
  const backfillQueue = new Queue(QUEUES.backfill, { connection: redisConnection() });
  const ingestionQueue = new Queue(QUEUES.ingestion, { connection: redisConnection() });
  const adapter = new InstagramGraphAdapter();

  void backfillQueue.upsertJobScheduler("backfill-tick", { every: 15 * 60_000 });

  const worker = new Worker(
    QUEUES.backfill,
    async (_job: Job) => {
      const accounts = await listActiveGraphAccounts();
      let totalEnqueued = 0;

      for (const acc of accounts) {
        const orgId = asOrgId(acc.orgId);
        const connected = await getConnectedAccount(orgId, acc.igAccountId);
        if (!connected?.accessToken) continue;

        const since = acc.lastBackfillAt
          ? new Date(acc.lastBackfillAt.getTime() - OVERLAP_MS)
          : new Date(Date.now() - 24 * 60 * 60_000); // first run: last day

        try {
          const threads = await adapter.listConversations(
            {
              accountId: connected.accountId,
              platformUserId: connected.platformUserId,
              handle: connected.handle,
              accessToken: connected.accessToken,
            },
            since
          );

          for (const t of threads) {
            const messages = await adapter.fetchMessages(
              {
                accountId: connected.accountId,
                platformUserId: connected.platformUserId,
                handle: connected.handle,
                accessToken: connected.accessToken,
              },
              t.platformThreadId,
              since
            );
            const jobs: Array<{ name: string; data: IngestionJob }> = messages.map((m) => ({
              name: "backfill",
              data: {
                orgId: acc.orgId,
                igAccountId: acc.igAccountId,
                igThreadId: t.platformThreadId,
                participantHandle: t.participantHandle,
                participantIgId: t.participantPlatformId,
                igMessageId: m.platformMessageId,
                direction: m.direction,
                contentType: m.text ? "text" : "attachment",
                text: m.text,
                sentAt: m.sentAt.toISOString(),
                source: "live",
                raw: m.raw,
              },
            }));
            if (jobs.length) await ingestionQueue.addBulk(jobs);
            totalEnqueued += jobs.length;
          }

          await updateBackfillCheckpoint(orgId, acc.igAccountId);
        } catch (err) {
          if (err instanceof TokenExpiredError) {
            await markTokenExpired(acc.igAccountId);
            console.error(`backfill: token expired for @${acc.handle} — flagged for reconnect`);
            continue; // other accounts still heal this tick
          }
          // Rate budget / transient errors: skip this account this tick; the
          // overlap window means the next tick recovers anything missed.
          console.error(`backfill: @${acc.handle} skipped this tick: ${(err as Error).message}`);
        }
      }

      return { accounts: accounts.length, enqueued: totalEnqueued };
    },
    { connection: redisConnection(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`backfill tick ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
