import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TIER_LIMITS } from "@dealdock/core";
import { inviteSeat, listSeats, removeSeat } from "@dealdock/db";
import { requireAuth } from "../auth";
import { requirePermission, requireWritable } from "../guards";

const InviteBody = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional(),
  role: z.enum(["assistant", "manager"]), // a second creator seat never exists
});

export async function seatRoutes(app: FastifyInstance) {
  app.get("/seats", { preHandler: requireAuth }, async (req) => {
    const seats = await listSeats(req.auth!.orgId);
    const limits = TIER_LIMITS;
    return { seats, limits };
  });

  /**
   * Invite a seat (PRD §6.10): tier limits enforced server-side —
   * Solo=1 seat, Studio=2 (creator+assistant), Roster=multi-manager.
   * The invited user activates the seat on first Clerk sign-in (email match).
   */
  app.post(
    "/seats/invite",
    { preHandler: [requireAuth, requireWritable, requirePermission("manage_seats")] },
    async (req, reply) => {
      const parsed = InviteBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      try {
        const seat = await inviteSeat(req.auth!.orgId, {
          email: parsed.data.email,
          name: parsed.data.name,
          role: parsed.data.role,
          invitedBySeatId: req.auth!.seatId,
        });
        return { seatId: seat.id, role: seat.role };
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("seat_limit")) {
          return reply.code(409).send({
            error: "seat_limit_reached",
            hint: "Upgrade the tier to add more seats.",
          });
        }
        if (message.includes("role_not_allowed")) {
          return reply.code(409).send({
            error: "role_not_allowed_on_tier",
            hint: "Managers are a Roster-tier feature; Studio adds one assistant.",
          });
        }
        throw err;
      }
    }
  );

  app.delete(
    "/seats/:id",
    { preHandler: [requireAuth, requireWritable, requirePermission("manage_seats")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id === req.auth!.seatId) {
        return reply.code(409).send({ error: "cannot_remove_own_seat" });
      }
      await removeSeat(req.auth!.orgId, id, req.auth!.seatId);
      return { removed: true };
    }
  );
}
