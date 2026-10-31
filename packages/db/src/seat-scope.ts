import { DomainError } from "@dealdock/core";
import type { Prisma, SeatRole } from "@prisma/client";
import { prisma } from "./client";
import type { OrgId } from "./org-id";

/** The shared client, or a transaction's when the check belongs inside one. */
type ScopeClient = Pick<Prisma.TransactionClient, "seat" | "igAccount">;

/**
 * Actor attribution is tenant-scoped too; a foreign seat is never an actor.
 * Callers that report a more specific code (send_seat_not_in_org) pass it.
 */
export async function requireSeatInOrg(
  orgId: OrgId,
  seatId: string,
  client: ScopeClient = prisma,
  code = "seat_not_in_org",
): Promise<{ id: string; role: SeatRole }> {
  const seat = await client.seat.findFirst({ where: { id: seatId, orgId }, select: { id: true, role: true } });
  if (!seat) throw new DomainError(code, 404);
  return seat;
}

/** An account id from a request must be this org's before anything reads or writes through it. */
export async function requireIgAccountInOrg(orgId: OrgId, igAccountId: string, client: ScopeClient = prisma): Promise<{ id: string }> {
  const account = await client.igAccount.findFirst({ where: { id: igAccountId, orgId }, select: { id: true } });
  if (!account) throw new DomainError("ig_account_not_in_org", 404);
  return account;
}
