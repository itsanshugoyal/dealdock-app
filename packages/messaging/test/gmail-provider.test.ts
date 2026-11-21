import { describe, expect, it } from "vitest";
import {
  GmailProvider,
  RateBudgetExceededError,
  TokenExpiredError,
  type ConnectedAccount,
} from "../src/index";
import { BRAND_PITCH, BRAND_REPLY_WITH_BRIEF, CREATOR_REPLY, HINGLISH_PITCH, NEWSLETTER, b64, message, textPart } from "./gmail-fixtures";

const ACCOUNT: ConnectedAccount = {
  accountId: "acc-email-1",
  platformUserId: "aanya.creates@gmail.com",
  handle: "aanya.creates@gmail.com",
  accessToken: "ya29.test-token",
};

type Call = { url: URL; method: string; body?: string; auth?: string };
type Route = (url: URL, call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function gmail(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    calls.push(call);
    const reply = route(url, call) ?? { status: 404, body: { error: { status: "NOT_FOUND" } } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { provider: new GmailProvider({ fetchImpl, now: () => Date.UTC(2026, 10, 5) }), calls };
}

const THREAD = { id: "18c1f0a2b3c4d5e6", messages: [BRAND_REPLY_WITH_BRIEF, BRAND_PITCH, CREATOR_REPLY] };
const threadRoute: Route = (url) => (url.pathname.endsWith(`/threads/${THREAD.id}`) ? { body: THREAD } : undefined);

describe("Gmail conversations", () => {
  it("reads a thread as one conversation: participant, name, subject, ordered messages, directions", async () => {
    const { provider, calls } = gmail(threadRoute);
    const thread = await provider.getThread(ACCOUNT, THREAD.id);
    expect(calls[0]!.url.searchParams.get("format")).toBe("full");
    expect(calls[0]!.auth).toBe("Bearer ya29.test-token");
    expect(thread).toMatchObject({
      platformThreadId: THREAD.id,
      participantHandle: "priya@glowco.in",
      participantPlatformId: "priya@glowco.in",
      participantName: "Priya Sharma",
      subject: "Paid collab: GlowCo serum launch",
      lastMessageAt: new Date(Number(BRAND_REPLY_WITH_BRIEF.internalDate)),
    });
    expect(thread!.messages.map((m) => [m.platformMessageId, m.direction])).toEqual([
      ["18c1f0a2b3c4d5e6", "inbound"],
      ["18c1f9e8d7c6b5a4", "outbound"],
      ["18c2a1b2c3d4e5f6", "inbound"],
    ]);
    expect(thread!.messages[2]!.raw).toMatchObject({
      headers: { From: '"Priya Sharma" <priya@glowco.in>' },
      attachments: [{ partId: "1", attachmentId: "ANGjdJ_brief", filename: "GlowCo brief.pdf", mimeType: "application/pdf", size: 48213 }],
    });
  });

  it("replies go where Gmail's Reply goes (Reply-To), drafts are skipped, own mail is outbound", async () => {
    const viaPlatform = message("m1", {
      threadId: "t-aspire",
      from: "GlowCo via Aspire <noreply@aspire.io>",
      internalDate: 1_000,
      payload: textPart("", "text/plain", "New campaign invite"),
      extraHeaders: { "Reply-To": "Jane Doe <jane@glowco.in>" },
    });
    const draft = message("m2", { threadId: "t-aspire", from: "aanya.creates@gmail.com", internalDate: 2_000, labels: ["DRAFT"], payload: textPart("", "text/plain", "half-typed") });
    const fromAlias = message("m3", { threadId: "t-aspire", from: "hello@aanya.studio", internalDate: 3_000, labels: ["SENT"], payload: textPart("", "text/plain", "Interested!") });
    const { provider } = gmail(() => ({ body: { id: "t-aspire", messages: [viaPlatform, draft, fromAlias] } }));
    const thread = await provider.getThread(ACCOUNT, "t-aspire");
    expect(thread).toMatchObject({ participantHandle: "jane@glowco.in", participantName: "Jane Doe" });
    expect(thread!.messages.map((m) => [m.platformMessageId, m.direction])).toEqual([["m1", "inbound"], ["m3", "outbound"]]);
  });

  it("leaves out threads of only your own sends, or only Promotions", async () => {
    const sentOnly = message("s1", { threadId: "t-sent", from: "Aanya <aanya.creates@gmail.com>", internalDate: 1, labels: ["SENT"], payload: textPart("", "text/plain", "Pitch") });
    const { provider } = gmail((url) => ({ body: url.pathname.endsWith("t-sent") ? { messages: [sentOnly] } : { messages: [NEWSLETTER] } }));
    expect(await provider.getThread(ACCOUNT, "t-sent")).toBeNull();
    expect(await provider.getThread(ACCOUNT, "t-promo")).toBeNull();
  });

  it("lists recent Primary conversations, paged and bounded by the search query", async () => {
    const since = new Date(Date.UTC(2026, 9, 6));
    const { provider, calls } = gmail((url) => {
      if (url.pathname.endsWith("/threads")) {
        return url.searchParams.get("pageToken")
          ? { body: { threads: [{ id: HINGLISH_PITCH.threadId }] } }
          : { body: { threads: [{ id: THREAD.id }, { id: NEWSLETTER.threadId }], nextPageToken: "p2" } };
      }
      if (url.pathname.endsWith(THREAD.id)) return { body: THREAD };
      if (url.pathname.endsWith(NEWSLETTER.threadId!)) return { body: { messages: [NEWSLETTER] } };
      if (url.pathname.endsWith(HINGLISH_PITCH.threadId!)) return { body: { messages: [HINGLISH_PITCH] } };
      return undefined;
    });
    const threads = await provider.listConversations(ACCOUNT, since);
    expect(threads.map((t) => [t.platformThreadId, t.participantHandle, t.subject])).toEqual([
      [THREAD.id, "priya@glowco.in", "Paid collab: GlowCo serum launch"],
      [HINGLISH_PITCH.threadId, "rohan@chaicafe.in", "Collab? ☕"],
    ]);
    const q = calls[0]!.url.searchParams.get("q")!;
    expect(q).toContain(`after:${since.getTime() / 1000}`);
    expect(q).toContain("-category:promotions");
    expect(q).not.toContain("from:me");
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("fetchMessages returns only messages after `since`", async () => {
    const { provider } = gmail(threadRoute);
    const messages = await provider.fetchMessages(ACCOUNT, THREAD.id, new Date(Number(CREATOR_REPLY.internalDate)));
    expect(messages.map((m) => m.platformMessageId)).toEqual(["18c2a1b2c3d4e5f6"]);
  });
});

describe("Gmail incremental sync", () => {
  it("groups added messages by thread, skipping drafts and filed-away mail, and returns the next cursor", async () => {
    const { provider, calls } = gmail(() => ({
      body: {
        historyId: "9100",
        history: [
          { messagesAdded: [{ message: { id: "a1", threadId: "t1", labelIds: ["INBOX", "CATEGORY_PERSONAL"] } }] },
          { messagesAdded: [{ message: { id: "d1", threadId: "t1", labelIds: ["DRAFT"] } }] },
          { messagesAdded: [{ message: { id: "s1", threadId: "t1", labelIds: ["SENT"] } }] },
          { messagesAdded: [{ message: { id: "p1", threadId: "t2", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] } }] },
        ],
      },
    }));
    const changes = await provider.listHistory(ACCOUNT, "9000");
    expect(changes).toEqual({ historyId: "9100", threads: new Map([["t1", new Set(["a1", "s1"])]]) });
    expect(calls[0]!.url.searchParams.get("startHistoryId")).toBe("9000");
    expect(calls[0]!.url.searchParams.get("historyTypes")).toBe("messageAdded");
  });

  it("reports an expired cursor (404) as null so the caller re-syncs", async () => {
    const { provider } = gmail(() => undefined);
    expect(await provider.listHistory(ACCOUNT, "1")).toBeNull();
  });

  it("reads the mailbox history id and renews push with a topic", async () => {
    const { provider, calls } = gmail((url) => (url.pathname.endsWith("/profile") ? { body: { emailAddress: ACCOUNT.handle, historyId: "777" } } : { body: { historyId: "777", expiration: "1" } }));
    expect(await provider.currentHistoryId(ACCOUNT)).toBe("777");
    await provider.watch(ACCOUNT, "projects/dealdock/topics/gmail");
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ topicName: "projects/dealdock/topics/gmail", labelIds: ["INBOX", "SENT"] });
  });
});

describe("Gmail sends (API send gate only)", () => {
  it("replies in-thread to the newest message with In-Reply-To, References and Re: subject", async () => {
    const { provider, calls } = gmail((url, call) => {
      if (call.method === "POST") return { body: { id: "18c3000000000001", threadId: THREAD.id } };
      return threadRoute(url, call);
    });
    const receipt = await provider.sendMessage(ACCOUNT, { platformThreadId: THREAD.id, recipientPlatformId: "priya@glowco.in" }, "Brief received, thanks!");
    expect(receipt).toEqual({ platformMessageId: "18c3000000000001", sentAt: new Date(Date.UTC(2026, 10, 5)) });
    expect(calls[0]!.url.searchParams.get("format")).toBe("metadata");
    expect(calls[0]!.url.searchParams.getAll("metadataHeaders")).toContain("References");
    const send = calls[1]!;
    expect(send.url.pathname).toBe("/gmail/v1/users/me/messages/send");
    const { raw, threadId } = JSON.parse(send.body!) as { raw: string; threadId: string };
    expect(threadId).toBe(THREAD.id);
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: priya@glowco.in\r\n");
    expect(mime).toContain("Subject: Re: Paid collab: GlowCo serum launch\r\n");
    expect(mime).toContain("In-Reply-To: <18c2a1b2c3d4e5f6@mail.gmail.com>\r\n");
    expect(mime).toContain("References: <18c1f0a2b3c4d5e6@mail.gmail.com> <18c1f9e8d7c6b5a4@mail.gmail.com> <18c2a1b2c3d4e5f6@mail.gmail.com>\r\n");
  });

  it("attaches files as multipart/mixed when asked", async () => {
    const { provider, calls } = gmail((url, call) => (call.method === "POST" ? { body: { id: "sent-1" } } : threadRoute(url, call)));
    await provider.sendMessage(ACCOUNT, { platformThreadId: THREAD.id, recipientPlatformId: "priya@glowco.in" }, "Invoice attached.", {
      attachments: [{ filename: "INV-0042.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF") }],
    });
    const mime = Buffer.from((JSON.parse(calls[1]!.body!) as { raw: string }).raw, "base64url").toString("utf8");
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="dealdock_[0-9a-f]+"/);
    expect(mime).toContain('filename="INV-0042.pdf"');
  });

  it("never sends voice notes", async () => {
    const { provider, calls } = gmail(() => ({ body: {} }));
    await expect(provider.sendAudio()).rejects.toThrow("voice-note");
    await expect(provider.sendFile()).rejects.toThrow("attaches files");
    expect(calls).toHaveLength(0);
  });

  it("maps 401 to TokenExpiredError and rate limits to RateBudgetExceededError", async () => {
    const expired = gmail(() => ({ status: 401, body: { error: { status: "UNAUTHENTICATED" } } }));
    await expect(expired.provider.getThread(ACCOUNT, "t")).rejects.toBeInstanceOf(TokenExpiredError);
    const throttled = gmail(() => ({ status: 429, headers: { "retry-after": "7" }, body: { error: { status: "RESOURCE_EXHAUSTED" } } }));
    await expect(throttled.provider.listThreadIds(ACCOUNT)).rejects.toMatchObject({ name: "RateBudgetExceededError", retryAfterMs: 7000 });
    const quota = gmail(() => ({ status: 403, body: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } }));
    await expect(quota.provider.currentHistoryId(ACCOUNT)).rejects.toBeInstanceOf(RateBudgetExceededError);
  });

  it("spends the per-account budget before calling Gmail", async () => {
    let consumed = 0;
    const provider = new GmailProvider({
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
      rateBudget: { consume: async () => { consumed += 1; throw new RateBudgetExceededError("acc-email-1", 1000); } },
    });
    await expect(provider.currentHistoryId(ACCOUNT)).rejects.toBeInstanceOf(RateBudgetExceededError);
    expect(consumed).toBe(1);
  });
});

describe("Gmail extras", () => {
  it("downloads an attachment by partId, whatever its current attachment id", async () => {
    const { provider, calls } = gmail((url) => {
      if (url.pathname.endsWith("/attachments/ANGjdJ_brief")) return { body: { size: 4, data: b64("%PDF") } };
      if (url.pathname.endsWith(`/messages/${BRAND_REPLY_WITH_BRIEF.id}`)) return { body: BRAND_REPLY_WITH_BRIEF };
      return undefined;
    });
    const file = await provider.getAttachment(ACCOUNT, BRAND_REPLY_WITH_BRIEF.id, "1");
    expect(file).toEqual({ bytes: Buffer.from("%PDF"), filename: "GlowCo brief.pdf", mimeType: "application/pdf" });
    expect(calls).toHaveLength(2);
    expect(await provider.getAttachment(ACCOUNT, BRAND_REPLY_WITH_BRIEF.id, "0.0")).toBeNull(); // the body, not a file
  });

  it("reads a sender's display name from their latest From header", async () => {
    const { provider, calls } = gmail((url) =>
      url.pathname.endsWith("/messages") ? { body: { messages: [{ id: "m9" }] } } : { body: message("m9", { from: "Rohan Mehta <rohan@chaicafe.in>", internalDate: 1, payload: textPart("", "text/plain", "") }) }
    );
    expect(await provider.getUserProfile(ACCOUNT, "rohan@chaicafe.in")).toMatchObject({ name: "Rohan Mehta", username: null, followerCount: null });
    expect(calls[0]!.url.searchParams.get("q")).toBe("from:rohan@chaicafe.in");
    expect(await provider.getUserProfile(ACCOUNT, "not an address OR in:anywhere")).toBeNull();
  });

  it("has no webhooks of its own", () => {
    const { provider } = gmail(() => undefined);
    expect(provider.platform).toBe("email");
    expect(provider.verifyWebhook()).toBe(false);
    expect(provider.parseWebhook()).toEqual([]);
  });
});
