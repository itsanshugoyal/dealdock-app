import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { minorUnitsToNumber, validateRegionPreferences } from "../money";

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
  validateRegionPreferences(input);
  const currencyCode = input.currencyCode ?? "INR";
  if (!new Set(["INR", "USD", "GBP", "EUR", "AED"]).has(currencyCode)) {
    throw new DomainError("unsupported_currency_code", 400);
  }
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.name,
        tier: input.tier ?? "solo",
        currencyCode,
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
    // Profile exists for settings visibility, but no sent-DM sample is usable
    // until the creator records explicit consent.
    await tx.voiceProfile.create({
      data: { orgId: org.id, igAccountId: igAccount.id, enabled: false, sampleMessageIds: [] },
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

/** Verified Clerk admin bootstrap; no synthetic account or implicit voice consent. */
export async function provisionOrganization(orgId: OrgId, input: {
  name: string; clerkUserId: string; email: string; currencyCode: string; locale: string; timezone: string;
}) {
  validateRegionPreferences(input);
  if (!["INR","USD","GBP","EUR","AED"].includes(input.currencyCode)) throw new DomainError("unsupported_currency_code", 400);
  new Intl.DateTimeFormat("en", {timeZone:input.timezone}).format();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`;
    const existing = await tx.organization.findUnique({where:{id:orgId}});
    if (existing) return {id:existing.id, created:false};
    const org = await tx.organization.create({data:{id:orgId,name:input.name,currencyCode:input.currencyCode,locale:input.locale,timezone:input.timezone}});
    const user = await tx.user.upsert({where:{clerkUserId:input.clerkUserId},create:{clerkUserId:input.clerkUserId,email:input.email},update:{email:input.email}});
    await tx.seat.create({data:{orgId:org.id,userId:user.id,role:"creator"}});
    await tx.subscription.create({data:{orgId:org.id,tier:"solo",rail:org.currencyCode==="INR"?"razorpay":"paddle"}});
    await writeAudit(tx, {orgId:org.id,action:"organization.created",entityType:"organization",entityId:org.id});
    return {id:org.id, created:true};
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

type VoiceChoice = { consentedAt: Date | null; revokedAt: Date | null } | null;

/** Each account's writing-voice consent as onboarding and settings show it. */
function voiceConsentOf(accounts: Array<{ id: string; voice: VoiceChoice }>) {
  return accounts.map((account) => ({
    igAccountId: account.id,
    consented: Boolean(account.voice?.consentedAt && !account.voice.revokedAt),
  }));
}

function onboardingComplete(org: { businessContext: unknown; igAccounts: Array<{ voice: VoiceChoice }> }): boolean {
  if (!org.businessContext || org.igAccounts.length === 0) return false;
  // A deliberate decline is also a completed choice, represented by revokedAt.
  return org.igAccounts.some((a) => Boolean(a.voice?.consentedAt || a.voice?.revokedAt));
}

/** The onboarding answers so far, and whether onboarding is complete (isOnboardingComplete's answer). */
export async function getOnboardingProfile(orgId: OrgId) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      currencyCode: true,
      locale: true,
      timezone: true,
      businessContext: true,
      igAccounts: {
        select: {
          id: true,
          handle: true,
          voice: { select: { enabled: true, consentedAt: true, revokedAt: true } },
        },
      },
    },
  });
  if (!org) return null;
  return {
    ...org,
    voiceConsent: voiceConsentOf(org.igAccounts),
    complete: onboardingComplete(org),
  };
}

export async function isOnboardingComplete(orgId: OrgId) {
  return (await getOnboardingProfile(orgId))?.complete ?? false;
}

/**
 * Everything GET /settings shows, from one Organization read: region and
 * nudge preferences, tier, deletion state, the monthly goal, and each
 * connected account with its writing-voice consent. Null for an unknown org.
 */
export async function getOrgSettings(orgId: OrgId) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      currencyCode: true,
      locale: true,
      timezone: true,
      nudgeDelayDays: true,
      tier: true,
      deletionRequestedAt: true,
      monthlyGoalMinor: true,
      igAccounts: {
        orderBy: [{ connectedAt: "asc" }, { id: "asc" }],
        select: { id: true, handle: true, status: true, provider: true, voice: { select: { consentedAt: true, revokedAt: true } } },
      },
    },
  });
  if (!org) return null;
  return {
    currencyCode: org.currencyCode,
    locale: org.locale,
    timezone: org.timezone,
    nudgeDelayDays: org.nudgeDelayDays,
    accounts: org.igAccounts.map(({ id, handle, status, provider }) => ({ id, handle, status, provider })),
    voiceConsent: voiceConsentOf(org.igAccounts),
    deletionRequestedAt: org.deletionRequestedAt,
    monthlyGoalMinor: org.monthlyGoalMinor === null ? null : minorUnitsToNumber(org.monthlyGoalMinor, "monthlyGoalMinor"),
    tier: org.tier,
  };
}
