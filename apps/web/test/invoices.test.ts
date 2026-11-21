import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingProfileInputSchema, owedTotals, type DealDto, type InvoiceDto } from "@dealdock/core";
import { counterpartyOf, dealNextStep, dealPrimaryAction, dealStage, dealWith, invoiceDueDefault, invoiceKinds, invoiceStatus, openInvoice, owedAction, whoFrom } from "../src/lib/deals";
import { apiFieldErrors, billingForm, billingInput, countryOptions, issueErrors, withGstin } from "../src/lib/billing";
import { DEMO_BILLING } from "../src/lib/demo-data";
import { demoStore } from "../src/lib/demo-store";
import { ApiStore } from "../src/lib/api-store";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T06:30:00Z"); // Wednesday, 12:00 in Kolkata
const ZONE = "Asia/Kolkata";
const iso = (at: number) => new Date(at).toISOString();

function deal(patch: Partial<DealDto> = {}): DealDto {
  return {
    id: "deal-1", threadId: "t-1", igAccountId: "ig-1", counterpartyHandle: "brand", counterpartyName: "Brand", channel: "instagram",
    title: "1 reel + 2 stories", dealType: "brand", amountMinor: 60_000_00, currencyCode: "INR", stage: "agreed",
    terms: { deliverables: [], usage: null, usageEndsAt: null, exclusivity: null, exclusivityEndsAt: null, revisionsIncluded: null, advancePercent: null, paymentDays: null, notes: null, disclosure: [] },
    agreedAt: iso(NOW - 3 * DAY), dueAt: null, invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null,
    createdAt: iso(NOW - 3 * DAY), updatedAt: iso(NOW - 3 * DAY), invoices: [], ...patch,
  };
}
function invoice(patch: Partial<InvoiceDto> = {}): InvoiceDto {
  return {
    id: "inv-1", dealId: "deal-1", kind: "full", number: "DM-2026-27-001", status: "issued", title: "Tax invoice", issuedAt: iso(NOW - DAY), dueAt: iso(NOW + 5 * DAY),
    currencyCode: "INR", supplier: { ...DEMO_BILLING, timezone: ZONE, locale: "en-IN" }, billTo: { name: "Brand Pvt Ltd", addressLines: [], city: null, state: "27", country: "IN", taxNumber: null },
    lines: [{ description: "1 reel + 2 stories", sacCode: "998361", quantity: 1, amountMinor: 60_000_00 }], subtotalMinor: 60_000_00,
    taxes: [{ kind: "igst", label: "IGST 18%", ratePercent: 18, amountMinor: 10_800_00 }], taxMinor: 10_800_00, totalMinor: 70_800_00, supplyType: "domestic", placeOfSupply: "29",
    declaration: null, notes: null, paidAt: null, receivedMinor: null, tdsMinor: null, voidedAt: null, createdAt: iso(NOW - DAY), updatedAt: iso(NOW - DAY), ...patch,
  };
}

describe("invoices on a deal card", () => {
  it("leads with sending a new invoice, then its payment, then the balance after an advance", () => {
    const issued = invoice({ issuedAt: iso(NOW - DAY) });
    const silent = () => false;
    const sentSince = (at: string) => Date.parse(at) < NOW - DAY / 2;
    expect(dealPrimaryAction(deal({ stage: "invoiced", invoices: [issued] }), NOW, silent)).toBe("send_invoice");
    expect(dealPrimaryAction(deal({ stage: "invoiced", invoices: [issued] }), NOW, sentSince)).toBe("invoice_paid");
    const advance = invoice({ kind: "advance", status: "paid", subtotalMinor: 30_000_00 });
    expect(dealPrimaryAction(deal({ stage: "invoiced", invoices: [advance] }), NOW, silent)).toBe("balance");
    // A void invoice bills nothing: payment asked for without one is marked paid.
    expect(dealPrimaryAction(deal({ stage: "invoiced", invoices: [invoice({ status: "void" })] }), NOW, silent)).toBe("paid");
    // Overdue in a conversation: remind first.
    expect(dealPrimaryAction(deal({ stage: "invoiced", dueAt: iso(NOW - 2 * DAY), invoices: [issued] }), NOW, sentSince)).toBe("remind");
  });

  it("never leads a deal agreed elsewhere with a message", () => {
    const elsewhere = deal({ threadId: null, channel: null });
    expect(dealPrimaryAction(elsewhere, NOW)).toBe("invoice");
    expect(dealPrimaryAction({ ...elsewhere, stage: "invoiced", dueAt: iso(NOW - 2 * DAY), invoices: [invoice()] }, NOW)).toBe("invoice_paid");
    expect(owedAction({ invoices: [invoice()] })).toBe("invoice_paid");
    expect(owedAction({ invoices: [invoice({ status: "paid" })] })).toBe("balance");
    expect(owedAction({ invoices: [invoice({ status: "void" })] })).toBe("paid");
  });

  it("offers the kinds core allows, and dates a balance from today when the deal's due date was the advance's", () => {
    const terms = { ...deal().terms, advancePercent: 50, paymentDays: 15 };
    expect(invoiceKinds(deal({ terms }))).toEqual(["advance", "full"]);
    expect(invoiceKinds(deal({ terms: { ...terms, advancePercent: 100 } }))).toEqual(["full"]);
    const advance = invoice({ kind: "advance", subtotalMinor: 30_000_00, dueAt: iso(NOW + DAY) });
    expect(invoiceKinds(deal({ terms, invoices: [advance] }))).toEqual(["balance"]);
    expect(invoiceKinds(deal({ terms, invoices: [advance, invoice({ kind: "balance", subtotalMinor: 30_000_00 })] }))).toEqual([]);
    expect(invoiceKinds(deal({ terms, invoices: [{ ...advance, status: "void" }] }))).toEqual(["advance", "full"]);
    const borrowed = deal({ terms, dueAt: advance.dueAt, invoices: [advance] });
    expect(Date.parse(invoiceDueDefault("balance", borrowed, NOW)) - NOW).toBe(15 * DAY);
    expect(invoiceDueDefault("full", deal({ terms, dueAt: iso(NOW + 9 * DAY) }), NOW)).toBe(iso(NOW + 9 * DAY));
    expect(invoiceDueDefault("advance", deal({ terms }), NOW)).toBe(iso(NOW));
  });

  it("names invoice states and the next step in words", () => {
    expect(invoiceStatus(invoice(), NOW)).toEqual({ text: "Issued", tone: "neutral" });
    expect(invoiceStatus(invoice({ dueAt: iso(NOW - 1) }), NOW)).toEqual({ text: "Overdue", tone: "waiting" });
    expect(invoiceStatus(invoice({ status: "paid" }), NOW).text).toBe("Paid");
    expect(invoiceStatus(invoice({ status: "void", dueAt: iso(NOW - DAY) }), NOW).text).toBe("Void");
    expect(openInvoice(deal({ invoices: [invoice({ id: "late", dueAt: iso(NOW + 9 * DAY) }), invoice({ id: "soon" })] }))?.id).toBe("soon");
    expect(dealStage(deal({ stage: "invoiced", invoices: [invoice()] }), NOW).text).toBe("Invoiced");
    expect(dealNextStep(deal({ stage: "invoiced", invoices: [invoice({ dueAt: iso(Date.parse("2026-12-12T10:00:00Z")) })] }), NOW, "en-IN", ZONE)).toBe("Invoice due 12 Dec");
    expect(dealNextStep(deal({ stage: "invoiced", invoices: [invoice({ status: "paid", kind: "advance" })] }), NOW, "en-IN", ZONE)).toBe("Advance paid · balance to invoice");
  });

  it("reads who a deal agreed elsewhere is with as typed, and only a conversation's handle takes an @", () => {
    expect(counterpartyOf(" @zenith.run ")).toEqual({ counterpartyHandle: "@zenith.run", counterpartyName: null });
    expect(counterpartyOf("zenith.run")).toEqual({ counterpartyHandle: "zenith.run", counterpartyName: null });
    expect(counterpartyOf("partnerships@zenith.example")).toEqual({ counterpartyHandle: "partnerships@zenith.example", counterpartyName: null });
    expect(counterpartyOf("Zenith Sports")).toEqual({ counterpartyHandle: "Zenith Sports", counterpartyName: "Zenith Sports" });
    expect(counterpartyOf("   ")).toBeNull();
    expect(dealWith(deal({ threadId: null, counterpartyHandle: "Zenith Sports", counterpartyName: "Zenith Sports" }))).toBe("Zenith Sports");
    expect(dealWith(deal({ threadId: null, counterpartyHandle: "zenith.run", counterpartyName: null }))).toBe("zenith.run");
    // A conversation's deal keeps its handle, as everywhere else.
    expect(dealWith(deal({ counterpartyName: "Kesar & Clay", counterpartyHandle: "kesarandclay" }))).toBe("@kesarandclay");
    expect(whoFrom("Zenith Sports", false)).toBe("Zenith Sports");
    expect(whoFrom("zenith.run", false)).toBe("zenith.run");
    expect(whoFrom("brand", true)).toBe("@brand");
    expect(whoFrom("anika@lumenskin.example", true)).toBe("anika@lumenskin.example");
  });
});

describe("billing details form", () => {
  it("sends only what the country and registration show, so hidden values never fail out of sight", () => {
    const india = { ...billingForm(DEMO_BILLING, { country: "IN" }), lutArn: "AD27123456789012" };
    const plain = billingInput({ ...india, taxKind: "none" });
    expect(plain.tax).toEqual({ kind: "none", number: null, ratePercent: null, lutArn: null });
    expect(BillingProfileInputSchema.safeParse(plain).success).toBe(true);
    const abroad = billingInput({ ...india, country: "GB", taxKind: "vat", taxNumber: "GB123456789", vatRate: "20", iban: "GB29NWBK60161331926819", state: "" });
    expect(abroad).toMatchObject({ pan: null, sacCode: null, payment: { upiId: null, ifsc: null, iban: "GB29NWBK60161331926819" }, tax: { kind: "vat", ratePercent: 20, lutArn: null } });
    expect(BillingProfileInputSchema.safeParse(abroad).success).toBe(true);
    // GST only exists in India: a GST form moved abroad sends no registration.
    expect(billingInput({ ...india, country: "US", state: "" }).tax.kind).toBe("none");
    expect(billingInput(india).addressLines).toEqual(DEMO_BILLING.addressLines);
  });

  it("fills the state and PAN from a valid GSTIN, and maps errors to their fields", () => {
    const form = billingForm(null, { country: "IN", email: "diya@example.com" });
    expect(form).toMatchObject({ taxKind: "none", prefix: "INV", email: "diya@example.com" });
    expect(withGstin(form, "29aakct5310r1zn")).toMatchObject({ taxNumber: "29AAKCT5310R1ZN", state: "29", pan: "AAKCT5310R" });
    expect(withGstin(form, "29AAKCT5310R1ZX")).toMatchObject({ taxNumber: "29AAKCT5310R1ZX", state: "", pan: "" });
    const checked = BillingProfileInputSchema.safeParse(billingInput({ ...form, legalName: "Diya", taxKind: "gst_in", taxNumber: "29AAKCT5310R1ZX" }));
    expect(checked.success).toBe(false);
    expect(issueErrors(checked.error!.issues)).toMatchObject({ "tax.number": "Enter a valid 15-character GSTIN" });
    expect(apiFieldErrors({ detail: { formErrors: [], fieldErrors: { invoicePrefix: ["Use letters and digits only"], tax: [1] } } })).toEqual({ invoicePrefix: "Use letters and digits only" });
    expect(apiFieldErrors(new Error("no detail"))).toEqual({});
  });

  it("lists countries by name from the platform", () => {
    const options = countryOptions();
    expect(options.find((item) => item.code === "IN")?.name).toBe("India");
    expect(options.some((item) => item.code === "EU" || item.code === "ZZ")).toBe(false);
    expect(options.map((item) => item.name)).toEqual([...options.map((item) => item.name)].sort((a, b) => a.localeCompare(b)));
  });
});

describe("demo invoices", () => {
  it("seeds an overdue invoice with IGST and a deal agreed elsewhere with its advance paid and balance invoiced", async () => {
    await demoStore.init();
    const deals = (await demoStore.loadDeals({ status: "all" })) ?? [];
    const tealeaf = deals.find((item) => item.id === "deal-tealeaf")!;
    expect(tealeaf.invoices).toHaveLength(1);
    expect(tealeaf.invoices![0]).toMatchObject({ kind: "full", status: "issued", subtotalMinor: 60_000_00, totalMinor: 70_800_00, taxes: [{ label: "IGST 18%" }] });
    expect(invoiceStatus(tealeaf.invoices![0]!, Date.now()).text).toBe("Overdue");
    const expo = deals.find((item) => item.id === "deal-expo")!;
    expect(expo).toMatchObject({ threadId: null, channel: null, stage: "invoiced", paidMinor: 24_000_00 });
    expect(expo.invoices!.map((item) => [item.kind, item.status, item.totalMinor])).toEqual([["advance", "paid", 28_320_00], ["balance", "issued", 66_080_00]]);
    // Its payment is in Revenue net of GST, with TDS counted, and belongs to its creator.
    const all = await demoStore.loadLedger(new Date(Date.parse(expo.invoices![0]!.paidAt!)).toISOString().slice(0, 7), "ig-demo-diya");
    expect(all?.entries.find((entry) => entry.dealId === "deal-expo")).toMatchObject({ threadId: null, amountMinor: 24_000_00, note: expect.stringMatching(/· DM-/) });
    // Owed is what the brand pays: the open balance invoice in full, GST included (₹56,000 + 18%).
    expect(owedTotals([expo], Date.now()).owedMinor).toBe(66_080_00);
    expect(all?.entries.find((entry) => entry.dealId === "deal-expo")?.channel).toBeNull();
    // Your data counts what the API counts: deals, their invoices, billing details and inboxes.
    expect(await demoStore.loadDataSummary()).toMatchObject({ deals: deals.length, invoices: 3, billingProfiles: 1, emailInboxes: [{ address: "collabs@diyamehra.example", status: "active" }] });
    const billing = await demoStore.loadBillingProfile();
    expect(billing).toMatchObject({ inherited: false, profile: { legalName: "Diya Mehra", invoicePrefix: "DM" } });
    expect(billing?.profile?.nextInvoiceNumber).toMatch(/^DM-\d{4}-\d{2}-\d{3}$/);
  });

  // Each demo write waits like a network round trip, and these chain a dozen of them.
  it("issues an advance and its balance, sends a note with the PDF, and records only what isn't GST", { timeout: 20_000 }, async () => {
    await demoStore.init();
    const before = (await demoStore.loadBillingProfile())!.profile!.nextInvoiceNumber;
    const founders = (await demoStore.loadDeals({ status: "all" }))!.find((item) => item.id === "deal-founders")!;
    const billTo = { name: "Founders Circle Community LLP", addressLines: [], city: "Mumbai", state: "27", country: "IN", taxNumber: null };
    await expect(demoStore.createInvoice(founders.id, { kind: "advance", billTo: { ...billTo, taxNumber: "27ABJPM4821K1ZX" } })).rejects.toMatchObject({ status: 400, code: "invalid_body" });
    const advance = await demoStore.createInvoice(founders.id, { kind: "advance", billTo, dueAt: iso(Date.now() + DAY) });
    expect(advance).toMatchObject({ number: before, subtotalMinor: 25_000_00, totalMinor: 29_500_00, title: "Tax invoice", placeOfSupply: "27" });
    expect(advance.taxes.map((tax) => tax.label)).toEqual(["CGST 9%", "SGST 9%"]);
    await expect(demoStore.createInvoice(founders.id, { kind: "advance", billTo })).rejects.toMatchObject({ code: "advance_must_be_first_invoice" });
    let moved = (await demoStore.loadThread("t-founders"))!.deals.find((item) => item.id === founders.id)!;
    expect(moved).toMatchObject({ stage: "invoiced", dueAt: advance.dueAt });
    await expect(demoStore.markDealPaid(founders.id, { idempotencyKey: "deal-paid" })).rejects.toMatchObject({ status: 409, code: "deal_has_open_invoices" });
    await expect(demoStore.updateDeal(founders.id, { amountMinor: 1 })).rejects.toMatchObject({ status: 409, code: "deal_has_invoices" });

    // The cover note names the invoice; sending it carries the PDF, never as a voice note.
    const note = await demoStore.generateDraft("t-founders", { purpose: "invoice", dealId: founders.id, invoiceId: advance.id });
    expect(note).toMatchObject({ purpose: "invoice", invoiceId: advance.id });
    expect(note.body).toContain(`${advance.number} for ₹29,500`);
    await expect(demoStore.send("t-founders", note.body, { asVoice: true })).rejects.toMatchObject({ status: 409 });
    const sent = await demoStore.send("t-founders", note.body);
    expect(sent.attachmentSent).toBe(true);
    expect((await demoStore.loadThread("t-founders"))!.messages.at(-1)?.attachments?.[0]?.filename).toBe(`${advance.number}.pdf`);

    const ledgerBefore = demoStore.getSnapshot().ledger.length;
    const paid = await demoStore.markInvoicePaid(advance.id, { tdsMinor: 2_500_00, idempotencyKey: "advance-paid" });
    expect(paid.invoice).toMatchObject({ status: "paid", receivedMinor: 27_000_00, tdsMinor: 2_500_00 });
    // Received ₹27,000 + TDS ₹2,500 − GST ₹4,500: the fee share.
    expect(paid.deal).toMatchObject({ stage: "invoiced", paidMinor: 25_000_00, dueAt: null });
    expect(demoStore.getSnapshot().ledger).toHaveLength(ledgerBefore + 1);
    expect((await demoStore.markInvoicePaid(advance.id, { tdsMinor: 2_500_00, idempotencyKey: "advance-paid" })).invoice.status).toBe("paid");
    await expect(demoStore.markInvoicePaid(advance.id, { idempotencyKey: "another" })).rejects.toMatchObject({ code: "invoice_already_paid" });
    await expect(demoStore.voidInvoice(advance.id)).rejects.toMatchObject({ code: "invoice_already_paid" });
    await expect(demoStore.generateDraft("t-founders", { purpose: "invoice", dealId: founders.id, invoiceId: advance.id })).rejects.toMatchObject({ code: "invoice_not_open" });

    const balance = await demoStore.createInvoice(founders.id, { kind: "balance", billTo });
    expect(balance.subtotalMinor).toBe(25_000_00);
    const voided = await demoStore.voidInvoice(balance.id);
    expect(voided).toMatchObject({ status: "void" });
    const again = await demoStore.createInvoice(founders.id, { kind: "balance", billTo });
    // Numbers are never reused: the voided one keeps its number.
    expect(new Set([advance.number, balance.number, again.number]).size).toBe(3);
    const settled = await demoStore.markInvoicePaid(again.id, { idempotencyKey: "balance-paid" });
    expect(settled.deal).toMatchObject({ stage: "paid", receivedMinor: 27_000_00 + 29_500_00, tdsMinor: 2_500_00, paidMinor: 50_000_00 });

    // Deleting a payment in Revenue reopens its invoice and the deal, as the API does.
    const entry = demoStore.getSnapshot().ledger.find((item) => item.invoiceId === again.id)!;
    await demoStore.deleteLedger(entry.id);
    moved = (await demoStore.loadThread("t-founders"))!.deals.find((item) => item.id === founders.id)!;
    expect(moved.stage).toBe("invoiced");
    expect(moved.invoices!.find((item) => item.id === again.id)?.status).toBe("issued");
    const actions = ((await demoStore.loadAudit(500)) ?? []).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["invoice.created", "invoice.paid", "invoice.voided", "deal.paid"]));
  });

  it("adds a deal agreed elsewhere and keeps per-creator billing details on Roster", { timeout: 20_000 }, async () => {
    await demoStore.init();
    await expect(demoStore.createDeal({ igAccountId: "ig-nope", counterpartyHandle: "Zenith Sports", title: "Launch reel", dealType: "brand", amountMinor: 40_000_00, idempotencyKey: "elsewhere-0" })).rejects.toMatchObject({ status: 404 });
    const created = await demoStore.createDeal({ igAccountId: "ig-demo-rohan", counterpartyHandle: "Zenith Sports", counterpartyName: "Zenith Sports", title: "Launch reel", dealType: "brand", amountMinor: 40_000_00, idempotencyKey: "elsewhere-1" });
    expect(created).toMatchObject({ threadId: null, channel: null, igAccountId: "ig-demo-rohan", counterpartyName: "Zenith Sports", stage: "agreed", paidMinor: 0 });
    expect((await demoStore.loadDeals({ status: "open", igAccountId: "ig-demo-rohan" }))?.map((item) => item.id)).toContain(created.id);

    const rohan = await demoStore.loadBillingProfile("ig-demo-rohan");
    expect(rohan).toMatchObject({ inherited: true, profile: { legalName: "Diya Mehra" } });
    const own = { ...DEMO_BILLING, legalName: "Rohan Kapoor", tax: { kind: "none" as const, number: null, ratePercent: null, lutArn: null }, pan: null, invoicePrefix: "DM" };
    await expect(demoStore.saveBillingProfile(own, "ig-demo-rohan")).rejects.toMatchObject({ status: 409, code: "invoice_prefix_in_use" });
    await expect(demoStore.saveBillingProfile({ ...own, invoicePrefix: "TOO-LONG" }, "ig-demo-rohan")).rejects.toMatchObject({ status: 400, detail: { fieldErrors: { invoicePrefix: expect.any(Array) } } });
    const saved = await demoStore.saveBillingProfile({ ...own, invoicePrefix: "RK" }, "ig-demo-rohan");
    expect(saved).toMatchObject({ igAccountId: "ig-demo-rohan", legalName: "Rohan Kapoor" });
    expect(saved.nextInvoiceNumber).toMatch(/^RK-\d{4}-\d{2}-001$/);
    // His deals are invoiced from his own details, untaxed: he isn't registered.
    const issued = await demoStore.createInvoice(created.id, { kind: "full", billTo: { name: "Zenith Sports Pvt Ltd", addressLines: [], city: null, state: null, country: "IN", taxNumber: null } });
    expect(issued).toMatchObject({ number: saved.nextInvoiceNumber, title: "Invoice", taxMinor: 0, totalMinor: 40_000_00, supplier: { legalName: "Rohan Kapoor" } });
  });

  it("keeps a session saved before invoices, adding the billing details and sample invoices", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } });
    vi.resetModules();
    const first = (await import("../src/lib/demo-store")).demoStore;
    await first.init();
    // The same session as an older build saved it: no billing details, no invoices, no deal agreed elsewhere.
    const saved = JSON.parse(storage.get("dealdock-demo-v2")!);
    delete saved.billingProfiles;
    saved.deals = saved.deals.filter((item: DealDto) => item.id !== "deal-expo").map(({ invoices: _invoices, ...item }: DealDto) => item);
    saved.ledger = saved.ledger.filter((entry: { dealId?: string }) => entry.dealId !== "deal-expo");
    storage.set("dealdock-demo-v2", JSON.stringify(saved));
    vi.resetModules();
    const restored = (await import("../src/lib/demo-store")).demoStore;
    await restored.init();
    const deals = (await restored.loadDeals({ status: "all" })) ?? [];
    expect(deals.find((item) => item.id === "deal-expo")?.invoices).toHaveLength(2);
    expect(deals.find((item) => item.id === "deal-tealeaf")?.invoices).toHaveLength(1);
    expect(deals.every((item) => Array.isArray(item.invoices))).toBe(true);
    expect((await restored.loadBillingProfile())?.profile?.legalName).toBe("Diya Mehra");
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("API store invoices", () => {
  it("issues, pays and reads billing details through the API, refreshing what each changes", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    const issued = invoice({ id: "inv-9", dealId: "deal-9" });
    const owed = deal({ id: "deal-9", threadId: null, channel: null });
    const respond = (key: string, init: RequestInit): unknown => {
      if (key === "GET /deals?status=open") return { deals: [owed] };
      if (key === "GET /settings/billing-profile?igAccountId=ig-1") return { profile: null, inherited: false };
      if (key === "POST /deals/deal-9/invoices") { bodies.create = JSON.parse(String(init.body)); return issued; }
      if (key === "POST /invoices/inv-9/paid") return { invoice: { ...issued, status: "paid" }, deal: { ...owed, stage: "paid", invoices: [{ ...issued, status: "paid" }] } };
      if (key === "PUT /settings/billing-profile") return new Response(JSON.stringify({ error: "invalid_body", detail: { formErrors: [], fieldErrors: { invoicePrefix: ["Use letters and digits only"] } } }), { status: 400 });
      if (key === "GET /dashboard") return { org: { currencyCode: "INR", locale: "en-IN" }, mtdRecoveredMinor: 0, biggestMinor: 0, avgMinor: 0, mtdDealCount: 0 };
      if (key === "GET /ledger") return { entries: [{ id: "l1", threadId: null, channel: null, handle: "Zenith Sports", dealType: "brand", amountMinor: 60_000_00, closedAt: iso(NOW) }, { id: "l2", threadId: "t-mail", channel: "email", handle: "anika@lumenskin.example", dealType: "brand", amountMinor: 1_000_00, closedAt: iso(NOW) }], months: [], selectedMonth: "2026-11", timezone: ZONE };
      if (key === "GET /onboarding") return { complete: true, timezone: ZONE };
      return { rows: [] };
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      const { pathname, search } = new URL(url);
      const key = `${init.method ?? "GET"} ${pathname}${search}`;
      calls.push(key);
      const body = respond(key, init);
      return body instanceof Response ? body : Response.json(body);
    }));
    const store = new ApiStore();
    store.authenticate("actor", async () => "actor");
    await vi.waitFor(() => expect(store.getSnapshot().state).toBe("ready"));
    // A payment without a conversation has no thread to link to; an email one says it's email.
    expect(store.getSnapshot().ledger.map((entry) => [entry.threadId, entry.channel])).toEqual([[null, null], ["t-mail", "email"]]);
    expect(await store.loadBillingProfile("ig-1")).toEqual({ profile: null, inherited: false });
    await store.loadDeals();
    calls.length = 0;

    const billTo = { name: "Zenith Sports Pvt Ltd", addressLines: [], city: null, state: null, country: "IN", taxNumber: null };
    await store.createInvoice("deal-9", { kind: "full", billTo });
    expect(bodies.create).toEqual({ kind: "full", billTo });
    expect(store.getSnapshot().deals.data?.[0]?.invoices?.map((item) => item.id)).toEqual(["inv-9"]);
    expect(store.getSnapshot().deals.stale).toBe(true);

    calls.length = 0;
    const result = await store.markInvoicePaid("inv-9", { idempotencyKey: "paid-key-0000001" });
    expect(result.deal.stage).toBe("paid");
    expect([...calls].sort()).toEqual(["GET /dashboard", "GET /ledger", "POST /invoices/inv-9/paid"]);

    // A 400 keeps the API's field errors for the form.
    await expect(store.saveBillingProfile({ ...DEMO_BILLING, invoicePrefix: "D M" })).rejects.toMatchObject({ status: 400, detail: { fieldErrors: { invoicePrefix: ["Use letters and digits only"] } } });
  });
});
