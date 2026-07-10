import type { MessageDirection } from "@dealdock/core";

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
}

export interface RemoteMessage {
  platformMessageId: string;
  platformThreadId: string;
  direction: MessageDirection;
  text: string;
  sentAt: Date;
  /** Raw provider payload, persisted as JSONB for audit/replay. */
  raw: unknown;
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

export interface MessagingProvider {
  readonly platform: Platform;

  verifyWebhook(req: WebhookRequest): boolean;
  parseWebhook(payload: unknown): InboundEvent[];

  listConversations(account: ConnectedAccount, since?: Date): Promise<RemoteThread[]>;
  fetchMessages(
    account: ConnectedAccount,
    platformThreadId: string,
    since?: Date
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
    text: string
  ): Promise<SendReceipt>;
}
