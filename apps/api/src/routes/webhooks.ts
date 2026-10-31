import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IngestionJob } from "@dealdock/core";
import {
  findAccountByPlatformUserId,
  markWebhookProcessed,
  recordWebhookIngress,
} from "@dealdock/db";
import { ingestionContent, ingestionDedupeKey } from "@dealdock/messaging";
import { captureRawBody, rawBodyOf } from "../raw-body";
import { getGraphAdapter } from "../graph";

const MockWebhookBody = z.object({
  events: z.array(IngestionJob).min(1).max(500),
});

export async function webhookRoutes(app: FastifyInstance) {
  /**
   * Mock-provider webhook (M0): accepts InboundEvents with an ARBITRARY orgId,
   * so it is a privileged fixture-injection path. Gated on BOTH a
   * non-production build AND a shared secret (x-mock-secret) — NODE_ENV alone
   * is a deployment convention, not an auth control (F4). If MOCK_WEBHOOK_SECRET
   * is unset the route is never registered at all.
   */
  const mockSecret = process.env.MOCK_WEBHOOK_SECRET;
  if (process.env.NODE_ENV !== "production" && mockSecret) {
    app.post("/webhooks/mock", async (req, reply) => {
      const provided = req.headers["x-mock-secret"];
      const header = Array.isArray(provided) ? provided[0] : provided;
      if (
        !header ||
        header.length !== mockSecret.length ||
        !timingSafeEqual(Buffer.from(header), Buffer.from(mockSecret))
      ) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const parsed = MockWebhookBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_payload", detail: parsed.error.flatten() });
      }

      const persisted = await recordWebhookIngress("mock", { eventCount: parsed.data.events.length }, parsed.data.events.map((event) => ({
        orgId: event.orgId as never,
        dedupeKey: `mock:ingestion:${event.igMessageId}`,
        payload: event,
      })));
      if (persisted.webhookEventId) await markWebhookProcessed(persisted.webhookEventId);
      return reply.code(202).send({ accepted: persisted.outbox.length, deduplicated: persisted.deduplicated });
    });
  }

  /**
   * Meta webhook verification handshake (GET) — echoes hub.challenge when the
   * verify token matches (docs/meta-app-review.md §2).
   */
  app.get("/webhooks/instagram", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (
      verifyToken &&
      q["hub.mode"] === "subscribe" &&
      q["hub.verify_token"] === verifyToken &&
      q["hub.challenge"]
    ) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send();
  });

  /**
   * Instagram messages webhook: signature-verified (X-Hub-Signature-256),
   * raw payload persisted for audit/replay, events resolved to orgs by the
   * business IGSID, enqueued, 200 fast (ARCHITECTURE.md §4.3).
   */
  app.post(
    "/webhooks/instagram",
    {
      ...captureRawBody(),
    },
    async (req, reply) => {
      const adapter = getGraphAdapter();
      const rawBody = rawBodyOf(req);

      if (!adapter.verifyWebhook({ headers: req.headers, rawBody })) {
        return reply.code(401).send();
      }

      const events = adapter.parseWebhook(req.body);
      const normalized: IngestionJob[] = [];
      for (const event of events) {
        const account = await findAccountByPlatformUserId(event.accountPlatformUserId);
        if (!account) continue; // not one of ours (or disconnected) — ack and drop

        normalized.push({
          orgId: account.orgId,
          igAccountId: account.id,
          igThreadId: event.message.platformThreadId,
          // Webhooks carry only the IGSID. No Graph call here (it would spend the
          // per-account budget that human sends need on every new DM): the real
          // username replaces this placeholder when the backfill's conversation
          // list or the thread's profile refresh supplies it (05b gap 13).
          participantHandle: event.message.platformThreadId,
          participantIgId: event.message.platformThreadId,
          igMessageId: event.message.platformMessageId,
          direction: event.message.direction,
          // Voice notes → contentType "audio" + their expiring CDN URL (F8).
          ...ingestionContent(event.message),
          text: event.message.text,
          sentAt: event.message.sentAt.toISOString(),
          source: "live",
          raw: event.message.raw,
        });
      }
      // DM content lives only in its tenant-scoped outbox/message row. A
      // provider batch can contain several tenants, so never retain it globally.
      const persisted = await recordWebhookIngress("instagram", { eventCount: events.length }, normalized.map((event) => ({
        orgId: event.orgId as never,
        // Shared with the Graph backfill, so a message both deliver is ingested once.
        dedupeKey: ingestionDedupeKey(event.igAccountId, event.igMessageId),
        payload: event,
      })));
      if (persisted.webhookEventId) await markWebhookProcessed(persisted.webhookEventId);
      return reply.code(200).send({ received: events.length, accepted: persisted.outbox.length, deduplicated: persisted.deduplicated });
    }
  );
}
