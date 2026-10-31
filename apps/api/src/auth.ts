import type { FastifyReply, FastifyRequest } from "fastify";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { activateInvitedSeat, asOrgId, findSeat, type OrgId } from "@dealdock/db";
import { bearerToken, organizationClaim, verifiedPrimaryEmail } from "./clerk-claims";

/**
 * Auth context attached to every authenticated request (ARCHITECTURE.md §6).
 * Clerk verifies identity; OUR Seat table is authoritative for permissions
 * (ADR-6) — a valid Clerk session without a seat in the org gets 403.
 */
export interface AuthContext {
  clerkUserId: string;
  orgId: OrgId;
  seatId: string;
  role: "creator" | "assistant" | "manager";
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const DEV_BYPASS_HEADER = "x-demo-org";

/**
 * preHandler: resolves AuthContext or replies 401/403.
 *
 * Local demo access is an explicit opt-in. It is deliberately unavailable in
 * production, and a request may only select the single seeded org configured
 * in DEALDOCK_DEV_ORG_ID; arbitrary org ids are never accepted from a header.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const secretKey = process.env.CLERK_SECRET_KEY;

  if (!secretKey) {
    const devAuthEnabled =
      process.env.NODE_ENV !== "production" &&
      process.env.DEALDOCK_DISABLE_AUTH === "true" &&
      Boolean(process.env.DEALDOCK_DEV_ORG_ID);
    if (!devAuthEnabled) {
      return reply.code(500).send({ error: "auth_not_configured" });
    }
    const demoOrg = req.headers[DEV_BYPASS_HEADER];
    if (typeof demoOrg !== "string" || demoOrg !== process.env.DEALDOCK_DEV_ORG_ID) {
      return reply
        .code(401)
        .send({ error: "unauthenticated", hint: `dev mode: set ${DEV_BYPASS_HEADER} for the configured demo org` });
    }
    const orgId = asOrgId(demoOrg);
    const seat = await findSeat(orgId, "user_demo_local");
    if (!seat) return reply.code(403).send({ error: "no_seat_in_org" });
    req.auth = { clerkUserId: "user_demo_local", orgId, seatId: seat.id, role: seat.role };
    return;
  }

  const token = bearerToken(req.headers.authorization);
  if (!token) return reply.code(401).send({ error: "unauthenticated" });

  let clerkUserId: string;
  let claimedOrgId: string | undefined;
  try {
    const claims = await verifyToken(token, { secretKey });
    clerkUserId = claims.sub;
    claimedOrgId = organizationClaim(claims as Record<string, unknown>);
  } catch {
    return reply.code(401).send({ error: "invalid_token" });
  }

  // A caller-controlled org header would turn one valid Clerk session into a
  // cross-org probing primitive. The signed Clerk organization claim is the
  // only organization selector in authenticated mode.
  if (!claimedOrgId) return reply.code(403).send({ error: "org_membership_required" });

  const orgId = asOrgId(claimedOrgId);
  const seat = await findSeat(orgId, clerkUserId);
  if (!seat) return reply.code(403).send({ error: "no_seat_in_org" });

  req.auth = { clerkUserId, orgId, seatId: seat.id, role: seat.role };
}

/**
 * Invites are activated only from a signed Clerk organisation claim and an
 * email Clerk itself reports as verified. The browser never supplies an email
 * or an organisation id, so it cannot claim somebody else's invitation.
 */
export async function activateVerifiedInvite(req: FastifyRequest, reply: FastifyReply) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return reply.code(503).send({ error: "invite_activation_unavailable" });
  const token = bearerToken(req.headers.authorization);
  if (!token) return reply.code(401).send({ error: "unauthenticated" });
  try {
    const claims = await verifyToken(token, { secretKey });
    const orgClaim = organizationClaim(claims as Record<string, unknown>);
    if (typeof orgClaim !== "string" || !orgClaim) return reply.code(403).send({ error: "org_membership_required" });
    const verifiedEmail = verifiedPrimaryEmail(await createClerkClient({ secretKey }).users.getUser(claims.sub));
    if (verifiedEmail === null) return reply.code(403).send({ error: "verified_email_required" });
    const seat = await activateInvitedSeat(asOrgId(orgClaim), { clerkUserId: claims.sub, verifiedEmail });
    if (!seat) return reply.code(404).send({ error: "matching_invitation_not_found" });
    return reply.code(200).send({ activated: true, seatId: seat.id, role: seat.role });
  } catch {
    return reply.code(401).send({ error: "invalid_token" });
  }
}
