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
    /** Seconds; null = never expires (Unified Login system-user token); unset = Instagram Login's 60 days. */
    expiresIn?: number | null;
  }
) {
  const accessTokenEnc = encryptToken(input.accessToken);
  const tokenExpiresAt = input.expiresIn === null ? null : new Date(Date.now() + (input.expiresIn ?? 60 * 86400) * 1000);
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
          tokenExpiresAt,
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
        tokenExpiresAt,
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

/**
 * The creator account a new email inbox belongs to: the given Instagram
 * account, else the org's only one. Roster workspaces have several creators,
 * so they must say which.
 */
export async function resolveInboxOwner(orgId: OrgId, igAccountId?: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { tier: true } });
  if (!org) throw new DomainError("org_not_found", 404);
  if (!igAccountId && org.tier === "roster") throw new DomainError("ig_account_required", 400);
  const owner = await prisma.igAccount.findFirst({
    where: { orgId, platform: "instagram", ...(igAccountId ? { id: igAccountId } : {}) },
    orderBy: [{ connectedAt: "asc" }, { id: "asc" }],
    select: { id: true, handle: true },
  });
  if (!owner) throw igAccountId ? new DomainError("ig_account_not_in_org", 404) : new DomainError("no_connected_account", 409);
  return owner;
}

/**
 * Connects (or reconnects) a Gmail inbox for one creator account. One live
 * inbox per creator; an inbox still live for another creator must be
 * disconnected there first, so threads and money never move silently.
 */
export async function connectEmailAccount(
  orgId: OrgId,
  input: { ownerAccountId: string; address: string; accessToken: string; refreshToken: string; expiresIn: number }
) {
  const igUserId = input.address.toLowerCase();
  const tokens = {
    accessTokenEnc: encryptToken(input.accessToken),
    refreshTokenEnc: encryptToken(input.refreshToken),
    tokenRefreshedAt: new Date(),
    tokenExpiresAt: new Date(Date.now() + input.expiresIn * 1000),
  };
  return prisma.$transaction(async (tx) => {
    // Same per-org lock as connectGraphAccount: two callbacks must not both pass the one-inbox check.
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`;
    const owner = await tx.igAccount.findFirst({ where: { id: input.ownerAccountId, orgId, platform: "instagram" }, select: { id: true } });
    if (!owner) throw new DomainError("ig_account_not_in_org", 404);
    const existing = await tx.igAccount.findFirst({
      where: { platform: "email", igUserId },
      select: { id: true, orgId: true, ownerAccountId: true, status: true },
    });
    if (existing && existing.orgId !== orgId) throw new DomainError("account_connected_to_other_org", 409);
    if (existing?.ownerAccountId && existing.ownerAccountId !== owner.id && existing.status !== "disconnected") {
      throw new DomainError("email_connected_to_other_creator", 409);
    }
    const otherInbox = await tx.igAccount.findFirst({
      where: { orgId, platform: "email", ownerAccountId: owner.id, status: { not: "disconnected" }, ...(existing ? { id: { not: existing.id } } : {}) },
      select: { id: true },
    });
    if (otherInbox) throw new DomainError("email_account_limit", 409);
    if (existing) {
      return tx.igAccount.update({
        where: { id: existing.id },
        data: { ...tokens, handle: input.address, ownerAccountId: owner.id, status: "active", disconnectedAt: null },
      });
    }
    const account = await tx.igAccount.create({
      data: { orgId, platform: "email", provider: "gmail", igUserId, handle: input.address, accountType: "creator", ownerAccountId: owner.id, ...tokens },
    });
    await tx.ingestionCheckpoint.create({ data: { orgId, igAccountId: account.id } });
    await tx.voiceProfile.create({ data: { orgId, igAccountId: account.id, enabled: false, sampleMessageIds: [] } });
    return account;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Settings → Email: the org's live inboxes (disconnected ones are history, not accounts). */
export async function listEmailAccounts(orgId: OrgId) {
  const accounts = await prisma.igAccount.findMany({
    where: { orgId, platform: "email", status: { not: "disconnected" } },
    orderBy: [{ connectedAt: "asc" }, { id: "asc" }],
    select: { id: true, handle: true, status: true, connectedAt: true, ownerAccountId: true, checkpoint: { select: { lastBackfillAt: true } } },
  });
  return accounts.map((account) => ({
    id: account.id,
    address: account.handle,
    status: account.status,
    connectedAt: account.connectedAt,
    lastSyncedAt: account.checkpoint?.lastBackfillAt ?? null,
    ownerAccountId: account.ownerAccountId,
  }));
}

/** ConnectedAccount for adapters — the only decryption path (send gate + backfill). */
export async function getConnectedAccount(orgId: OrgId, igAccountId: string) {
  const account = await prisma.igAccount.findFirst({
    where: { id: igAccountId, orgId },
    include: { checkpoint: { select: { syncCursor: true } } },
  });
  if (!account) return null;
  return {
    accountId: account.id,
    platformUserId: account.igUserId,
    handle: account.handle,
    accessToken: account.accessTokenEnc ? decryptToken(account.accessTokenEnc) : "",
    refreshToken: account.refreshTokenEnc ? decryptToken(account.refreshTokenEnc) : null,
    provider: account.provider,
    status: account.status,
    tokenRefreshedAt: account.tokenRefreshedAt,
    tokenExpiresAt: account.tokenExpiresAt,
    syncCursor: account.checkpoint?.syncCursor ?? null,
  };
}

export async function saveRefreshedGraphToken(orgId: OrgId, igAccountId: string, accessToken: string, expiresIn: number) {
  await prisma.igAccount.updateMany({
    where: { id: igAccountId, orgId, status: "active" },
    data: { accessTokenEnc: encryptToken(accessToken), tokenRefreshedAt: new Date(), tokenExpiresAt: new Date(Date.now() + expiresIn * 1000) },
  });
}

export async function disconnectAccount(orgId: OrgId, igAccountId: string, seatId: string, platform?: "instagram" | "email") {
  const account = await prisma.igAccount.findFirst({
    where: { id: igAccountId, orgId, ...(platform ? { platform } : {}) },
    select: { id: true, platform: true },
  });
  if (!account) throw new DomainError("account not in org", 404);

  // Ingestion stops immediately (PRD §6.1): consumers check status per job,
  // and the tokens are dropped, not just flagged.
  await prisma.$transaction([
    prisma.igAccount.update({
      where: { id: account.id },
      data: { status: "disconnected", disconnectedAt: new Date(), accessTokenEnc: null, refreshTokenEnc: null },
    }),
    writeAudit(prisma, {
      orgId,
      seatId,
      action: account.platform === "email" ? "email.disconnected" : "ig.disconnected",
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
 * SYSTEM context (no org scope): webhook receivers resolve which org an event
 * belongs to by the account's platform id (IGSID, or the Gmail address for a
 * Gmail push). Read-only, id-keyed.
 */
export async function findAccountByPlatformUserId(igUserId: string, platform: "instagram" | "email" = "instagram") {
  return prisma.igAccount.findFirst({
    where: { platform, igUserId, status: "active" },
    select: { id: true, orgId: true, provider: true },
  });
}

/** SYSTEM context: accounts a polling scheduler walks (ARCHITECTURE.md §4.3), by provider. */
export async function listActiveGraphAccounts(provider: "instagram_graph" | "gmail" = "instagram_graph") {
  const accounts = await prisma.igAccount.findMany({
    where: { provider, status: "active" },
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

/** `syncCursor` (Gmail historyId) is saved with the sync it resumes after; Instagram passes none. */
export async function updateBackfillCheckpoint(orgId: OrgId, igAccountId: string, syncCursor?: string) {
  await prisma.ingestionCheckpoint.updateMany({
    where: { orgId, igAccountId },
    data: { lastBackfillAt: new Date(), ...(syncCursor ? { syncCursor } : {}) },
  });
}
