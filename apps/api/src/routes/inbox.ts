import type { FastifyInstance } from "fastify";
import { listInboxThreads, markActiveUseStarted } from "@dealdock/db";
import { requireAuth } from "../auth";

export async function inboxRoutes(app: FastifyInstance) {
  /** Revenue Inbox (M0 slice: state filter + default sort; full §6.3 filters in M1). */
  app.get("/inbox", { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    // First real inbox interaction starts the 7-day billing clock (PRD §6.12).
    await markActiveUseStarted(auth.orgId);
    const state = (req.query as Record<string, string>)["state"];
    const rows = await listInboxThreads(auth.orgId, {
      state: state === "waiting" || state === "closed" ? state : "open",
      limit: 50,
    });
    return { rows };
  });

  app.get("/me", { preHandler: requireAuth }, async (req) => {
    const { clerkUserId, orgId, role } = req.auth!;
    return { clerkUserId, orgId, role };
  });
}
