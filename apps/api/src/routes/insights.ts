import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Insights } from "@dealdock/core";
import { getInsights } from "@dealdock/db";
import { requireAuth } from "../auth";

const InsightsQuery = z.object({
  months: z.coerce.number().int().min(1).max(12).default(6),
});

export async function insightRoutes(app: FastifyInstance) {
  /** Today + Revenue numbers (F7): goal, trend, mix, pipeline, speed, voice, leak, top deals. */
  app.get("/insights", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = InsightsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    return (await getInsights(req.auth!.orgId, { months: parsed.data.months })) satisfies Insights;
  });
}
