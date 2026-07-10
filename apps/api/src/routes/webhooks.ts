import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IngestionJob } from "@dealdock/core";
import {
  findAccountByPlatformUserId,
  markWebhookProcessed,
  recordWebhookEvent,
} from "@dealdock/db";
import { InstagramGraphAdapter } from "@dealdock/messaging";
import { getIngestionQueue } from "../queues";

const MockWebhookBody = z.object({
  events: z.array(IngestionJob).min(1).max(500),
});

export async function webhookRoutes(app: FastifyInstance) {
  /**
   * Mock-provider webhook (M0): accepts InboundEvents, persists the raw
   * payload for audit/replay, enqueues ingestion jobs, returns 202 fast —
   * the same shape the real Instagram webhook receiver (M3) will follow.
   * Not registered in production environments.
   */
  if (process.env.NODE_ENV !== "production") {
    app.post("/webhooks/mock", async (req, reply) => {
      const parsed = MockWebhookBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_payload", detail: parsed.error.flatten() });
      }

      await recordWebhookEvent("mock", parsed.data);
      const queue = getIngestionQueue();
      await queue.addBulk(
        parsed.data.events.map((e) => ({ name: "inbound", data: e }))
      );

      return reply.code(202).send({ enqueued: parsed.data.events.length });
    });
  }

  /**
   * Meta webhook verification handshake (GET) — echoes hub.challenge when the
   * verify token matches (docs/meta-app-review.md §2).
   */
  app.get("/webhooks/instagram", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (
      q["hub.mode"] === "subscribe" &&
      q["hub.verify_token"] === process.env.META_WEBHOOK_VERIFY_TOKEN &&
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
      config: { rawBody: true },
      preParsing: async (req, _reply, payload) => {
        // Capture raw body for HMAC verification before JSON parsing.
        const chunks: Buffer[] = [];
        for await (const chunk of payload) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks);
        (req as { rawBody?: string }).rawBody = raw.toString("utf8");
        const { Readable } = await import("node:stream");
        return Readable.from(raw);
      },
    },
    async (req, reply) => {
      const adapter = new InstagramGraphAdapter();
      const rawBody = (req as { rawBody?: string }).rawBody ?? "";

      if (!adapter.verifyWebhook({ headers: req.headers, rawBody })) {
        return reply.code(401).send();
      }

      const record = await recordWebhookEvent("instagram", req.body);
      const events = adapter.parseWebhook(req.body);

      const queue = getIngestionQueue();
      let enqueued = 0;
      for (const event of events) {
        const account = await findAccountByPlatformUserId(event.accountPlatformUserId);
        if (!account) continue; // not one of ours (or disconnected) — ack and drop

        const job: IngestionJob = {
          orgId: account.orgId,
          igAccountId: account.id,
          igThreadId: event.message.platformThreadId,
          participantHandle: event.message.platformThreadId, // enriched by backfill pass
          participantIgId: event.message.platformThreadId,
          igMessageId: event.message.platformMessageId,
          direction: event.message.direction,
          contentType: event.message.text ? "text" : "attachment",
          text: event.message.text,
          sentAt: event.message.sentAt.toISOString(),
          source: "live",
          raw: event.message.raw,
        };
        await queue.add("instagram", job);
        enqueued += 1;
      }

      await markWebhookProcessed(record.id);
      return reply.code(200).send({ received: events.length, enqueued });
    }
  );
}
