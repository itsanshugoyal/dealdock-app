import type { FastifyReply, FastifyRequest } from "fastify";
import { isOrgReadOnly } from "@dealdock/db";
import { can, type PermissionAction } from "./permissions";

/**
 * Write guard (PRD §5.7): a cancelled org past its period end is read-only —
 * Revenue Ledger stays viewable for 30 days and CSV export always works, but
 * nothing mutates. Composes AFTER requireAuth.
 */
export async function requireWritable(req: FastifyRequest, reply: FastifyReply) {
  if (!req.auth) return reply.code(401).send({ error: "unauthenticated" });
  if (await isOrgReadOnly(req.auth.orgId)) {
    return reply.code(403).send({
      error: "org_read_only",
      hint: "Subscription ended — ledger is read-only. Export CSV anytime, or resubscribe to continue.",
    });
  }
}

/** Role guard factory: requirePermission("manage_seats") etc. */
export function requirePermission(action: PermissionAction) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) return reply.code(401).send({ error: "unauthenticated" });
    if (!can(req.auth.role, action)) {
      return reply.code(403).send({ error: "forbidden", action });
    }
  };
}
