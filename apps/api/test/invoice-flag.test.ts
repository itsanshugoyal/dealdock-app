import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@dealdock/db";
import { buildServer } from "../src/index";

// The HTTP layer only: the repositories are stubbed, auth is a creator seat.
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  isOrgReadOnly: vi.fn(async () => false),
  getInvoice: vi.fn(async () => null),
  listDealInvoices: vi.fn(async () => []),
  getDashboard: vi.fn(async () => ({ org: { currencyCode: "INR", locale: "en-IN", name: "Studio" } })),
}));
vi.mock("../src/auth", () => ({
  requireAuth: async (req: { auth?: unknown }) => {
    req.auth = { clerkUserId: "user_1", orgId: "org_1", seatId: "seat_1", role: "creator" };
  },
}));

const app = buildServer();
app.log.level = "silent";

const INVOICE_REQUESTS = [
  { method: "GET", url: "/settings/billing-profile" },
  { method: "PUT", url: "/settings/billing-profile", payload: {} },
  { method: "GET", url: "/deals/deal_1/invoices" },
  { method: "POST", url: "/deals/deal_1/invoices", payload: {} },
  { method: "GET", url: "/invoices/inv_1" },
  { method: "GET", url: "/invoices/inv_1/pdf" },
  { method: "POST", url: "/invoices/inv_1/void" },
  { method: "POST", url: "/invoices/inv_1/paid", payload: {} },
  { method: "GET", url: "/media/invoices/inv_1/INV-1.pdf?exp=1&sig=x" },
] as const;

beforeEach(() => vi.mocked(db.listDealInvoices).mockClear());
afterEach(() => vi.unstubAllEnvs());

describe("FEATURE_INVOICES_ENABLED", () => {
  it("answers 404 feature_disabled on every invoice route while off, before touching data", async () => {
    vi.stubEnv("FEATURE_INVOICES_ENABLED", "false");
    for (const request of INVOICE_REQUESTS) {
      const response = await app.inject(request);
      expect([response.statusCode, response.json()], request.url).toEqual([404, { error: "feature_disabled" }]);
    }
    expect(db.listDealInvoices).not.toHaveBeenCalled();
  });

  it("refuses an invoice cover note while off", async () => {
    vi.stubEnv("FEATURE_INVOICES_ENABLED", "false");
    vi.spyOn(db, "getDraftThreadContext").mockResolvedValueOnce({ id: "thread_1", igAccountId: "ig_1" } as never);
    const response = await app.inject({ method: "POST", url: "/threads/thread_1/draft", payload: { purpose: "invoice", dealId: "deal_1", invoiceId: "inv_1" } });
    expect([response.statusCode, response.json()]).toEqual([404, { error: "feature_disabled" }]);
  });

  it("serves the invoice routes as before when on (the default)", async () => {
    const response = await app.inject({ method: "GET", url: "/deals/deal_1/invoices" });
    expect([response.statusCode, response.json()]).toEqual([200, { invoices: [] }]);
    expect(db.listDealInvoices).toHaveBeenCalledWith("org_1", "deal_1");
  });

  it("tells the web through GET /dashboard features", async () => {
    expect((await app.inject({ method: "GET", url: "/dashboard" })).json().features).toMatchObject({ invoices: true });
    vi.stubEnv("FEATURE_INVOICES_ENABLED", "false");
    expect((await app.inject({ method: "GET", url: "/dashboard" })).json().features).toEqual({ invoices: false, humanAgent: false, insights: false, commentLeads: false, unifiedLogin: false, instagramOpenAccess: false });
  });
});
