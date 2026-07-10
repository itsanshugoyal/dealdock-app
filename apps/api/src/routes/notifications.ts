import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deletePushSubscription, savePushSubscription, updatePushPrefs } from "@dealdock/db";
import { requireAuth } from "../auth";

const SubscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

const PrefsBody = z.object({
  notifyHighValue: z.boolean().optional(),
  notifyNudge: z.boolean().optional(),
  notifyWeeklySummary: z.boolean().optional(),
});

export async function notificationRoutes(app: FastifyInstance) {
  /** Web Push subscription (PRD §6.8) — stored per seat, VAPID on the worker side. */
  app.post("/notifications/subscribe", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    await savePushSubscription(req.auth!.orgId, req.auth!.seatId, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });
    return { subscribed: true };
  });

  app.delete("/notifications/subscribe", { preHandler: requireAuth }, async (req, reply) => {
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    if (!endpoint) return reply.code(400).send({ error: "endpoint_required" });
    await deletePushSubscription(req.auth!.orgId, endpoint);
    return { unsubscribed: true };
  });

  /** Per-type toggles (PRD §6.8) — every notification kind individually controllable. */
  app.put("/notifications/prefs", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = PrefsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    await updatePushPrefs(req.auth!.orgId, req.auth!.seatId, parsed.data);
    return { updated: true };
  });
}
