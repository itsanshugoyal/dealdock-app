import type { Tier } from "@dealdock/core";

/**
 * BillingProvider — one interface, two rails (ADR-4, ARCHITECTURE.md §9):
 *  - Razorpay for INR orgs (UPI Autopay mandates — how Indian creators pay)
 *  - Paddle as merchant of record for everything else (Paddle owns global
 *    sales-tax/VAT/GST compliance; the founding team files nothing)
 * Rail is selected by org currency and never mixed per org.
 */

export type BillingRail = "razorpay" | "paddle";

export function railForCurrency(currencyCode: string): BillingRail {
  return currencyCode === "INR" ? "razorpay" : "paddle";
}

/** Pilot price points (PRD §8). Minor units; rail-side ids come from env. */
export const PRICING: Record<Tier, { inrMinor: number; usdMinor: number }> = {
  solo: { inrMinor: 4_000_00, usdMinor: 49_00 },
  studio: { inrMinor: 8_000_00, usdMinor: 99_00 },
  roster: { inrMinor: 15_000_00, usdMinor: 179_00 },
};

export interface CreateSubscriptionInput {
  orgId: string;
  tier: Tier;
  currencyCode: string;
  customerEmail: string;
  customerName?: string;
  /** Stable DB reservation id; prevents a timeout from creating two mandates. */
  requestKey: string;
}

export interface CreatedSubscription {
  externalId: string;
  /** Hosted page the creator opens to authorize the mandate / first payment. */
  checkoutUrl: string | null;
}

/** Rail-agnostic event shape — both webhook formats normalize to this. */
export interface BillingEvent {
  externalId: string;
  kind:
    | "charged" // payment succeeded → active
    | "payment_failed" // → past_due (grace banner, no feature cut for 7 days)
    | "cancelled" // runs to period end, then read-only
    | "activated" // mandate authorized / subscription live (pre-first-charge)
    | "unknown";
  currentPeriodEnd?: Date;
  /** Provider event id, used by persistence to make webhook replay idempotent. */
  eventId?: string;
  /** Provider occurrence time, used to reject stale non-terminal state changes. */
  occurredAt?: Date;
  /** Paddle checkout transaction before its durable subscription id exists. */
  provisionalExternalId?: string;
  /**
   * Org tag echoed back by the rail (Paddle custom_data / Razorpay notes) — the
   * durable key that lets us bind a new subscription id onto the org's row even
   * when the row still holds a provisional/transaction id (F5).
   */
  orgId?: string;
  raw: unknown;
}

export interface BillingWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

/** Reconciliation is a remote snapshot, not a webhook event. */
export interface BillingStatusSnapshot {
  kind: BillingEvent["kind"];
  currentPeriodEnd?: Date;
  occurredAt?: Date;
}

export interface BillingProvider {
  readonly rail: BillingRail;
  createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription>;
  cancelAtPeriodEnd(externalId: string): Promise<void>;
  /** Remote status fetch for the reconciliation poller (webhooks can be lost). */
  fetchStatus(externalId: string): Promise<BillingStatusSnapshot>;
  verifyWebhook(req: BillingWebhookRequest): boolean;
  parseEvents(payload: unknown): BillingEvent[];
}
