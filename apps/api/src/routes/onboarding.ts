import type { FastifyInstance } from "fastify";
import type { IngestionJob } from "@dealdock/core";
import { getLeakScanSummary, getOrganization } from "@dealdock/db";
import { MockInstagramAdapter } from "@dealdock/messaging";
import { requireAuth } from "../auth";
import { getIngestionQueue } from "../queues";

export async function onboardingRoutes(app: FastifyInstance) {
  /**
   * Leak Scan trigger (PRD §5.1.6): backfills the last 30 days of history
   * through the SAME ingestion→classification pipeline, tagged source=leak_scan
   * (batch mode of ARCHITECTURE.md §5.1 — no separate code path, no drafts).
   */
  app.post("/onboarding/leak-scan", { preHandler: requireAuth }, async (req, reply) => {
    const auth = req.auth!;
    const org = await getOrganization(auth.orgId);
    const account = org?.igAccounts[0];
    if (!account) return reply.code(409).send({ error: "no_connected_account" });
    if (account.provider !== "mock") {
      return reply.code(409).send({ error: "graph_backfill_lands_in_m3" });
    }

    const adapter = new MockInstagramAdapter();
    const connected = {
      accountId: account.id,
      platformUserId: account.igUserId,
      handle: account.handle,
      accessToken: "",
    };
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const threads = await adapter.listConversations(connected, since);

    const jobs: Array<{ name: string; data: IngestionJob }> = [];
    for (const t of threads) {
      const messages = await adapter.fetchMessages(connected, t.platformThreadId, since);
      for (const m of messages) {
        jobs.push({
          name: "leak-scan",
          data: {
            orgId: auth.orgId,
            igAccountId: account.id,
            igThreadId: t.platformThreadId,
            participantHandle: t.participantHandle,
            participantIgId: t.participantPlatformId,
            igMessageId: m.platformMessageId,
            direction: m.direction,
            contentType: "text",
            text: m.text,
            sentAt: m.sentAt.toISOString(),
            source: "leak_scan",
            raw: m.raw,
          },
        });
      }
    }
    await getIngestionQueue().addBulk(jobs);
    return reply.code(202).send({ enqueued: jobs.length });
  });

  /** Poll for the reveal numbers while the batch classifies. */
  app.get("/onboarding/leak-scan", { preHandler: requireAuth }, async (req) => {
    return getLeakScanSummary(req.auth!.orgId);
  });
}
