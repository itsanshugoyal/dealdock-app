import { prisma } from "../client";
import type { OrgId } from "../org-id";

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
  const org = await prisma.organization.update({
    where: { id: orgId },
    data: input,
  });
  await prisma.auditLog.create({
    data: {
      orgId,
      seatId,
      action: "settings.region_changed",
      entityType: "organization",
      entityId: orgId,
      detail: input as never,
    },
  });
  return org;
}

/** Honest inventory of stored data (PRD §6.11). */
export async function getDataSummary(orgId: OrgId) {
  const [messages, classifications, drafts, ledgerEntries, auditRows, org] =
    await Promise.all([
      prisma.message.count({ where: { orgId } }),
      prisma.classification.count({ where: { orgId } }),
      prisma.draft.count({ where: { orgId } }),
      prisma.ledgerEntry.count({ where: { orgId } }),
      prisma.auditLog.count({ where: { orgId } }),
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
    storingSince: org?.createdAt,
    deletionRequestedAt: org?.deletionRequestedAt,
  };
}

/** Single-archive export: DMs, classifications, drafts, ledger (PRD §6.11). */
export async function exportOrgArchive(orgId: OrgId) {
  const [org, threads, ledger, audit] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true, currencyCode: true, locale: true, timezone: true, createdAt: true },
    }),
    prisma.thread.findMany({
      where: { orgId },
      include: {
        messages: {
          orderBy: { sentAt: "asc" },
          include: { classification: true },
        },
        drafts: true,
      },
    }),
    prisma.ledgerEntry.findMany({ where: { orgId } }),
    prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } }),
  ]);

  // BigInt → number for JSON.
  return JSON.parse(
    JSON.stringify(
      { exportedAt: new Date().toISOString(), org, threads, ledger, audit },
      (_k, v) => (typeof v === "bigint" ? Number(v) : v)
    )
  );
}

/** 7-day grace, then the retention job hard-deletes everything (PRD §6.11). */
export async function requestAccountDeletion(orgId: OrgId, seatId: string) {
  const requestedAt = new Date();
  await prisma.organization.update({
    where: { id: orgId },
    data: { deletionRequestedAt: requestedAt },
  });
  await prisma.auditLog.create({
    data: {
      orgId,
      seatId,
      action: "account.deletion_requested",
      entityType: "organization",
      entityId: orgId,
    },
  });
  return new Date(requestedAt.getTime() + 7 * 864e5);
}

export async function getIgnoreList(orgId: OrgId): Promise<string[]> {
  const rows = await prisma.ignoreListEntry.findMany({
    where: { orgId },
    select: { handle: true },
    orderBy: { handle: "asc" },
  });
  return rows.map((r) => r.handle);
}

export async function setIgnoreList(orgId: OrgId, seatId: string, handles: string[]) {
  const normalized = [...new Set(handles.map((h) => h.replace(/^@/, "").toLowerCase()))];
  await prisma.$transaction([
    prisma.ignoreListEntry.deleteMany({ where: { orgId } }),
    prisma.ignoreListEntry.createMany({
      data: normalized.map((handle) => ({ orgId, handle })),
    }),
    prisma.auditLog.create({
      data: {
        orgId,
        seatId,
        action: "settings.ignore_list_changed",
        entityType: "organization",
        entityId: orgId,
        detail: { count: normalized.length },
      },
    }),
  ]);
}

export async function setVoiceEnabled(orgId: OrgId, seatId: string, enabled: boolean) {
  await prisma.voiceProfile.updateMany({ where: { orgId }, data: { enabled } });
  await prisma.auditLog.create({
    data: {
      orgId,
      seatId,
      action: enabled ? "settings.voice_enabled" : "settings.voice_disabled",
      entityType: "organization",
      entityId: orgId,
    },
  });
}
