import { createHash } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type { IngestionJob } from "@dealdock/core";
import { asOrgId, enqueueIngestionOutbox, listActiveGraphAccounts, updateBackfillCheckpoint, type OrgId } from "@dealdock/db";
import { ingestionDedupeKey, type RemoteMessage, type RemoteThread } from "@dealdock/messaging";
import { getGmailProvider, gmailConfig, gmailPushConfig, withGmailAccount, type GmailAccount } from "./gmail";
import { redisConnection } from "./queues";

/**
 * Gmail sync, owned by the API like Graph maintenance: the worker may not
 * hold a Gmail token (it can send). Normalized messages reach the worker
 * through the same ingestion outbox as Instagram, so classification and
 * drafting are queued the same way.
 *
 * First sync (and whenever Gmail drops the cursor's history): the last 30
 * days, as source "leak_scan" — classified, no drafts or pushes. After that:
 * incremental from IngestionCheckpoint.syncCursor (Gmail historyId), "live".
 * Triggers: right after connecting, every Gmail push, and a poll — every
 * 2 minutes without push, every 15 as a safety net with it.
 */

const EMAIL_SYNC_QUEUE = "email-sync";
const BACKFILL_WINDOW_MS = 30 * 864e5;
const POLL_MS = 2 * 60_000;
const SAFETY_POLL_MS = 15 * 60_000;
/** Gmail watches lapse after 7 days; Google advises renewing daily. */
const WATCH_RENEW_MS = 24 * 60 * 60_000;

let syncQueue: Queue | undefined;

/** Sync one inbox soon. `trigger` dedupes: a Pub/Sub redelivery of the same push queues nothing new. */
export async function scheduleEmailSync(orgId: string, igAccountId: string, trigger: string) {
  syncQueue ??= new Queue(EMAIL_SYNC_QUEUE, { connection: redisConnection() });
  await syncQueue.add("account", { orgId, igAccountId }, {
    // BullMQ forbids ':' in custom ids.
    jobId: createHash("sha256").update(`${trigger}:${igAccountId}`).digest("hex"),
    removeOnComplete: true,
    removeOnFail: { age: 3600 },
  });
}

/** Pulls what changed in one inbox into the ingestion outbox; returns how many messages were queued. */
export async function syncEmailAccount(orgIdValue: string, igAccountId: string): Promise<number> {
  const orgId = asOrgId(orgIdValue);
  return (await withGmailAccount(orgId, igAccountId, (account) => pull(orgId, account))) ?? 0;
}

async function pull(orgId: OrgId, account: GmailAccount): Promise<number> {
  const gmail = getGmailProvider();
  const changes = account.syncCursor ? await gmail.listHistory(account, account.syncCursor) : null;
  if (!changes) return backfill(orgId, account);
  let queued = 0;
  for (const [threadId, added] of changes.threads) {
    const thread = await gmail.getThread(account, threadId);
    if (thread) queued += await enqueue(orgId, account.accountId, thread, thread.messages.filter((m) => added.has(m.platformMessageId)), "live");
  }
  await updateBackfillCheckpoint(orgId, account.accountId, changes.historyId);
  return queued;
}

async function backfill(orgId: OrgId, account: GmailAccount): Promise<number> {
  const gmail = getGmailProvider();
  // Taken before listing, so mail that lands mid-backfill is the next incremental sync's.
  const historyId = await gmail.currentHistoryId(account);
  const since = new Date(Date.now() - BACKFILL_WINDOW_MS);
  let queued = 0;
  for (const threadId of await gmail.listThreadIds(account, since)) {
    const thread = await gmail.getThread(account, threadId);
    if (thread) queued += await enqueue(orgId, account.accountId, thread, thread.messages.filter((m) => m.sentAt > since), "leak_scan");
  }
  await updateBackfillCheckpoint(orgId, account.accountId, historyId);
  return queued;
}

async function enqueue(orgId: OrgId, igAccountId: string, thread: RemoteThread, messages: RemoteMessage[], source: "live" | "leak_scan") {
  for (const message of messages) {
    const job: IngestionJob = {
      orgId,
      igAccountId,
      igThreadId: thread.platformThreadId,
      participantHandle: thread.participantHandle,
      participantIgId: thread.participantPlatformId,
      igMessageId: message.platformMessageId,
      direction: message.direction,
      contentType: "text",
      text: message.text,
      sentAt: message.sentAt.toISOString(),
      source,
      raw: message.raw,
    };
    await enqueueIngestionOutbox(orgId, {
      // Our own sends are already recorded under their Gmail id, so their echo is a duplicate.
      dedupeKey: ingestionDedupeKey(igAccountId, message.platformMessageId),
      // The worker's ingestion consumer puts these email-only fields on the Thread.
      payload: { ...job, subject: thread.subject, participantName: thread.participantName },
    });
  }
  return messages.length;
}

export function startEmailSync() {
  if (!gmailConfig()) return { async close() {} };
  const push = gmailPushConfig();
  if (!push && process.env.GMAIL_PUBSUB_TOPIC) {
    console.warn("Gmail push is off: GMAIL_PUBSUB_VERIFICATION_TOKEN is missing or under 24 characters. Polling every 2 minutes.");
  }
  const queue = new Queue(EMAIL_SYNC_QUEUE, { connection: redisConnection() });
  void queue.upsertJobScheduler("email-poll", { every: push ? SAFETY_POLL_MS : POLL_MS })
    .catch((error) => console.error("Email poll scheduler registration failed", error.message));
  if (push) {
    void queue.upsertJobScheduler("email-watch", { every: WATCH_RENEW_MS })
      .catch((error) => console.error("Gmail watch scheduler registration failed", error.message));
  }
  const worker = new Worker(EMAIL_SYNC_QUEUE, async (job) => {
    if (job.name === "account") return { queued: await syncEmailAccount(job.data.orgId, job.data.igAccountId) };
    // A scheduler left from a run with push on renews nothing once push is off.
    if (job.name === "email-watch" && !push) return { accounts: 0 };
    const accounts = await listActiveGraphAccounts("gmail");
    for (const account of accounts) {
      try {
        if (job.name === "email-watch" && push) {
          await withGmailAccount(asOrgId(account.orgId), account.igAccountId, (inbox) => getGmailProvider().watch(inbox, push.topic));
        } else {
          await syncEmailAccount(account.orgId, account.igAccountId);
        }
      } catch (error) {
        // One inbox's failure never stalls the others; the next tick retries it.
        console.error(`email ${job.name} failed for account ${account.igAccountId}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    return { accounts: accounts.length };
  }, { connection: redisConnection(), concurrency: 1 });
  worker.on("failed", (job, error) => console.error(`Email sync ${job?.id} failed: ${error.message}`));
  return {
    async close() {
      await worker.close();
      await queue.close();
      await syncQueue?.close();
      syncQueue = undefined;
    },
  };
}
