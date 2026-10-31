import { Prisma } from "@prisma/client";
import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { minorUnitsToNumber } from "../money";
import { requireSeatInOrg } from "../seat-scope";
import { startOfZonedMonth } from "../zoned-time";

/**
 * Seat management (PRD §6.10). Tier limits enforced HERE — the repo is the
 * chokepoint, so no route can bypass them:
 *   solo: 1 seat (creator only) · studio: 2 (creator + 1 assistant) ·
 *   roster: creator + managers (no hard cap in pilot), assistants not a roster concept.
 */

const SEAT_RULES: Record<
  string,
  { maxSeats: number | null; allowedInviteRoles: Array<"assistant" | "manager"> }
> = {
  solo: { maxSeats: 1, allowedInviteRoles: [] },
  studio: { maxSeats: 2, allowedInviteRoles: ["assistant"] },
  roster: { maxSeats: null, allowedInviteRoles: ["manager"] },
};

export async function listSeats(orgId: OrgId) {
  const seats = await prisma.seat.findMany({
    where: { orgId },
    include: { user: { select: { email: true, name: true, clerkUserId: true } } },
    orderBy: { createdAt: "asc" },
  });
  return seats.map((s) => ({
    id: s.id,
    role: s.role,
    email: s.user.email,
    name: s.user.name,
    activated: !s.user.clerkUserId.startsWith("invited:"),
    createdAt: s.createdAt,
  }));
}

export async function inviteSeat(
  orgId: OrgId,
  input: {
    email: string;
    name?: string;
    role: "assistant" | "manager";
    invitedBySeatId: string;
  }
) {
  // Serializable isolation makes the count-then-insert atomic against a
  // concurrent invite (F6): two racing invites can't both read a stale count
  // and both commit past the tier cap — one aborts and the caller can retry.
  return prisma.$transaction(
    async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: orgId },
        select: { tier: true },
      });
      if (!org) throw new DomainError("org not found", 404);

      const rules = SEAT_RULES[org.tier]!;
      if (!rules.allowedInviteRoles.includes(input.role)) {
        throw new DomainError(`role_not_allowed: ${input.role} on ${org.tier}`, 409);
      }
      const seatCount = await tx.seat.count({ where: { orgId } });
      if (rules.maxSeats !== null && seatCount >= rules.maxSeats) {
        throw new DomainError(`seat_limit: ${org.tier} allows ${rules.maxSeats}`, 409);
      }

      // Placeholder identity until first Clerk sign-in with a matching email
      // swaps the real clerkUserId in (auth middleware handles the claim).
      const user = await tx.user.upsert({
        where: { clerkUserId: `invited:${input.email.toLowerCase()}` },
        create: {
          clerkUserId: `invited:${input.email.toLowerCase()}`,
          email: input.email.toLowerCase(),
          name: input.name,
        },
        update: { name: input.name },
      });

      const seat = await tx.seat.create({
        data: { orgId, userId: user.id, role: input.role },
      });

      await writeAudit(tx, {
        orgId,
        seatId: input.invitedBySeatId,
        action: "seat.invited",
        entityType: "seat",
        entityId: seat.id,
        detail: { email: input.email, role: input.role },
      });

      return seat;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function removeSeat(orgId: OrgId, seatId: string, removedBySeatId: string) {
  return prisma.$transaction(async (tx) => {
    const seat = await requireSeatInOrg(orgId, seatId, tx, "seat not in org");
    if (seat.role === "creator") throw new DomainError("cannot_remove_creator", 409);

    await tx.seat.delete({ where: { id: seat.id } });
    await writeAudit(tx, {
      orgId,
      seatId: removedBySeatId,
      action: "seat.removed",
      entityType: "seat",
      entityId: seat.id,
      detail: { role: seat.role },
    });
  });
}

/**
 * Bind an invitation to the Clerk identity only after the API has obtained a
 * verified primary email from Clerk itself. Neither an arbitrary request email
 * nor a bare invitation id can claim a seat.
 */
export async function activateInvitedSeat(
  orgId: OrgId,
  input: { clerkUserId: string; verifiedEmail: string },
) {
  const email = input.verifiedEmail.trim().toLowerCase();
  if (!email || !input.clerkUserId.trim()) throw new Error("invalid_verified_identity");
  const placeholder = `invited:${email}`;
  return prisma.$transaction(async (tx) => {
    const invited = await tx.seat.findFirst({
      where: { orgId, user: { clerkUserId: placeholder, email } },
      include: { user: true },
    });
    if (!invited) return null;
    const already = await tx.user.findUnique({ where: { clerkUserId: input.clerkUserId } });
    if (already && already.id !== invited.userId) {
      const existingSeat = await tx.seat.findUnique({
        where: { orgId_userId: { orgId, userId: already.id } },
      });
      if (existingSeat) {
        // A duplicate/late invitation cannot overwrite the role already held
        // by the verified identity. Remove only this unused placeholder seat.
        await tx.seat.delete({ where: { id: invited.id } });
        return existingSeat;
      }
      const claimed = await tx.seat.update({ where: { id: invited.id }, data: { userId: already.id } });
      const remaining = await tx.seat.count({ where: { userId: invited.userId } });
      if (remaining === 0) await tx.user.delete({ where: { id: invited.userId } });
      return claimed;
    }
    if (already) return tx.seat.findUniqueOrThrow({ where: { id: invited.id } });
    await tx.user.update({
      where: { id: invited.userId },
      data: { clerkUserId: input.clerkUserId, email },
    });
    return tx.seat.findUniqueOrThrow({ where: { id: invited.id } });
  });
}

/** Roster overview rollups (PRD §5.6.1): one row per connected account. */
export async function getRosterOverview(orgId: OrgId) {
  const [accounts, org] = await Promise.all([
    prisma.igAccount.findMany({
      where: { orgId },
      select: { id: true, handle: true, status: true },
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }),
  ]);
  if (!org) throw new DomainError("org_not_found", 404);

  // The org's calendar month, not the server's: a sale at 01:00 IST on the 1st is this month's.
  const monthStart = startOfZonedMonth(new Date(), org.timezone);

  const rows = [];
  for (const account of accounts) {
    const [recovered, highPriority, reviewCount] = await Promise.all([
      prisma.ledgerEntry.aggregate({
        where: {
          orgId,
          deletedAt: null,
          closedAt: { gte: monthStart },
          thread: { igAccountId: account.id },
        },
        _sum: { amountMinor: true },
      }),
      prisma.thread.count({
        where: {
          orgId,
          igAccountId: account.id,
          state: "open",
          estValueMaxMinor: { not: null },
          lastOutboundAt: null,
        },
      }),
      prisma.classification.count({
        where: {
          orgId,
          routedTo: "review_queue",
          reviewOutcome: null,
          message: { thread: { igAccountId: account.id } },
        },
      }),
    ]);
    rows.push({
      igAccountId: account.id,
      handle: account.handle,
      status: account.status,
      mtdRecoveredMinor: minorUnitsToNumber(recovered._sum.amountMinor ?? 0n),
      unreadHighPriority: highPriority,
      reviewQueueSize: reviewCount,
    });
  }
  return rows;
}
