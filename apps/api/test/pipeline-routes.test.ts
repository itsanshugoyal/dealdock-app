import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DealDto, ParsedLeadEvent } from "@dealdock/core";
import * as db from "@dealdock/db";
import { buildServer } from "../src/index";

// The HTTP layer only: repositories are stubbed, auth is a creator seat, and no push queue is reached.
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  isOrgReadOnly: vi.fn(async () => false),
  resolveLeadSource: vi.fn(),
  recordLeadEvents: vi.fn(),
  createLeadSource: vi.fn(),
  setLeadSourceSecret: vi.fn(async () => ({ id: "src_1", provider: "stripe", label: null, lastEventAt: null, createdAt: "2026-11-07T00:00:00.000Z", needsSecret: false })),
  setLeadStage: vi.fn(async (_org: string, _seat: string, _thread: string, stage: string) => ({ leadStage: stage })),
  listRenewals: vi.fn(async () => []),
  handleRenewal: vi.fn(async () => ({ id: "deal_1" })),
  getOrgSettings: vi.fn(async () => ({ timezone: "Asia/Kolkata", locale: "en-IN" })),
  getDraftThreadContext: vi.fn(),
  getCreatorContext: vi.fn(),
  getDraftVoiceContext: vi.fn(),
  getDealConversation: vi.fn(),
  getDeal: vi.fn(),
  getInvoice: vi.fn(),
  isIgnoredHandle: vi.fn(async () => false),
  createDraft: vi.fn(),
  resolveDraftContext: vi.fn(async () => null),
}));
vi.mock("../src/auth", () => ({
  requireAuth: async (req: { auth?: unknown }) => {
    req.auth = { clerkUserId: "user_1", orgId: "org_1", seatId: "seat_1", role: "creator" };
  },
}));
const queued = vi.fn(async () => undefined);
vi.mock("../src/queues", () => ({ getNotificationsQueue: () => ({ add: queued }), getIngestionQueue: () => ({ getJobCounts: async () => ({}) }) }));

const app = buildServer();
app.log.level = "silent";

const TOKEN = "A".repeat(43);
const SECRET = "whsec_test_secret";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const source = (provider: string, secret: string | null = SECRET) => ({ id: `src_${provider}`, orgId: "org_1", provider, secret, orgCurrency: "INR" });
const post = (body: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/webhooks/leads/${TOKEN}`, payload: body, headers: { "content-type": "application/json", ...headers } });

/** What the database does for a redelivery: one row per (source, external id). */
const stored = new Set<string>();
beforeEach(() => {
  stored.clear();
  queued.mockClear();
  vi.mocked(db.resolveLeadSource).mockReset();
  vi.mocked(db.recordLeadEvents).mockReset().mockImplementation(async (_org, from, events: readonly ParsedLeadEvent[]) => {
    let count = 0;
    for (const event of events) {
      const key = `${from.id}:${event.externalId}`;
      if (!stored.has(key)) { stored.add(key); count += 1; }
    }
    return { stored: count, duplicates: events.length - count, matchedPayments: [] };
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("POST /webhooks/leads/:token", () => {
  const entity = { id: "pay_ABC", amount: 499_900, currency: "INR", notes: { name: "Neha S" }, created_at: 1_762_400_000 };
  const captured = JSON.stringify({ event: "payment.captured", payload: { payment: { entity } } });

  it("answers 404 for an address that isn't connected", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(null);
    expect((await post(captured)).statusCode).toBe(404);
    expect(db.recordLeadEvents).not.toHaveBeenCalled();
  });

  it("refuses a Razorpay report whose signature doesn't match, before reading it", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("razorpay") as never);
    for (const headers of [{}, { "x-razorpay-signature": sign(captured, "someone-else") }, { "x-razorpay-signature": sign(`${captured} `) }, { "x-razorpay-signature": "zz" }]) {
      const response = await post(captured, headers);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_signature" });
    }
    expect(db.recordLeadEvents).not.toHaveBeenCalled();
  });

  it("stores a payment once, however many times or ways Razorpay reports it", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("razorpay") as never);
    const first = await post(captured, { "x-razorpay-signature": sign(captured) });
    expect([first.statusCode, first.json()]).toEqual([200, { received: 1, stored: 1 }]);
    const again = await post(captured, { "x-razorpay-signature": sign(captured) });
    expect([again.statusCode, again.json()]).toEqual([200, { received: 1, stored: 0 }]);
    const linkPaid = JSON.stringify({ event: "payment_link.paid", payload: { payment: { entity }, payment_link: { entity: { customer: { name: "Neha Shah" } } } } });
    expect((await post(linkPaid, { "x-razorpay-signature": sign(linkPaid) })).json()).toEqual({ received: 1, stored: 0 });
    expect(stored.size).toBe(1);
    expect(vi.mocked(db.recordLeadEvents).mock.calls[0]![2]).toEqual([
      { kind: "paid", externalId: "pay_ABC", ref: null, amountMinor: 499_900, currencyCode: "INR", payerName: "Neha S", occurredAt: new Date(1_762_400_000_000).toISOString() },
    ]);
  });

  it("acknowledges events it doesn't use, and refuses a body that isn't the tool's", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("razorpay") as never);
    const failed = JSON.stringify({ event: "payment.failed", payload: { payment: { entity } } });
    expect((await post(failed, { "x-razorpay-signature": sign(failed) })).json()).toEqual({ received: 0 });
    const broken = JSON.stringify({ event: "payment.captured", payload: {} });
    expect((await post(broken, { "x-razorpay-signature": sign(broken) })).statusCode).toBe(400);
    expect(db.recordLeadEvents).not.toHaveBeenCalled();
  });

  it("checks Stripe's timestamped signature, any v1, within five minutes", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("stripe") as never);
    const body = JSON.stringify({ type: "checkout.session.completed", created: 1, data: { object: { id: "cs_1", payment_status: "paid", client_reference_id: "dd_t1", amount_total: 4_900, currency: "usd" } } });
    const now = Math.floor(Date.now() / 1000);
    const valid = sign(`${now}.${body}`);
    expect((await post(body, { "stripe-signature": `t=${now},v1=${"0".repeat(64)},v1=${valid}` })).statusCode).toBe(200);
    expect((await post(body, { "stripe-signature": `t=${now - 301},v1=${sign(`${now - 301}.${body}`)}` })).statusCode).toBe(401);
    expect((await post(body, { "stripe-signature": `t=${now},v1=${sign(body)}` })).statusCode).toBe(401);
    expect(vi.mocked(db.recordLeadEvents).mock.calls[0]![2][0]).toMatchObject({ ref: "dd_t1", amountMinor: 4_900, currencyCode: "USD" });
  });

  it("checks Calendly's signature with DealDock's signing key, within three minutes", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("calendly") as never);
    const body = JSON.stringify({ event: "invitee.created", payload: { uri: "https://api.calendly.com/x/invitees/1", name: "Rhea", tracking: { utm_content: "dd_t1" } } });
    const now = Math.floor(Date.now() / 1000);
    expect((await post(body, { "calendly-webhook-signature": `t=${now},v1=${sign(`${now}.${body}`)}` })).statusCode).toBe(200);
    expect((await post(body, { "calendly-webhook-signature": `t=${now - 200},v1=${sign(`${now - 200}.${body}`)}` })).statusCode).toBe(401);
  });

  it("checks Cal.com's signature when the creator set a secret, and trusts the address alone when not", async () => {
    const body = JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: { uid: "bk_1", attendees: [{ name: "Arjun" }] } });
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("cal_com") as never);
    expect((await post(body, { "x-cal-signature-256": sign(body) })).statusCode).toBe(200);
    expect((await post(body)).statusCode).toBe(401);
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("cal_com", null) as never);
    expect((await post(body)).statusCode).toBe(200);
  });

  it("takes DealDock's own JSON on the other address, and refuses an oversized body", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("other", null) as never);
    const paid = JSON.stringify({ event: "paid", id: "zap-1", amount: 2999.5, name: "Neha" });
    expect((await post(paid)).json()).toEqual({ received: 1, stored: 1 });
    expect(vi.mocked(db.recordLeadEvents).mock.calls[0]![2][0]).toMatchObject({ amountMinor: 299_950, currencyCode: "INR", payerName: "Neha" });
    expect((await post(JSON.stringify({ event: "paid" }))).statusCode).toBe(400);
    expect((await post(JSON.stringify({ event: "paid", id: "x", note: "y".repeat(70 * 1024) }))).statusCode).toBe(413);
  });

  it("queues a push for a matched payment without waiting for it", async () => {
    vi.mocked(db.resolveLeadSource).mockResolvedValue(source("other", null) as never);
    vi.mocked(db.recordLeadEvents).mockResolvedValueOnce({ stored: 1, duplicates: 0, matchedPayments: [{ threadId: "t1", handle: "rhea.runs", amountMinor: 499_900, currencyCode: "INR" }] });
    expect((await post(JSON.stringify({ event: "paid", id: "zap-2", amount: 4999 }))).statusCode).toBe(200);
    expect(queued).toHaveBeenCalledWith("lead-paid", { orgId: "org_1", kind: "lead_paid", threadId: "t1", handle: "rhea.runs", valueMaxMinor: 499_900, currencyCode: "INR", locale: "en-IN" });
  });
});

describe("connecting a tool", () => {
  beforeEach(() => {
    vi.mocked(db.createLeadSource).mockReset().mockImplementation(async (_org, _seat, input) => ({ id: "src_1", provider: input.provider, label: input.label, lastEventAt: null, createdAt: "2026-11-07T00:00:00.000Z", needsSecret: input.secret === null && (input.provider === "razorpay" || input.provider === "stripe") }));
    process.env.PUBLIC_API_URL = "https://api.dealdock.test";
  });
  const connect = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/lead-sources", payload: body });

  it("shows a new secret address once and stores only what the database needs", async () => {
    const response = await connect({ provider: "razorpay", secret: "rzp_webhook_secret" });
    expect(response.statusCode).toBe(200);
    const { address } = response.json() as { address: string };
    const token = /^https:\/\/api\.dealdock\.test\/webhooks\/leads\/([A-Za-z0-9_-]{43})$/.exec(address)?.[1];
    expect(token).toBeTruthy();
    expect(db.createLeadSource).toHaveBeenCalledWith("org_1", "seat_1", { provider: "razorpay", label: null, token, secret: "rzp_webhook_secret" });
    // The address is different every time.
    expect((await connect({ provider: "other" })).json().address).not.toBe(address);
  });

  it("takes Stripe's signing secret after the address, and no secret for the plain address", async () => {
    for (const body of [{ provider: "other", secret: "whatever-it-is" }, { provider: "calendly" }, { provider: "calendly", secret: "whatever-it-is", accessKey: "calendly-personal-access-key-0123" }, { provider: "razorpay", secret: "short" }, { provider: "nope" }]) {
      expect((await connect(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(db.createLeadSource).not.toHaveBeenCalled();
    expect((await connect({ provider: "cal_com" })).statusCode).toBe(200);
    // Stripe shows its secret only once the address is saved there: it waits for it.
    expect((await connect({ provider: "stripe" })).json().source).toMatchObject({ provider: "stripe", needsSecret: true });
    const saved = await app.inject({ method: "PUT", url: "/lead-sources/src_1/secret", payload: { secret: "whsec_from_stripe" } });
    expect([saved.statusCode, saved.json().needsSecret]).toEqual([200, false]);
    expect(db.setLeadSourceSecret).toHaveBeenCalledWith("org_1", "seat_1", "src_1", "whsec_from_stripe");
    expect((await app.inject({ method: "PUT", url: "/lead-sources/src_1/secret", payload: { secret: "" } })).statusCode).toBe(400);
  });

  it("subscribes Calendly with the creator's key once, signed with a key DealDock made", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/users/me")
        ? new Response(JSON.stringify({ resource: { uri: "https://api.calendly.com/users/U1", current_organization: "https://api.calendly.com/organizations/O1" } }), { status: 200 })
        : new Response("{}", { status: 201 });
    }));
    const response = await connect({ provider: "calendly", accessKey: "calendly-personal-access-key-0123" });
    expect(response.json()).toMatchObject({ address: null, source: { provider: "calendly" } });
    const subscription = JSON.parse(String(calls[1]!.init!.body));
    expect(subscription).toMatchObject({ events: ["invitee.created"], scope: "user", user: "https://api.calendly.com/users/U1", organization: "https://api.calendly.com/organizations/O1" });
    expect(subscription.url).toMatch(/^https:\/\/api\.dealdock\.test\/webhooks\/leads\/[A-Za-z0-9_-]{43}$/);
    const stored = vi.mocked(db.createLeadSource).mock.calls[0]![2];
    expect(stored.secret).toBe(subscription.signing_key);
    expect(JSON.stringify(stored)).not.toContain("calendly-personal-access-key");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect((await connect({ provider: "calendly", accessKey: "calendly-personal-access-key-0123" })).json()).toEqual({ error: "calendly_key_refused" });
  });
});

describe("stages and renewals", () => {
  it("sets a stage by hand and refuses one that doesn't exist", async () => {
    const response = await app.inject({ method: "PUT", url: "/threads/t1/lead-stage", payload: { stage: "booked" } });
    expect([response.statusCode, response.json()]).toEqual([200, { leadStage: "booked" }]);
    expect(db.setLeadStage).toHaveBeenCalledWith("org_1", "seat_1", "t1", "booked");
    expect((await app.inject({ method: "PUT", url: "/threads/t1/lead-stage", payload: { stage: "won" } })).statusCode).toBe(400);
  });

  it("lists renewals and records Not now or a copied pitch", async () => {
    expect((await app.inject({ method: "GET", url: "/renewals" })).json()).toEqual({ renewals: [] });
    await app.inject({ method: "POST", url: "/deals/deal_1/renewal-handled", payload: { how: "not_now" } });
    expect(db.handleRenewal).toHaveBeenCalledWith("org_1", "deal_1", "seat_1", "not_now");
    expect((await app.inject({ method: "POST", url: "/deals/deal_1/renewal-handled", payload: { how: "later" } })).statusCode).toBe(400);
  });

  it("drafts a renewal pitch for a paid deal in its conversation, keeping the deal on the draft", async () => {
    vi.stubEnv("DEALDOCK_AI_MODE", "heuristic");
    const paidDeal = { id: "deal_1", threadId: "t1", igAccountId: "ig_1", stage: "paid", dealType: "brand", invoices: [] } as unknown as DealDto;
    vi.mocked(db.getDraftThreadContext).mockResolvedValue({ id: "t1", igAccountId: "ig_1", participantHandle: "glowco", topLabel: "brand_deal", latestInbound: null, liveDraft: null, messages: [], channel: "instagram", subject: null } as never);
    vi.mocked(db.getCreatorContext).mockResolvedValue({ voiceEnabled: true, voiceVersion: 1, businessSummary: "Creator", currencyCode: "INR", locale: "en-IN", typicalBrandDealMinor: null, typicalCoachingMinor: null, typicalCourseMinor: null, styleCard: null, correctionExamples: [] } as never);
    vi.mocked(db.getDraftVoiceContext).mockResolvedValue({ exemplarPool: [], lessonPool: [] } as never);
    vi.mocked(db.getDealConversation).mockResolvedValue({ igAccountId: "ig_1", participantHandle: "glowco", timezone: "Asia/Kolkata", threadHistory: [] });
    vi.mocked(db.getDeal).mockResolvedValue({ ...paidDeal, title: "Reel", amountMinor: 5_000_000, currencyCode: "INR", paidAt: "2026-08-01T00:00:00Z", terms: { deliverables: [] } } as never);
    vi.mocked(db.createDraft).mockImplementation(async (_org, input) => ({ id: "d1", body: input.body, kind: input.kind ?? "reply", status: "ready", version: 1, label: null, instruction: null, chips: [], alternatives: [], chosenAlternative: null, generationContext: input.generationContext, invoiceId: null }) as never);
    const response = await app.inject({ method: "POST", url: "/threads/t1/draft", payload: { purpose: "renewal", dealId: "deal_1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ purpose: "renewal", dealId: "deal_1", kind: "nudge" });
    expect(vi.mocked(db.createDraft).mock.calls[0]![1].generationContext).toMatchObject({ purpose: "renewal", dealId: "deal_1" });

    vi.mocked(db.getDeal).mockResolvedValue({ ...paidDeal, stage: "agreed" } as never);
    expect((await app.inject({ method: "POST", url: "/threads/t1/draft", payload: { purpose: "renewal", dealId: "deal_1" } })).json()).toEqual({ error: "deal_not_paid" });
  });
});
