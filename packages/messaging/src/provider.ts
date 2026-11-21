import type { DeliverableMetrics, MessageDirection, MessageSource } from "@dealdock/core";

/**
 * MessagingProvider — the single seam between DealDock and any DM platform.
 * Two pilot implementations: MockInstagramAdapter (dev/demo/tests) and
 * InstagramGraphAdapter (M3, official Meta Graph API only — PRD §7.2), plus
 * GmailProvider for the email channel (polling + Pub/Sub push, no webhooks here).
 * WhatsApp Business (V2) becomes "write one more adapter". See ADR-3.
 */

export type Platform = "instagram" | "whatsapp" | "email";

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
  /** The other party's display name, when the platform gives one (email From header). */
  participantName?: string;
  /** Email subject line; DMs have none. */
  subject?: string;
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
  /** Files sent with the text (email); platforms without file sends ignore them. */
  attachments?: OutgoingAttachment[];
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
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
   * Sends a file (an invoice PDF) the platform fetches from `fileUrl`
   * (public https, short-lived signed link), as its own message. Same caller
   * rule and errors as sendMessage. Email attaches files to sendMessage instead.
   */
  sendFile(
    account: ConnectedAccount,
    target: SendTarget,
    fileUrl: string,
    opts?: SendOptions
  ): Promise<SendReceipt>;

  /**
   * Instagram's private reply to a comment (comment leads): one DM to the
   * commenter, addressed by the comment id. The platform takes one per
   * comment, within 7 days of it, and it opens no messaging window. Same
   * caller rule as sendMessage: the API send gate, after a person approves.
   * @throws TokenExpiredError / RateBudgetExceededError like sendMessage.
   */
  sendPrivateReply(account: ConnectedAccount, commentId: string, text: string): Promise<SendReceipt>;

  /**
   * The sender's public profile, or null when the platform withholds it.
   * Token-bearing read: API process only, within the account's rate budget.
   * @throws TokenExpiredError / RateBudgetExceededError like other reads.
   */
  getUserProfile(account: ConnectedAccount, platformUserId: string): Promise<UserProfile | null>;

  /**
   * A post's lifetime results, found by its link among the account's recent
   * media (reels and feed posts: stories can't be listed). Null when the post
   * isn't found. Token-bearing read: API process only, within the account's
   * budget. Platforms without posts (email) don't implement it.
   * @throws TokenExpiredError / RateBudgetExceededError like other reads.
   */
  getMediaInsights?(account: ConnectedAccount, postUrl: string): Promise<MediaInsights | null>;
}

/** A post's results as the platform reports them (lifetime totals); null where it returned no number. */
export interface MediaInsights {
  mediaId: string;
  permalink: string;
  /** "VIDEO", "IMAGE", "CAROUSEL_ALBUM": a hint only. */
  mediaType: string | null;
  postedAt: string | null;
  metrics: DeliverableMetrics;
}

/** The shortcode in an Instagram post link (/p/, /reel/, /reels/, /tv/, with or without the handle first), or null. */
export function postShortcode(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !/(?:^|\.)instagram\.com$/i.test(parsed.hostname)) return null;
    return /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]{5,40})(?:\/|$)/.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
