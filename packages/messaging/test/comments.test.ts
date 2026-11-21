import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  IG_COMMENTS_SCOPE,
  InstagramGraphAdapter,
  MockInstagramAdapter,
  parseCommentWebhook,
  RateBudgetExceededError,
  subscribeToInstagramWebhooks,
  TokenExpiredError,
  type ConnectedAccount,
} from "../src/index";

const NOW = Date.parse("2026-11-07T10:00:00Z");
const CREATOR = "17841400000000";
const value = (overrides: Record<string, unknown> = {}) => ({
  id: "17865799348089039",
  text: "PRICE?",
  from: { id: "232323232", username: "fan.one" },
  media: { id: "17887498072083520", media_product_type: "REELS" },
  ...overrides,
});

describe("comments webhook parsing", () => {
  it("reads the Instagram Login shape: field and value on the entry", () => {
    const comments = parseCommentWebhook({ object: "instagram", entry: [{ id: CREATOR, time: 1_762_509_000, field: "comments", value: value() }] }, NOW);
    expect(comments).toEqual([{
      accountPlatformUserId: CREATOR,
      commentId: "17865799348089039",
      mediaId: "17887498072083520",
      mediaProductType: "REELS",
      commenterId: "232323232",
      commenterHandle: "fan.one",
      text: "PRICE?",
      commentedAt: new Date(1_762_509_000 * 1000),
    }]);
  });

  it("reads the Facebook Login shape: entry.changes[]", () => {
    const comments = parseCommentWebhook({
      object: "instagram",
      entry: [{ id: CREATOR, time: 1_762_509_000_000, changes: [{ field: "comments", value: value() }, { field: "mentions", value: value({ id: "2" }) }] }],
    }, NOW);
    expect(comments.map((comment) => [comment.commentId, comment.commentedAt.getTime()])).toEqual([["17865799348089039", 1_762_509_000_000]]);
  });

  it("reads Unified Login's comment_id", () => {
    const { id: _id, ...rest } = value();
    const comments = parseCommentWebhook({
      object: "instagram",
      entry: [{ id: CREATOR, time: 1_762_509_000, changes: [{ field: "comments", value: { ...rest, comment_id: "17865799348089039" } }] }],
    }, NOW);
    expect(comments.map((comment) => comment.commentId)).toEqual(["17865799348089039"]);
  });

  it("keeps replies to comments and ad comments, which are comments too", () => {
    const comments = parseCommentWebhook({
      object: "instagram",
      entry: [
        { id: CREATOR, field: "comments", value: value({ parent_id: "17865799348089000" }) },
        { id: CREATOR, field: "comments", value: value({ id: "3", media: { id: "4", media_product_type: "AD", ad_id: "9", ad_title: "Promo", original_media_id: "5" } }) },
      ],
    }, NOW);
    expect(comments.map((comment) => [comment.commentId, comment.mediaProductType])).toEqual([["17865799348089039", "REELS"], ["3", "AD"]]);
  });

  it("skips comments without text, the creator's own comments, other fields and other objects", () => {
    const entry = (v: unknown, field = "comments") => ({ id: CREATOR, time: 1, field, value: v });
    expect(parseCommentWebhook({ object: "instagram", entry: [
      entry(value({ text: undefined })),
      entry(value({ text: "   " })),
      entry(value({ from: { id: CREATOR, username: "the.creator" } })),
      entry(value({ media: undefined })),
      entry(value(), "mentions"),
      { id: CREATOR, messaging: [{ message: { mid: "m1", text: "PRICE" } }] },
    ] }, NOW)).toEqual([]);
    expect(parseCommentWebhook({ object: "page", entry: [entry(value())] }, NOW)).toEqual([]);
    expect(parseCommentWebhook(null, NOW)).toEqual([]);
    expect(parseCommentWebhook({ object: "instagram", entry: [{ field: "comments", value: value() }] }, NOW)).toEqual([]);
  });

  it("bounds what it keeps: text, a username or the id, and a time no later than now", () => {
    const [comment] = parseCommentWebhook({ object: "instagram", entry: [{ id: CREATOR, time: NOW / 1000 + 3_600, field: "comments", value: value({ text: `PRICE ${"x".repeat(3_000)}`, from: { id: "55" } }) }] }, NOW);
    expect(comment!.text).toHaveLength(2_200);
    expect(comment!.commenterHandle).toBe("55");
    expect(comment!.commentedAt.getTime()).toBe(NOW);
    const [noTime] = parseCommentWebhook({ object: "instagram", entry: [{ id: CREATOR, field: "comments", value: value({ from: { id: "56", username: "@Fan_Two" } }) }] }, NOW);
    expect([noTime!.commenterHandle, noTime!.commentedAt.getTime()]).toEqual(["Fan_Two", NOW]);
  });
});

const ACCOUNT: ConnectedAccount = { accountId: "acc-1", platformUserId: CREATOR, handle: "demo.creator", accessToken: "IGQVJ-token" };
function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("private replies through the Graph adapter", () => {
  it("posts to the account's messages edge addressed by the comment id", async () => {
    const fetch = fakeFetch(() => ({ body: { recipient_id: "232323232", message_id: "aWdfZAG1" } }));
    const adapter = new InstagramGraphAdapter({ fetchImpl: fetch.impl, now: () => NOW });
    const receipt = await adapter.sendPrivateReply(ACCOUNT, "17865799348089039", "Hey! It's ₹7,999. Link: https://example.com/c");
    expect(receipt).toEqual({ platformMessageId: "aWdfZAG1", sentAt: new Date(NOW) });
    expect(fetch.calls[0]!.url).toBe(`https://graph.instagram.com/v25.0/${CREATOR}/messages`);
    expect(fetch.calls[0]!.init?.method).toBe("POST");
    expect(fetch.calls[0]!.init?.headers).toMatchObject({ Authorization: "Bearer IGQVJ-token" });
    expect(JSON.parse(String(fetch.calls[0]!.init?.body))).toEqual({
      recipient: { comment_id: "17865799348089039" },
      message: { text: "Hey! It's ₹7,999. Link: https://example.com/c" },
    });
  });

  it("maps Meta's errors and never builds a path from a bad account id", async () => {
    const expired = new InstagramGraphAdapter({ fetchImpl: fakeFetch(() => ({ status: 400, body: { error: { code: 190, message: "expired" } } })).impl });
    await expect(expired.sendPrivateReply(ACCOUNT, "1", "hi")).rejects.toBeInstanceOf(TokenExpiredError);
    const throttled = new InstagramGraphAdapter({ fetchImpl: fakeFetch(() => ({ status: 400, body: { error: { code: 4, message: "limit" } } })).impl });
    await expect(throttled.sendPrivateReply(ACCOUNT, "1", "hi")).rejects.toBeInstanceOf(RateBudgetExceededError);
    const refused = new InstagramGraphAdapter({ fetchImpl: fakeFetch(() => ({ status: 400, body: { error: { code: 100, message: "already replied" } } })).impl });
    await expect(refused.sendPrivateReply(ACCOUNT, "1", "hi")).rejects.toThrow("Graph API error 100: already replied");

    const untouched = fakeFetch(() => ({ body: {} }));
    const adapter = new InstagramGraphAdapter({ fetchImpl: untouched.impl });
    await expect(adapter.sendPrivateReply({ ...ACCOUNT, platformUserId: "me/../x" }, "1", "hi")).rejects.toThrow("account id is invalid");
    await expect(adapter.sendPrivateReply(ACCOUNT, "", "hi")).rejects.toThrow("comment id is invalid");
    expect(untouched.calls).toHaveLength(0);
  });

  it("reads a post's permalink, and only an instagram.com one", async () => {
    const fetch = fakeFetch((url) => ({ body: { permalink: url.includes("/111?") ? "https://www.instagram.com/reel/Cx1/" : "https://evil.example/x" } }));
    const adapter = new InstagramGraphAdapter({ fetchImpl: fetch.impl });
    expect(await adapter.getMediaPermalink(ACCOUNT, "111")).toBe("https://www.instagram.com/reel/Cx1/");
    expect(fetch.calls[0]!.url).toBe("https://graph.instagram.com/v25.0/111?fields=permalink");
    expect(await adapter.getMediaPermalink(ACCOUNT, "222")).toBeNull();
    expect(await adapter.getMediaPermalink(ACCOUNT, "../me")).toBeNull();
    expect(fetch.calls).toHaveLength(2);
  });
});

describe("the mock provider's private replies", () => {
  it("answers each comment once, like Instagram", async () => {
    const mock = new MockInstagramAdapter(() => new Date(NOW));
    const first = await mock.sendPrivateReply(ACCOUNT, "c-1", "hi");
    expect(first.platformMessageId).toMatch(/^mock-private-c-1-/);
    expect(first.sentAt.getTime()).toBe(NOW);
    expect((await mock.sendPrivateReply(ACCOUNT, "c-2", "hi")).platformMessageId).not.toBe(first.platformMessageId);
    await expect(mock.sendPrivateReply(ACCOUNT, "c-1", "again")).rejects.toThrow("already has its private reply");
  });
});

describe("comment permission and webhook field", () => {
  it("asks for the comments permission only when comment leads are on", () => {
    const cfg = { appId: "app_1", redirectUri: "https://api.example/ig/callback" };
    expect(new URL(buildAuthorizeUrl(cfg, "s")).searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_messages");
    expect(new URL(buildAuthorizeUrl(cfg, "s", [IG_COMMENTS_SCOPE])).searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments",
    );
  });

  it("subscribes to comments with messages", async () => {
    const fetch = fakeFetch(() => ({ body: { success: true } }));
    await subscribeToInstagramWebhooks({ fetchImpl: fetch.impl }, "IGQVJ-token", CREATOR, ["comments", "messages"]);
    expect(String(fetch.calls[0]!.init?.body)).toBe("subscribed_fields=comments%2Cmessages");
    await expect(subscribeToInstagramWebhooks({ fetchImpl: fetch.impl }, "IGQVJ-token", CREATOR, [])).rejects.toThrow("invalid");
  });
});
