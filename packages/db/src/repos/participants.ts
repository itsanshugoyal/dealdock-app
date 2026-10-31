import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";

/**
 * Sender context (F5): a read-only display cache of the counterparty's public
 * Instagram profile on the Thread — never a contact record. Refreshed lazily
 * by the API (it needs the account token), at most weekly.
 */

/** Facts the API's profile refresher needs: who the sender is and how to reach the profile API. */
export async function getParticipantForRefresh(orgId: OrgId, threadId: string) {
  return prisma.thread.findFirst({
    where: { id: threadId, orgId },
    select: {
      id: true,
      igAccountId: true,
      participantIgId: true,
      profileFetchedAt: true,
      igAccount: { select: { provider: true, status: true } },
    },
  });
}

export interface ParticipantProfileInput {
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  followerCount: number | null;
  verified: boolean | null;
  followsYou: boolean | null;
}

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export async function saveParticipantProfile(
  orgId: OrgId,
  threadId: string,
  profile: ParticipantProfileInput,
  fetchedAt = new Date()
) {
  const followers = profile.followerCount;
  const updated = await prisma.thread.updateMany({
    where: { id: threadId, orgId },
    data: {
      participantName: profile.name?.slice(0, 120) || null,
      participantAvatarUrl: profile.avatarUrl?.startsWith("https://") ? profile.avatarUrl : null,
      participantFollowerCount:
        followers !== null && Number.isSafeInteger(followers) && followers >= 0 ? Math.min(followers, 2_147_483_647) : null,
      participantVerified: profile.verified,
      participantFollowsYou: profile.followsYou,
      profileFetchedAt: fetchedAt,
      // Webhooks only carry the IGSID; the profile's username is the real handle (05b gap 13).
      ...(profile.username && USERNAME.test(profile.username) ? { participantHandle: profile.username } : {}),
    },
  });
  if (!updated.count) throw new DomainError("thread_not_in_org", 404);
}

/**
 * Webhooks only know the sender's IGSID, so a webhook-created thread starts
 * with it as a placeholder handle. A history scan lists each conversation's
 * username; adopt it the way ingestion does for any delivery that carries one
 * (ignore-list matching relies on the username). Graph threads only: their
 * igThreadId is the IGSID. Returns the number of threads renamed.
 */
export async function adoptParticipantHandles(
  orgId: OrgId,
  igAccountId: string,
  participants: Array<{ participantIgId: string; handle: string }>
): Promise<number> {
  const handles = new Map(
    participants
      .filter((participant) => participant.handle !== participant.participantIgId && USERNAME.test(participant.handle))
      .map((participant) => [participant.participantIgId, participant.handle])
  );
  if (!handles.size) return 0;
  const ids = [...handles.keys()];
  // One read finds the few threads still on a placeholder; most scans rename nothing.
  const placeholders = await prisma.thread.findMany({
    where: { orgId, igAccountId, igThreadId: { in: ids }, participantHandle: { in: ids } },
    select: { id: true, igThreadId: true, participantHandle: true },
  });
  let adopted = 0;
  for (const thread of placeholders) {
    if (thread.participantHandle !== thread.igThreadId) continue;
    const updated = await prisma.thread.updateMany({
      where: { id: thread.id, orgId, participantHandle: thread.igThreadId },
      data: { participantHandle: handles.get(thread.igThreadId)! },
    });
    adopted += updated.count;
  }
  return adopted;
}
