import { describe, expect, it } from "vitest";
import {
  amountInWords,
  BillingProfileInputSchema,
  computeInvoice,
  defaultInvoiceDueAt,
  formatInvoiceNumber,
  invoiceDeclaration,
  invoiceNumberYear,
  invoiceRevenueMinor,
  invoiceShareMinor,
  invoiceTitle,
  InvoicePartySchema,
  isIndianStateCode,
  isValidGstin,
  isValidIfsc,
  isValidPan,
  isValidUpiId,
  percentOfMinor,
  upiPayUrl,
} from "../src/invoices";
import { dealRevenueMinor, owedTotals } from "../src/deals";
import type { TaxRegistration } from "../src/api-types";

const GSTIN_MH = "27AAPFU0939F1ZV"; // Maharashtra
const GSTIN_KA = "29AAGCB7383J1Z4"; // Karnataka
const GSTIN_CH = "04AAPFU0939F1Z?"; // completed below with its check character
const gst = (over: Partial<TaxRegistration> = {}): TaxRegistration => ({ kind: "gst_in", number: GSTIN_MH, ratePercent: null, lutArn: null, ...over });
const supplier = (tax: TaxRegistration, state: string | null = "27") => ({ state, tax, sacCode: "998361" });
const india = (state: string | null, taxNumber: string | null = null) => ({ country: "IN", state, taxNumber });
const invoice = (baseMinor: number, tax: TaxRegistration, billTo = india("27"), state: string | null = "27") =>
  computeInvoice({ baseMinor, description: "1 reel", supplier: supplier(tax, state), billTo });

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { status?: number }).status;
  }
  return undefined;
}

describe("GST and VAT", () => {
  it("splits 18% into CGST 9% + SGST 9% when the place of supply is the supplier's state", () => {
    const result = invoice(5_250_000, gst());
    expect(result).toMatchObject({ supplyType: "domestic", placeOfSupply: "27", subtotalMinor: 5_250_000, taxMinor: 945_000, totalMinor: 6_195_000 });
    expect(result.taxes).toEqual([
      { kind: "cgst", label: "CGST 9%", ratePercent: 9, amountMinor: 472_500 },
      { kind: "sgst", label: "SGST 9%", ratePercent: 9, amountMinor: 472_500 },
    ]);
    expect(result.lines).toEqual([{ description: "1 reel", sacCode: "998361", quantity: 1, amountMinor: 5_250_000 }]);
  });

  it("charges IGST 18% across states, taking the place of supply from the recipient's state or GSTIN", () => {
    expect(invoice(5_250_000, gst(), india("29")).taxes).toEqual([{ kind: "igst", label: "IGST 18%", ratePercent: 18, amountMinor: 945_000 }]);
    expect(invoice(5_250_000, gst(), india(null, GSTIN_KA))).toMatchObject({ placeOfSupply: "29", taxMinor: 945_000 });
    // Nothing on record for the recipient: the supplier's own state.
    expect(invoice(5_250_000, gst(), india(null))).toMatchObject({ placeOfSupply: "27", taxes: [{ kind: "cgst" }, { kind: "sgst" }] });
  });

  it("uses UTGST in a union territory without a legislature", () => {
    const chandigarh = GSTIN_CH.slice(0, 14) + checkChar(GSTIN_CH.slice(0, 14));
    expect(isValidGstin(chandigarh)).toBe(true);
    expect(invoice(100_000, gst({ number: chandigarh }), india("04"), "04").taxes.map((t) => t.label)).toEqual(["CGST 9%", "UTGST 9%"]);
  });

  it("rounds each tax line half up on its own, so the total is the exact sum of the lines", () => {
    // 9% of 50 paise is 4.5 → 5 per line; IGST 18% is exactly 9.
    expect(invoice(50, gst()).taxes.map((t) => t.amountMinor)).toEqual([5, 5]);
    expect(invoice(50, gst())).toMatchObject({ taxMinor: 10, totalMinor: 60 });
    expect(invoice(50, gst(), india("29"))).toMatchObject({ taxMinor: 9, totalMinor: 59 });
    // 9% of 101 paise = 9.09 → 9.
    expect(invoice(101, gst()).taxMinor).toBe(18);
    for (const base of [1, 49, 50, 51, 99_999, 3_333_333, 9_999_999_999]) {
      const r = invoice(base, gst());
      expect(r.totalMinor).toBe(r.subtotalMinor + r.taxes.reduce((sum, t) => sum + t.amountMinor, 0));
    }
    expect(percentOfMinor(9_007_199_254_740_991, 18)).toBe(1_621_295_865_853_378);
    expect(percentOfMinor(5, 2.5)).toBe(0); // 0.125
    expect(percentOfMinor(20, 2.5)).toBe(1); // 0.5 → 1
  });

  it("honours a profile's own GST rate", () => {
    expect(invoice(100_000, gst({ ratePercent: 5 })).taxes.map((t) => t.label)).toEqual(["CGST 2.5%", "SGST 2.5%"]);
  });

  it("exports under a LUT without tax and with the declaration; without a LUT, with IGST", () => {
    const us = { country: "US", state: "CA", taxNumber: null };
    const lut = invoice(5_250_000, gst({ lutArn: "AD270326001234X" }), us);
    expect(lut).toMatchObject({ supplyType: "export_lut", placeOfSupply: "96", taxes: [], taxMinor: 0, totalMinor: 5_250_000 });
    expect(invoiceDeclaration(lut.supplyType, "AD270326001234X")).toBe("Supply meant for export under LUT without payment of integrated tax (LUT ARN AD270326001234X)");
    expect(invoiceTitle(lut.supplyType, "gst_in")).toBe("Export invoice");

    const taxed = invoice(5_250_000, gst(), us);
    expect(taxed).toMatchObject({ supplyType: "export_tax", taxes: [{ kind: "igst", amountMinor: 945_000 }], totalMinor: 6_195_000 });
    expect(invoiceDeclaration(taxed.supplyType, null)).toBe("Supply meant for export on payment of integrated tax");
  });

  it("charges nothing without a registration, and one VAT line with one", () => {
    const none = invoice(5_250_000, { kind: "none", number: null, ratePercent: null, lutArn: null }, { country: "US", state: null, taxNumber: null }, null);
    expect(none).toMatchObject({ supplyType: "untaxed", placeOfSupply: null, taxes: [], totalMinor: 5_250_000 });
    expect(invoiceTitle("untaxed", "none")).toBe("Invoice");
    expect(invoiceTitle("domestic", "gst_in")).toBe("Tax invoice");

    const vat = invoice(100_050, { kind: "vat", number: "GB123456789", ratePercent: 20, lutArn: null }, { country: "GB", state: null, taxNumber: null }, null);
    expect(vat).toMatchObject({ supplyType: "domestic", placeOfSupply: null, taxes: [{ kind: "vat", label: "VAT 20%", amountMinor: 20_010 }], totalMinor: 120_060 });
    expect(invoiceTitle("domestic", "vat")).toBe("Invoice");
  });
});

describe("what an invoice bills", () => {
  const deal = { amountMinor: 5_250_000, advancePercent: 50 };

  it("bills the advance first, then the balance, never more than the fee", () => {
    expect(invoiceShareMinor("advance", deal, 0)).toBe(2_625_000);
    expect(invoiceShareMinor("balance", deal, 2_625_000)).toBe(2_625_000);
    expect(invoiceShareMinor("full", deal, 0)).toBe(5_250_000);
    // 33% of ₹1,000.01 = ₹330.0033 → ₹330.00 (half up).
    expect(invoiceShareMinor("advance", { amountMinor: 100_001, advancePercent: 33 }, 0)).toBe(33_000);
    expect(invoiceShareMinor("balance", { amountMinor: 100_001, advancePercent: 33 }, 33_000)).toBe(67_001);
  });

  it("refuses what the deal does not allow", () => {
    expect(statusOf(() => invoiceShareMinor("full", deal, 2_625_000))).toBe(409);
    expect(statusOf(() => invoiceShareMinor("balance", deal, 5_250_000))).toBe(409);
    expect(statusOf(() => invoiceShareMinor("advance", deal, 2_625_000))).toBe(409);
    expect(statusOf(() => invoiceShareMinor("advance", { amountMinor: 5_250_000, advancePercent: null }, 0))).toBe(409);
    expect(statusOf(() => invoiceShareMinor("advance", { amountMinor: 5_250_000, advancePercent: 0 }, 0))).toBe(409);
  });

  it("is due on issue for an advance, else on the deal's due date or its payment days", () => {
    const issued = new Date("2026-11-04T10:00:00Z");
    expect(defaultInvoiceDueAt("advance", { dueAt: "2026-12-01T00:00:00.000Z", paymentDays: 30 }, issued)).toBe("2026-11-04T10:00:00.000Z");
    expect(defaultInvoiceDueAt("balance", { dueAt: "2026-12-01T00:00:00.000Z", paymentDays: 30 }, issued)).toBe("2026-12-01T00:00:00.000Z");
    expect(defaultInvoiceDueAt("full", { dueAt: null, paymentDays: 30 }, issued)).toBe("2026-12-04T10:00:00.000Z");
    expect(defaultInvoiceDueAt("full", { dueAt: null, paymentDays: null }, issued)).toBe("2026-11-04T10:00:00.000Z");
  });

  it("counts what arrived plus TDS toward Revenue, net of the tax collected", () => {
    expect(invoiceRevenueMinor({ taxMinor: 945_000 }, { receivedMinor: 6_195_000 - 525_000, tdsMinor: 525_000 })).toBe(5_250_000);
    expect(invoiceRevenueMinor({ taxMinor: 0 }, { receivedMinor: 2_625_000, tdsMinor: null })).toBe(2_625_000);
  });
});

describe("invoice numbers", () => {
  it("count in India's financial year on the issuer's calendar, across the April boundary", () => {
    expect(invoiceNumberYear(new Date("2027-03-31T18:29:59Z"), "Asia/Kolkata", "IN")).toBe("2026-27"); // 31 Mar, 23:59 IST
    expect(invoiceNumberYear(new Date("2027-03-31T18:30:00Z"), "Asia/Kolkata", "IN")).toBe("2027-28"); // 1 Apr, 00:00 IST
    expect(invoiceNumberYear(new Date("2026-11-04T10:00:00Z"), "Asia/Kolkata", "IN")).toBe("2026-27");
    expect(invoiceNumberYear(new Date("2099-06-01T00:00:00Z"), "Asia/Kolkata", "IN")).toBe("2099-00");
  });

  it("count in the calendar year elsewhere", () => {
    expect(invoiceNumberYear(new Date("2027-01-01T04:59:59Z"), "America/New_York", "US")).toBe("2026");
    expect(invoiceNumberYear(new Date("2027-01-01T05:00:00Z"), "America/New_York", "US")).toBe("2027");
  });

  it("read prefix-year-sequence and fit GST's 16 characters", () => {
    expect(formatInvoiceNumber("INV", "2026-27", 1)).toBe("INV-2026-27-001");
    expect(formatInvoiceNumber("RIYA", "2026-27", 42)).toHaveLength(16);
    expect(formatInvoiceNumber("INV", "2026-27", 1000)).toBe("INV-2026-27-1000");
    expect(formatInvoiceNumber("INV", "2026", 7)).toBe("INV-2026-007");
  });
});

describe("validators", () => {
  it("checks a GSTIN's format, state and check character", () => {
    expect(isValidGstin(GSTIN_MH)).toBe(true);
    expect(isValidGstin(GSTIN_KA)).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false); // wrong check character
    expect(isValidGstin("99AAPFU0939F1ZV")).toBe(false); // no such state
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
    expect(isValidGstin("27aapfu0939f1zv")).toBe(false);
  });

  it("checks PAN, IFSC, UPI IDs and state codes", () => {
    expect(isValidPan("AAPFU0939F")).toBe(true);
    expect(isValidPan("ABCDE1234F")).toBe(false); // D is no holder type
    expect(isValidPan("AAPFU0939")).toBe(false);
    expect(isValidIfsc("HDFC0001234")).toBe(true);
    expect(isValidIfsc("HDFC1001234")).toBe(false);
    expect(isValidUpiId("riya.sharma@okhdfcbank")).toBe(true);
    expect(isValidUpiId("9876543210@ybl")).toBe(true);
    expect(isValidUpiId("riya@")).toBe(false);
    expect(isValidUpiId("riya sharma@ybl")).toBe(false);
    expect(isIndianStateCode("27")).toBe(true);
    expect(isIndianStateCode("28")).toBe(false); // undivided Andhra Pradesh, retired
    expect(isIndianStateCode("96")).toBe(false);
  });
});

describe("amount in words", () => {
  it("uses lakh and crore for rupees, with paise", () => {
    expect(amountInWords(6_195_000, "INR")).toBe("Rupees Sixty One Thousand Nine Hundred Fifty Only");
    expect(amountInWords(12_345_678_950, "INR")).toBe("Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Fifty Paise Only");
    expect(amountInWords(1_00_00_000_00 * 150, "INR")).toBe("Rupees One Hundred Fifty Crore Only");
    expect(amountInWords(10_000_001, "INR")).toBe("Rupees One Lakh and One Paisa Only");
    expect(amountInWords(0, "INR")).toBe("Rupees Zero Only");
  });

  it("uses thousands and millions elsewhere", () => {
    expect(amountInWords(123_456_789, "USD")).toBe("One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven US Dollars and Eighty Nine Cents Only");
    expect(amountInWords(100, "GBP")).toBe("One Pound Only");
    expect(amountInWords(250_001, "EUR")).toBe("Two Thousand Five Hundred Euros and One Cent Only");
    expect(amountInWords(9_007_199_254_740_991, "AED")).toMatch(/^Ninety Trillion Seventy One Billion .* UAE Dirhams and Ninety One Fils Only$/);
  });
});

describe("UPI pay link", () => {
  it("carries the payee, the exact amount and the invoice number", () => {
    expect(upiPayUrl({ upiId: "riya@okhdfcbank", payeeName: "Riya Sharma & Co", amountMinor: 6_195_050, invoiceNumber: "INV-2026-27-001" })).toBe(
      "upi://pay?pa=riya@okhdfcbank&pn=Riya%20Sharma%20%26%20Co&am=61950.50&cu=INR&tn=INV-2026-27-001",
    );
    expect(statusOf(() => upiPayUrl({ upiId: "not a vpa", payeeName: "R", amountMinor: 1, invoiceNumber: "X" }))).toBe(400);
  });
});

describe("billing profile input", () => {
  const base = {
    legalName: "Riya Sharma",
    addressLines: [" 12 Carter Road ", "", "Bandra West 400050"],
    city: "Mumbai",
    state: "27",
    country: "in",
    email: "riya@example.com",
    phone: "+91 98765 43210",
    tax: { kind: "gst_in", number: "27aapfu0939f1zv", ratePercent: null, lutArn: "ad270326001234x" },
    pan: "AAPFU0939F",
    udyamNumber: "udyam-mh-01-0001234",
    sacCode: "998361",
    payment: { upiId: "riya@okhdfcbank", ifsc: "hdfc0001234", accountNumber: "5010 0123 4567 89", paymentLink: "https://rzp.io/l/riya" },
    invoicePrefix: "riya",
  };
  const parse = (over: Record<string, unknown> = {}) => BillingProfileInputSchema.safeParse({ ...base, ...over });
  const paths = (over: Record<string, unknown>) => {
    const result = parse(over);
    return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
  };

  it("normalizes a GST profile: codes upper-cased, spaces dropped, blanks null", () => {
    const result = parse();
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      country: "IN",
      addressLines: ["12 Carter Road", "Bandra West 400050"],
      tax: { kind: "gst_in", number: GSTIN_MH, ratePercent: null, lutArn: "AD270326001234X" },
      udyamNumber: "UDYAM-MH-01-0001234",
      invoicePrefix: "RIYA",
      payment: { upiId: "riya@okhdfcbank", ifsc: "HDFC0001234", accountNumber: "50100123456789", bankName: null, swift: null, iban: null },
    });
  });

  it("keeps a GST profile consistent with its GSTIN", () => {
    expect(paths({ state: "29" })).toEqual(["state"]);
    expect(paths({ pan: "AAPFU0939G" })).toEqual(["pan"]);
    expect(paths({ tax: { ...base.tax, number: "27AAPFU0939F1ZW" } })).toEqual(["tax.number"]);
    expect(paths({ country: "US", state: "CA" })).toContain("tax.kind");
    expect(paths({ invoicePrefix: "RIYAS" })).toEqual(["invoicePrefix"]);
  });

  it("needs a VAT number and rate, and keeps LUTs and tax numbers to registrations", () => {
    const uk = { country: "GB", state: null, pan: null, udyamNumber: null, invoicePrefix: "INVOICE" };
    expect(paths({ ...uk, tax: { kind: "vat", number: "GB123456789", ratePercent: 20, lutArn: null } })).toEqual([]);
    expect(paths({ ...uk, tax: { kind: "vat", number: "GB123456789", ratePercent: null, lutArn: null } })).toEqual(["tax.ratePercent"]);
    expect(paths({ ...uk, tax: { kind: "none", number: null, ratePercent: null, lutArn: "AD270326001234X" } })).toEqual(["tax.lutArn"]);
    expect(paths({ ...uk, tax: { kind: "none", number: "GB1", ratePercent: null, lutArn: null } })).toContain("tax.number");
    expect(paths({ ...uk, tax: { kind: "vat", number: "GB123456789", ratePercent: 20.005, lutArn: null } })).toEqual(["tax.ratePercent"]);
    expect(paths({ payment: { upiId: "nope", paymentLink: "http://pay.example" } })).toEqual(["payment.upiId", "payment.paymentLink"]);
  });
});

describe("bill-to", () => {
  it("validates an Indian GSTIN against the state, and leaves other countries' tax numbers alone", () => {
    expect(InvoicePartySchema.safeParse({ name: "Glow Co", country: "IN", state: "29", taxNumber: GSTIN_KA }).success).toBe(true);
    expect(InvoicePartySchema.safeParse({ name: "Glow Co", country: "IN", state: "27", taxNumber: GSTIN_KA }).success).toBe(false);
    expect(InvoicePartySchema.safeParse({ name: "Glow Co", country: "IN", state: null, taxNumber: "12345" }).success).toBe(false);
    expect(InvoicePartySchema.parse({ name: " Glow Inc ", country: "us", state: "CA", taxNumber: "12-3456789" })).toEqual({
      name: "Glow Inc", addressLines: [], city: null, state: "CA", country: "US", taxNumber: "12-3456789",
    });
  });
});

describe("deals with invoice payments", () => {
  it("count the recorded payments toward Revenue and off what is owed", () => {
    expect(dealRevenueMinor({ amountMinor: 5_250_000, receivedMinor: 6_195_000, tdsMinor: null, paidMinor: 5_250_000 })).toBe(5_250_000);
    expect(dealRevenueMinor({ amountMinor: 5_250_000, receivedMinor: 4_000_000, tdsMinor: null })).toBe(4_000_000);
    const now = Date.parse("2026-11-04T10:00:00Z");
    expect(owedTotals([{ stage: "invoiced", dueAt: "2026-11-01T00:00:00Z", amountMinor: 5_250_000, paidMinor: 2_625_000 }], now)).toEqual({
      owedMinor: 2_625_000, overdueMinor: 2_625_000, openCount: 1, overdueCount: 1,
    });
  });
});

function checkChar(first14: string): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = chars.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return chars[(36 - (sum % 36)) % 36]!;
}

describe("document money", () => {
  it("always shows two decimals, exactly, in the org's grouping", async () => {
    const { formatMoneyFixed } = await import("../src/money");
    expect(formatMoneyFixed(6_195_000, { currency: "INR", locale: "en-IN" })).toBe("₹61,950.00");
    expect(formatMoneyFixed(12_345_678_905, { currency: "INR", locale: "en-IN" })).toBe("₹12,34,56,789.05");
    expect(formatMoneyFixed(123_456_789, { currency: "USD" })).toBe("$1,234,567.89");
    expect(formatMoneyFixed(9_007_199_254_740_991, { currency: "EUR", locale: "en-IE" })).toBe("€90,071,992,547,409.91");
    expect(formatMoneyFixed(5, { currency: "AED" })).toBe("AED 0.05");
  });
});
