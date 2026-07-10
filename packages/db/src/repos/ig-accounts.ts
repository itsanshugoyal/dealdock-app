import { prisma } from "../client";
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
  }
) {
  const existing = await prisma.igAccount.findFirst({
    where: { platform: "instagram", igUserId: input.igUserId },
    select: { id: true, orgId: true },
  });
  if (existing && existing.orgId !== orgId) {
    throw new Error("account_connected_to_other_org");
  }

  const accessTokenEnc = encryptToken(input.accessToken);

  if (existing) {
    // Reconnect: refresh token, reactivate, ingestion resumes.
    return prisma.igAccount.update({
      where: { id: existing.id },
      data: {
        accessTokenEnc,
        handle: input.handle,
        accountType: input.accountType,
        status: "active",
        disconnectedAt: null,
        provider: "instagram_graph",
      },
    });
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.igAccount.create({
      data: {
        orgId,
        platform: "instagram",
        provider: "instagram_graph",
        igUserId: input.igUserId,
        handle: input.handle,
        accountType: input.accountType,
        accessTokenEnc,
      },
    });
    await tx.ingestionCheckpoint.create({
      data: { orgId, igAccountId: account.id },
    });
    return account;
  });
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
  };
}

export async function disconnectAccount(orgId: OrgId, igAccountId: string, seatId: string) {
  const account = await prisma.igAccount.findFirst({
    where: { id: igAccountId, orgId },
    select: { id: true },
  });
  if (!account) throw new Error("account not in org");

  // Ingestion stops immediately (PRD §6.1): consumers check status per job,
  // and the token is dropped, not just flagged.
  await prisma.$transaction([
    prisma.igAccount.update({
      where: { id: account.id },
      data: { status: "disconnected", disconnectedAt: new Date(), accessTokenEnc: null },
    }),
    prisma.auditLog.create({
      data: {
        orgId,
        seatId,
        action: "ig.disconnected",
        entityType: "ig_account",
        entityId: account.id,
      },
    }),
  ]);
}

export async function markTokenExpired(igAccountId: string) {
  await prisma.igAccount.updateMany({
    where: { id: igAccountId, status: "active" },
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
