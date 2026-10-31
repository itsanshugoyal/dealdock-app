import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditRow } from "@dealdock/core";
import { listAuditRows } from "@dealdock/db";
import { requireAuth } from "../auth";
import { requirePermission } from "../guards";

const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function auditRoutes(app: FastifyInstance) {
  /**
   * Who sent what (F11). Rows carry drafted vs sent DM text, so only the
   * roles that may already take the full archive (creator, manager) read it.
   */
  app.get("/audit", { preHandler: [requireAuth, requirePermission("export_data")] }, async (req, reply) => {
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    return { rows: await listAuditRows(req.auth!.orgId, parsed.data.limit) } satisfies { rows: AuditRow[] };
  });
}
