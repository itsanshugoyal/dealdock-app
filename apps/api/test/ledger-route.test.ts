import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const { getLedger } = vi.hoisted(() => ({ getLedger: vi.fn() }));
vi.mock("@dealdock/db", () => ({ getLedger, getDashboard: vi.fn(), updateLedgerEntry: vi.fn(), deleteLedgerEntry: vi.fn() }));
vi.mock("../src/auth", () => ({ requireAuth: async (req: { auth: unknown }) => { req.auth = { orgId: "org-a", seatId: "seat-a", role: "creator" }; } }));
import { ledgerRoutes } from "../src/routes/ledger";

// Loading the API route module compiles the whole Fastify app on a cold run, which can pass 5s under load.
describe("ledger route scope", { timeout: 30_000 }, () => {
  it("exports only the requested account and month, preserving CSV escaping", async () => {
    getLedger.mockReset();
    getLedger.mockResolvedValue({ months: [{ month: "2026-01" }, { month: "2026-02" }], entries: [{ closedAt: new Date("2026-01-15T00:00:00Z"), handle: "buyer", dealType: "brand", amountMinor: 12345, currencyCode: "USD", note: "=unsafe" }] });
    const app = Fastify();
    await app.register(ledgerRoutes);
    const response = await app.inject({ method: "GET", url: "/ledger/export.csv?month=2026-01&igAccountId=ig-a" });
    expect(response.statusCode).toBe(200);
    expect(getLedger).toHaveBeenCalledTimes(1);
    expect(getLedger).toHaveBeenCalledWith("org-a", "2026-01", "ig-a");
    expect(response.body).toContain('"12345","USD","\'=unsafe"');
    expect((await app.inject({ method: "GET", url: "/ledger?month=2026-99" })).statusCode).toBe(400);
    await app.close();
  });
});
