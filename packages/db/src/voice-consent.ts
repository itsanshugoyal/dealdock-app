import { DomainError } from "@dealdock/core";
import { Prisma } from "@prisma/client";
import type { OrgId } from "./org-id";

type ConsentFields = { enabled: boolean; consentedAt: Date | null; revokedAt: Date | null };

/** Voice modeling needs durable, unrevoked, enabled consent on THIS account. */
export function hasVoiceConsent<T extends ConsentFields>(profile: T | null | undefined): profile is T {
  return Boolean(profile?.enabled && profile.consentedAt && !profile.revokedAt);
}

const LOCKED_PROFILE = {
  id: true,
  version: true,
  enabled: true,
  consentedAt: true,
  revokedAt: true,
  learningPaused: true,
  excludedMessageIds: true,
} as const;

/**
 * Lock an account's VoiceProfile row, then read it (null when the account has
 * none). Revocation updates this row, so a voice-derived write re-checks
 * consent under the lock: revocation either commits first or waits for the
 * write and then clears it. Model generation only needs revocation to wait,
 * so it takes the shared lock.
 */
export async function lockVoiceProfile(tx: Prisma.TransactionClient, orgId: OrgId, igAccountId: string, mode: "update" | "share" = "update") {
  const lock = mode === "share" ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "VoiceProfile" WHERE "orgId" = ${orgId} AND "igAccountId" = ${igAccountId} ${lock}`;
  return tx.voiceProfile.findFirst({ where: { orgId, igAccountId }, select: LOCKED_PROFILE });
}

/** lockVoiceProfile for a write that needs consent; voice_consent_required otherwise. */
export async function lockConsentedVoiceProfile(tx: Prisma.TransactionClient, orgId: OrgId, igAccountId: string, mode: "update" | "share" = "update") {
  const profile = await lockVoiceProfile(tx, orgId, igAccountId, mode);
  if (!hasVoiceConsent(profile)) throw new DomainError("voice_consent_required", 409);
  return profile;
}
