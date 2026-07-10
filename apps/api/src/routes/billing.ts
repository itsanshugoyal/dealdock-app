import type { FastifyInstance } from "fastify";
import { providerForRail, type BillingProvider } from "@dealdock/billing";
import {
  applyBillingEvent,
  getSubscription,
  markWebhookProcessed,
  recordWebhookEvent,
  requestCancellation,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { can } from "../permissions";
import { captureRawBody, rawBodyOf } from "../raw-body";

export async function billingRoutes(app: FastifyInstance) {
  /** Subscription state for the Settings → Billing panel (PRD §6.12). */
  app.get("/billing", { preHandler: requireAuth }, async (req) => {
    const sub = await getSubscription(req.auth!.orgId);
    if (!sub) return { status: "pilot_manual", rail: null };
    return {
      status: sub.status,
      rail: sub.rail,
      tier: sub.tier,
      checkoutUrl: sub.checkoutUrl, // creator opens this to authorize the mandate
      activeUseStartedAt: sub.activeUseStartedAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
    };
  });

  /**
   * Cancel — one confirmation, zero guilt UI (PRD §5.7). Runs to period end;
   * ledger stays read-only for 30 days after; CSV export always works.
   */
  app.post("/billing/cancel", { preHandler: requireAuth }, async (req, reply) => {
    const auth = req.auth!;
    if (!can(auth.role, "manage_billing")) {
      return reply.code(403).send({ error: "role_cannot_manage_billing" });
    }
    const sub = await requestCancellation(auth.orgId, auth.seatId);
    if (sub.externalId) {
      await providerForRail(sub.rail).cancelAtPeriodEnd(sub.externalId);
    }
    return { cancelled: true, runsUntil: sub.currentPeriodEnd };
  });

  /** Rail webhooks — verified, recorded, normalized, applied. Both rails. */
  const railWebhook = (path: string, provider: BillingProvider) => {
    app.post(path, { ...captureRawBody }, async (req, reply) => {
      if (!provider.verifyWebhook({ headers: req.headers, rawBody: rawBodyOf(req) })) {
        return reply.code(401).send();
      }
      const record = await recordWebhookEvent(provider.rail, req.body);
      for (const event of provider.parseEvents(req.body)) {
        const data = req.body as { data?: { id?: string } };
        await applyBillingEvent({
          externalId: event.externalId,
          kind: event.kind,
          currentPeriodEnd: event.currentPeriodEnd,
          // Paddle: first webhook carrying sub_… must match the provisional txn_… row.
          provisionalExternalId: data?.data?.id,
        });
      }
      await markWebhookProcessed(record.id);
      return reply.code(200).send({ ok: true });
    });
  };

  railWebhook("/webhooks/razorpay", providerForRail("razorpay"));
  railWebhook("/webhooks/paddle", providerForRail("paddle"));
}
