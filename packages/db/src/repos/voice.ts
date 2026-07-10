import { prisma } from "../client";
import type { OrgId } from "../org-id";

/**
 * Consented sent-DM samples for voice modeling (PRD §6.4). Only outbound
 * messages, only when the voice profile is enabled — consent is stored on the
 * profile row created at onboarding.
 */
export async function getSentSamples(orgId: OrgId, igAccountId: string, limit = 30) {
  const profile = await prisma.voiceProfile.findFirst({
    where: { orgId, igAccountId },
    select: { enabled: true },
  });
  if (!profile?.enabled) return null;

  const messages = await prisma.message.findMany({
    where: {
      orgId,
      direction: "outbound",
      thread: { igAccountId },
    },
    orderBy: { sentAt: "desc" },
    take: limit,
    select: { id: true, text: true },
  });
  return messages;
}

export async function saveStyleCard(
  orgId: OrgId,
  igAccountId: string,
  styleCard: Record<string, unknown>,
  sampleMessageIds: string[]
) {
  const profile = await prisma.voiceProfile.findFirst({
    where: { orgId, igAccountId },
    select: { id: true, version: true },
  });
  if (!profile) throw new Error("voice profile not found");

  return prisma.voiceProfile.update({
    where: { id: profile.id },
    data: {
      styleCard: styleCard as never,
      sampleMessageIds,
      version: profile.version + 1,
      refreshedAt: new Date(),
    },
  });
}
