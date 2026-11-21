import { Queue, Worker, type Job } from "bullmq";
import { QUEUES } from "@dealdock/core";
import { providerForCurrency, providerForRail } from "@dealdock/billing";
import {
  applyBillingEvent,
  asOrgId,
  listSubscriptionsDueFirstInvoice,
  listSubscriptionsForReconciliation,
  saveRailSubscription,
  claimFirstInvoice,
  releaseFirstInvoiceClaim,
} from "@dealdock/db";
import { redisConnection } from "../connection";

/** Hourly first-invoice pass. Exported for tests; returns how many orgs were due. */
export async function requestFirstInvoices(notify: (data: { orgId: string; kind: "billing_checkout_ready"; checkoutUrl: string | null }) => Promise<unknown>) {
  const due = await listSubscriptionsDueFirstInvoice();
  for (const d of due) {
    const provider = providerForCurrency(d.currencyCode);
    // Rail not set up yet (e.g. Paddle before approval): leave the org due, retry once it is.
    if (!provider.configured) continue;
    try {
      const claim = await claimFirstInvoice(asOrgId(d.orgId));
      if (!claim) continue;
      let created;
      try {
        created = await provider.createSubscription({
          orgId: d.orgId,
          tier: d.tier,
          currencyCode: d.currencyCode,
          customerEmail: d.creatorEmail,
          customerName: d.creatorName,
          requestKey: `subscription:${d.orgId}:${d.tier}`,
        });
      } catch (err) {
        if ((err as { definite?: boolean }).definite) {
          // The rail refused it, so nothing exists remotely: release so the next tick retries.
          await releaseFirstInvoiceClaim(asOrgId(d.orgId), claim.claimedAt);
          console.error(`billing: ${provider.rail} refused subscription for org ${d.orgId}: ${(err as Error).message}`);
        } else {
          // shortcut: a timeout/5xx may have created it remotely, so the claim stays and the org needs a manual check
          // in the rail dashboard; add a stale-claim sweep that reconciles by requestKey when volume makes this costly.
          console.error(`billing: NEEDS MANUAL CHECK, ${provider.rail} create was ambiguous for org ${d.orgId}: ${(err as Error).message}`);
        }
        continue;
      }
      const saved = await saveRailSubscription(asOrgId(d.orgId), created);
      if (!saved.saved) {
        await provider.cancelAtPeriodEnd(created.externalId);
        continue;
      }
      // Creator gets nudged to authorize the mandate (banner + push). GET /billing still has the link if this fails.
      await notify({
        orgId: d.orgId,
        kind: "billing_checkout_ready",
        checkoutUrl: created.checkoutUrl,
      });
    } catch (err) {
      // One org's failure must not hold up the rest of this tick.
      console.error(`billing: first invoice failed for org ${d.orgId}: ${(err as Error).message}`);
    }
  }
  return due.length;
}

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
        return { firstInvoicesRequested: await requestFirstInvoices((data) => notifications.add("billing-checkout-ready", data)) };
      }

      if (job.name === "reconcile-tick") {
        const subs = await listSubscriptionsForReconciliation();
        let reconciled = 0;
        for (const s of subs) {
          if (!s.externalId) continue;
          const snapshot = await providerForRail(s.rail).fetchStatus(s.externalId);
          if (snapshot.kind === "unknown") continue;
          const result = await applyBillingEvent({ externalId: s.externalId, rail:s.rail, ...snapshot });
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
