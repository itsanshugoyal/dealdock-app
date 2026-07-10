import { Worker, type Job } from "bullmq";
import webpush from "web-push";
import { z } from "zod";
import { formatMoneyCompact, QUEUES, type CurrencyCode } from "@dealdock/core";
import { asOrgId, listPushTargets, removeDeadSubscription } from "@dealdock/db";
import { redisConnection } from "../connection";

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
 * Web Push sender (ADR-10): standard VAPID, no Firebase. Dead subscriptions
 * (410/404) are pruned. Quiet hours + per-type toggles applied at target
 * selection (packages/db listPushTargets).
 */
export function startNotificationWorker() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const configured = Boolean(publicKey && privateKey);
  if (configured) {
    webpush.setVapidDetails("mailto:founders@dealdock.in", publicKey!, privateKey!);
  }

  const worker = new Worker(
    QUEUES.notifications,
    async (job: Job) => {
      const data = NotificationJob.parse(job.data);
      if (!configured) return { skipped: "vapid_not_configured" };

      const targets = await listPushTargets(asOrgId(data.orgId), data.kind);
      const payload = JSON.stringify(buildPayload(data));

      let sent = 0;
      for (const t of targets) {
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

  return worker;
}
