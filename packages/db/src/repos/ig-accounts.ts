import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import { Prisma } from "@prisma/client";
import { writeAudit } from "../audit-log";
import { decryptToken, encryptToken } from "../crypto";
import type { OrgId } from "../org-id";

/**
 * Connected-account lifecycle for the real Graph adapter (M3).
 * Tokens are AES-256-GCM encrypted at rest; decryption happens only here,
 * inside the repository layer, when building a ConnectedAccount for an adapter.
 */

export async function connectGraphAccount(
  orgId: OrgId,
  input: {
    igUserId: string;
    handle: string;
    accountType: "business" | "creator";
    accessToken: string;
    expiresIn?: number;
  }
) {
  const accessTokenEnc = encryptToken(input.accessToken);
  return prisma.$transaction(async (tx) => {
    // Serialize tier-cap decisions per organization. Count-then-create without
    // this lock lets two simultaneous OAuth callbacks exceed Solo/Roster caps.
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`;
    const existing = await tx.igAccount.findFirst({
      where: { platform: "instagram", igUserId: input.igUserId },
      select: { id: true, orgId: true },
    });
    if (existing && existing.orgId !== orgId) throw new DomainError("account_connected_to_other_org", 409);
    if (existing) {
      // Reconnect: refresh token, reactivate, ingestion resumes.
      return tx.igAccount.update({
        where: { id: existing.id },
        data: {
          accessTokenEnc,
          tokenRefreshedAt: new Date(),
          tokenExpiresAt: new Date(Date.now() + (input.expiresIn ?? 60 * 86400) * 1000),
          handle: input.handle,
          accountType: input.accountType,
          status: "active",
          disconnectedAt: null,
          provider: "instagram_graph",
        },
      });
    }
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { tier: true } });
    if (!org) throw new DomainError("org_not_found", 404);
    const cap = org.tier === "roster" ? 5 : 1;
    const accountCount = await tx.igAccount.count({ where: { orgId, platform: "instagram" } });
    if (accountCount >= cap) throw new DomainError(`ig_account_limit:${cap}`, 409);
    const account = await tx.igAccount.create({
      data: {
        orgId,
        platform: "instagram",
        provider: "instagram_graph",
        igUserId: input.igUserId,
        handle: input.handle,
        accountType: input.accountType,
        accessTokenEnc,
        tokenRefreshedAt: new Date(),
        tokenExpiresAt: new Date(Date.now() + (input.expiresIn ?? 60 * 86400) * 1000),
      },
    });
    await tx.ingestionCheckpoint.create({
      data: { orgId, igAccountId: account.id },
    });
    await tx.voiceProfile.create({
      data: { orgId, igAccountId: account.id, enabled: false, sampleMessageIds: [] },
    });
    return account;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** ConnectedAccount for adapters — the only decryption path (send gate + backfill). */
export async function getConnectedAccount(orgId: OrgId, igAccountId: string) {
  const account = await prisma.igAccount.findFirst({
    where: { id: igAccountId, orgId },
  });
  if (!account) return null;
  return {
    accountId: account.id,
    platformUserId: account.igUserId,
    handle: account.handle,
    accessToken: account.accessTokenEnc ? decryptToken(account.accessTokenEnc) : "",
    provider: account.provider,
    status: account.status,
    tokenRefreshedAt: account.tokenRefreshedAt,
    tokenExpiresAt: account.tokenExpiresAt,
  };
}

export async function saveRefreshedGraphToken(orgId: OrgId, igAccountId: string, accessToken: string, expiresIn: number) {
  await prisma.igAccount.updateMany({
    where: { id: igAccountId, orgId, status: "active" },
    data: { accessTokenEnc: encryptToken(accessToken), tokenRefreshedAt: new Date(), tokenExpiresAt: new Date(Date.now() + expiresIn * 1000) },
  });
}

export async function disconnectAccount(orgId: OrgId, igAccountId: string, seatId: string) {
  const account = await prisma.igAccount.findFirst({
    where: { id: igAccountId, orgId },
    select: { id: true },
  });
  if (!account) throw new DomainError("account not in org", 404);

  // Ingestion stops immediately (PRD §6.1): consumers check status per job,
  // and the token is dropped, not just flagged.
  await prisma.$transaction([
    prisma.igAccount.update({
      where: { id: account.id },
      data: { status: "disconnected", disconnectedAt: new Date(), accessTokenEnc: null },
    }),
    writeAudit(prisma, {
      orgId,
      seatId,
      action: "ig.disconnected",
      entityType: "ig_account",
      entityId: account.id,
    }),
  ]);
}

/** Org-scoped like every repo write (F11 / ADR-7) — never trust a bare id. */
export async function markTokenExpired(orgId: OrgId, igAccountId: string) {
  await prisma.igAccount.updateMany({
    where: { id: igAccountId, orgId, status: "active" },
    data: { status: "token_expired" },
  });
}

/**
 * SYSTEM context (no org scope): webhook receiver resolves which org a Meta
 * event belongs to by the business account's IGSID. Read-only, id-keyed.
 */
export async function findAccountByPlatformUserId(igUserId: string) {
  return prisma.igAccount.findFirst({
    where: { platform: "instagram", igUserId, status: "active" },
    select: { id: true, orgId: true, provider: true },
  });
}

/** SYSTEM context: accounts the backfill scheduler walks (ARCHITECTURE.md §4.3). */
export async function listActiveGraphAccounts() {
  const accounts = await prisma.igAccount.findMany({
    where: { provider: "instagram_graph", status: "active" },
    include: { checkpoint: true },
  });
  return accounts.map((a) => ({
    igAccountId: a.id,
    orgId: a.orgId,
    igUserId: a.igUserId,
    handle: a.handle,
    lastBackfillAt: a.checkpoint?.lastBackfillAt ?? null,
  }));
}

export async function updateBackfillCheckpoint(orgId: OrgId, igAccountId: string) {
  await prisma.ingestionCheckpoint.updateMany({
    where: { orgId, igAccountId },
    data: { lastBackfillAt: new Date() },
  });
}
