import { afterEach, describe, expect, it, vi } from "vitest";
import { featureFlags, type DealDto, type InvoiceDto } from "@dealdock/core";
import { dealPrimaryAction, owedAction } from "../src/lib/deals";
import { visibleSettingsSections } from "../src/lib/settings-sections";
import { demoStore } from "../src/lib/demo-store";
import { ApiStore } from "../src/lib/api-store";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T06:30:00Z");
const iso = (at: number) => new Date(at).toISOString();
const deal = (patch: Partial<DealDto> = {}) => ({ stage: "agreed", dueAt: null, createdAt: iso(NOW - 3 * DAY), invoices: [], ...patch }) as Pick<DealDto, "stage" | "dueAt" | "createdAt" | "invoices">;
const issued = { id: "inv-1", status: "issued", issuedAt: iso(NOW - DAY), dueAt: iso(NOW + 5 * DAY), subtotalMinor: 1 } as InvoiceDto;
const wrote = () => true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Invoices off hides every invoice step", () => {
  it("deal cards lead with Request payment, then Mark paid, never an invoice action", () => {
    expect(dealPrimaryAction(deal(), NOW, wrote)).toBe("invoice");
    expect(dealPrimaryAction(deal(), NOW, wrote, false)).toBe("request");
    expect(dealPrimaryAction(deal(), NOW, undefined, false)).toBe("request");
    expect(dealPrimaryAction(deal(), NOW, () => false, false)).toBe("recap");
    expect(dealPrimaryAction(deal({ stage: "invoiced", invoices: [issued] }), NOW, wrote, false)).toBe("paid");
    expect(dealPrimaryAction(deal({ stage: "invoiced", invoices: [{ ...issued, status: "paid" }] }), NOW, wrote, false)).toBe("paid");
  });

  it("Revenue's owed rows only mark paid", () => {
    expect(owedAction({ invoices: [issued] })).toBe("invoice_paid");
    expect(owedAction({ invoices: [issued] }, false)).toBe("paid");
    expect(owedAction({ invoices: [{ ...issued, status: "paid" }] }, false)).toBe("paid");
  });

  it("drops Billing details from the settings page, its index and the palette", () => {
    const on = featureFlags({});
    expect(visibleSettingsSections(on).map((section) => section.id)).toContain("billing");
    const off = visibleSettingsSections({ ...on, invoices: false }).map((section) => section.id);
    expect(off).not.toContain("billing");
    expect(off).toContain("plan");
  });
});

describe("where the web reads features", () => {
  it("demo mode uses the registry defaults", () => {
    expect(demoStore.getSnapshot().features).toEqual(featureFlags({}));
    expect(demoStore.getSnapshot().features.invoices).toBe(true);
  });

  it("the API store takes them from GET /dashboard, keeping defaults for any left out", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/dashboard") return Response.json({ org: { currencyCode: "INR", locale: "en-IN" }, mtdRecoveredMinor: 0, biggestMinor: 0, avgMinor: 0, mtdDealCount: 0, features: { invoices: false, commentLeads: "yes" } });
      if (pathname === "/onboarding") return Response.json({ complete: true });
      return Response.json({ rows: [], entries: [] });
    }));
    const store = new ApiStore();
    expect(store.getSnapshot().features.invoices).toBe(true);
    store.authenticate("actor", async () => "actor");
    await vi.waitFor(() => expect(store.getSnapshot().state).toBe("ready"));
    expect(store.getSnapshot().features).toEqual({ invoices: false, humanAgent: false, insights: false, commentLeads: false });
  });
});
