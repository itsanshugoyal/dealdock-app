import { createHmac, timingSafeEqual } from "node:crypto";
import {
  RateBudgetExceededError,
  SendWindowClosedError,
  TokenExpiredError,
  type ConnectedAccount,
  type InboundEvent,
  type MessagingProvider,
  type RemoteMessage,
  type RemoteThread,
  type SendReceipt,
  type SendTarget,
  type WebhookRequest,
} from "../provider";

/**
 * Official Instagram API with Instagram Login (ARCHITECTURE.md §4, PRD §7.2).
 * graph.instagram.com only — no scraping, no automation, nothing else.
 *
 * Thread identity: we key threads by the COUNTERPARTY's Instagram-scoped ID
 * (IGSID), not Meta's conversation id — webhooks carry only IGSIDs, so this
 * keeps webhook and backfill writes converging on the same Thread row.
 * The conversation id is preserved in `raw` for audit.
 *
 * Platform constraints handled here:
 *  - 24h standard messaging window → SendWindowClosedError (never retried)
 *  - token revocation (OAuthException 190) → TokenExpiredError
 *  - per-account rate budget (token bucket, conservative 180/hr) → queue, don't drop
 *  - Conversations API returns only the ~20 most recent messages per thread and
 *    omits Requests-folder threads inactive 30+ days — Leak Scan depth on real
 *    accounts is limited to what the API exposes (PRD §6.2 honesty requirement).
 */

const GRAPH_BASE = "https://graph.instagram.com/v25.0";
const BUDGET_CAPACITY = 180; // conservative vs Meta's ~200/hr
const BUDGET_WINDOW_MS = 60 * 60_000;

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
}

export interface InstagramGraphAdapterOptions {
  appSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class InstagramGraphAdapter implements MessagingProvider {
  readonly platform = "instagram" as const;

  private appSecret: string;
  private fetchImpl: typeof fetch;
  private now: () => number;
  /** accountId → { tokens, lastRefill } */
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(opts: InstagramGraphAdapterOptions = {}) {
    this.appSecret = opts.appSecret ?? process.env.META_APP_SECRET ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  verifyWebhook(req: WebhookRequest): boolean {
    if (!this.appSecret) return false;
    const header = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature?.startsWith("sha256=")) return false;

    const expected = createHmac("sha256", this.appSecret)
      .update(req.rawBody, "utf8")
      .digest("hex");
    const provided = signature.slice("sha256=".length);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  }

  parseWebhook(payload: unknown): InboundEvent[] {
    const body = payload as {
      object?: string;
      entry?: Array<{
        time?: number;
        messaging?: Array<{
          sender?: { id?: string };
          recipient?: { id?: string };
          timestamp?: number;
          message?: {
            mid?: string;
            text?: string;
            is_echo?: boolean;
            attachments?: Array<{ type?: string }>;
          };
        }>;
      }>;
    };
    if (body?.object !== "instagram" || !Array.isArray(body.entry)) return [];

    const events: InboundEvent[] = [];
    for (const entry of body.entry) {
      for (const m of entry.messaging ?? []) {
        if (!m.message?.mid || !m.sender?.id || !m.recipient?.id) continue;

        // Echoes are the business's own sends (from IG app or another tool) —
        // captured as outbound so "unreplied" logic and voice sampling stay true.
        const isEcho = m.message.is_echo === true;
        const businessIgsid = isEcho ? m.sender.id : m.recipient.id;
        const counterpartyIgsid = isEcho ? m.recipient.id : m.sender.id;

        events.push({
          accountPlatformUserId: businessIgsid,
          message: {
            platformMessageId: m.message.mid,
            platformThreadId: counterpartyIgsid, // thread keyed by counterparty IGSID
            direction: isEcho ? "outbound" : "inbound",
            text: m.message.text ?? "",
            sentAt: new Date(m.timestamp ?? entry.time ?? this.now()),
            raw: m,
          },
        });
      }
    }
    return events;
  }

  // ── Reads (backfill / self-healing) ──────────────────────────────────────

  async listConversations(account: ConnectedAccount, since?: Date): Promise<RemoteThread[]> {
    const data = await this.graphGet<{
      data?: Array<{
        id: string;
        updated_time?: string;
        participants?: { data?: Array<{ id: string; username?: string }> };
      }>;
    }>(account, `/me/conversations`, {
      platform: "instagram",
      fields: "id,updated_time,participants",
      limit: "50",
    });

    const threads: RemoteThread[] = [];
    for (const conv of data.data ?? []) {
      const counterparty = conv.participants?.data?.find(
        (p) => p.id !== account.platformUserId
      );
      if (!counterparty) continue;
      const updatedAt = conv.updated_time ? new Date(conv.updated_time) : new Date(this.now());
      if (since && updatedAt <= since) continue;
      threads.push({
        platformThreadId: counterparty.id,
        participantHandle: counterparty.username ?? counterparty.id,
        participantPlatformId: counterparty.id,
        lastMessageAt: updatedAt,
      });
    }
    return threads;
  }

  async fetchMessages(
    account: ConnectedAccount,
    platformThreadId: string,
    since?: Date
  ): Promise<RemoteMessage[]> {
    // platformThreadId is the counterparty IGSID — resolve their conversation,
    // then read its (API-limited, ~20 most recent) messages.
    const conv = await this.graphGet<{ data?: Array<{ id: string }> }>(
      account,
      `/me/conversations`,
      { platform: "instagram", user_id: platformThreadId }
    );
    const conversationId = conv.data?.[0]?.id;
    if (!conversationId) return [];

    const data = await this.graphGet<{
      messages?: {
        data?: Array<{
          id: string;
          created_time?: string;
          from?: { id?: string };
          message?: string;
        }>;
      };
    }>(account, `/${conversationId}`, {
      fields: "messages{id,created_time,from,message}",
    });

    const out: RemoteMessage[] = [];
    for (const m of data.messages?.data ?? []) {
      const sentAt = m.created_time ? new Date(m.created_time) : new Date(this.now());
      if (since && sentAt <= since) continue;
      out.push({
        platformMessageId: m.id,
        platformThreadId,
        direction: m.from?.id === account.platformUserId ? "outbound" : "inbound",
        text: m.message ?? "",
        sentAt,
        raw: { ...m, conversationId },
      });
    }
    return out;
  }

  // ── Send (called ONLY by the API-layer send gate) ────────────────────────

  async sendMessage(
    account: ConnectedAccount,
    target: SendTarget,
    text: string
  ): Promise<SendReceipt> {
    this.consumeBudget(account.accountId);
    const res = await this.fetchImpl(`${GRAPH_BASE}/me/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: target.recipientPlatformId },
        message: { text },
      }),
    });

    const body = (await res.json()) as { message_id?: string; error?: GraphError };
    if (!res.ok || body.error) {
      throw this.mapError(body.error, account, target);
    }
    return {
      platformMessageId: body.message_id ?? `ig-${this.now()}`,
      sentAt: new Date(this.now()),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async graphGet<T>(
    account: ConnectedAccount,
    path: string,
    params: Record<string, string>
  ): Promise<T> {
    this.consumeBudget(account.accountId);
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`${GRAPH_BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    const body = (await res.json()) as T & { error?: GraphError };
    if (!res.ok || body.error) {
      throw this.mapError(body.error, account);
    }
    return body;
  }

  private mapError(
    error: GraphError | undefined,
    account: ConnectedAccount,
    target?: SendTarget
  ): Error {
    const code = error?.code;
    const message = error?.message ?? "unknown Graph API error";

    // OAuthException — token invalid/expired/revoked → reconnect flow.
    if (code === 190) return new TokenExpiredError(account.accountId);
    // Outside the 24h standard messaging window (code 10 / policy subcodes).
    if (code === 10 || /outside of allowed window|24 ?hour/i.test(message)) {
      return new SendWindowClosedError(target?.platformThreadId ?? "unknown");
    }
    // Platform throttling.
    if (code === 4 || code === 17 || code === 613) {
      return new RateBudgetExceededError(account.accountId, 60_000);
    }
    return new Error(`Graph API error ${code ?? "?"}: ${message}`);
  }

  private consumeBudget(accountId: string) {
    const now = this.now();
    const bucket = this.buckets.get(accountId) ?? {
      tokens: BUDGET_CAPACITY,
      lastRefill: now,
    };
    // Continuous refill.
    const refill = ((now - bucket.lastRefill) / BUDGET_WINDOW_MS) * BUDGET_CAPACITY;
    bucket.tokens = Math.min(BUDGET_CAPACITY, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil(
        ((1 - bucket.tokens) / BUDGET_CAPACITY) * BUDGET_WINDOW_MS
      );
      this.buckets.set(accountId, bucket);
      throw new RateBudgetExceededError(accountId, retryAfterMs);
    }
    bucket.tokens -= 1;
    this.buckets.set(accountId, bucket);
  }
}
