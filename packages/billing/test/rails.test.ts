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
  });

  it("normalizes subscription lifecycle events", () => {
    const rail = new RazorpayRail({ webhookSecret: RZP_WEBHOOK_SECRET });
    const mk = (event: string) => ({
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
        return { body: { id: "sub_new1", short_url: "https://rzp.io/i/abc" } };
      }),
    });
    const created = await rail.createSubscription({
      orgId: "org1",
      tier: "studio",
      currencyCode: "INR",
      customerEmail: "a@b.c",
    });
    expect(created).toEqual({ externalId: "sub_new1", checkoutUrl: "https://rzp.io/i/abc" });
  });
});

describe("Paddle rail", () => {
  it("verifies Paddle-Signature (ts;h1 over `${ts}:${raw}`)", () => {
    const rail = new PaddleRail({ webhookSecret: PADDLE_WEBHOOK_SECRET });
    const raw = JSON.stringify({ event_type: "transaction.completed" });
    const ts = "1720000000";
    const h1 = createHmac("sha256", PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest("hex");
    expect(
      rail.verifyWebhook({ headers: { "paddle-signature": `ts=${ts};h1=${h1}` }, rawBody: raw })
    ).toBe(true);
    expect(
      rail.verifyWebhook({ headers: { "paddle-signature": `ts=${ts};h1=${h1}` }, rawBody: raw + "x" })
    ).toBe(false);
  });

  it("normalizes events and prefers the durable subscription_id", () => {
    const rail = new PaddleRail({ webhookSecret: PADDLE_WEBHOOK_SECRET });
    const charged = rail.parseEvents({
      event_type: "transaction.completed",
      data: { id: "txn_1", subscription_id: "sub_pdl1" },
    });
    expect(charged[0]).toMatchObject({ externalId: "sub_pdl1", kind: "charged" });

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
      fetchImpl: fakeFetch((url) => {
        expect(url).toContain("/transactions");
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
    });
    expect(created).toEqual({ externalId: "txn_9", checkoutUrl: "https://pay.paddle.com/x" });
  });
});
