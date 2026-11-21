import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DEAL_TERMS, type DealDto, type PublicRateCard } from "@dealdock/core";
import * as db from "@dealdock/db";
import { MOCK_INSIGHTS } from "@dealdock/messaging";
import { buildServer } from "../src/index";

// The HTTP layer only: repositories are stubbed. A request without a session is refused, except the public rate card.
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  isOrgReadOnly: vi.fn(async () => false),
  createOffer: vi.fn(),
  updateOffer: vi.fn(),
  setRateCardToken: vi.fn(),
  getPublicRateCard: vi.fn(),
  setUsageHandled: vi.fn(),
  getDeal: vi.fn(),
  getConnectedAccount: vi.fn(),
  updateDeliverable: vi.fn(),
  getDraftThreadContext: vi.fn(),
  getCreatorContext: vi.fn(),
  getDraftVoiceContext: vi.fn(),
  getDealConversation: vi.fn(),
  isIgnoredHandle: vi.fn(),
  createDraft: vi.fn(),
  resolveDraftContext: vi.fn(async () => null),
}));
vi.mock("../src/auth", () => ({
  requireAuth: async (req: { auth?: unknown; headers: Record<string, unknown> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (!req.headers.authorization) return reply.code(401).send({ error: "unauthenticated" });
    req.auth = { clerkUserId: "user_1", orgId: "org_1", seatId: "seat_1", role: "creator" };
  },
}));

const app = buildServer();
app.log.level = "silent";
const signedIn = { authorization: "Bearer test" };
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object, headers: signedIn });
const deal = (patch: Partial<DealDto> = {}): DealDto => ({
  id: "deal_1", threadId: "thread_1", igAccountId: "ig_1", counterpartyHandle: "glowco", counterpartyName: null, channel: "instagram", title: "1 reel",
  dealType: "brand", amountMinor: 50_000_00, currencyCode: "INR", stage: "paid", terms: EMPTY_DEAL_TERMS, agreedAt: "2026-10-01T00:00:00Z", dueAt: null,
  invoicedAt: null, paidAt: "2026-10-20T00:00:00Z", receivedMinor: 50_000_00, tdsMinor: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...patch,
});
const posted = (label: string) => deal({ terms: { ...EMPTY_DEAL_TERMS, deliverables: [{ id: "d1", label, dueAt: null, done: true, postUrl: "https://www.instagram.com/reel/Cx1AbC9/", postedAt: "2026-10-25T10:00:00Z" }] } });

afterEach(() => {
  delete process.env.META_INSIGHTS_ENABLED;
});

describe("add-on prices on offers", () => {
  beforeEach(() => {
    vi.mocked(db.createOffer).mockReset().mockResolvedValue({ id: "offer_1" } as never);
  });

  it("validates them at the boundary and passes every key, unset ones as null", async () => {
    const response = await post("/offers", { name: "Reel", dealType: "brand", addOns: { usagePerMonthMinor: 15_000_00 } });
    expect(response.statusCode).toBe(201);
    expect(vi.mocked(db.createOffer).mock.calls[0]![2].addOns).toEqual({
      usagePerMonthMinor: 15_000_00, partnershipAdsPerMonthMinor: null, exclusivityPerMonthMinor: null, extraRevisionMinor: null, rushMinor: null, rawFootageMinor: null,
    });
    for (const addOns of [{ usagePerMonthMinor: -1 }, { rushMinor: 1.5 }, { rawFootageMinor: "500" }]) {
      expect((await post("/offers", { name: "Reel", dealType: "brand", addOns })).statusCode, JSON.stringify(addOns)).toBe(400);
    }
  });

  it("are for brand offers only", async () => {
    const response = await post("/offers", { name: "Coaching", dealType: "coaching", addOns: { rushMinor: 5_000_00 } });
    expect([response.statusCode, response.json().error]).toEqual([400, "invalid_body"]);
    // No price set is fine on any type.
    expect((await post("/offers", { name: "Coaching", dealType: "coaching", addOns: { rushMinor: null } })).statusCode).toBe(201);
    expect(db.createOffer).toHaveBeenCalledTimes(1);
  });
});

describe("the private rate-card link", () => {
  const card: PublicRateCard = { handle: "diya.moves", currencyCode: "INR", locale: "en-IN", offers: [] };

  it("makes an unguessable base64url token per creator account, and turns it off", async () => {
    vi.mocked(db.setRateCardToken).mockImplementation(async (_org, _seat, igAccountId, token) => ({ igAccountId, token }));
    const made = await post("/offers/rate-card", { igAccountId: "ig_1" });
    const token = made.json().token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 random bytes: 192 bits
    expect(db.setRateCardToken).toHaveBeenLastCalledWith("org_1", "seat_1", "ig_1", token);
    expect((await post("/offers/rate-card", { igAccountId: "ig_1" })).json().token).not.toBe(token);
    const off = await app.inject({ method: "DELETE", url: "/offers/rate-card/ig_1", headers: signedIn });
    expect(off.json()).toEqual({ igAccountId: "ig_1", token: null });
    expect((await app.inject({ method: "POST", url: "/offers/rate-card", payload: { igAccountId: "ig_1" } })).statusCode).toBe(401);
  });

  it("is readable without a session, returns public data only, and is never cached or indexed", async () => {
    vi.mocked(db.getPublicRateCard).mockResolvedValue(card);
    const response = await app.inject({ method: "GET", url: "/public/rate-cards/AbCdEfGhIjKlMnOpQrStUvWxYz012345" });
    expect([response.statusCode, response.json()]).toEqual([200, card]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("reads not found for a turned-off link, and never looks up a malformed token", async () => {
    vi.mocked(db.getPublicRateCard).mockReset().mockResolvedValue(null);
    expect((await app.inject({ method: "GET", url: "/public/rate-cards/AbCdEfGhIjKlMnOpQrStUvWxYz012345" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/public/rate-cards/short" })).statusCode).toBe(404);
    expect(db.getPublicRateCard).toHaveBeenCalledTimes(1);
  });
});

describe("usage rights and results on deals", () => {
  it("marks the usage reminder done, or brings it back", async () => {
    vi.mocked(db.setUsageHandled).mockResolvedValue(deal({ usageHandledAt: "2026-11-07T00:00:00Z" }));
    expect((await post("/deals/deal_1/usage-handled", { handled: true })).statusCode).toBe(200);
    expect(db.setUsageHandled).toHaveBeenLastCalledWith("org_1", "deal_1", "seat_1", true);
    expect((await post("/deals/deal_1/usage-handled", {})).statusCode).toBe(400);
  });

  it("fetches a post's results only when the flag is on, never for a story", async () => {
    vi.mocked(db.getDeal).mockResolvedValue(posted("1 reel"));
    vi.mocked(db.getConnectedAccount).mockResolvedValue({ accountId: "ig_1", platformUserId: "1", handle: "diya.moves", accessToken: "t", provider: "mock", status: "active" } as never);
    vi.mocked(db.updateDeliverable).mockResolvedValue(posted("1 reel"));
    expect((await post("/deals/deal_1/deliverables/d1/insights", {})).json()).toEqual({ error: "insights_unavailable" });

    process.env.META_INSIGHTS_ENABLED = "true";
    expect((await post("/deals/deal_1/deliverables/d1/insights", {})).statusCode).toBe(200);
    expect(db.updateDeliverable).toHaveBeenLastCalledWith("org_1", "deal_1", "seat_1", "d1", expect.objectContaining({ metrics: { ...MOCK_INSIGHTS } }));

    vi.mocked(db.getDeal).mockResolvedValue(posted("2 stories"));
    expect((await post("/deals/deal_1/deliverables/d1/insights", {})).json()).toEqual({ error: "story_results_not_available" });
    vi.mocked(db.getDeal).mockResolvedValue(deal({ terms: { ...EMPTY_DEAL_TERMS, deliverables: [{ id: "d1", label: "1 reel", dueAt: null, done: true }] } }));
    expect((await post("/deals/deal_1/deliverables/d1/insights", {})).json()).toEqual({ error: "post_link_required" });
    expect((await post("/deals/deal_1/deliverables/missing/insights", {})).statusCode).toBe(404);
  });
});

describe("usage-rights drafts", () => {
  beforeEach(() => {
    process.env.DEALDOCK_AI_MODE = "heuristic";
    vi.mocked(db.getDraftThreadContext).mockResolvedValue({
      id: "thread_1", igAccountId: "ig_1", participantHandle: "glowco", topLabel: "brand_deal", channel: "instagram", subject: null,
      messages: [], latestInbound: null, liveDraft: null, exclusivities: [], timezone: "Asia/Kolkata",
    });
    vi.mocked(db.getCreatorContext).mockResolvedValue({
      voiceEnabled: true, businessSummary: "Creator", currencyCode: "INR", locale: "en-IN", typicalBrandDealMinor: null, typicalCoachingMinor: null, typicalCourseMinor: null,
      styleCard: null, correctionExamples: [], offers: [], voiceRules: [], measured: [], voiceVersion: 1, excludedMessageIds: [],
    } as never);
    vi.mocked(db.getDraftVoiceContext).mockResolvedValue({ exemplarPool: [], lessonPool: [] } as never);
    vi.mocked(db.getDealConversation).mockResolvedValue({ igAccountId: "ig_1", participantHandle: "glowco", timezone: "Asia/Kolkata", threadHistory: [] });
    vi.mocked(db.isIgnoredHandle).mockResolvedValue(false);
    vi.mocked(db.createDraft).mockImplementation(async (_org, input) => ({ id: "draft_1", version: 1, status: "ready", chosenAlternative: null, invoiceId: null, ...input }) as never);
  });
  afterEach(() => {
    delete process.env.DEALDOCK_AI_MODE;
  });

  it("drafts for a paid deal, since rights outlast the payment, but never for a cancelled one", async () => {
    vi.mocked(db.getDeal).mockResolvedValue(deal({ terms: { ...EMPTY_DEAL_TERMS, usageEndsAt: "2026-12-03T18:29:59.000Z" } }));
    const drafted = await post("/threads/thread_1/draft", { purpose: "usage_renewal", dealId: "deal_1" });
    expect(drafted.statusCode).toBe(200);
    expect(drafted.json()).toMatchObject({ purpose: "usage_renewal", kind: "nudge" });
    expect(drafted.json().body).toContain("end on 3 Dec");
    // No usage price is set: the draft names none, and says so.
    expect(drafted.json().body).not.toMatch(/₹/);

    vi.mocked(db.getDeal).mockResolvedValue(deal({ stage: "cancelled" }));
    const cancelled = await post("/threads/thread_1/draft", { purpose: "usage_renewal", dealId: "deal_1" });
    expect([cancelled.statusCode, cancelled.json()]).toEqual([409, { error: "deal_not_open" }]);
  });
});
