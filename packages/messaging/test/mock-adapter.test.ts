import { describe, expect, it } from "vitest";
import {
  CORPUS,
  MOCK_VOICE_NOTE,
  MockInstagramAdapter,
  mockSenderProfile,
  type ConnectedAccount,
  type MessagingProvider,
} from "../src/index";

const ACCOUNT: ConnectedAccount = { accountId: "acc-mock", platformUserId: "mock-business", handle: "demo.creator", accessToken: "" };
const target = { platformThreadId: "mock-thread-0", recipientPlatformId: "mock-user-0" };

describe("MockInstagramAdapter contract", () => {
  const adapter: MessagingProvider = new MockInstagramAdapter(() => new Date("2026-10-31T12:00:00Z"));

  it("returns distinct receipts for text and voice-note sends", async () => {
    const text = await adapter.sendMessage(ACCOUNT, target, "hello", { humanAgentTag: true });
    const audio = await adapter.sendAudio(ACCOUNT, target, "https://api.example.test/media/a/1");
    expect(text.platformMessageId).not.toBe(audio.platformMessageId);
    expect(audio.platformMessageId).toMatch(/^mock-audio-mock-thread-0-/);
    expect(audio.sentAt.toISOString()).toBe("2026-10-31T12:00:00.000Z");
  });

  it("serves fixture sender profiles for corpus participants", async () => {
    const curated = await adapter.getUserProfile(ACCOUNT, "mock-user-0");
    expect(curated).toMatchObject({ username: CORPUS[0]!.handle, name: "Herbal India", isVerified: true });
    const last = CORPUS.length - 1;
    const generated = await adapter.getUserProfile(ACCOUNT, `mock-user-${last}`);
    expect(generated?.username).toBe(CORPUS[last]!.handle);
    expect(generated?.followerCount).toBeGreaterThanOrEqual(200);
    await expect(adapter.getUserProfile(ACCOUNT, "someone-else")).resolves.toBeNull();
    expect(mockSenderProfile("x.y_z9")).toEqual(mockSenderProfile("x.y_z9"));
  });

  it("includes one inbound voice note with a fixture media url", async () => {
    const threads = await adapter.listConversations(ACCOUNT);
    expect(threads).toHaveLength(CORPUS.length + 1);
    const voiceThread = threads.find((thread) => thread.platformThreadId === MOCK_VOICE_NOTE.platformThreadId)!;
    expect(voiceThread.participantHandle).toBe(MOCK_VOICE_NOTE.handle);
    const [note] = await adapter.fetchMessages(ACCOUNT, voiceThread.platformThreadId);
    expect(note).toMatchObject({ direction: "inbound", text: "", media: { kind: "audio", url: MOCK_VOICE_NOTE.mediaUrl } });
    await expect(adapter.getUserProfile(ACCOUNT, MOCK_VOICE_NOTE.participantPlatformId)).resolves.toMatchObject({ name: "Kavya Iyer" });
  });
});
