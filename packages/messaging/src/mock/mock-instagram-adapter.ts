import type {
  ConnectedAccount,
  InboundEvent,
  MessagingProvider,
  RemoteMessage,
  RemoteThread,
  SendOptions,
  SendReceipt,
  SendTarget,
  UserProfile,
  WebhookRequest,
} from "../provider";
import { CORPUS } from "./corpus";
import { MOCK_VOICE_NOTE, mockProfileForPlatformUser } from "./senders";

/**
 * Deterministic mock of the Instagram Graph adapter (ADR-3).
 * Serves the fixture corpus as threads/messages so the entire product loop —
 * ingest → classify → inbox → draft → send → ledger — runs end-to-end with
 * zero Meta dependency. Used by local dev, demos, E2E and contract tests.
 */
export class MockInstagramAdapter implements MessagingProvider {
  readonly platform = "instagram" as const;

  private readonly now: () => Date;
  private sendCounter = 0;
  /** Keeps receipt ids unique across API restarts (they are message idempotency keys). */
  private readonly runId = Date.now().toString(36);

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  verifyWebhook(_req: WebhookRequest): boolean {
    return true;
  }

  parseWebhook(payload: unknown): InboundEvent[] {
    // The mock "webhook" payload is simply an array of InboundEvent.
    return Array.isArray(payload) ? (payload as InboundEvent[]) : [];
  }

  async listConversations(_account: ConnectedAccount, since?: Date): Promise<RemoteThread[]> {
    const corpus = CORPUS.map((f, i) => ({
      platformThreadId: `mock-thread-${i}`,
      participantHandle: f.handle,
      participantPlatformId: `mock-user-${i}`,
      lastMessageAt: this.minutesAgoDate(f.minutesAgo),
    }));
    const voiceNote = {
      platformThreadId: MOCK_VOICE_NOTE.platformThreadId,
      participantHandle: MOCK_VOICE_NOTE.handle,
      participantPlatformId: MOCK_VOICE_NOTE.participantPlatformId,
      lastMessageAt: this.minutesAgoDate(MOCK_VOICE_NOTE.minutesAgo),
    };
    return [...corpus, voiceNote].filter((t) => !since || t.lastMessageAt > since);
  }

  async fetchMessages(
    _account: ConnectedAccount,
    platformThreadId: string,
    since?: Date
  ): Promise<RemoteMessage[]> {
    if (platformThreadId === MOCK_VOICE_NOTE.platformThreadId) {
      const sentAt = this.minutesAgoDate(MOCK_VOICE_NOTE.minutesAgo);
      const voiceNote: RemoteMessage = {
        platformMessageId: MOCK_VOICE_NOTE.platformMessageId,
        platformThreadId,
        direction: "inbound",
        text: "",
        sentAt,
        raw: { mock: true, fixture: "voice-note" },
        media: { kind: "audio", url: MOCK_VOICE_NOTE.mediaUrl },
      };
      return !since || sentAt > since ? [voiceNote] : [];
    }
    const index = Number(platformThreadId.replace("mock-thread-", ""));
    const fixture = CORPUS[index];
    if (!fixture) return [];
    const message: RemoteMessage = {
      platformMessageId: `mock-msg-${index}-0`,
      platformThreadId,
      direction: "inbound",
      text: fixture.text,
      sentAt: this.minutesAgoDate(fixture.minutesAgo),
      raw: { mock: true, fixtureIndex: index },
    };
    return !since || message.sentAt > since ? [message] : [];
  }

  async sendMessage(
    _account: ConnectedAccount,
    target: SendTarget,
    _text: string,
    _opts?: SendOptions
  ): Promise<SendReceipt> {
    return this.receipt("sent", target);
  }

  async sendAudio(
    _account: ConnectedAccount,
    target: SendTarget,
    _audioUrl: string,
    _opts?: SendOptions
  ): Promise<SendReceipt> {
    return this.receipt("audio", target);
  }

  async getUserProfile(_account: ConnectedAccount, platformUserId: string): Promise<UserProfile | null> {
    return mockProfileForPlatformUser(platformUserId);
  }

  private receipt(kind: "sent" | "audio", target: SendTarget): SendReceipt {
    this.sendCounter += 1;
    return {
      platformMessageId: `mock-${kind}-${target.platformThreadId}-${this.runId}-${this.sendCounter}`,
      sentAt: this.now(),
    };
  }

  private minutesAgoDate(minutes: number): Date {
    return new Date(this.now().getTime() - minutes * 60_000);
  }
}
