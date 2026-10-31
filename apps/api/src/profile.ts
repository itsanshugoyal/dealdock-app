import type { FastifyBaseLogger } from "fastify";
import { asOrgId, getConnectedAccount, getParticipantForRefresh, saveParticipantProfile } from "@dealdock/db";
import { MockInstagramAdapter, type MessagingProvider } from "@dealdock/messaging";
import { getGraphAdapter } from "./graph";

/** Sender profiles are display context, refreshed at most weekly. */
const PROFILE_TTL_MS = 7 * 24 * 60 * 60_000;
const mockAdapter = new MockInstagramAdapter();
/** Threads whose refresh is running in this process: a re-read meanwhile starts no second Graph call. */
const inFlight = new Set<string>();

/** Never fetched, or fetched more than a week ago. */
export function isProfileStale(fetchedAt: Date | null, now = Date.now()): boolean {
  return fetchedAt === null || now - fetchedAt.getTime() >= PROFILE_TTL_MS;
}

/**
 * Sender context (F5): refresh a thread participant's Instagram profile
 * (name, avatar, followers, verified, follows-you) when it is missing or
 * older than 7 days. Instagram accounts read the User Profile API with the
 * account token — API process only, within the per-account Graph budget —
 * and mock accounts use fixture profiles. The username also replaces the
 * IGSID a webhook stored as the handle (05b gap 13).
 *
 * Runs in the background: nothing awaits it, so a slow or failing lookup
 * never delays or fails a conversation read; the result shows on the next
 * read. A failure records nothing (the next view retries) and is logged by
 * error name only.
 */
export function refreshParticipantProfileInBackground(orgId: string, threadId: string, log: FastifyBaseLogger): void {
  const key = `${orgId}:${threadId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  refresh(orgId, threadId)
    .catch((err: unknown) => log.warn({ err: err instanceof Error ? err.name : "unknown" }, "participant_profile_refresh_failed"))
    .finally(() => inFlight.delete(key));
}

async function refresh(orgIdValue: string, threadId: string) {
  const orgId = asOrgId(orgIdValue);
  const thread = await getParticipantForRefresh(orgId, threadId);
  if (!thread || thread.igAccount.status !== "active") return;
  if (!isProfileStale(thread.profileFetchedAt)) return;
  const provider: MessagingProvider | null =
    thread.igAccount.provider === "mock" ? mockAdapter : thread.igAccount.provider === "instagram_graph" ? getGraphAdapter() : null;
  const connected = provider ? await getConnectedAccount(orgId, thread.igAccountId) : null;
  if (!provider || !connected) return;
  const profile = await provider.getUserProfile(connected, thread.participantIgId);
  if (!profile) return;
  await saveParticipantProfile(orgId, thread.id, {
    name: profile.name,
    username: profile.username,
    avatarUrl: profile.profilePicUrl,
    followerCount: profile.followerCount,
    verified: profile.isVerified,
    followsYou: profile.followsBusiness,
  });
}
