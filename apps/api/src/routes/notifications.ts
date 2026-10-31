import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isTrustedPushEndpoint } from "@dealdock/core";
import { deletePushSubscription, getPushPreferences, savePushSubscription, updatePushPrefs } from "@dealdock/db";
import { requireAuth } from "../auth";
import { requireWritable } from "../guards";

const SubscribeBody = z.object({
  endpoint: z.string().url().refine(isTrustedPushEndpoint, "Unsupported browser push service"),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}(==)?$/) }),
});

const PrefsBody = z.object({
  notifyHighValue: z.boolean().optional(),
  notifyNudge: z.boolean().optional(),
  notifyWeeklySummary: z.boolean().optional(),
});

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/notifications/prefs", { preHandler: requireAuth }, async (req) =>
    getPushPreferences(req.auth!.orgId, req.auth!.seatId)
  );
  /** Web Push subscription (PRD §6.8) — stored per seat, VAPID on the worker side. */
  app.post("/notifications/subscribe", { preHandler: [requireAuth, requireWritable] }, async (req, reply) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    await savePushSubscription(req.auth!.orgId, req.auth!.seatId, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });
    return { subscribed: true };
  });

  app.delete("/notifications/subscribe", { preHandler: [requireAuth, requireWritable] }, async (req, reply) => {
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    if (!endpoint) return reply.code(400).send({ error: "endpoint_required" });
    await deletePushSubscription(req.auth!.orgId, endpoint);
    return { unsubscribed: true };
  });

  /**
   * Per-type toggles (PRD §6.8) — every notification kind individually
   * controllable, including the Monday weekly summary (worker digest producer).
   */
  app.put("/notifications/prefs", { preHandler: [requireAuth, requireWritable] }, async (req, reply) => {
    const parsed = PrefsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    await updatePushPrefs(req.auth!.orgId, req.auth!.seatId, parsed.data);
    return { updated: true };
  });
}
