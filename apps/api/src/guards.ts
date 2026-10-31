import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isOrgReadOnly, resolveVoiceAccount, type OrgId } from "@dealdock/db";
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

/** A connected Instagram account named in a body or query. */
export const IgAccountId = z.string().min(1).max(64);

/** A body or query whose only field is the optional account. */
export const AccountRef = z.object({ igAccountId: IgAccountId.optional() });

/**
 * The account a request is about (db resolveVoiceAccount): the given id (404
 * when it is not this org's), else the org's first active account by
 * connectedAt, else its first account of any status. When the org has no
 * account at all this replies 409 no_connected_account and returns null, so
 * the handler just returns.
 */
export async function requireIgAccount(orgId: OrgId, igAccountId: string | undefined, reply: FastifyReply) {
  const account = await resolveVoiceAccount(orgId, igAccountId);
  if (!account) reply.code(409).send({ error: "no_connected_account" });
  return account;
}
