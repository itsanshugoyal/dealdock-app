import type { FastifyInstance } from "fastify";
import { providerForRail, type BillingProvider } from "@dealdock/billing";
import {
  applyBillingEvent,
  getSubscription,
  markWebhookProcessed,
  recordWebhookEvent,
  requestCancellation,
  scopeWebhookEventToOrg,
  asOrgId,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { requirePermission, requireWritable } from "../guards";
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
  app.post("/billing/cancel", { preHandler: [requireAuth, requireWritable, requirePermission("manage_billing")] }, async (req, reply) => {
    const auth = req.auth!;
    const sub = await getSubscription(auth.orgId);
    if (!sub) return reply.code(409).send({ error: "no_subscription" });

    // Cancel on the rail FIRST — only persist cancelledAt once the rail has
    // confirmed (F8). Persisting first would let a rail failure leave us showing
    // "cancelled" while the subscription stays live and keeps charging.
    if (sub.externalId) {
      try {
        await providerForRail(sub.rail).cancelAtPeriodEnd(sub.externalId);
      } catch (err) {
        req.log.error({ err: (err as Error).message, orgId: auth.orgId }, "rail cancel failed");
        return reply.code(502).send({ error: "cancel_failed_at_rail" });
      }
    }
    const persisted = await requestCancellation(auth.orgId, auth.seatId);
    return { cancelled: true, runsUntil: persisted.currentPeriodEnd };
  });

  /** Rail webhooks — verified, recorded, normalized, applied. Both rails. */
  const railWebhook = (path: string, provider: BillingProvider) => {
    app.post(path, { ...captureRawBody() }, async (req, reply) => {
      if (!provider.verifyWebhook({ headers: req.headers, rawBody: rawBodyOf(req) })) {
        return reply.code(401).send();
      }
      const record = await recordWebhookEvent(provider.rail, req.body);
      const data = req.body as { data?: { id?: string } };
      const unresolved: string[] = [];
      for (const event of provider.parseEvents(req.body)) {
        const result = await applyBillingEvent({
          rail: provider.rail,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          externalId: event.externalId,
          kind: event.kind,
          currentPeriodEnd: event.currentPeriodEnd,
          // Paddle: first webhook carrying sub_… must match the provisional txn_… row.
          provisionalExternalId: event.provisionalExternalId,
          // Durable resolution when the external id doesn't match our row yet.
          orgId: event.orgId,
        });
        if ("orgId" in result && result.orgId) await scopeWebhookEventToOrg(record.id, asOrgId(result.orgId));
        // A financial event we couldn't apply must never be silently swallowed:
        // record it on the WebhookEvent row and log for the reconciliation pass.
        if (!result.applied) {
          unresolved.push(`${event.kind}:${event.externalId}:${result.reason}`);
          req.log.warn(
            { rail: provider.rail, event: event.kind, externalId: event.externalId, reason: result.reason },
            "billing event not applied"
          );
        }
      }
      await markWebhookProcessed(record.id, unresolved.length ? unresolved.join("; ") : undefined);
      return reply.code(200).send({ ok: true, unresolved: unresolved.length });
    });
  };

  railWebhook("/webhooks/razorpay", providerForRail("razorpay"));
  railWebhook("/webhooks/paddle", providerForRail("paddle"));
}
