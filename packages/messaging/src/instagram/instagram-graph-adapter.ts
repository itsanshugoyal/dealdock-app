import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessageSource } from "@dealdock/core";
import {
  RateBudgetExceededError,
  SendWindowClosedError,
  TokenExpiredError,
  type ConnectedAccount,
  type InboundEvent,
  type MessagingProvider,
  type RemoteMessage,
  type RemoteThread,
  type SendOptions,
  type SendReceipt,
  type SendTarget,
  type UserProfile,
  type WebhookRequest,
} from "../provider";
import { InMemoryGraphRateBudget, type GraphRateBudget } from "./graph-rate-budget";

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

const PROFILE_FIELDS = "name,username,profile_pic,follower_count,is_verified_user,is_user_follow_business";

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
}

interface WebhookAttachment {
  type?: string;
  payload?: { url?: string };
}

interface Referral {
  source?: string;
  ad_id?: string;
}

/** Story reply, story mention, reel share or ad/link referral → where the conversation came from. */
function sourceOf(
  message: { attachments?: WebhookAttachment[]; reply_to?: { story?: unknown }; referral?: Referral },
  referral: Referral | undefined
): MessageSource | undefined {
  const ref = message.referral ?? referral;
  if (ref) return ref.ad_id || ref.source?.toUpperCase() === "ADS" ? "ad" : "link";
  const kinds = (message.attachments ?? []).map((attachment) => attachment.type);
  if (message.reply_to?.story || kinds.includes("story_mention")) return "story";
  if (kinds.some((kind) => kind === "ig_reel" || kind === "reel" || kind === "share")) return "reel";
  return undefined;
}

/**
 * History attachments use the Conversations API node shape. How Instagram
 * voice notes appear there is undocumented (unverified on a live account),
 * so accept an explicit type, an audio_data url or an audio/* MIME type.
 */
function historyMedia(
  attachments: { data?: Array<Record<string, unknown>> } | undefined
): RemoteMessage["media"] {
  const first = attachments?.data?.[0];
  if (!first) return undefined;
  const mime = typeof first.mime_type === "string" ? first.mime_type : "";
  const nested = (key: string) => {
    const value = first[key] as { url?: unknown } | undefined;
    return typeof value?.url === "string" ? value.url : undefined;
  };
  const kind = typeof first.type === "string"
    ? first.type
    : nested("audio_data") || mime.startsWith("audio/") ? "audio"
    : nested("video_data") || mime.startsWith("video/") ? "video"
    : nested("image_data") || mime.startsWith("image/") ? "image"
    : "file";
  const url = nested("payload") ?? nested("audio_data") ?? (typeof first.file_url === "string" ? first.file_url : undefined)
    ?? nested("video_data") ?? nested("image_data");
  return { kind, url: url ?? null };
}

const stringOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);
const boolOrNull = (value: unknown) => (typeof value === "boolean" ? value : null);

export interface InstagramGraphAdapterOptions {
  appSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** API injects a Redis implementation so replicas share the same budget. */
  rateBudget?: GraphRateBudget;
}

export class InstagramGraphAdapter implements MessagingProvider {
  readonly platform = "instagram" as const;

  private appSecret: string;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private rateBudget: GraphRateBudget;

  constructor(opts: InstagramGraphAdapterOptions = {}) {
    this.appSecret = opts.appSecret ?? process.env.META_APP_SECRET ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.rateBudget =
      opts.rateBudget ?? new InMemoryGraphRateBudget(BUDGET_CAPACITY, BUDGET_WINDOW_MS, this.now);
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
    try {
      return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
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
          referral?: Referral;
          message?: {
            mid?: string;
            text?: string;
            is_echo?: boolean;
            attachments?: WebhookAttachment[];
            reply_to?: { story?: unknown };
            referral?: Referral;
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
        // Voice notes arrive as attachments[].type "audio" (detect by type, not MIME).
        const attachment = m.message.attachments?.[0];
        const threadSource = isEcho ? undefined : sourceOf(m.message, m.referral);

        events.push({
          accountPlatformUserId: businessIgsid,
          message: {
            platformMessageId: m.message.mid,
            platformThreadId: counterpartyIgsid, // thread keyed by counterparty IGSID
            direction: isEcho ? "outbound" : "inbound",
            text: m.message.text ?? "",
            sentAt: new Date(m.timestamp ?? entry.time ?? this.now()),
            raw: m,
            ...(attachment ? { media: { kind: attachment.type ?? "unknown", url: attachment.payload?.url ?? null } } : {}),
            ...(threadSource ? { threadSource } : {}),
          },
        });
      }
    }
    return events;
  }

  // ── Reads (backfill / self-healing) ──────────────────────────────────────

  async listConversations(account: ConnectedAccount, since?: Date): Promise<RemoteThread[]> {
    type Conversation = {
      id: string;
      updated_time?: string;
      participants?: { data?: Array<{ id: string; username?: string }> };
    };
    const updatedAt = (conv: Conversation) => (conv.updated_time ? new Date(conv.updated_time) : new Date(this.now()));
    // Every page spends the budget human sends share. Meta does not document
    // this list's order, so paging stops only once a whole page is older than
    // `since` — not at the first old conversation.
    const conversations = await this.graphGetAll<Conversation>(
      account,
      `/me/conversations`,
      { platform: "instagram", fields: "id,updated_time,participants", limit: "50" },
      since ? (page) => page.length > 0 && page.every((conv) => updatedAt(conv) <= since) : undefined
    );

    const threads: RemoteThread[] = [];
    for (const conv of conversations) {
      const counterparty = conv.participants?.data?.find(
        (p) => p.id !== account.platformUserId
      );
      if (!counterparty) continue;
      const lastMessageAt = updatedAt(conv);
      if (since && lastMessageAt <= since) continue;
      threads.push({
        platformThreadId: counterparty.id,
        participantHandle: counterparty.username ?? counterparty.id,
        participantPlatformId: counterparty.id,
        lastMessageAt,
        conversationId: conv.id,
      });
    }
    return threads;
  }

  async fetchMessages(
    account: ConnectedAccount,
    platformThreadId: string,
    since?: Date,
    listedConversationId?: string
  ): Promise<RemoteMessage[]> {
    // platformThreadId is the counterparty IGSID. Without the listing's
    // conversation id, resolve their conversation first; then read its
    // (API-limited, ~20 most recent) messages.
    const conversationId = listedConversationId ?? (await this.conversationWith(account, platformThreadId));
    if (!conversationId) return [];

    const messages = await this.graphGetAll<{
      id: string;
      created_time?: string;
      from?: { id?: string };
      message?: string;
      attachments?: { data?: Array<Record<string, unknown>> };
    }>(account, `/${conversationId}/messages`, {
      fields: "id,created_time,from,message,attachments",
      limit: "50",
    });

    const out: RemoteMessage[] = [];
    for (const m of messages) {
      const sentAt = m.created_time ? new Date(m.created_time) : new Date(this.now());
      if (since && sentAt <= since) continue;
      const media = historyMedia(m.attachments);
      out.push({
        platformMessageId: m.id,
        platformThreadId,
        direction: m.from?.id === account.platformUserId ? "outbound" : "inbound",
        text: m.message ?? "",
        sentAt,
        raw: { ...m, conversationId },
        ...(media ? { media } : {}),
      });
    }
    return out;
  }

  /**
   * Sender context via the Instagram User Profile API — available once the
   * person has messaged the account. Spends the same per-account budget as
   * every Graph read. Null when Meta withholds the profile (blocked, no
   * consent, deleted user); token and budget errors still throw.
   */
  async getUserProfile(account: ConnectedAccount, platformUserId: string): Promise<UserProfile | null> {
    // IGSIDs are numeric: never build a Graph path from anything else.
    if (!/^\d{1,32}$/.test(platformUserId)) return null;
    let body: Record<string, unknown>;
    try {
      body = await this.graphGet<Record<string, unknown>>(account, `/${platformUserId}`, { fields: PROFILE_FIELDS });
    } catch (error) {
      if (error instanceof TokenExpiredError || error instanceof RateBudgetExceededError) throw error;
      return null;
    }
    const followers = body.follower_count;
    const picture = stringOrNull(body.profile_pic);
    return {
      name: stringOrNull(body.name),
      username: stringOrNull(body.username),
      profilePicUrl: picture?.startsWith("https://") ? picture : null,
      followerCount: typeof followers === "number" && Number.isSafeInteger(followers) && followers >= 0 ? followers : null,
      isVerified: boolOrNull(body.is_verified_user),
      followsBusiness: boolOrNull(body.is_user_follow_business),
    };
  }

  // ── Send (called ONLY by the API-layer send gate) ────────────────────────

  async sendMessage(
    account: ConnectedAccount,
    target: SendTarget,
    text: string,
    opts: SendOptions = {}
  ): Promise<SendReceipt> {
    return this.postMessage(account, target, { text }, opts);
  }

  /** Voice note: Meta fetches `audioUrl` (aac/m4a/wav/mp4, ≤ 25 MB) — research 03 §4.1. */
  async sendAudio(
    account: ConnectedAccount,
    target: SendTarget,
    audioUrl: string,
    opts: SendOptions = {}
  ): Promise<SendReceipt> {
    if (!audioUrl.startsWith("https://")) throw new Error("Instagram audio must be fetched over https");
    return this.postMessage(account, target, { attachment: { type: "audio", payload: { url: audioUrl } } }, opts);
  }

  private async postMessage(
    account: ConnectedAccount,
    target: SendTarget,
    message: Record<string, unknown>,
    opts: SendOptions
  ): Promise<SendReceipt> {
    await this.consumeBudget(account.accountId);
    const res = await this.fetchImpl(`${GRAPH_BASE}/me/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: target.recipientPlatformId },
        message,
        // Meta documents MESSAGE_TAG + HUMAN_AGENT on the Page (Facebook Login)
        // messages route ("only HUMAN_AGENT is available for Instagram
        // Messaging"); the Instagram Login docs show no syntax. Verify on a live
        // Instagram Login account before setting META_HUMAN_AGENT_ENABLED.
        ...(opts.humanAgentTag ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await res.json()) as { message_id?: string; error?: GraphError };
    if (!res.ok || body.error) {
      throw this.mapError(body.error, account, target);
    }
    if (!body.message_id) throw new Error("Instagram accepted no verifiable message receipt");
    return {
      platformMessageId: body.message_id,
      sentAt: new Date(this.now()),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The conversation id for a counterparty IGSID (one Graph read). */
  private async conversationWith(account: ConnectedAccount, participantId: string): Promise<string | undefined> {
    const conv = await this.graphGet<{ data?: Array<{ id: string }> }>(
      account,
      `/me/conversations`,
      { platform: "instagram", user_id: participantId }
    );
    return conv.data?.[0]?.id;
  }

  private async graphGet<T>(
    account: ConnectedAccount,
    path: string,
    params: Record<string, string>
  ): Promise<T> {
    await this.consumeBudget(account.accountId);
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`${GRAPH_BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as T & { error?: GraphError };
    if (!res.ok || body.error) {
      throw this.mapError(body.error, account);
    }
    return body;
  }

  /**
   * Follows provider pagination with a strict page cap and trusted origin.
   * `enough(page)` returning true stops before the next page: the caller
   * needs nothing beyond it, so that is not a truncation.
   */
  private async graphGetAll<T>(
    account: ConnectedAccount,
    path: string,
    params: Record<string, string>,
    enough?: (page: T[]) => boolean
  ): Promise<T[]> {
    const first = await this.graphGet<{ data?: T[]; paging?: { next?: string } }>(
      account,
      path,
      params
    );
    const rows = [...(first.data ?? [])];
    let next = enough?.(first.data ?? []) ? undefined : first.paging?.next;
    for (let page = 0; next && page < 19; page += 1) {
      const url = new URL(next);
      next = undefined;
      if (url.protocol !== "https:" || url.hostname !== "graph.instagram.com") {
        throw new Error("Graph pagination returned an untrusted URL");
      }
      await this.consumeBudget(account.accountId);
      const res = await this.fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${account.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { data?: T[]; paging?: { next?: string }; error?: GraphError };
      if (!res.ok || body.error) throw this.mapError(body.error, account);
      const data = body.data ?? [];
      rows.push(...data);
      next = enough?.(data) ? undefined : body.paging?.next;
    }
    if (next) throw new Error("Graph history exceeds the bounded page budget; checkpoint not advanced");
    return rows;
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

  private async consumeBudget(accountId: string) {
    await this.rateBudget.consume(accountId);
  }
}
