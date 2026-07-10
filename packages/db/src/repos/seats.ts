import { prisma } from "../client";
import type { OrgId } from "../org-id";

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
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: orgId },
      select: { tier: true },
    });
    if (!org) throw new Error("org not found");

    const rules = SEAT_RULES[org.tier]!;
    if (!rules.allowedInviteRoles.includes(input.role)) {
      throw new Error(`role_not_allowed: ${input.role} on ${org.tier}`);
    }
    const seatCount = await tx.seat.count({ where: { orgId } });
    if (rules.maxSeats !== null && seatCount >= rules.maxSeats) {
      throw new Error(`seat_limit: ${org.tier} allows ${rules.maxSeats}`);
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

    await tx.auditLog.create({
      data: {
        orgId,
        seatId: input.invitedBySeatId,
        action: "seat.invited",
        entityType: "seat",
        entityId: seat.id,
        detail: { email: input.email, role: input.role },
      },
    });

    return seat;
  });
}

export async function removeSeat(orgId: OrgId, seatId: string, removedBySeatId: string) {
  return prisma.$transaction(async (tx) => {
    const seat = await tx.seat.findFirst({ where: { id: seatId, orgId } });
    if (!seat) throw new Error("seat not in org");
    if (seat.role === "creator") throw new Error("cannot_remove_creator");

    await tx.seat.delete({ where: { id: seat.id } });
    await tx.auditLog.create({
      data: {
        orgId,
        seatId: removedBySeatId,
        action: "seat.removed",
        entityType: "seat",
        entityId: seat.id,
        detail: { role: seat.role },
      },
    });
  });
}

/** Roster overview rollups (PRD §5.6.1): one row per connected account. */
export async function getRosterOverview(orgId: OrgId) {
  const accounts = await prisma.igAccount.findMany({
    where: { orgId },
    select: { id: true, handle: true, status: true },
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

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
      mtdRecoveredMinor: Number(recovered._sum.amountMinor ?? 0),
      unreadHighPriority: highPriority,
      reviewQueueSize: reviewCount,
    });
  }
  return rows;
}
