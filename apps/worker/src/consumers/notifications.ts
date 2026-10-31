import { Queue, Worker, type Job } from "bullmq";
import webpush from "web-push";
import { z } from "zod";
import { formatMoneyCompact, QUEUES, isTrustedPushEndpoint, type CurrencyCode } from "@dealdock/core";
import {
  asOrgId,
  getWeeklyDigestSummary,
  listPushTargets,
  listWeeklyDigestCandidates,
  recordWeeklyDigestSent,
  removeDeadSubscription,
} from "@dealdock/db";
import { redisConnection } from "../connection";

/** Hourly scan job on the notifications queue that produces Monday digests. */
const WEEKLY_DIGEST_TICK = "weekly-digest-tick";

export const NotificationJob = z.object({
  orgId: z.string(),
  kind: z.enum(["high_value", "nudge", "weekly_summary", "billing_checkout_ready"]),
  threadId: z.string().optional(),
  handle: z.string().optional(),
  valueMaxMinor: z.number().optional(),
  currencyCode: z.string().optional(),
  locale: z.string().optional(),
  checkoutUrl: z.string().nullable().optional(),
  summaryText: z.string().optional(),
});
export type NotificationJob = z.infer<typeof NotificationJob>;

/** Notification copy leads with money (DESIGN.md §6). */
function buildPayload(data: NotificationJob): { title: string; body: string; url: string } {
  const money =
    data.valueMaxMinor && data.currencyCode
      ? formatMoneyCompact(data.valueMaxMinor, {
          currency: data.currencyCode as CurrencyCode,
          locale: data.locale,
        })
      : null;

  switch (data.kind) {
    case "high_value":
      return {
        title: money ? `New deal — est. ${money}+` : "New high-value DM",
        body: data.handle ? `@${data.handle} just messaged. Draft is ready.` : "Draft is ready.",
        url: data.threadId ? `/thread/${data.threadId}` : "/inbox",
      };
    case "nudge":
      return {
        title: money ? `${money} deal waiting on a follow-up` : "Follow-up due",
        body: data.handle
          ? `@${data.handle} has gone quiet — your nudge is drafted.`
          : "A thread went quiet — nudge drafted.",
        url: data.threadId ? `/thread/${data.threadId}` : "/inbox?filter=waiting",
      };
    case "weekly_summary":
      return {
        title: "Your week in recovered revenue",
        body: data.summaryText ?? "Open your dashboard for the numbers.",
        url: "/",
      };
    case "billing_checkout_ready":
      return {
        title: "DealDock pilot — first invoice ready",
        body: "Your week of active use is done. Authorize the payment to continue.",
        url: "/settings",
      };
  }
}

/**
 * "Last week: ₹1.2L recovered · 9 replies · voice match 82%". Null when the
 * week had no sales and no replies: DealDock never sends a guilt push.
 */
export function weeklySummaryText(summary: {
  recoveredMinor: number;
  replies: number;
  voiceMatchPct: number | null;
  currencyCode: CurrencyCode;
  locale: string;
}): string | null {
  if (summary.recoveredMinor === 0 && summary.replies === 0) return null;
  const parts = [
    `${formatMoneyCompact(summary.recoveredMinor, { currency: summary.currencyCode, locale: summary.locale })} recovered`,
    `${summary.replies} ${summary.replies === 1 ? "reply" : "replies"}`,
  ];
  if (summary.voiceMatchPct !== null) parts.push(`voice match ${summary.voiceMatchPct}%`);
  return `Last week: ${parts.join(" · ")}`;
}

/** One digest per org per ISO week, queued only inside the org's push hours. */
async function produceWeeklyDigests(queue: Queue) {
  let queued = 0;
  for (const { orgId, isoWeek } of await listWeeklyDigestCandidates()) {
    const text = weeklySummaryText(await getWeeklyDigestSummary(asOrgId(orgId)));
    if (!text) continue;
    await queue.add("weekly-summary", { orgId, kind: "weekly_summary", summaryText: text }, { jobId: `weekly-summary-${orgId}-${isoWeek}` });
    await recordWeeklyDigestSent(asOrgId(orgId), isoWeek);
    queued += 1;
  }
  return { queued };
}

/** Hourly digest tick: every timezone gets exactly one tick in its local Monday 09:00 hour. */
export function startWeeklyDigestScheduler() {
  const queue = new Queue(QUEUES.notifications, { connection: redisConnection() });
  void queue.upsertJobScheduler(WEEKLY_DIGEST_TICK, { every: 60 * 60_000 });
  return queue;
}

/**
 * Web Push sender (ADR-10): standard VAPID, no Firebase. Dead subscriptions
 * (410/404) are pruned. Quiet hours + per-type toggles applied at target
 * selection (packages/db listPushTargets).
 */
export function startNotificationWorker() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const configured = Boolean(publicKey && privateKey);
  if (configured) {
    webpush.setVapidDetails("mailto:hello@dealdock.io", publicKey!, privateKey!);
  }
  const digestQueue = new Queue(QUEUES.notifications, { connection: redisConnection() });

  const worker = new Worker(
    QUEUES.notifications,
    async (job: Job) => {
      // Without VAPID a digest could never arrive, so leave the week unsent.
      if (job.name === WEEKLY_DIGEST_TICK) return configured ? produceWeeklyDigests(digestQueue) : { skipped: "vapid_not_configured" };
      const data = NotificationJob.parse(job.data);
      if (!configured) return { skipped: "vapid_not_configured" };

      const targets = await listPushTargets(asOrgId(data.orgId), data.kind);
      const payload = JSON.stringify(buildPayload(data));

      let sent = 0;
      for (const t of targets) {
        if (!isTrustedPushEndpoint(t.endpoint)) { await removeDeadSubscription(t.id); continue; }
        try {
          await webpush.sendNotification(
            { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
            payload
          );
          sent += 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await removeDeadSubscription(t.id);
        }
      }
      return { sent, targets: targets.length };
    },
    { connection: redisConnection(), concurrency: 4 }
  );

  worker.on("failed", (job, err) => {
    console.error(`notification job ${job?.id} failed: ${err.message}`);
  });
  worker.on("closed", () => void digestQueue.close());

  return worker;
}
