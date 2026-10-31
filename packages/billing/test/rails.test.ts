import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PaddleRail } from "../src/paddle";
import { RazorpayRail } from "../src/razorpay";
import { railForCurrency } from "../src/provider";

const RZP_WEBHOOK_SECRET = "rzp-whsec";
const PADDLE_WEBHOOK_SECRET = "pdl-whsec";

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("rail selection (ADR-4/ADR-9: one rail per org, by currency)", () => {
  it("routes INR to Razorpay, everything else to Paddle", () => {
    expect(railForCurrency("INR")).toBe("razorpay");
    for (const c of ["USD", "GBP", "EUR", "AED"]) expect(railForCurrency(c)).toBe("paddle");
  });
});

describe("Razorpay rail", () => {
  it("verifies X-Razorpay-Signature (HMAC sha256 of raw body)", () => {
    const rail = new RazorpayRail({ webhookSecret: RZP_WEBHOOK_SECRET });
    const raw = JSON.stringify({ event: "subscription.charged" });
    const sig = createHmac("sha256", RZP_WEBHOOK_SECRET).update(raw).digest("hex");
    expect(rail.verifyWebhook({ headers: { "x-razorpay-signature": sig }, rawBody: raw })).toBe(true);
    expect(rail.verifyWebhook({ headers: { "x-razorpay-signature": sig }, rawBody: raw + "x" })).toBe(false);
    expect(rail.verifyWebhook({ headers: {}, rawBody: raw })).toBe(false);
    expect(rail.verifyWebhook({ headers: { "x-razorpay-signature": "zz".repeat(32) }, rawBody: raw })).toBe(false);
  });

  it("normalizes subscription lifecycle events", () => {
    const rail = new RazorpayRail({ webhookSecret: RZP_WEBHOOK_SECRET });
    const mk = (event: string) => ({
      id: "evt_rzp_1",
      created_at: 1754000000,
      event,
      payload: { subscription: { entity: { id: "sub_rzp1", status: "x", current_end: 1755000000 } } },
    });
    expect(rail.parseEvents(mk("subscription.charged"))[0]).toMatchObject({
      externalId: "sub_rzp1",
      kind: "charged",
    });
    expect(rail.parseEvents(mk("subscription.halted"))[0]!.kind).toBe("payment_failed");
    expect(rail.parseEvents(mk("subscription.cancelled"))[0]!.kind).toBe("cancelled");
    expect(rail.parseEvents(mk("subscription.authenticated"))[0]!.kind).toBe("activated");
    expect(rail.parseEvents(mk("subscription.charged"))[0]!.currentPeriodEnd).toEqual(
      new Date(1755000000 * 1000)
    );
    expect(rail.parseEvents(mk("subscription.charged"))[0]).toMatchObject({
      eventId: "evt_rzp_1",
      occurredAt: new Date(1754000000 * 1000),
    });
  });

  it("creates a subscription and returns the mandate short_url", async () => {
    const rail = new RazorpayRail({
      keyId: "k",
      keySecret: "s",
      planIds: { studio: "plan_studio_inr" },
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toContain("/subscriptions");
        const body = JSON.parse(String(init?.body));
        expect(body.plan_id).toBe("plan_studio_inr");
        expect(body.notes.requestKey).toBe("first-invoice-org1-20261028");
        return { body: { id: "sub_new1", short_url: "https://rzp.io/i/abc" } };
      }),
    });
    const created = await rail.createSubscription({
      orgId: "org1",
      tier: "studio",
      currencyCode: "INR",
      customerEmail: "a@b.c",
      requestKey: "first-invoice-org1-20261028",
    });
    expect(created).toEqual({ externalId: "sub_new1", checkoutUrl: "https://rzp.io/i/abc" });
  });

  it("returns a reconciliation snapshot with period end rather than an invented event", async () => {
    const rail = new RazorpayRail({
      keyId: "k",
      keySecret: "s",
      fetchImpl: fakeFetch(() => ({ body: { status: "active", current_end: 1755000000, updated_at: 1754000000 } })),
    });
    await expect(rail.fetchStatus("sub_rzp1")).resolves.toEqual({
      kind: "charged",
      currentPeriodEnd: new Date(1755000000 * 1000),
      occurredAt: new Date(1754000000 * 1000),
    });
  });
});

describe("Paddle rail", () => {
  it("verifies a fresh Paddle-Signature and rejects tampered bodies", () => {
    const ts = "1720000000";
    // Pin the clock to the signed timestamp so the freshness window passes.
    const rail = new PaddleRail({
      webhookSecret: PADDLE_WEBHOOK_SECRET,
      now: () => Number(ts) * 1000,
    });
    const raw = JSON.stringify({ event_type: "transaction.completed" });
    const h1 = createHmac("sha256", PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest("hex");
    expect(
      rail.verifyWebhook({ headers: { "paddle-signature": `ts=${ts};h1=${h1}` }, rawBody: raw })
    ).toBe(true);
    expect(
      rail.verifyWebhook({ headers: { "paddle-signature": `ts=${ts};h1=${h1}` }, rawBody: raw + "x" })
    ).toBe(false);
    expect(
      rail.verifyWebhook({ headers: { "paddle-signature": `ts=${ts};h1=${h1};h1=${h1}` }, rawBody: raw })
    ).toBe(false);
  });

  it("rejects a stale (replayed) signature even with a valid HMAC (F3)", () => {
    const ts = "1720000000";
    const raw = JSON.stringify({ event_type: "transaction.completed" });
    const h1 = createHmac("sha256", PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest("hex");
    // Clock is 10 minutes past the signed ts — outside the 5-min tolerance.
    const rail = new PaddleRail({
      webhookSecret: PADDLE_WEBHOOK_SECRET,
      now: () => (Number(ts) + 600) * 1000,
    });
    expect(
      rail.verifyWebhook({ headers: { "paddle-signature": `ts=${ts};h1=${h1}` }, rawBody: raw })
    ).toBe(false);
  });

  it("normalizes events and prefers the durable subscription_id", () => {
    const rail = new PaddleRail({ webhookSecret: PADDLE_WEBHOOK_SECRET });
    const charged = rail.parseEvents({
      event_type: "transaction.completed",
      event_id: "evt_pdl_1",
      occurred_at: "2026-07-01T00:00:00Z",
      data: { id: "txn_1", subscription_id: "sub_pdl1" },
    });
    expect(charged[0]).toMatchObject({
      externalId: "sub_pdl1",
      provisionalExternalId: "txn_1",
      kind: "charged",
      eventId: "evt_pdl_1",
      occurredAt: new Date("2026-07-01T00:00:00Z"),
    });

    const cancelled = rail.parseEvents({
      event_type: "subscription.canceled",
      data: { id: "sub_pdl1", current_billing_period: { ends_at: "2026-08-01T00:00:00Z" } },
    });
    expect(cancelled[0]!.kind).toBe("cancelled");
    expect(cancelled[0]!.currentPeriodEnd).toEqual(new Date("2026-08-01T00:00:00Z"));
  });

  it("creates a hosted-checkout transaction", async () => {
    const rail = new PaddleRail({
      apiKey: "pk",
      priceIds: { solo: "pri_solo_usd" },
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toContain("/transactions");
        expect(init?.headers).toMatchObject({ "Idempotency-Key": "first-invoice-org2-20261028" });
        return {
          body: { data: { id: "txn_9", checkout: { url: "https://pay.paddle.com/x" } } },
        };
      }),
    });
    const created = await rail.createSubscription({
      orgId: "org2",
      tier: "solo",
      currencyCode: "USD",
      customerEmail: "c@d.e",
      requestKey: "first-invoice-org2-20261028",
    });
    expect(created).toEqual({ externalId: "txn_9", checkoutUrl: "https://pay.paddle.com/x" });
  });

  it("returns a Paddle reconciliation snapshot with current-period boundary", async () => {
    const rail = new PaddleRail({
      apiKey: "pk",
      fetchImpl: fakeFetch(() => ({ body: { data: { status: "past_due", current_billing_period: { ends_at: "2026-08-01T00:00:00Z" }, updated_at: "2026-07-15T00:00:00Z" } } })),
    });
    await expect(rail.fetchStatus("sub_pdl1")).resolves.toEqual({
      kind: "payment_failed",
      currentPeriodEnd: new Date("2026-08-01T00:00:00Z"),
      occurredAt: new Date("2026-07-15T00:00:00Z"),
    });
  });
});
