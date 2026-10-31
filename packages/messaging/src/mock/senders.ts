import type { UserProfile } from "../provider";
import { CORPUS } from "./corpus";

/**
 * Sender-context fixtures (F5) for the mock adapter and the web demo:
 * curated profiles for the demo handles, a deterministic profile for every
 * other corpus handle, and one inbound voice note (F8). Browser-safe.
 */

type FixtureProfile = Omit<UserProfile, "username">;

const CURATED: Record<string, FixtureProfile> = {
  herbalindia_official: { name: "Herbal India", profilePicUrl: null, followerCount: 248_000, isVerified: true, followsBusiness: false },
  "vikram.lifts91": { name: "Vikram Rathore", profilePicUrl: null, followerCount: 1_240, isVerified: false, followsBusiness: true },
  anjali_learns: { name: "Anjali Mehta", profilePicUrl: null, followerCount: 860, isVerified: false, followsBusiness: true },
  "startupdesi.in": { name: "StartupDesi", profilePicUrl: null, followerCount: 52_300, isVerified: false, followsBusiness: false },
  rohan_fan123: { name: "Rohan", profilePicUrl: null, followerCount: 312, isVerified: false, followsBusiness: true },
  "growfast.agency.2026": { name: "GrowFast Agency", profilePicUrl: null, followerCount: 18, isVerified: false, followsBusiness: false },
  priyasharma_sis: { name: "Priya Sharma", profilePicUrl: null, followerCount: 540, isVerified: false, followsBusiness: true },
  "wellness.collab.hub": { name: "Wellness Collab Hub", profilePicUrl: null, followerCount: 9_800, isVerified: false, followsBusiness: false },
  "kavya.creates": { name: "Kavya Iyer", profilePicUrl: null, followerCount: 21_400, isVerified: false, followsBusiness: true },
};

/** Same handle → same profile (no RNG), so demos and tests are reproducible. */
export function mockSenderProfile(handle: string): UserProfile {
  const curated = CURATED[handle];
  if (curated) return { ...curated, username: handle };
  let hash = 0;
  for (const char of handle) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const name = handle
    .split(/[._\d]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
  return {
    name: name || null,
    username: handle,
    profilePicUrl: null,
    followerCount: 200 + (hash % 50_000),
    isVerified: hash % 17 === 0,
    followsBusiness: hash % 3 !== 0,
  };
}

/**
 * The mock inbox's one voice note. Its URL uses the fixture scheme that
 * @dealdock/speech's downloader serves outside production (MOCK_MEDIA_SCHEME).
 */
export const MOCK_VOICE_NOTE = {
  handle: "kavya.creates",
  participantPlatformId: "mock-user-voice-0",
  platformThreadId: "mock-thread-voice-0",
  platformMessageId: "mock-voice-note-0",
  mediaUrl: "mock-media://fixture/voice-note-0",
  minutesAgo: 45,
} as const;

/** Profile for a mock participant id ("mock-user-<corpus index>" or the voice-note sender). */
export function mockProfileForPlatformUser(platformUserId: string): UserProfile | null {
  if (platformUserId === MOCK_VOICE_NOTE.participantPlatformId) return mockSenderProfile(MOCK_VOICE_NOTE.handle);
  const match = /^mock-user-(\d+)$/.exec(platformUserId);
  const fixture = match ? CORPUS[Number(match[1])] : undefined;
  return fixture ? mockSenderProfile(fixture.handle) : null;
}
