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
  raw: unknown;
}

export interface BillingWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface BillingProvider {
  readonly rail: BillingRail;
  createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription>;
  cancelAtPeriodEnd(externalId: string): Promise<void>;
  /** Remote status fetch for the reconciliation poller (webhooks can be lost). */
  fetchStatus(externalId: string): Promise<BillingEvent["kind"]>;
  verifyWebhook(req: BillingWebhookRequest): boolean;
  parseEvents(payload: unknown): BillingEvent[];
}
