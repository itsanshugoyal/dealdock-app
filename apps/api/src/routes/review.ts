import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listReviewQueue, reviewClassification } from "@dealdock/db";
import { requireAuth } from "../auth";
import { requirePermission, requireWritable } from "../guards";

const ReviewBody = z.object({
  outcome: z.enum(["confirmed", "overridden"]),
  overrideLabel: z
    .enum([
      "brand_deal",
      "coaching_lead",
      "course_inquiry",
      "other_commerce",
      "fan",
      "spam",
      "personal",
      "uncertain",
    ])
    .optional(),
});

export async function reviewRoutes(app: FastifyInstance) {
  app.get("/review-queue", { preHandler: requireAuth }, async (req) => {
    const rows = await listReviewQueue(req.auth!.orgId);
    return { rows };
  });

  /** Confirm/override — corrections train the creator's classifier (PRD §6.6). */
  app.post(
    "/classifications/:id/review",
    { preHandler: [requireAuth, requireWritable, requirePermission("review")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ReviewBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const updated = await reviewClassification(req.auth!.orgId, {
        classificationId: id,
        seatId: req.auth!.seatId,
        outcome: parsed.data.outcome,
        overrideLabel: parsed.data.overrideLabel,
      });
      return { label: updated.label, outcome: updated.reviewOutcome };
    }
  );
}
