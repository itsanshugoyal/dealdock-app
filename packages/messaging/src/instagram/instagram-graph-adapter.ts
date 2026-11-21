import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessageSource } from "@dealdock/core";
import {
  postShortcode,
  RateBudgetExceededError,
  SendWindowClosedError,
  TokenExpiredError,
  type ConnectedAccount,
  type InboundEvent,
  type MediaInsights,
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
 * The configured Graph host only (graph.instagram.com, or graph.facebook.com for
 * Unified Login) — no scraping, no automation, nothing else.
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

/** Instagram Login host. Unified Login apps pass UNIFIED_GRAPH_BASE as `graphBase`. */
export const INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com/v25.0";
export const UNIFIED_GRAPH_BASE = "https://graph.facebook.com/v25.0";
/** Meta: "This message is sent outside of allowed window" (code 10). */
const WINDOW_CLOSED_SUBCODE = 2534022;
const BUDGET_CAPACITY = 180; // conservative vs Meta's ~200/hr
const BUDGET_WINDOW_MS = 60 * 60_000;

const PROFILE_FIELDS = "name,username,profile_pic,follower_count,is_verified_user,is_user_follow_business";
/**
 * Post results asked of /{media-id}/insights: lifetime totals, all valid for
 * reels and feed posts (2026); `saved` reads into `saves`. Never the
 * deprecated impressions, plays or video_views.
 */
export const INSIGHT_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"] as const;
/** Pages of 50 recent media searched for a post before giving up: the posts a deal covers are recent. */
const MEDIA_PAGES = 4;

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

/** Graph paths are named by the account id (the Instagram professional account id in both login modes): never build one from anything else. */
function accountPath(account: ConnectedAccount): string {
  if (!/^\d{1,32}$/.test(account.platformUserId)) throw new Error("Instagram account id is invalid");
  return `/${account.platformUserId}`;
}

const stringOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);
const boolOrNull = (value: unknown) => (typeof value === "boolean" ? value : null);

export interface InstagramGraphAdapterOptions {
  appSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** API injects a Redis implementation so replicas share the same budget. */
  rateBudget?: GraphRateBudget;
  /** Graph host and version; defaults to Instagram Login. Pagination may only follow this host. */
  graphBase?: string;
}

export class InstagramGraphAdapter implements MessagingProvider {
  readonly platform = "instagram" as const;

  private appSecret: string;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private rateBudget: GraphRateBudget;
  private graphBase: string;
  private graphHost: string;

  constructor(opts: InstagramGraphAdapterOptions = {}) {
    this.appSecret = opts.appSecret ?? process.env.META_APP_SECRET ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.rateBudget =
      opts.rateBudget ?? new InMemoryGraphRateBudget(BUDGET_CAPACITY, BUDGET_WINDOW_MS, this.now);
    this.graphBase = opts.graphBase ?? INSTAGRAM_GRAPH_BASE;
    this.graphHost = new URL(this.graphBase).hostname;
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
      `${accountPath(account)}/conversations`,
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

  /**
   * A post's results: find it by shortcode among the account's recent media
   * (a carousel is its parent: children have no insights), then read its
   * lifetime insights. Null when the link isn't an Instagram post or isn't
   * among the last few pages. Insights can lag Instagram by up to 48 hours.
   */
  async getMediaInsights(account: ConnectedAccount, postUrl: string): Promise<MediaInsights | null> {
    const shortcode = postShortcode(postUrl);
    if (!shortcode) return null;
    type Media = { id?: string; permalink?: string; timestamp?: string; media_type?: string };
    type Page = { data?: Media[]; paging?: { next?: string } };
    let page = await this.graphGet<Page>(account, `${accountPath(account)}/media`, { fields: "id,permalink,timestamp,media_type", limit: "50" });
    let match: Media | undefined;
    for (let read = 1; ; read += 1) {
      match = (page.data ?? []).find((media) => media.permalink && postShortcode(media.permalink) === shortcode);
      if (match || read >= MEDIA_PAGES || !page.paging?.next) break;
      page = await this.graphNext<Page>(account, page.paging.next);
    }
    // Media ids are numeric: never build a Graph path from anything else.
    if (!match?.id || !/^\d{1,32}$/.test(match.id)) return null;
    const insights = await this.graphGet<{ data?: Array<{ name?: string; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }> }>(
      account,
      `/${match.id}/insights`,
      { metric: INSIGHT_METRICS.join(",") }
    );
    const read = (name: (typeof INSIGHT_METRICS)[number]) => {
      const metric = insights.data?.find((item) => item.name === name);
      const value = metric?.total_value?.value ?? metric?.values?.[0]?.value;
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const postedAt = match.timestamp ? new Date(match.timestamp) : null;
    return {
      mediaId: match.id,
      permalink: match.permalink!,
      mediaType: stringOrNull(match.media_type),
      postedAt: postedAt && Number.isFinite(postedAt.getTime()) ? postedAt.toISOString() : null,
      metrics: { views: read("views"), reach: read("reach"), likes: read("likes"), comments: read("comments"), shares: read("shares"), saves: read("saved") },
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

  /** A file message (an invoice PDF): Meta fetches `fileUrl`. Whether Instagram Login apps may send PDFs is unverified on a live account. */
  async sendFile(
    account: ConnectedAccount,
    target: SendTarget,
    fileUrl: string,
    opts: SendOptions = {}
  ): Promise<SendReceipt> {
    if (!fileUrl.startsWith("https://")) throw new Error("Instagram files must be fetched over https");
    return this.postMessage(account, target, { attachment: { type: "file", payload: { url: fileUrl } } }, opts);
  }

  /**
   * Private reply to a comment (comment leads): addressed by the comment id,
   * from the account's own messages edge. Meta takes one per comment, within
   * 7 days of it, and replies { recipient_id, message_id }.
   */
  async sendPrivateReply(account: ConnectedAccount, commentId: string, text: string): Promise<SendReceipt> {
    if (!commentId || commentId.length > 128) throw new Error("Instagram comment id is invalid");
    return this.post(account, `${accountPath(account)}/messages`, { recipient: { comment_id: commentId }, message: { text } });
  }

  /** A post's permalink, for a comment lead's link to the post (one Graph read); null when Meta gives none. */
  async getMediaPermalink(account: ConnectedAccount, mediaId: string): Promise<string | null> {
    if (!/^\d{1,40}$/.test(mediaId)) return null;
    const body = await this.graphGet<{ permalink?: unknown }>(account, `/${mediaId}`, { fields: "permalink" });
    return typeof body.permalink === "string" && /^https:\/\/(www\.)?instagram\.com\//.test(body.permalink) ? body.permalink : null;
  }

  private async postMessage(
    account: ConnectedAccount,
    target: SendTarget,
    message: Record<string, unknown>,
    opts: SendOptions
  ): Promise<SendReceipt> {
    return this.post(account, `${accountPath(account)}/messages`, {
      recipient: { id: target.recipientPlatformId },
      message,
      // Meta documents MESSAGE_TAG + HUMAN_AGENT on the Page (Facebook Login)
      // messages route ("only HUMAN_AGENT is available for Instagram
      // Messaging"); the Instagram Login docs show no syntax. Verify on a live
      // Instagram Login account before setting META_HUMAN_AGENT_ENABLED.
      ...(opts.humanAgentTag ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : {}),
    }, target);
  }

  /** One POST to a messages edge; Meta answers with the new message's id. */
  private async post(account: ConnectedAccount, path: string, payload: Record<string, unknown>, target?: SendTarget): Promise<SendReceipt> {
    await this.consumeBudget(account.accountId);
    const res = await this.fetchImpl(`${this.graphBase}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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
      `${accountPath(account)}/conversations`,
      { platform: "instagram", user_id: participantId }
    );
    return conv.data?.[0]?.id;
  }

  /** The next page of a Graph listing: the configured host only, within the account's budget. */
  private async graphNext<T>(account: ConnectedAccount, next: string): Promise<T> {
    const url = new URL(next);
    if (url.protocol !== "https:" || url.hostname !== this.graphHost) throw new Error("Graph pagination returned an untrusted URL");
    await this.consumeBudget(account.accountId);
    const res = await this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${account.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as T & { error?: GraphError };
    if (!res.ok || body.error) throw this.mapError(body.error, account);
    return body;
  }

  private async graphGet<T>(
    account: ConnectedAccount,
    path: string,
    params: Record<string, string>
  ): Promise<T> {
    await this.consumeBudget(account.accountId);
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`${this.graphBase}${path}?${qs}`, {
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
      if (url.protocol !== "https:" || url.hostname !== this.graphHost) {
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
    // Outside the 24h standard messaging window. Bare code 10 is also a missing permission
    // or a personal account (Unified Login), so it needs the window subcode or text.
    if ((code === 10 && error?.error_subcode === WINDOW_CLOSED_SUBCODE) || /outside of allowed window|24 ?hour/i.test(message)) {
      return new SendWindowClosedError(target?.platformThreadId ?? "unknown");
    }
    // Platform throttling.
    if (code === 4 || code === 17 || code === 613 || code === 80002) {
      return new RateBudgetExceededError(account.accountId, 60_000);
    }
    return new Error(`Graph API error ${code ?? "?"}: ${message}`);
  }

  private async consumeBudget(accountId: string) {
    await this.rateBudget.consume(accountId);
  }
}
