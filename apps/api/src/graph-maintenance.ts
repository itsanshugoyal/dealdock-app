import { Queue, Worker } from "bullmq";
import { createHash } from "node:crypto";
import { QUEUES, type IngestionJob } from "@dealdock/core";
import { adoptParticipantHandles, asOrgId, getConnectedAccount, listActiveGraphAccounts, markLeakScanCompleted, markTokenExpired, updateBackfillCheckpoint, enqueueIngestionOutbox, saveRefreshedGraphToken } from "@dealdock/db";
import { MockInstagramAdapter, TokenExpiredError, ingestionContent, ingestionDedupeKey, refreshLongLivedToken, type RemoteMessage, type RemoteThread } from "@dealdock/messaging";
import { getGraphAdapter } from "./graph";
import { redisConnection } from "./queues";
import { scheduleVoiceRefreshAfterScan } from "./routes/voice";

/** A Leak Scan reads the last 30 days of history (PRD §5.1.6). */
const LEAK_SCAN_WINDOW_MS = 30 * 864e5;
/** The 15-minute backfill re-reads this much before its last run, for messages stamped while it ran. */
const BACKFILL_OVERLAP_MS = 5 * 60_000;

let graphQueue: Queue | undefined;
export async function scheduleLeakScan(orgId: string, igAccountId: string) {
  graphQueue ??= new Queue(QUEUES.backfill, { connection: redisConnection() });
  const jobId = createHash("sha256").update(`leak-scan:${orgId}:${igAccountId}`).digest("hex");
  // A failed scan keeps its id for an hour, and adding that id again would be
  // ignored: remove it so this request really runs a new scan.
  const previous = await graphQueue.getJob(jobId);
  if (previous && (await previous.isFailed())) await previous.remove();
  await graphQueue.add("leak-scan", { orgId, igAccountId }, {
    jobId,
    removeOnComplete: true, removeOnFail: { age: 3600 },
  });
}

/** API owns all Graph credentials and I/O. Only normalized data reaches workers. */
export async function scanAccountHistory(orgIdValue: string, accountId: string, since: Date, source: "live" | "leak_scan") {
  const orgId = asOrgId(orgIdValue);
  const connected = await getConnectedAccount(orgId, accountId);
  if (!connected || connected.status !== "active") return 0;
  if (connected.provider === "instagram_graph" && connected.tokenRefreshedAt && Date.now() - connected.tokenRefreshedAt.getTime() >= 7 * 864e5) {
    const refreshed = await refreshLongLivedToken({}, connected.accessToken);
    await saveRefreshedGraphToken(orgId, accountId, refreshed.accessToken, refreshed.expiresIn);
    connected.accessToken = refreshed.accessToken;
  }
  const mock = connected.provider === "mock";
  const adapter = mock ? new MockInstagramAdapter() : getGraphAdapter();
  const toJob = (thread: RemoteThread, message: RemoteMessage): IngestionJob => ({
    orgId, igAccountId: accountId,
    // Webhooks identify a one-to-one conversation by the counterparty's
    // IGSID. Use that same canonical key for polled Graph history.
    igThreadId: mock ? thread.platformThreadId : thread.participantPlatformId,
    participantHandle: thread.participantHandle, participantIgId: thread.participantPlatformId,
    igMessageId: message.platformMessageId, direction: message.direction,
    // Voice notes → contentType "audio" + their expiring CDN URL (F8).
    ...ingestionContent(message), text: message.text,
    sentAt: message.sentAt.toISOString(), source, raw: message.raw,
  });
  let count = 0;
  const conversations = await adapter.listConversations(connected, since);
  // History shares the webhook's dedupe key, so its deliveries no longer
  // rename a webhook-only thread (still on the sender's IGSID): take the
  // listed username directly. Ignore-list matching relies on it.
  if (!mock) {
    await adoptParticipantHandles(orgId, accountId, conversations.map((thread) => ({ participantIgId: thread.participantPlatformId, handle: thread.participantHandle })));
  }
  for (const thread of conversations) {
    // The listing names the conversation, so reading it costs no lookup.
    const messages = await adapter.fetchMessages(connected, thread.platformThreadId, since, thread.conversationId);
    for (const message of messages) {
      // The webhook's key: a message both deliver is written and ingested once.
      await enqueueIngestionOutbox(orgId, { dedupeKey: ingestionDedupeKey(accountId, message.platformMessageId), payload: toJob(thread, message) });
      count++;
    }
  }
  await updateBackfillCheckpoint(orgId, accountId);
  return count;
}

export function startGraphMaintenance() {
  const queue = new Queue(QUEUES.backfill, { connection: redisConnection() });
  void queue.upsertJobScheduler("graph-backfill", { every: 15 * 60_000 }).catch(error => console.error("Graph scheduler registration failed", error.message));
  const worker = new Worker(QUEUES.backfill, async job => {
    if (job.name === "leak-scan") {
      const orgId = asOrgId(job.data.orgId);
      let enqueued = 0;
      try {
        enqueued = await scanAccountHistory(orgId, job.data.igAccountId, new Date(Date.now() - LEAK_SCAN_WINDOW_MS), "leak_scan");
      } finally {
        // Even a failed scan settles the reveal on what it found, rather than leaving it "running".
        await markLeakScanCompleted(orgId, job.data.igAccountId);
      }
      // The scanned history (their own replies included) lands through ingestion; re-read the voice once it settles.
      if (enqueued > 0) await scheduleVoiceRefreshAfterScan(orgId, job.data.igAccountId);
      return { enqueued };
    }
    const accounts = await listActiveGraphAccounts();
    for (const account of accounts) {
      try {
        await scanAccountHistory(account.orgId, account.igAccountId, new Date((account.lastBackfillAt?.getTime() ?? Date.now() - 864e5) - BACKFILL_OVERLAP_MS), "live");
      } catch (error) {
        if (error instanceof TokenExpiredError) await markTokenExpired(asOrgId(account.orgId), account.igAccountId);
        else throw error;
      }
    }
    return { accounts: accounts.length };
  }, { connection: redisConnection(), concurrency: 1 });
  worker.on("failed", (job, error) => console.error(`Graph maintenance ${job?.id} failed: ${error.message}`));
  return { async close() { await worker.close(); await queue.close(); await graphQueue?.close(); graphQueue = undefined; } };
}
