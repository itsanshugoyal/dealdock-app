import {
  RateBudgetExceededError,
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
} from "../provider";
import { InMemoryGraphRateBudget, type GraphRateBudget } from "../instagram/graph-rate-budget";
import {
  composeReply,
  findPart,
  firstMailbox,
  header,
  isPlainAddress,
  parseGmailMessage,
  type GmailMessage,
} from "./mime";

/**
 * Gmail as a messaging channel (docs/email-channel.md): a Gmail thread is a
 * DealDock thread, keyed by Gmail's threadId; its participant is the other
 * party's address. Reads are polled or pushed-then-pulled (no webhooks here),
 * and sends are threaded plain-text replies. Only the API holds this provider:
 * the token carries gmail.send, which is send capability (ARCHITECTURE.md §6.2).
 *
 * Which mail counts: Primary — anything Gmail did not file under Promotions,
 * Social, Updates or Forums, in the inbox or archived — and never spam, trash,
 * chats or drafts. A thread needs at least one such message from someone else,
 * so threads of only your own sends are left out.
 */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const REQUEST_TIMEOUT_MS = 30_000;
/** Gmail's own per-user quota is far larger; this bounds runaway loops and fits a full 30-day backfill. */
export const GMAIL_BUDGET_PER_HOUR = 1_200;
/** Most conversations one sync reads: the newest ones win when more changed (Gmail lists newest first). */
const MAX_THREADS = 300;
const MAX_HISTORY_PAGES = 10;

const CONVERSATION_QUERY = "-in:chats -in:drafts -category:promotions -category:social -category:updates -category:forums";
const HIDDEN = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);
const NOT_PRIMARY = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]);

export type GmailThread = RemoteThread & { messages: RemoteMessage[] };

interface GmailError {
  error?: { status?: string; errors?: Array<{ reason?: string }> };
}

const sentAt = (message: GmailMessage) => new Date(Number(message.internalDate) || 0);
const labelled = (message: { labelIds?: string[] }, labels: Set<string>) => (message.labelIds ?? []).some((l) => labels.has(l));

export interface GmailProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The API injects a Redis budget so replicas share it. */
  rateBudget?: GraphRateBudget;
}

export class GmailProvider implements MessagingProvider {
  readonly platform = "email" as const;

  private fetchImpl: typeof fetch;
  private now: () => number;
  private rateBudget: GraphRateBudget;

  constructor(opts: GmailProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.rateBudget = opts.rateBudget ?? new InMemoryGraphRateBudget(GMAIL_BUDGET_PER_HOUR, 60 * 60_000, this.now);
  }

  // ── Webhooks: none. Gmail push (Pub/Sub) only says "something changed"; the API then syncs. ──

  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): InboundEvent[] {
    return [];
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** Conversations with mail after `since`, newest first, bounded. Each is one thread read. */
  async listConversations(account: ConnectedAccount, since?: Date): Promise<RemoteThread[]> {
    const threads: RemoteThread[] = [];
    for (const id of await this.listThreadIds(account, since)) {
      const thread = await this.getThread(account, id);
      if (thread) threads.push(thread);
    }
    return threads;
  }

  async fetchMessages(account: ConnectedAccount, platformThreadId: string, since?: Date): Promise<RemoteMessage[]> {
    const thread = await this.getThread(account, platformThreadId);
    return (thread?.messages ?? []).filter((message) => !since || message.sentAt > since);
  }

  /** Ids of conversations with mail after `since` (all of them without it), newest first. */
  async listThreadIds(account: ConnectedAccount, since?: Date): Promise<string[]> {
    const q = since ? `${CONVERSATION_QUERY} after:${Math.floor(since.getTime() / 1000)}` : CONVERSATION_QUERY;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.get<{ threads?: Array<{ id?: string }>; nextPageToken?: string }>(account, "/threads", {
        q,
        maxResults: "100",
        pageToken,
      });
      for (const thread of page?.threads ?? []) if (thread.id) ids.push(thread.id);
      pageToken = page?.nextPageToken;
    } while (pageToken && ids.length < MAX_THREADS);
    return ids.slice(0, MAX_THREADS);
  }

  /**
   * A conversation and all its messages from one read. Null when Gmail no
   * longer has it, or it has no Primary mail from someone else. The
   * participant is the first such sender — their Reply-To when set, since
   * that is where Gmail's own Reply goes.
   */
  async getThread(account: ConnectedAccount, threadId: string): Promise<GmailThread | null> {
    const thread = await this.get<{ messages?: GmailMessage[] }>(account, `/threads/${encodeURIComponent(threadId)}`, { format: "full" });
    const messages = (thread?.messages ?? [])
      .filter((message) => !labelled(message, HIDDEN))
      .sort((a, b) => sentAt(a).getTime() - sentAt(b).getTime());
    const own = account.platformUserId;
    const first = messages.find((message) => !this.isOwn(message, own) && !labelled(message, NOT_PRIMARY));
    if (!first) return null;
    const from = firstMailbox(header(first, "From"));
    const participant = firstMailbox(header(first, "Reply-To")) ?? from;
    if (!participant || !isPlainAddress(participant.address)) return null;
    const name = participant.name ?? from?.name;
    const subject = header(messages[0]!, "Subject")?.trim().slice(0, 500);
    return {
      platformThreadId: threadId,
      participantHandle: participant.address,
      participantPlatformId: participant.address,
      lastMessageAt: sentAt(messages[messages.length - 1]!),
      ...(name ? { participantName: name.slice(0, 120) } : {}),
      ...(subject ? { subject } : {}),
      messages: messages.map((message) => this.toRemoteMessage(message, threadId, own)),
    };
  }

  /** The mailbox's current history id: where the next incremental sync starts. */
  async currentHistoryId(account: ConnectedAccount): Promise<string> {
    const profile = await this.get<{ historyId?: string }>(account, "/profile");
    if (!profile?.historyId) throw new Error("Gmail returned no history id");
    return profile.historyId;
  }

  /**
   * Messages added since `startHistoryId`, grouped by thread, and the cursor
   * to resume from. Null when Gmail no longer keeps that history (about a
   * week) or too much changed for one pass: the caller re-syncs the recent window.
   */
  async listHistory(
    account: ConnectedAccount,
    startHistoryId: string
  ): Promise<{ historyId: string; threads: Map<string, Set<string>> } | null> {
    type History = { messagesAdded?: Array<{ message?: { id?: string; threadId?: string; labelIds?: string[] } }> };
    const threads = new Map<string, Set<string>>();
    let historyId: string | undefined;
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await this.get<{ history?: History[]; nextPageToken?: string; historyId?: string }>(account, "/history", {
        startHistoryId,
        historyTypes: "messageAdded",
        maxResults: "500",
        pageToken,
      });
      if (!page) return null;
      historyId ??= page.historyId;
      for (const record of page.history ?? []) {
        for (const { message } of record.messagesAdded ?? []) {
          // Drafts add a message on every autosave; filed-away categories never become threads.
          if (!message?.id || !message.threadId || labelled(message, HIDDEN) || labelled(message, NOT_PRIMARY)) continue;
          threads.set(message.threadId, (threads.get(message.threadId) ?? new Set<string>()).add(message.id));
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken && ++pages < MAX_HISTORY_PAGES);
    if (pageToken || threads.size > MAX_THREADS) return null;
    return { historyId: historyId ?? startHistoryId, threads };
  }

  /** One attachment's bytes, found again by partId (attachment ids are not stable between reads). */
  async getAttachment(
    account: ConnectedAccount,
    messageId: string,
    partId: string
  ): Promise<{ bytes: Buffer; filename: string; mimeType: string } | null> {
    const message = await this.get<GmailMessage>(account, `/messages/${encodeURIComponent(messageId)}`, { format: "full" });
    const part = findPart(message?.payload, partId);
    if (!part?.filename) return null;
    const data = part.body?.attachmentId
      ? (await this.get<{ data?: string }>(
          account,
          `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`
        ))?.data
      : part.body?.data;
    if (data === undefined) return null;
    return { bytes: Buffer.from(data, "base64url"), filename: part.filename, mimeType: part.mimeType || "application/octet-stream" };
  }

  /**
   * The sender's display name from their latest message's From header —
   * email has no profile API. Null when there is no mail from them.
   */
  async getUserProfile(account: ConnectedAccount, platformUserId: string): Promise<UserProfile | null> {
    if (!isPlainAddress(platformUserId)) return null;
    const list = await this.get<{ messages?: Array<{ id?: string }> }>(account, "/messages", { q: `from:${platformUserId}`, maxResults: "1" });
    const id = list?.messages?.[0]?.id;
    const message = id
      ? await this.get<GmailMessage>(account, `/messages/${encodeURIComponent(id)}`, { format: "metadata", metadataHeaders: "From" })
      : null;
    if (!message) return null;
    return {
      name: firstMailbox(header(message, "From"))?.name ?? null,
      username: null,
      profilePicUrl: null,
      followerCount: null,
      isVerified: null,
      followsBusiness: null,
    };
  }

  // ── Push (Pub/Sub) ───────────────────────────────────────────────────────

  /** Starts or renews (lasts 7 days) push notifications for new inbox mail and sends. */
  async watch(account: ConnectedAccount, topicName: string): Promise<void> {
    await this.request(account, "POST", "/watch", { json: { topicName, labelIds: ["INBOX", "SENT"] } });
  }

  async stopWatch(account: ConnectedAccount): Promise<void> {
    await this.request(account, "POST", "/stop");
  }

  // ── Send (called ONLY by the API-layer send gate) ────────────────────────

  /**
   * A threaded reply to the newest message in the thread: Gmail threads it
   * by threadId plus In-Reply-To/References and a matching "Re:" subject.
   */
  async sendMessage(account: ConnectedAccount, target: SendTarget, text: string, opts: SendOptions = {}): Promise<SendReceipt> {
    const thread = await this.get<{ messages?: GmailMessage[] }>(account, `/threads/${encodeURIComponent(target.platformThreadId)}`, {
      format: "metadata",
      metadataHeaders: ["Subject", "Message-ID", "Message-Id", "References"],
    });
    const parent = (thread?.messages ?? [])
      .filter((message) => !labelled(message, HIDDEN))
      .sort((a, b) => sentAt(a).getTime() - sentAt(b).getTime())
      .at(-1);
    if (!parent) throw new Error("Gmail thread not found");
    const raw = composeReply({
      to: target.recipientPlatformId,
      subject: header(parent, "Subject") ?? "",
      inReplyTo: header(parent, "Message-ID"),
      references: header(parent, "References"),
      text,
      attachments: opts.attachments,
    });
    const sent = await this.request<{ id?: string }>(account, "POST", "/messages/send", { json: { raw, threadId: target.platformThreadId } });
    if (!sent?.id) throw new Error("Gmail accepted no verifiable message receipt");
    return { platformMessageId: sent.id, sentAt: new Date(this.now()) };
  }

  async sendAudio(): Promise<SendReceipt> {
    throw new Error("Email does not support voice-note sends");
  }

  /** Email attaches files to the reply itself (SendOptions.attachments). */
  async sendFile(): Promise<SendReceipt> {
    throw new Error("Email attaches files to sendMessage");
  }

  async sendPrivateReply(): Promise<SendReceipt> {
    throw new Error("Email has no comments to reply to");
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Our own mail: Gmail's SENT label (covers send-as aliases), or From is the inbox's address. */
  private isOwn(message: GmailMessage, ownAddress: string): boolean {
    return (message.labelIds ?? []).includes("SENT") || firstMailbox(header(message, "From"))?.address === ownAddress;
  }

  private toRemoteMessage(message: GmailMessage, threadId: string, ownAddress: string): RemoteMessage {
    const { text, attachments } = parseGmailMessage(message);
    const headers = Object.fromEntries(
      ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID"].map((name) => [name, header(message, name) ?? null])
    );
    return {
      platformMessageId: message.id,
      platformThreadId: threadId,
      direction: this.isOwn(message, ownAddress) ? "outbound" : "inbound",
      text,
      sentAt: sentAt(message),
      // Headers and attachment metadata only: bodies are already in `text`, and files stay in Gmail.
      raw: { id: message.id, threadId, labelIds: message.labelIds ?? [], internalDate: message.internalDate ?? null, headers, attachments },
    };
  }

  /** Undefined values are left out; an array repeats its key (metadataHeaders). */
  private get<T>(account: ConnectedAccount, path: string, query: Record<string, string | string[] | undefined> = {}): Promise<T | null> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const item of [value ?? []].flat()) params.append(key, item);
    return this.request<T>(account, "GET", params.size ? `${path}?${params.toString()}` : path);
  }

  /** One Gmail call within the account's budget. Null for 404 (gone, or history too old). */
  private async request<T>(account: ConnectedAccount, method: "GET" | "POST", path: string, opts: { json?: unknown } = {}): Promise<T | null> {
    await this.rateBudget.consume(account.accountId);
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        ...(opts.json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(opts.json === undefined ? {} : { body: JSON.stringify(opts.json) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    const body = (await res.json().catch(() => ({}))) as T & GmailError;
    if (res.ok) return body;
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
    if (res.status === 401) throw new TokenExpiredError(account.accountId);
    if (res.status === 429 || /rateLimitExceeded/i.test(reason)) {
      throw new RateBudgetExceededError(account.accountId, (Number(res.headers.get("retry-after")) || 60) * 1000);
    }
    throw new Error(`Gmail API error ${res.status}${reason ? ` ${reason}` : ""}`);
  }
}
