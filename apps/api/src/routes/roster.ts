import type { FastifyInstance } from "fastify";
import { getRosterOverview } from "@dealdock/db";
import { requireAuth } from "../auth";
import { requirePermission } from "../guards";

export async function rosterRoutes(app: FastifyInstance) {
  /** Roster overview (PRD §5.6): per-account MTD recovered, priority, queue. */
  app.get(
    "/roster",
    { preHandler: [requireAuth, requirePermission("view_roster")] },
    async (req) => {
      const rows = await getRosterOverview(req.auth!.orgId);
      return { rows };
    }
  );
}
