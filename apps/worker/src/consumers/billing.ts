import { Queue, Worker, type Job } from "bullmq";
import { QUEUES } from "@dealdock/core";
import { providerForCurrency, providerForRail } from "@dealdock/billing";
import {
  applyBillingEvent,
  asOrgId,
  listSubscriptionsDueFirstInvoice,
  listSubscriptionsForReconciliation,
  saveRailSubscription,
} from "@dealdock/db";
import { redisConnection } from "../connection";

/**
 * Billing scheduler (ARCHITECTURE.md §9, PRD §6.12):
 *  - hourly: orgs past the 7-day active-use gate → create the rail
 *    subscription → store the mandate/checkout URL the creator authorizes.
 *    Invoiced-after-the-fact trust mechanics, not a free trial.
 *  - daily: reconciliation poller — webhooks get lost; remote status wins.
 */
export function startBillingScheduler() {
  const queue = new Queue(QUEUES.billing, { connection: redisConnection() });
  const notifications = new Queue(QUEUES.notifications, { connection: redisConnection() });

  void queue.upsertJobScheduler("first-invoice-tick", { every: 60 * 60_000 });
  void queue.upsertJobScheduler("reconcile-tick", { every: 24 * 60 * 60_000 });

  const worker = new Worker(
    QUEUES.billing,
    async (job: Job) => {
      if (job.name === "first-invoice-tick") {
        const due = await listSubscriptionsDueFirstInvoice();
        for (const d of due) {
          const provider = providerForCurrency(d.currencyCode);
          const created = await provider.createSubscription({
            orgId: d.orgId,
            tier: d.tier,
            currencyCode: d.currencyCode,
            customerEmail: d.creatorEmail,
            customerName: d.creatorName,
          });
          await saveRailSubscription(asOrgId(d.orgId), created);
          // Creator gets nudged to authorize the mandate (banner + push).
          await notifications.add("billing-checkout-ready", {
            orgId: d.orgId,
            kind: "billing_checkout_ready",
            checkoutUrl: created.checkoutUrl,
          });
        }
        return { firstInvoicesRequested: due.length };
      }

      if (job.name === "reconcile-tick") {
        const subs = await listSubscriptionsForReconciliation();
        let reconciled = 0;
        for (const s of subs) {
          if (!s.externalId) continue;
          const kind = await providerForRail(s.rail).fetchStatus(s.externalId);
          if (kind === "unknown") continue;
          const result = await applyBillingEvent({ externalId: s.externalId, kind });
          if (result.applied) reconciled += 1;
        }
        return { reconciled };
      }

      return { skipped: job.name };
    },
    { connection: redisConnection(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`billing job ${job?.name} failed: ${err.message}`);
  });

  return worker;
}
