/**
 * @dealdock/billing — dual-rail billing behind one interface (ADR-4).
 * Consumed by apps/api (webhooks, cancel, portal) and apps/worker (the 7-day
 * active-use gate scheduler + reconciliation poller). No DB access here.
 */

export * from "./provider";
export { RazorpayRail } from "./razorpay";
export { PaddleRail } from "./paddle";

import { PaddleRail } from "./paddle";
import { RazorpayRail } from "./razorpay";
import { railForCurrency, type BillingProvider } from "./provider";

const razorpay = new RazorpayRail();
const paddle = new PaddleRail();

export function providerForCurrency(currencyCode: string): BillingProvider {
  return railForCurrency(currencyCode) === "razorpay" ? razorpay : paddle;
}

export function providerForRail(rail: "razorpay" | "paddle"): BillingProvider {
  return rail === "razorpay" ? razorpay : paddle;
}
