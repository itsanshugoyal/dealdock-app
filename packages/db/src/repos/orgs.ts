import { prisma } from "../client";
import type { OrgId } from "../org-id";

export interface CreateOrgInput {
  name: string;
  tier?: "solo" | "studio" | "roster";
  currencyCode?: string;
  locale?: string;
  timezone?: string;
  creator: { clerkUserId: string; email: string; name?: string };
  igAccount: {
    provider?: "mock" | "instagram_graph";
    igUserId: string;
    handle: string;
    accountType: "business" | "creator";
  };
}

/** Onboarding bootstrap: org + creator user/seat + connected account + checkpoint. */
export async function createOrganizationWithCreator(input: CreateOrgInput) {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.name,
        tier: input.tier ?? "solo",
        currencyCode: input.currencyCode ?? "INR",
        locale: input.locale ?? "en-IN",
        timezone: input.timezone ?? "Asia/Kolkata",
      },
    });

    const user = await tx.user.upsert({
      where: { clerkUserId: input.creator.clerkUserId },
      create: {
        clerkUserId: input.creator.clerkUserId,
        email: input.creator.email,
        name: input.creator.name,
      },
      update: { email: input.creator.email, name: input.creator.name },
    });

    const seat = await tx.seat.create({
      data: { orgId: org.id, userId: user.id, role: "creator" },
    });

    const igAccount = await tx.igAccount.create({
      data: {
        orgId: org.id,
        provider: input.igAccount.provider ?? "mock",
        igUserId: input.igAccount.igUserId,
        handle: input.igAccount.handle,
        accountType: input.igAccount.accountType,
      },
    });

    await tx.ingestionCheckpoint.create({
      data: { orgId: org.id, igAccountId: igAccount.id },
    });

    return { org, user, seat, igAccount };
  });
}

export async function getOrganization(orgId: OrgId) {
  return prisma.organization.findUnique({
    where: { id: orgId },
    include: { igAccounts: true, seats: { include: { user: true } } },
  });
}

/** Local/demo bootstrap lookup — used only by the seed-driven M0 demo. */
export async function findDemoBootstrap() {
  const org = await prisma.organization.findFirst({
    where: { name: "Demo Creator Co" },
    include: { igAccounts: true },
  });
  if (!org || org.igAccounts.length === 0) return null;
  return { org, igAccount: org.igAccounts[0]! };
}

export async function findSeat(orgId: OrgId, clerkUserId: string) {
  return prisma.seat.findFirst({
    where: { orgId, user: { clerkUserId } },
    include: { user: true, org: true },
  });
}
