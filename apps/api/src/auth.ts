import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyToken } from "@clerk/backend";
import { asOrgId, findSeat, type OrgId } from "@dealdock/db";

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
 * Local M0 demo mode: when CLERK_SECRET_KEY is unset AND not production,
 * the `x-demo-org` header selects the org (seeded demo). This path is
 * structurally impossible in production — the key check comes first.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const secretKey = process.env.CLERK_SECRET_KEY;

  if (!secretKey) {
    if (process.env.NODE_ENV === "production") {
      return reply.code(500).send({ error: "auth_not_configured" });
    }
    const demoOrg = req.headers[DEV_BYPASS_HEADER];
    if (typeof demoOrg !== "string" || !demoOrg) {
      return reply
        .code(401)
        .send({ error: "unauthenticated", hint: `dev mode: set ${DEV_BYPASS_HEADER} header` });
    }
    const orgId = asOrgId(demoOrg);
    const seat = await findSeat(orgId, "user_demo_local");
    if (!seat) return reply.code(403).send({ error: "no_seat_in_org" });
    req.auth = { clerkUserId: "user_demo_local", orgId, seatId: seat.id, role: seat.role };
    return;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return reply.code(401).send({ error: "unauthenticated" });

  let clerkUserId: string;
  let claimedOrgId: string | undefined;
  try {
    const claims = await verifyToken(token, { secretKey });
    clerkUserId = claims.sub;
    claimedOrgId = (claims as Record<string, unknown>)["org_id"] as string | undefined;
  } catch {
    return reply.code(401).send({ error: "invalid_token" });
  }

  const orgIdRaw = claimedOrgId ?? (req.headers["x-org-id"] as string | undefined);
  if (!orgIdRaw) return reply.code(400).send({ error: "org_not_specified" });

  const orgId = asOrgId(orgIdRaw);
  const seat = await findSeat(orgId, clerkUserId);
  if (!seat) return reply.code(403).send({ error: "no_seat_in_org" });

  req.auth = { clerkUserId, orgId, seatId: seat.id, role: seat.role };
}
