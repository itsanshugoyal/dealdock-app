import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";
import { minorUnitsToNumber, requireMinorUnits, validateRegionPreferences } from "../money";

const SUPPORTED_CURRENCIES = new Set(["INR", "USD", "GBP", "EUR", "AED"]);

function assertCurrency(currencyCode: string) {
  if (!SUPPORTED_CURRENCIES.has(currencyCode)) throw new DomainError("unsupported_currency_code", 400);
}

export async function updateRegion(
  orgId: OrgId,
  seatId: string,
  input: {
    currencyCode?: string;
    locale?: string;
    timezone?: string;
    nudgeDelayDays?: number;
  }
) {
  validateRegionPreferences(input);
  return prisma.$transaction(async (tx) => {
    const current = await tx.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true },
    });
    if (!current) throw new DomainError("org_not_found", 404);
    // Currency is the organisation's permanent monetary unit. Locale/timezone
    // remain editable display/calendar preferences, but currency never changes
    // through Settings or would silently reinterpret money already persisted.
    if (input.currencyCode) assertCurrency(input.currencyCode);
    if (input.currencyCode && input.currencyCode !== current.currencyCode) {
      throw new DomainError("currency_immutable_for_organization", 409);
    }
    const org = await tx.organization.update({ where: { id: orgId }, data: input });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "settings.region_changed",
      entityType: "organization",
      entityId: orgId,
      detail: input as never,
    });
    return org;
  });
}

/** Monthly confirmed-revenue goal (Insights), org-currency minor units; null clears it. */
export async function setMonthlyGoal(orgId: OrgId, seatId: string, monthlyGoalMinor: number | null) {
  await requireSeatInOrg(orgId, seatId);
  const goal = monthlyGoalMinor === null ? null : requireMinorUnits(monthlyGoalMinor, "monthlyGoalMinor");
  await prisma.$transaction([
    prisma.organization.update({ where: { id: orgId }, data: { monthlyGoalMinor: goal } }),
    writeAudit(prisma, {
      orgId, seatId, action: "settings.goal_changed", entityType: "organization", entityId: orgId, detail: { monthlyGoalMinor },
    }),
  ]);
  return { monthlyGoalMinor };
}

/** The goal as a number for read models (stored as BIGINT). */
export async function getMonthlyGoal(orgId: OrgId): Promise<number | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { monthlyGoalMinor: true } });
  return org?.monthlyGoalMinor == null ? null : minorUnitsToNumber(org.monthlyGoalMinor, "monthlyGoalMinor");
}

/** Atomic onboarding save; its currency is the denomination of all supplied ranges. */
export async function upsertOnboardingProfile(
  orgId: OrgId,
  seatId: string,
  input: {
    businessContext: Record<string, unknown>;
    currencyCode: string;
    locale: string;
    timezone: string;
  }
) {
  validateRegionPreferences(input);
  return prisma.$transaction(async (tx) => {
    const current = await tx.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true },
    });
    if (!current) throw new DomainError("org_not_found", 404);
    assertCurrency(input.currencyCode);
    if (current.currencyCode !== input.currencyCode) {
      throw new DomainError("currency_immutable_for_organization", 409);
    }
    const context = { ...input.businessContext, currencyCode: input.currencyCode };
    const org = await tx.organization.update({
      where: { id: orgId },
      data: {
        currencyCode: input.currencyCode,
        locale: input.locale,
        timezone: input.timezone,
        businessContext: context as never,
      },
    });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "onboarding.profile_saved",
      entityType: "organization",
      entityId: orgId,
    });
    return org;
  });
}

/** Honest inventory of stored data (PRD §6.11). */
export async function getDataSummary(orgId: OrgId) {
  const [messages, classifications, drafts, ledgerEntries, auditRows, voiceRules, offers, audioClips, org] =
    await Promise.all([
      prisma.message.count({ where: { orgId } }),
      prisma.classification.count({ where: { orgId } }),
      prisma.draft.count({ where: { orgId } }),
      prisma.ledgerEntry.count({ where: { orgId } }),
      prisma.auditLog.count({ where: { orgId } }),
      prisma.voiceRule.count({ where: { orgId } }),
      prisma.offer.count({ where: { orgId } }),
      prisma.audioAsset.count({ where: { orgId } }),
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { createdAt: true, deletionRequestedAt: true },
      }),
    ]);
  return {
    messagesProcessed: messages,
    classifications,
    draftsGenerated: drafts,
    ledgerEntries,
    auditRows,
    voiceRules,
    offers,
    audioClips,
    storingSince: org?.createdAt,
    deletionRequestedAt: org?.deletionRequestedAt,
  };
}

/**
 * Single-archive export: DMs (incl. voice-note transcripts), classifications,
 * drafts + feedback, ledger, offers, learned voice rules and speaking-voice
 * consent metadata (PRD §6.11). Audio bytes are never inlined in JSON; clips
 * are listed as metadata only. Provider voice ids stay internal.
 */
export async function exportOrgArchive(orgId: OrgId) {
  const [org, threads, ledger, audit, offers, voiceRules, speakingVoices, audioAssets] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        name: true,
        currencyCode: true,
        locale: true,
        timezone: true,
        monthlyGoalMinor: true,
        createdAt: true,
      },
    }),
    prisma.thread.findMany({
      where: { orgId },
      include: {
        messages: {
          orderBy: { sentAt: "asc" },
          include: { classification: true },
        },
        drafts: { include: { feedback: { orderBy: { createdAt: "asc" } } } },
      },
    }),
    prisma.ledgerEntry.findMany({ where: { orgId } }),
    prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } }),
    prisma.offer.findMany({ where: { orgId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.voiceRule.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } }),
    prisma.speakingVoice.findMany({
      where: { orgId },
      select: {
        id: true,
        igAccountId: true,
        provider: true,
        status: true,
        consentStatement: true,
        consentedAt: true,
        consentSeatId: true,
        disclosureEnabled: true,
        sampleSeconds: true,
        sampleAssetIds: true,
        revokedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.audioAsset.findMany({
      where: { orgId },
      // Never select `bytes`: archives are JSON and clips can be 25 MB each.
      select: {
        id: true,
        kind: true,
        mimeType: true,
        sizeBytes: true,
        durationMs: true,
        text: true,
        sha256: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // BigInt → number for JSON.
  return JSON.parse(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        org,
        threads,
        ledger,
        audit,
        offers,
        voiceRules,
        speakingVoices,
        audioAssets,
      },
      (_k, v) => (typeof v === "bigint" ? Number(v) : v)
    )
  );
}

/** 7-day grace, then the retention job hard-deletes everything (PRD §6.11). */
export async function requestAccountDeletion(orgId: OrgId, seatId: string) {
  await requireSeatInOrg(orgId, seatId);
  const existing = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { deletionRequestedAt: true },
  });
  if (!existing) throw new DomainError("org_not_found", 404);
  const requestedAt = existing.deletionRequestedAt ?? new Date();
  if (!existing.deletionRequestedAt) {
    await prisma.$transaction([
      prisma.organization.update({ where: { id: orgId }, data: { deletionRequestedAt: requestedAt } }),
      writeAudit(prisma, {
        orgId,
        seatId,
        action: "account.deletion_requested",
        entityType: "organization",
        entityId: orgId,
      }),
    ]);
  }
  return new Date(requestedAt.getTime() + 7 * 864e5);
}

/** A creator can withdraw deletion during the documented seven-day grace. */
export async function cancelAccountDeletion(orgId: OrgId, seatId: string) {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: orgId },
      select: { deletionRequestedAt: true },
    });
    if (!org) throw new DomainError("org_not_found", 404);
    if (!org.deletionRequestedAt) return { cancelled: false as const };
    await tx.organization.update({ where: { id: orgId }, data: { deletionRequestedAt: null } });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "account.deletion_cancelled",
      entityType: "organization",
      entityId: orgId,
    });
    return { cancelled: true as const };
  });
}

export async function getIgnoreList(orgId: OrgId, igAccountId?: string): Promise<string[]> {
  const rows = await prisma.ignoreListEntry.findMany({
    where: {
      orgId,
      ...(igAccountId ? { OR: [{ igAccountId }, { igAccountId: null }] } : { igAccountId: null }),
    },
    select: { handle: true },
    orderBy: { handle: "asc" },
  });
  return rows.map((r) => r.handle);
}

export async function setIgnoreList(
  orgId: OrgId,
  seatId: string,
  handles: string[],
  igAccountId?: string
) {
  const normalized = [...new Set(handles.map((h) => h.replace(/^@/, "").toLowerCase()))];
  await prisma.$transaction(async (tx) => {
    if (igAccountId) await requireIgAccountInOrg(orgId, igAccountId, tx);
    await tx.ignoreListEntry.deleteMany({ where: { orgId, igAccountId: igAccountId ?? null } });
    if (normalized.length) {
      await tx.ignoreListEntry.createMany({ data: normalized.map((handle) => ({ orgId, igAccountId: igAccountId ?? null, handle })) });
    }
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "settings.ignore_list_changed",
      entityType: "organization",
      entityId: igAccountId ?? orgId,
      detail: { count: normalized.length, igAccountId: igAccountId ?? null },
    });
  });
}

/** Ingestion checks both account-local and legacy org-wide ignore rules. */
export async function isIgnoredHandle(orgId: OrgId, igAccountId: string, handle: string) {
  const normalized = handle.replace(/^@/, "").toLowerCase();
  return Boolean(
    await prisma.ignoreListEntry.findFirst({
      where: { orgId, handle: normalized, OR: [{ igAccountId }, { igAccountId: null }] },
      select: { id: true },
    })
  );
}

export async function setVoiceEnabled(orgId: OrgId, seatId: string, enabled: boolean) {
  await requireSeatInOrg(orgId, seatId);
  if (enabled) {
    const [accounts, consentedProfiles] = await Promise.all([
      prisma.igAccount.count({ where: { orgId } }),
      prisma.voiceProfile.count({
        where: { orgId, consentedAt: { not: null }, revokedAt: null },
      }),
    ]);
    // Explicit consent is a per-account record. Missing profiles are not an
    // implicit yes, including accounts connected before this safety invariant.
    if (accounts === 0 || consentedProfiles !== accounts) throw new DomainError("voice_consent_required", 409);
  }
  await prisma.voiceProfile.updateMany({ where: { orgId }, data: { enabled } });
  await writeAudit(prisma, {
    orgId,
    seatId,
    action: enabled ? "settings.voice_enabled" : "settings.voice_disabled",
    entityType: "organization",
    entityId: orgId,
  });
}
