import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_REPLY_WINDOW_MS } from "@dealdock/core";
import * as db from "@dealdock/db";
import * as messaging from "@dealdock/messaging";
import { MockInstagramAdapter } from "@dealdock/messaging";
import { buildServer } from "../src/index";

// The HTTP layer only: repositories are stubbed (the claim's SQL is covered by the db integration test).
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  isOrgReadOnly: vi.fn(async () => false),
  getCommentLead: vi.fn(),
  getConnectedAccount: vi.fn(),
  claimCommentLeadSend: vi.fn(),
  releaseCommentLeadSend: vi.fn(),
  completeCommentLeadSend: vi.fn(),
  markTokenExpired: vi.fn(),
  skipCommentLead: vi.fn(),
  clearExpiredCommentLeads: vi.fn(),
  getCreatorContext: vi.fn(),
  isIgnoredHandle: vi.fn(async () => false),
  saveCommentLeadDraft: vi.fn(async () => true),
  listCommentKeywords: vi.fn(async () => []),
  listCommentLeads: vi.fn(async () => []),
  setCommentKeywords: vi.fn(async (_org: string, _seat: string, _account: string, keywords: string[]) => keywords),
  resolveVoiceAccount: vi.fn(async () => ({ id: "ig_1", handle: "diya.moves" })),
  findAccountByPlatformUserId: vi.fn(async () => null),
  findCommentLeadAccount: vi.fn(),
  recordWebhookIngress: vi.fn(async () => ({ webhookEventId: "wh_1", outbox: [], deduplicated: false })),
  markWebhookProcessed: vi.fn(),
}));
vi.mock("@dealdock/messaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/messaging")>()),
  subscribeToInstagramWebhooks: vi.fn(async () => undefined),
}));
const seat = vi.hoisted(() => ({ role: "creator" }));
vi.mock("../src/auth", () => ({
  requireAuth: async (req: { auth?: unknown }) => {
    req.auth = { clerkUserId: "user_1", orgId: "org_1", seatId: "seat_1", role: seat.role };
  },
}));

const APP_SECRET = "comment-leads-test-secret";
process.env.META_APP_SECRET = APP_SECRET;
const app = buildServer();
app.log.level = "silent";

const now = Date.now();
const leadRow = (commentedAt = new Date(now - 3_600_000)) => ({
  id: "lead_1", igAccountId: "ig_1", commentId: "1789", mediaId: "m1", commenterHandle: "fan.one", text: "PRICE?", keyword: "PRICE",
  mediaUrl: null, commentedAt, status: "new" as const, draftBody: "Heyy! It's ₹7,999.", missingFacts: [], sentAt: null,
});
const account = (provider = "mock") => ({ accountId: "ig_1", platformUserId: "17841400000000", handle: "diya.moves", accessToken: "token", refreshToken: null, provider, status: "active", tokenRefreshedAt: null, tokenExpiresAt: null, syncCursor: null });

/**
 * The claim as the database makes it: one conditional update, so only the
 * first of two racing sends wins. Each store has its own comment, since the
 * mock provider (like Instagram) takes one private reply per comment.
 */
function fakeLeadStore(commentedAt = new Date(now - 3_600_000)) {
  let status: "new" | "sending" | "sent" = "new";
  const commentId = `c-${crypto.randomUUID()}`;
  vi.mocked(db.claimCommentLeadSend).mockImplementation(async () => {
    if (Date.now() - commentedAt.getTime() >= COMMENT_REPLY_WINDOW_MS) return { claimed: false, reason: "too_late" };
    if (status !== "new") return { claimed: false, reason: status };
    status = "sending";
    return { claimed: true, lead: { id: "lead_1", igAccountId: "ig_1", commentId, commenterHandle: "fan.one", draftBody: "Heyy!" } };
  });
  vi.mocked(db.releaseCommentLeadSend).mockImplementation(async () => { if (status === "sending") status = "new"; });
  vi.mocked(db.completeCommentLeadSend).mockImplementation(async (_org, _id, input) => {
    status = "sent";
    return { ...leadRow(commentedAt), status: "sent", draftBody: input.text, sentAt: input.sentAt } as never;
  });
  return { status: () => status, commentId };
}
const send = (text = "Heyy! It's ₹7,999. Want the link?") => app.inject({ method: "POST", url: "/comment-leads/lead_1/send", payload: { text } });

beforeEach(() => {
  vi.stubEnv("META_COMMENTS_ENABLED", "true");
  seat.role = "creator";
  vi.mocked(db.getCommentLead).mockResolvedValue(leadRow() as never);
  vi.mocked(db.getConnectedAccount).mockResolvedValue(account() as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /comment-leads/:id/send", () => {
  it("sends the approved text once, by private reply to the comment, and records who sent it", async () => {
    const store = fakeLeadStore();
    const reply = vi.spyOn(MockInstagramAdapter.prototype, "sendPrivateReply");
    const response = await send("  Heyy! It's ₹7,999. Want the link?  ");
    expect(response.statusCode).toBe(200);
    expect(response.json().lead).toMatchObject({ id: "lead_1", status: "sent", draftBody: "Heyy! It's ₹7,999. Want the link?" });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]!.slice(1)).toEqual([store.commentId, "Heyy! It's ₹7,999. Want the link?"]);
    expect(db.completeCommentLeadSend).toHaveBeenCalledWith("org_1", "lead_1", expect.objectContaining({ seatId: "seat_1", text: "Heyy! It's ₹7,999. Want the link?" }));
    expect(store.status()).toBe("sent");

    // A second send is refused and never reaches Instagram.
    const again = await send();
    expect([again.statusCode, again.json()]).toEqual([409, { error: "comment_lead_already_sent" }]);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two racing sends through", async () => {
    fakeLeadStore();
    const reply = vi.spyOn(MockInstagramAdapter.prototype, "sendPrivateReply");
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("refuses after the comment's 7 days, before anything is sent", async () => {
    const old = new Date(now - COMMENT_REPLY_WINDOW_MS - 60_000);
    fakeLeadStore(old);
    vi.mocked(db.getCommentLead).mockResolvedValue(leadRow(old) as never);
    const reply = vi.spyOn(MockInstagramAdapter.prototype, "sendPrivateReply");
    const response = await send();
    expect([response.statusCode, response.json()]).toEqual([409, { error: "comment_lead_too_late" }]);
    expect(reply).not.toHaveBeenCalled();
  });

  it("frees the lead and says so when Instagram refuses the reply", async () => {
    const store = fakeLeadStore();
    vi.spyOn(MockInstagramAdapter.prototype, "sendPrivateReply").mockRejectedValueOnce(new Error("Graph API error 100"));
    const failed = await send();
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: "private_reply_failed", hint: expect.stringContaining("can't go twice") });
    expect(store.status()).toBe("new");
    expect(db.completeCommentLeadSend).not.toHaveBeenCalled();
    expect((await send()).statusCode).toBe(200);
  });

  it("marks an expired token for reconnecting", async () => {
    fakeLeadStore();
    vi.spyOn(MockInstagramAdapter.prototype, "sendPrivateReply").mockRejectedValueOnce(new messaging.TokenExpiredError("ig_1"));
    const response = await send();
    expect([response.statusCode, response.json().error]).toEqual([409, "account_not_active"]);
    expect(db.markTokenExpired).toHaveBeenCalledWith("org_1", "ig_1");
  });

  it("needs the send permission, a writable plan, text, the feature and an active account", async () => {
    fakeLeadStore();
    expect((await send("   ")).json()).toEqual({ error: "send_text_required" });
    vi.mocked(db.isOrgReadOnly).mockResolvedValueOnce(true);
    expect((await send()).statusCode).toBe(403);
    vi.mocked(db.getConnectedAccount).mockResolvedValueOnce({ ...account(), status: "token_expired" } as never);
    expect((await send()).json()).toEqual({ error: "account_not_active" });
    vi.stubEnv("META_COMMENTS_ENABLED", "false");
    expect((await send()).json()).toEqual({ error: "comment_leads_not_configured" });
    expect(db.claimCommentLeadSend).not.toHaveBeenCalled();
  });
});

describe("keywords, drafting, skipping and the listing", () => {
  it("saves one creator's keywords and subscribes a real account to comment updates", async () => {
    vi.mocked(db.getConnectedAccount).mockResolvedValue(account("instagram_graph") as never);
    const saved = await app.inject({ method: "PUT", url: "/comment-leads/keywords", payload: { igAccountId: "ig_1", keywords: [" PRICE ", "price", "Link"] } });
    expect([saved.statusCode, saved.json()]).toEqual([200, { igAccountId: "ig_1", keywords: ["PRICE", "Link"] }]);
    expect(messaging.subscribeToInstagramWebhooks).toHaveBeenCalledWith({}, "token", "17841400000000", ["comments", "messages"]);

    vi.mocked(messaging.subscribeToInstagramWebhooks).mockRejectedValueOnce(new Error("IG webhook subscription failed"));
    const failed = await app.inject({ method: "PUT", url: "/comment-leads/keywords", payload: { keywords: ["PRICE"] } });
    expect([failed.statusCode, failed.json().error]).toEqual([502, "instagram_subscription_failed"]);
    expect(db.setCommentKeywords).toHaveBeenCalledTimes(1);
  });

  it("refuses too many or too long keywords, and seats without settings access", async () => {
    const put = (keywords: string[]) => app.inject({ method: "PUT", url: "/comment-leads/keywords", payload: { keywords } });
    expect((await put(Array.from({ length: 11 }, (_, i) => `k${i}`))).json()).toEqual({ error: "too_many_keywords" });
    expect((await put(["x".repeat(31)])).json()).toEqual({ error: "keyword_too_long" });
    seat.role = "assistant";
    expect((await put(["PRICE"])).statusCode).toBe(403);
    expect(db.setCommentKeywords).not.toHaveBeenCalled();
  });

  it("drafts again only for an open lead with voice consent, within its 7 days", async () => {
    vi.stubEnv("DEALDOCK_AI_MODE", "heuristic");
    vi.mocked(db.getCreatorContext).mockResolvedValue({ voiceEnabled: true, businessSummary: "Coach", currencyCode: "INR", locale: "en-IN", typicalBrandDealMinor: null, typicalCoachingMinor: null, typicalCourseMinor: null, styleCard: null, correctionExamples: [], offers: [{ id: "o1", name: "Cohort", dealType: "course", priceMinMinor: 799_900, priceMaxMinor: null, link: null, details: null, availability: null }] } as never);
    const drafted = await app.inject({ method: "POST", url: "/comment-leads/lead_1/draft" });
    expect(drafted.statusCode).toBe(200);
    expect(vi.mocked(db.saveCommentLeadDraft).mock.calls[0]![2].body).toContain("₹7,999");

    vi.mocked(db.getCommentLead).mockResolvedValueOnce(leadRow(new Date(now - COMMENT_REPLY_WINDOW_MS - 1)) as never);
    expect((await app.inject({ method: "POST", url: "/comment-leads/lead_1/draft" })).json()).toEqual({ error: "comment_lead_too_late" });
    vi.mocked(db.getCreatorContext).mockResolvedValueOnce({ voiceEnabled: false } as never);
    expect((await app.inject({ method: "POST", url: "/comment-leads/lead_1/draft" })).json()).toEqual({ error: "voice_modeling_disabled" });
  });

  it("skips and clears through the repositories, scoped to the caller's org", async () => {
    expect((await app.inject({ method: "POST", url: "/comment-leads/lead_1/skip" })).json()).toEqual({ skipped: true });
    expect(db.skipCommentLead).toHaveBeenCalledWith("org_1", "seat_1", "lead_1");
    vi.mocked(db.clearExpiredCommentLeads).mockResolvedValueOnce(2);
    expect((await app.inject({ method: "POST", url: "/comment-leads/clear", payload: { igAccountId: "ig_1" } })).json()).toEqual({ cleared: 2 });
    expect(db.clearExpiredCommentLeads).toHaveBeenCalledWith("org_1", "seat_1", "ig_1");
  });

  it("reports whether comment leads are on, so the web app can hide them", async () => {
    vi.stubEnv("META_COMMENTS_ENABLED", "false");
    expect((await app.inject({ method: "GET", url: "/comment-leads" })).json()).toEqual({ configured: false, keywords: [], leads: [] });
    vi.stubEnv("META_COMMENTS_ENABLED", "true");
    vi.mocked(db.listCommentLeads).mockResolvedValueOnce([leadRow() as never]);
    const listed = (await app.inject({ method: "GET", url: "/comment-leads" })).json();
    expect(listed.configured).toBe(true);
    expect(listed.leads[0]).toMatchObject({ id: "lead_1", keyword: "PRICE", replyBy: new Date(leadRow().commentedAt.getTime() + COMMENT_REPLY_WINDOW_MS).toISOString() });
    expect(listed.leads[0]).not.toHaveProperty("commentId");
  });
});

describe("the comments webhook", () => {
  const CREATOR = "17841400000000";
  const body = (comments: Array<{ id: string; text?: string; from: { id: string; username: string } }>) => JSON.stringify({
    object: "instagram",
    entry: comments.map((value) => ({ id: CREATOR, time: Math.floor(now / 1000), field: "comments", value: { ...value, media: { id: "m1", media_product_type: "REELS" } } })),
  });
  const post = (raw: string) => app.inject({
    method: "POST", url: "/webhooks/instagram", payload: raw,
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}` },
  });

  beforeEach(() => {
    vi.mocked(db.findCommentLeadAccount).mockResolvedValue({ id: "ig_1", orgId: "org_1", handle: "diya.moves", igUserId: CREATOR, commentKeywords: ["PRICE", "link"] });
  });

  it("queues only keyword comments by other people, through the outbox the worker reads", async () => {
    const response = await post(body([
      { id: "c1", text: "Price kya hai?? 🔥", from: { id: "u1", username: "fan.one" } },
      { id: "c2", text: "So pretty", from: { id: "u2", username: "fan.two" } },
      { id: "c3", text: "LINK please", from: { id: "u3", username: "Diya.Moves" } },
      { id: "c4", from: { id: "u4", username: "fan.four" } },
    ]));
    expect(response.statusCode).toBe(200);
    const events = vi.mocked(db.recordWebhookIngress).mock.calls[0]![2];
    expect(events).toEqual([{
      orgId: "org_1",
      kind: "comment_lead",
      dedupeKey: "instagram:comment:ig_1:c1",
      payload: { igAccountId: "ig_1", commentId: "c1", mediaId: "m1", commenterIgId: "u1", commenterHandle: "fan.one", text: "Price kya hai?? 🔥", keyword: "PRICE", commentedAt: new Date(Math.floor(now / 1000) * 1000).toISOString() },
    }]);
  });

  it("ignores comments while comment leads are off, and unsigned payloads always", async () => {
    vi.stubEnv("META_COMMENTS_ENABLED", "false");
    await post(body([{ id: "c1", text: "PRICE", from: { id: "u1", username: "fan.one" } }]));
    expect(vi.mocked(db.recordWebhookIngress).mock.calls[0]![2]).toEqual([]);
    expect(db.findCommentLeadAccount).not.toHaveBeenCalled();
    const unsigned = await app.inject({ method: "POST", url: "/webhooks/instagram", payload: body([]), headers: { "content-type": "application/json" } });
    expect(unsigned.statusCode).toBe(401);
  });
});
