import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  due: vi.fn(), claim: vi.fn(), release: vi.fn(), save: vi.fn(),
  rail: { rail: "paddle", configured: true, createSubscription: vi.fn(), cancelAtPeriodEnd: vi.fn() },
}));
vi.mock("@dealdock/db", () => ({
  asOrgId: (id: string) => id,
  listSubscriptionsDueFirstInvoice: m.due,
  claimFirstInvoice: m.claim,
  releaseFirstInvoiceClaim: m.release,
  saveRailSubscription: m.save,
  applyBillingEvent: vi.fn(),
  listSubscriptionsForReconciliation: vi.fn(),
}));
vi.mock("@dealdock/billing", () => ({ providerForCurrency: () => m.rail, providerForRail: () => m.rail }));
vi.mock("../src/connection", () => ({ redisConnection: () => ({}) }));

import { requestFirstInvoices } from "../src/consumers/billing";

const org = { orgId: "org_1", tier: "solo", currencyCode: "USD", creatorEmail: "c@x.io", creatorName: "C" };
const claimedAt = new Date("2026-11-21T10:00:00Z");

describe("first-invoice pass", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.rail.configured = true;
    m.due.mockResolvedValue([org]);
    m.claim.mockResolvedValue({ orgId: "org_1", claimedAt });
    m.save.mockResolvedValue({ saved: true });
  });

  it("skips a rail that isn't configured without claiming the org", async () => {
    m.rail.configured = false;
    const notify = vi.fn();
    await requestFirstInvoices(notify);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.rail.createSubscription).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("releases the claim when the rail refuses, so the next tick retries", async () => {
    m.rail.createSubscription.mockRejectedValue(Object.assign(new Error("Paddle transaction create failed: 400"), { definite: true }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = vi.fn();
    await requestFirstInvoices(notify);
    expect(m.release).toHaveBeenCalledWith("org_1", claimedAt);
    expect(m.save).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the claim when the create was ambiguous, so it can't create a second subscription", async () => {
    m.rail.createSubscription.mockRejectedValue(new Error("Razorpay createSubscription failed: 503"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await requestFirstInvoices(vi.fn());
    expect(m.release).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("NEEDS MANUAL CHECK");
  });

  it("carries on with the next org when one fails", async () => {
    m.due.mockResolvedValue([org, { ...org, orgId: "org_2" }]);
    m.claim.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ orgId: "org_2", claimedAt });
    m.rail.createSubscription.mockResolvedValue({ externalId: "txn_2", checkoutUrl: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = vi.fn();
    expect(await requestFirstInvoices(notify)).toBe(2);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_2" }));
  });

  it("saves the subscription and sends the checkout link on success", async () => {
    m.rail.createSubscription.mockResolvedValue({ externalId: "txn_1", checkoutUrl: "https://app.dealdock.io/pay?_ptxn=txn_1" });
    const notify = vi.fn();
    expect(await requestFirstInvoices(notify)).toBe(1);
    expect(m.release).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({ orgId: "org_1", kind: "billing_checkout_ready", checkoutUrl: "https://app.dealdock.io/pay?_ptxn=txn_1" });
  });
});
