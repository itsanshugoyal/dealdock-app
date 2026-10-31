import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CLASSIFICATION_LABELS, type InboxResponse } from "@dealdock/core";
import { listInboxPage, markActiveUseStarted } from "@dealdock/db";
import { requireAuth } from "../auth";
import { toInboxRow } from "../dto/inbox";
import { isHumanAgentEnabled } from "../feature-flags";

const InboxQuery = z.object({
  // v1 clients sent anything here; unknown states still mean the open inbox.
  state: z.enum(["open", "waiting", "closed"]).catch("open"),
  label: z.enum(CLASSIFICATION_LABELS).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).max(512).optional(),
});

export async function inboxRoutes(app: FastifyInstance) {
  /** Revenue Inbox v2 (PRD §6.3): state/label filters, search, keyset paging. */
  app.get("/inbox", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = InboxQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const auth = req.auth!;
    // First real inbox interaction starts the 7-day billing clock (PRD §6.12).
    await markActiveUseStarted(auth.orgId);
    const now = new Date();
    const page = await listInboxPage(auth.orgId, { ...parsed.data, q: parsed.data.q || undefined, now });
    const humanAgentEnabled = isHumanAgentEnabled();
    return {
      rows: page.rows.map((row) => toInboxRow(row, now, humanAgentEnabled)),
      nextCursor: page.nextCursor,
    } satisfies InboxResponse;
  });

  app.get("/me", { preHandler: requireAuth }, async (req) => {
    const { clerkUserId, orgId, role } = req.auth!;
    return { clerkUserId, orgId, role };
  });
}
