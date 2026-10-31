import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  BillingEvent,
  BillingProvider,
  BillingWebhookRequest,
  CreateSubscriptionInput,
  CreatedSubscription,
} from "./provider";

/**
 * Razorpay Subscriptions rail (INR orgs — UPI Autopay / card mandates).
 * Plans are created once in the Razorpay dashboard; their ids arrive via env:
 *   RAZORPAY_PLAN_SOLO / RAZORPAY_PLAN_STUDIO / RAZORPAY_PLAN_ROSTER
 * The created subscription's short_url is the mandate-authorization page the
 * creator opens (PRD §6.12 — first invoice after the 7-day active-use gate).
 */

const API_BASE = "https://api.razorpay.com/v1";

export interface RazorpayRailOptions {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
  planIds?: Partial<Record<"solo" | "studio" | "roster", string>>;
}

export class RazorpayRail implements BillingProvider {
  readonly rail = "razorpay" as const;

  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;
  private fetchImpl: typeof fetch;
  private planIds: Record<string, string | undefined>;

  constructor(opts: RazorpayRailOptions = {}) {
    this.keyId = opts.keyId ?? process.env.RAZORPAY_KEY_ID ?? "";
    this.keySecret = opts.keySecret ?? process.env.RAZORPAY_KEY_SECRET ?? "";
    this.webhookSecret = opts.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.planIds = {
      solo: opts.planIds?.solo ?? process.env.RAZORPAY_PLAN_SOLO,
      studio: opts.planIds?.studio ?? process.env.RAZORPAY_PLAN_STUDIO,
      roster: opts.planIds?.roster ?? process.env.RAZORPAY_PLAN_ROSTER,
    };
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription> {
    const planId = this.planIds[input.tier];
    if (!planId) throw new Error(`RAZORPAY_PLAN_${input.tier.toUpperCase()} not configured`);

    const res = await this.fetchImpl(`${API_BASE}/subscriptions`, {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_id: planId,
        total_count: 60, // monthly × 5 years max; cancel-anytime applies (PRD §6.12)
        customer_notify: 1,
        // Razorpay echoes notes in lifecycle webhooks. This durable reservation
        // key lets reconciliation find an ambiguous remote creation without
        // creating another mandate after a timeout.
        notes: { orgId: input.orgId, tier: input.tier, requestKey: input.requestKey },
      }),
    });
    const body = (await res.json()) as {
      id?: string;
      short_url?: string;
      error?: { description?: string };
    };
    if (!res.ok || !body.id) {
      throw new Error(`Razorpay createSubscription failed: ${body.error?.description ?? res.status}`);
    }
    return { externalId: body.id, checkoutUrl: body.short_url ?? null };
  }

  async cancelAtPeriodEnd(externalId: string): Promise<void> {
    const res = await this.fetchImpl(`${API_BASE}/subscriptions/${externalId}/cancel`, {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ cancel_at_cycle_end: 1 }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: { description?: string } };
      throw new Error(`Razorpay cancel failed: ${body.error?.description ?? res.status}`);
    }
  }

  async fetchStatus(externalId: string): Promise<import("./provider").BillingStatusSnapshot> {
    const res = await this.fetchImpl(`${API_BASE}/subscriptions/${externalId}`, {
      headers: { Authorization: this.authHeader() },
    });
    const body = (await res.json()) as { status?: string; current_end?: number; updated_at?: number };
    if (!res.ok) return { kind: "unknown" };
    const snapshot = {
      ...(body.current_end ? { currentPeriodEnd: new Date(body.current_end * 1000) } : {}),
      ...(body.updated_at ? { occurredAt: new Date(body.updated_at * 1000) } : {}),
    };
    switch (body.status) {
      case "active":
        return { kind: "charged", ...snapshot };
      case "authenticated":
        return { kind: "activated", ...snapshot };
      case "halted":
      case "pending":
        return { kind: "payment_failed", ...snapshot };
      case "cancelled":
      case "completed":
      case "expired":
        return { kind: "cancelled", ...snapshot };
      default:
        return { kind: "unknown", ...snapshot };
    }
  }

  verifyWebhook(req: BillingWebhookRequest): boolean {
    if (!this.webhookSecret) return false;
    const header = req.headers["x-razorpay-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return false;
    const expected = createHmac("sha256", this.webhookSecret)
      .update(req.rawBody, "utf8")
      .digest("hex");
    if (signature.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }

  parseEvents(payload: unknown): BillingEvent[] {
    const body = payload as {
      id?: string;
      created_at?: number;
      event?: string;
      payload?: {
        subscription?: {
          entity?: {
            id?: string;
            status?: string;
            current_end?: number;
            notes?: { orgId?: string };
          };
        };
      };
    };
    const sub = body.payload?.subscription?.entity;
    if (!body.event || !sub?.id) return [];

    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : undefined;
    const occurredAt = body.created_at ? new Date(body.created_at * 1000) : undefined;
    const map: Record<string, BillingEvent["kind"]> = {
      "subscription.charged": "charged",
      "subscription.activated": "activated",
      "subscription.authenticated": "activated",
      "subscription.halted": "payment_failed",
      "subscription.pending": "payment_failed",
      "subscription.cancelled": "cancelled",
      "subscription.completed": "cancelled",
    };
    return [
      {
        externalId: sub.id,
        kind: map[body.event] ?? "unknown",
        currentPeriodEnd: periodEnd,
        ...(body.id ? { eventId: body.id } : {}),
        ...(occurredAt && !Number.isNaN(occurredAt.getTime()) ? { occurredAt } : {}),
        orgId: sub.notes?.orgId,
        raw: payload,
      },
    ];
  }
}
