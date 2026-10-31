import type { MessageDirection, MessageSource } from "@dealdock/core";

/**
 * MessagingProvider — the single seam between DealDock and any DM platform.
 * Two pilot implementations: MockInstagramAdapter (dev/demo/tests) and
 * InstagramGraphAdapter (M3, official Meta Graph API only — PRD §7.2).
 * WhatsApp Business (V2) becomes "write one more adapter". See ADR-3.
 */

export type Platform = "instagram" | "whatsapp";

export interface ConnectedAccount {
  /** DealDock IgAccount id (db). */
  accountId: string;
  /** Platform-side user id. */
  platformUserId: string;
  handle: string;
  /** Decrypted access token — handled only inside adapters. */
  accessToken: string;
}

export interface RemoteThread {
  platformThreadId: string;
  participantHandle: string;
  participantPlatformId: string;
  lastMessageAt: Date;
  /** The platform's own conversation id, when the listing returns one; fetchMessages then skips looking it up. */
  conversationId?: string;
}

export interface RemoteMessage {
  platformMessageId: string;
  platformThreadId: string;
  direction: MessageDirection;
  text: string;
  sentAt: Date;
  /** Raw provider payload, persisted as JSONB for audit/replay. */
  raw: unknown;
  /**
   * First attachment, if any. Voice notes are kind "audio" with a signed CDN
   * url that expires — the worker downloads it on receipt (research 03 §4.2).
   */
  media?: { kind: string; url: string | null };
  /** Where the conversation came from when the payload says so (story reply, reel share, ad/link referral). */
  threadSource?: MessageSource;
}

export interface InboundEvent {
  accountPlatformUserId: string;
  message: RemoteMessage;
}

export interface SendReceipt {
  platformMessageId: string;
  sentAt: Date;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

/** Typed failure for sends outside the platform's allowed window (Meta 24h rule). */
export class SendWindowClosedError extends Error {
  constructor(public readonly platformThreadId: string) {
    super(`Send window closed for thread ${platformThreadId}`);
    this.name = "SendWindowClosedError";
  }
}

/** Access token revoked/expired — account needs the reconnect flow (OAuthException 190). */
export class TokenExpiredError extends Error {
  constructor(public readonly accountId: string) {
    super(`Access token expired for account ${accountId}`);
    this.name = "TokenExpiredError";
  }
}

/** Per-account rate budget exhausted — queue, don't drop (ARCHITECTURE.md §4.2). */
export class RateBudgetExceededError extends Error {
  constructor(public readonly accountId: string, public readonly retryAfterMs: number) {
    super(`Rate budget exhausted for account ${accountId}; retry in ${retryAfterMs}ms`);
    this.name = "RateBudgetExceededError";
  }
}

/** Send target: the thread for persistence + the recipient IGSID the platform needs. */
export interface SendTarget {
  platformThreadId: string;
  recipientPlatformId: string;
}

export interface SendOptions {
  /**
   * Human-approved reply 24h–7d after the person's last message: Meta's
   * HUMAN_AGENT message tag. Only set when the app holds that permission
   * (META_HUMAN_AGENT_ENABLED) and the send falls in the extended window.
   */
  humanAgentTag?: boolean;
}

/** Read-only sender context from the platform's user profile API (F5); never a contact record. */
export interface UserProfile {
  name: string | null;
  username: string | null;
  profilePicUrl: string | null;
  followerCount: number | null;
  isVerified: boolean | null;
  followsBusiness: boolean | null;
}

export interface MessagingProvider {
  readonly platform: Platform;

  verifyWebhook(req: WebhookRequest): boolean;
  parseWebhook(payload: unknown): InboundEvent[];

  /** Conversations updated after `since` (all of them without it). */
  listConversations(account: ConnectedAccount, since?: Date): Promise<RemoteThread[]>;
  /**
   * A thread's messages sent after `since`. Pass the listing's
   * `conversationId` when there is one: it saves a lookup by participant.
   */
  fetchMessages(
    account: ConnectedAccount,
    platformThreadId: string,
    since?: Date,
    conversationId?: string
  ): Promise<RemoteMessage[]>;

  /**
   * Sends a message. Callers MUST be the API-layer send gate — the worker
   * never holds send capability (ARCHITECTURE.md §6.2).
   * @throws SendWindowClosedError when outside the platform reply window.
   * @throws TokenExpiredError when the account needs reconnecting.
   * @throws RateBudgetExceededError when the per-account budget is spent.
   */
  sendMessage(
    account: ConnectedAccount,
    target: SendTarget,
    text: string,
    opts?: SendOptions
  ): Promise<SendReceipt>;

  /**
   * Sends a voice note the platform fetches from `audioUrl` (public https,
   * short-lived signed link). Same caller rule and errors as sendMessage.
   */
  sendAudio(
    account: ConnectedAccount,
    target: SendTarget,
    audioUrl: string,
    opts?: SendOptions
  ): Promise<SendReceipt>;

  /**
   * The sender's public profile, or null when the platform withholds it.
   * Token-bearing read: API process only, within the account's rate budget.
   * @throws TokenExpiredError / RateBudgetExceededError like other reads.
   */
  getUserProfile(account: ConnectedAccount, platformUserId: string): Promise<UserProfile | null>;
}
