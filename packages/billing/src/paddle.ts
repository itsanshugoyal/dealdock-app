import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  BillingEvent,
  BillingProvider,
  BillingWebhookRequest,
  CreateSubscriptionInput,
  CreatedSubscription,
} from "./provider";

/**
 * Paddle Billing rail (merchant of record — all non-INR orgs, ADR-4).
 * Paddle is the seller of record and owns global sales-tax/VAT/GST compliance.
 * Prices are created once in the Paddle dashboard; ids arrive via env:
 *   PADDLE_PRICE_SOLO / PADDLE_PRICE_STUDIO / PADDLE_PRICE_ROSTER
 * We create a hosted-checkout transaction; the subscription id arrives on the
 * subscription.activated webhook after the creator completes checkout.
 */

const API_BASE = () =>
  process.env.PADDLE_ENV === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";

/** Reject webhooks whose signed timestamp is older than this (replay defense). */
const SIGNATURE_TOLERANCE_SEC = 300;

export interface PaddleRailOptions {
  apiKey?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
  priceIds?: Partial<Record<"solo" | "studio" | "roster", string>>;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
}

export class PaddleRail implements BillingProvider {
  readonly rail = "paddle" as const;

  private apiKey: string;
  private webhookSecret: string;
  private fetchImpl: typeof fetch;
  private priceIds: Record<string, string | undefined>;
  private now: () => number;

  constructor(opts: PaddleRailOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.PADDLE_API_KEY ?? "";
    this.webhookSecret = opts.webhookSecret ?? process.env.PADDLE_WEBHOOK_SECRET ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.priceIds = {
      solo: opts.priceIds?.solo ?? process.env.PADDLE_PRICE_SOLO,
      studio: opts.priceIds?.studio ?? process.env.PADDLE_PRICE_STUDIO,
      roster: opts.priceIds?.roster ?? process.env.PADDLE_PRICE_ROSTER,
    };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription> {
    const priceId = this.priceIds[input.tier];
    if (!priceId) throw new Error(`PADDLE_PRICE_${input.tier.toUpperCase()} not configured`);

    const res = await this.fetchImpl(`${API_BASE()}/transactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.requestKey,
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: { orgId: input.orgId, tier: input.tier },
        checkout: { url: null }, // Paddle default hosted checkout
      }),
    });
    const body = (await res.json()) as {
      data?: { id?: string; checkout?: { url?: string } };
      error?: { detail?: string };
    };
    if (!res.ok || !body.data?.id) {
      throw new Error(`Paddle transaction create failed: ${body.error?.detail ?? res.status}`);
    }
    // The transaction id is a provisional external id; the durable
    // subscription id replaces it via the subscription.activated webhook.
    return { externalId: body.data.id, checkoutUrl: body.data.checkout?.url ?? null };
  }

  async cancelAtPeriodEnd(externalId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${API_BASE()}/subscriptions/${externalId}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ effective_from: "next_billing_period" }),
      }
    );
    if (!res.ok) {
      const body = (await res.json()) as { error?: { detail?: string } };
      throw new Error(`Paddle cancel failed: ${body.error?.detail ?? res.status}`);
    }
  }

  async fetchStatus(externalId: string): Promise<import("./provider").BillingStatusSnapshot> {
    if (!externalId.startsWith("sub_")) return { kind: "unknown" }; // provisional txn id
    const res = await this.fetchImpl(`${API_BASE()}/subscriptions/${externalId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const body = (await res.json()) as { data?: { status?: string; current_billing_period?: { ends_at?: string }; updated_at?: string } };
    if (!res.ok) return { kind: "unknown" };
    const snapshot = {
      ...(body.data?.current_billing_period?.ends_at ? { currentPeriodEnd: new Date(body.data.current_billing_period.ends_at) } : {}),
      ...(body.data?.updated_at ? { occurredAt: new Date(body.data.updated_at) } : {}),
    };
    switch (body.data?.status) {
      case "active":
        return { kind: "charged", ...snapshot };
      case "trialing":
        return { kind: "activated", ...snapshot };
      case "past_due":
        return { kind: "payment_failed", ...snapshot };
      case "canceled":
      case "paused":
        return { kind: "cancelled", ...snapshot };
      default:
        return { kind: "unknown", ...snapshot };
    }
  }

  /** Paddle-Signature: ts=<unix>;h1=<hmac sha256 of "<ts>:<rawBody>">. */
  verifyWebhook(req: BillingWebhookRequest): boolean {
    if (!this.webhookSecret) return false;
    const header = req.headers["paddle-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return false;

    // One canonical timestamp and HMAC only. Accepting duplicate fields lets
    // an attacker exploit parser disagreement between proxies and this code.
    const match = /^ts=(\d+);h1=([a-fA-F0-9]{64})$/.exec(signature);
    const ts = match?.[1];
    const h1 = match?.[2];
    if (!ts || !h1) return false;

    // Freshness: reject a stale/replayed signed timestamp before the HMAC even
    // matters (F3). A captured-but-valid webhook can't be replayed indefinitely.
    const tsSec = Number(ts);
    if (!Number.isFinite(tsSec)) return false;
    if (Math.abs(this.now() / 1000 - tsSec) > SIGNATURE_TOLERANCE_SEC) return false;

    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${ts}:${req.rawBody}`, "utf8")
      .digest("hex");
    if (h1.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(h1, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }

  parseEvents(payload: unknown): BillingEvent[] {
    const body = payload as {
      event_id?: string;
      occurred_at?: string;
      event_type?: string;
      data?: {
        id?: string;
        subscription_id?: string;
        status?: string;
        current_billing_period?: { ends_at?: string };
        custom_data?: { orgId?: string };
      };
    };
    if (!body.event_type || !body.data) return [];

    const externalId = body.data.subscription_id ?? body.data.id;
    if (!externalId) return [];
    const periodEnd = body.data.current_billing_period?.ends_at
      ? new Date(body.data.current_billing_period.ends_at)
      : undefined;
    const occurredAt = body.occurred_at ? new Date(body.occurred_at) : undefined;

    const map: Record<string, BillingEvent["kind"]> = {
      "transaction.completed": "charged",
      "subscription.activated": "activated",
      "subscription.past_due": "payment_failed",
      "subscription.canceled": "cancelled",
    };
    return [
      {
        externalId,
        kind: map[body.event_type] ?? "unknown",
        currentPeriodEnd: periodEnd,
        ...(body.event_id ? { eventId: body.event_id } : {}),
        ...(occurredAt && !Number.isNaN(occurredAt.getTime()) ? { occurredAt } : {}),
        ...(body.data.subscription_id && body.data.id ? { provisionalExternalId: body.data.id } : {}),
        orgId: body.data.custom_data?.orgId,
        raw: payload,
      },
    ];
  }
}
