import { z } from "zod";
import { DomainError } from "./errors";
import type { CurrencyCode } from "./money";
import { moneyInputValue } from "./money-input";
import type { BillingProfileInput, InvoiceKind, InvoiceLine, InvoiceParty, InvoiceTaxLine, SupplyType, TaxKind } from "./api-types";

/**
 * Invoices: the pure rules shared by the API, the PDF renderer and the web
 * forms (tax, numbering, validation, amounts in words, UPI links), so an
 * invoice reads the same everywhere. Money is integer minor units: each tax
 * line is rounded half up on its own and the total is the exact sum of its
 * parts. India's rules here (GST split, place of supply, LUT, numbering) are
 * pending a chartered accountant's review.
 */

export const INVOICE_KINDS = ["full", "advance", "balance"] as const satisfies readonly InvoiceKind[];
export const TAX_KINDS = ["gst_in", "vat", "none"] as const satisfies readonly TaxKind[];

/** GST state codes (a GSTIN's first two digits) and their names. */
export const INDIAN_STATES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};
/** Place of supply for an export, as GST returns code it ("Other Countries"). */
export const EXPORT_PLACE_OF_SUPPLY = "96";
/** Union territories without a legislature charge UTGST where a state charges SGST. */
const UTGST_STATES = new Set(["04", "26", "31", "35", "38", "97"]);
export const DEFAULT_GST_PERCENT = 18;
/** GST caps an invoice number at 16 characters, unique within the financial year. */
export const GST_INVOICE_NUMBER_MAX = 16;

// ── Validators ─────────────────────────────────────────────────────────────

export function isIndianStateCode(value: string): boolean {
  return Object.hasOwn(INDIAN_STATES, value);
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A GSTIN: state code, the holder's PAN, entity number, a letter, then the mod-36 check character. */
export function isValidGstin(value: string): boolean {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z][0-9A-Z]{2}$/.test(value) || !isIndianStateCode(value.slice(0, 2))) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(value[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === value[14];
}

/** PAN: three letters, the holder type (P person, C company, F firm…), a letter, four digits, a letter. */
export function isValidPan(value: string): boolean {
  return /^[A-Z]{3}[ABCEFGHJLPT][A-Z]\d{4}[A-Z]$/.test(value);
}

export function isValidIfsc(value: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value);
}

/** A UPI address (VPA): name@handle. */
export function isValidUpiId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// ── Request schemas (API boundary and web forms) ───────────────────────────

/** Optional free text: blank or missing means not set. */
const text = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);
/** Optional identifier: spaces dropped, upper-cased, then checked. */
const code = (check: (value: string) => boolean, message: string) =>
  z.string().max(64).nullish()
    .transform((value) => value?.replace(/\s+/g, "").toUpperCase() || null)
    .refine((value) => value === null || check(value), message);
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use the 2-letter country code, like IN");
const addressLines = z.array(z.string().trim().max(120)).max(4).default([]).transform((lines) => lines.filter(Boolean));
const issue = (ctx: z.RefinementCtx, path: Array<string | number>, message: string) => ctx.addIssue({ code: "custom", path, message });

export const TaxRegistrationSchema = z.object({
  kind: z.enum(TAX_KINDS),
  number: code((value) => /^[A-Z0-9-]{4,20}$/.test(value), "Enter the tax number"),
  ratePercent: z.number().min(0).max(100)
    .refine((rate) => Math.abs(rate * 100 - Math.round(rate * 100)) < 1e-9, "Use at most 2 decimals")
    .nullish().transform((rate) => rate ?? null),
  lutArn: code((value) => /^[A-Z]{2}\d{2}[0-9A-Z]{9,12}$/.test(value), "Enter the LUT's ARN"),
});

export const PaymentDetailsSchema = z.object({
  upiId: text(256).refine((value) => value === null || isValidUpiId(value), "Enter a UPI ID like name@bank"),
  bankName: text(80),
  accountName: text(120),
  accountNumber: code((value) => /^[0-9A-Z]{6,34}$/.test(value), "Enter the account number"),
  ifsc: code(isValidIfsc, "Enter the 11-character IFSC, like HDFC0001234"),
  swift: code((value) => /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value), "Enter the 8 or 11-character SWIFT/BIC"),
  iban: code((value) => /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value), "Enter the IBAN"),
  paymentLink: text(500).refine((value) => value === null || isHttpsUrl(value), "Payment links must be https"),
});

/** PUT /settings/billing-profile. Cross-field rules keep a GST profile consistent with its GSTIN. */
export const BillingProfileInputSchema = z
  .object({
    legalName: z.string().trim().min(1).max(120),
    addressLines,
    city: text(80),
    state: text(80),
    country,
    email: text(254).refine((value) => value === null || z.email().safeParse(value).success, "Enter a valid email"),
    phone: text(20).refine((value) => value === null || /^\+?[0-9 ()-]{6,20}$/.test(value), "Enter a phone number"),
    tax: TaxRegistrationSchema,
    pan: code(isValidPan, "Enter the 10-character PAN, like ABCDE1234F"),
    udyamNumber: code((value) => /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(value), "Enter the Udyam number, like UDYAM-MH-01-0001234"),
    sacCode: text(8).refine((value) => value === null || /^\d{4,8}$/.test(value), "SAC and HSN codes are 4 to 8 digits"),
    payment: PaymentDetailsSchema,
    invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, "Use letters and digits only").default("INV"),
  })
  .superRefine((profile, ctx) => {
    const india = profile.country === "IN";
    const { tax } = profile;
    if (india && profile.state !== null && !isIndianStateCode(profile.state)) issue(ctx, ["state"], "Pick the state");
    // "-2026-27-001" is 12 characters, so 4 keeps a number within GST's 16.
    if (india && profile.invoicePrefix.length > 4) issue(ctx, ["invoicePrefix"], "Keep the prefix to 4 characters so numbers fit GST's 16");
    if (tax.kind === "gst_in") {
      if (!india) issue(ctx, ["tax", "kind"], "GST registration needs an address in India");
      if (tax.number === null || !isValidGstin(tax.number)) issue(ctx, ["tax", "number"], "Enter a valid 15-character GSTIN");
      else {
        if (profile.state !== tax.number.slice(0, 2)) issue(ctx, ["state"], "The state must be the GSTIN's");
        if (profile.pan !== null && profile.pan !== tax.number.slice(2, 12)) issue(ctx, ["pan"], "The PAN must be the one in the GSTIN");
      }
    } else if (tax.lutArn !== null) issue(ctx, ["tax", "lutArn"], "A LUT goes with a GST registration");
    if (tax.kind === "vat" && tax.number === null) issue(ctx, ["tax", "number"], "Enter the VAT number");
    if (tax.kind === "vat" && tax.ratePercent === null) issue(ctx, ["tax", "ratePercent"], "Enter the VAT rate");
    if (tax.kind === "none" && (tax.number !== null || tax.ratePercent !== null)) issue(ctx, ["tax", "kind"], "Pick GST or VAT to add a tax number");
  });

/** An invoice's billTo. An Indian GSTIN must be valid and agree with the state. */
export const InvoicePartySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    addressLines,
    city: text(80),
    state: text(80),
    country,
    taxNumber: z.string().max(30).nullish().transform((value) => value?.replace(/\s+/g, "").toUpperCase() || null),
  })
  .superRefine((party, ctx) => {
    if (party.country !== "IN") return;
    if (party.state !== null && !isIndianStateCode(party.state)) issue(ctx, ["state"], "Pick the state");
    if (party.taxNumber === null) return;
    if (!isValidGstin(party.taxNumber)) issue(ctx, ["taxNumber"], "Enter a valid 15-character GSTIN");
    else if (party.state !== null && party.state !== party.taxNumber.slice(0, 2)) issue(ctx, ["state"], "The state must be the GSTIN's");
  });

// Compile-time: the schemas produce exactly the wire shapes.
const _profileShape: (input: z.output<typeof BillingProfileInputSchema>) => BillingProfileInput = (input) => input;
const _partyShape: (input: z.output<typeof InvoicePartySchema>) => InvoiceParty = (input) => input;
void _profileShape;
void _partyShape;

// ── Money ──────────────────────────────────────────────────────────────────

/** `percent`% of an amount, rounded half up to a whole minor unit. Exact for rates with up to 3 decimals. */
export function percentOfMinor(amountMinor: number, percent: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError(`minor units must be a non-negative integer, got ${amountMinor}`);
  // percent in thousandths, so amount × percent / 100 = amount × thousandths / 100000.
  const scaled = BigInt(amountMinor) * BigInt(Math.round(percent * 1000));
  return Number((scaled * 2n + 100_000n) / 200_000n);
}

function taxLine(kind: InvoiceTaxLine["kind"], name: string, ratePercent: number, baseMinor: number): InvoiceTaxLine {
  return { kind, label: `${name} ${ratePercent}%`, ratePercent, amountMinor: percentOfMinor(baseMinor, ratePercent) };
}

/**
 * What an invoice bills of the deal's fee, before tax: all of it, the agreed
 * advance, or what earlier (non-void) invoices left. Never more than the fee.
 */
export function invoiceShareMinor(kind: InvoiceKind, deal: { amountMinor: number; advancePercent: number | null }, invoicedMinor: number): number {
  if (kind === "advance") {
    if (!deal.advancePercent) throw new DomainError("deal_has_no_advance", 409);
    if (invoicedMinor > 0) throw new DomainError("advance_must_be_first_invoice", 409);
    return percentOfMinor(deal.amountMinor, deal.advancePercent);
  }
  const share = kind === "full" ? deal.amountMinor : deal.amountMinor - invoicedMinor;
  if (share <= 0) throw new DomainError("nothing_left_to_invoice", 409);
  if (invoicedMinor + share > deal.amountMinor) throw new DomainError("invoice_exceeds_deal_amount", 409);
  return share;
}

export function invoiceLineDescription(kind: InvoiceKind, title: string, advancePercent: number | null): string {
  if (kind === "advance") return `Advance (${advancePercent}%): ${title}`;
  return kind === "balance" ? `Balance: ${title}` : title;
}

export interface InvoiceComputation {
  lines: InvoiceLine[];
  subtotalMinor: number;
  taxes: InvoiceTaxLine[];
  taxMinor: number;
  totalMinor: number;
  supplyType: SupplyType;
  placeOfSupply: string | null;
}

/**
 * Lines, taxes and total for one invoice. India, GST-registered: 18% unless
 * the profile says otherwise; CGST + SGST (UTGST in a union territory without
 * a legislature) when the place of supply is the supplier's state, else IGST;
 * a recipient outside India is an export (no tax under a LUT, else IGST).
 * VAT: one line at the profile's rate. No registration: no tax.
 */
export function computeInvoice(input: {
  baseMinor: number;
  description: string;
  supplier: Pick<BillingProfileInput, "state" | "tax" | "sacCode">;
  billTo: Pick<InvoiceParty, "country" | "state" | "taxNumber">;
}): InvoiceComputation {
  const { baseMinor, supplier, billTo } = input;
  if (!Number.isSafeInteger(baseMinor) || baseMinor <= 0) throw new DomainError("invoice_amount_must_be_positive", 400);
  const { tax } = supplier;
  let supplyType: SupplyType = "untaxed";
  let placeOfSupply: string | null = null;
  let taxes: InvoiceTaxLine[] = [];
  if (tax.kind === "gst_in") {
    const rate = tax.ratePercent ?? DEFAULT_GST_PERCENT;
    if (billTo.country !== "IN") {
      placeOfSupply = EXPORT_PLACE_OF_SUPPLY;
      supplyType = tax.lutArn ? "export_lut" : "export_tax";
      if (!tax.lutArn) taxes = [taxLine("igst", "IGST", rate, baseMinor)];
    } else {
      // A GSTIN starts with the state it is registered in.
      const home = tax.number?.slice(0, 2) ?? supplier.state ?? "";
      // Services to a business: the recipient's state; with none on record, the supplier's (IGST Act s.12(2)).
      const place = billTo.state ?? billTo.taxNumber?.slice(0, 2) ?? home;
      supplyType = "domestic";
      placeOfSupply = place;
      taxes =
        place === home
          ? [taxLine("cgst", "CGST", rate / 2, baseMinor), UTGST_STATES.has(place) ? taxLine("utgst", "UTGST", rate / 2, baseMinor) : taxLine("sgst", "SGST", rate / 2, baseMinor)]
          : [taxLine("igst", "IGST", rate, baseMinor)];
    }
  } else if (tax.kind === "vat") {
    supplyType = "domestic";
    taxes = [taxLine("vat", "VAT", tax.ratePercent ?? 0, baseMinor)];
  }
  const taxMinor = taxes.reduce((sum, line) => sum + line.amountMinor, 0);
  const totalMinor = baseMinor + taxMinor;
  if (!Number.isSafeInteger(totalMinor)) throw new DomainError("invoice_total_too_large", 400);
  return {
    lines: [{ description: input.description, sacCode: supplier.sacCode, quantity: 1, amountMinor: baseMinor }],
    subtotalMinor: baseMinor,
    taxes,
    taxMinor,
    totalMinor,
    supplyType,
    placeOfSupply,
  };
}

export function invoiceTitle(supplyType: SupplyType, taxKind: TaxKind): string {
  if (supplyType === "export_lut" || supplyType === "export_tax") return "Export invoice";
  return taxKind === "gst_in" ? "Tax invoice" : "Invoice";
}

/** The endorsement an Indian export invoice carries (CGST Rules, r.46). */
export function invoiceDeclaration(supplyType: SupplyType, lutArn: string | null): string | null {
  if (supplyType === "export_lut") return `Supply meant for export under LUT without payment of integrated tax${lutArn ? ` (LUT ARN ${lutArn})` : ""}`;
  return supplyType === "export_tax" ? "Supply meant for export on payment of integrated tax" : null;
}

/** When an invoice is due unless the creator picks a date: an advance on issue; otherwise the deal's due date, else its payment days from issue. */
export function defaultInvoiceDueAt(kind: InvoiceKind, deal: { dueAt: string | null; paymentDays: number | null }, issuedAt: Date): string {
  if (kind !== "advance" && deal.dueAt) return deal.dueAt;
  const days = kind === "advance" ? 0 : (deal.paymentDays ?? 0);
  return new Date(issuedAt.getTime() + days * 86_400_000).toISOString();
}

/** What an invoice payment adds to Revenue: what arrived plus TDS withheld, less the GST/VAT it collected for the government. */
export function invoiceRevenueMinor(invoice: { taxMinor: number }, payment: { receivedMinor: number; tdsMinor: number | null }): number {
  return payment.receivedMinor + (payment.tdsMinor ?? 0) - invoice.taxMinor;
}

// ── Numbering ──────────────────────────────────────────────────────────────

/** The year an invoice number counts in, on the issuer's calendar: India's financial year (April–March, "2026-27"), else the calendar year. */
export function invoiceNumberYear(at: Date, timeZone: string, country: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = part("year");
  if (country !== "IN") return String(year);
  const start = part("month") >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "INV-2026-27-001": prefix, year, sequence (3 digits, more past 999). Hyphens only, so it is a safe file name too. */
export function formatInvoiceNumber(prefix: string, year: string, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(3, "0")}`;
}

// ── Amount in words ────────────────────────────────────────────────────────

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const SCALES = ["", "Thousand", "Million", "Billion", "Trillion"];

function underThousand(n: number): string[] {
  const words = n >= 100 ? [ONES[Math.floor(n / 100)]!, "Hundred"] : [];
  const rest = n % 100;
  if (rest >= 20) words.push(TENS[Math.floor(rest / 10)]!, ...(rest % 10 ? [ONES[rest % 10]!] : []));
  else if (rest > 0) words.push(ONES[rest]!);
  return words;
}

/** Indian numbering: crore, lakh, thousand, hundred. */
function indianWords(n: number): string[] {
  if (n >= 1e7) return [...indianWords(Math.floor(n / 1e7)), "Crore", ...indianWords(n % 1e7)];
  const lakh = Math.floor(n / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  return [...(lakh ? [...underThousand(lakh), "Lakh"] : []), ...(thousand ? [...underThousand(thousand), "Thousand"] : []), ...underThousand(n % 1e3)];
}

/** Thousand, million, billion, trillion: enough for any safe amount. */
function internationalWords(n: number): string[] {
  return SCALES.map((scale, i) => {
    const chunk = Math.floor(n / 1000 ** i) % 1000;
    return chunk ? [...underThousand(chunk), ...(scale ? [scale] : [])] : [];
  }).reverse().flat();
}

const CURRENCY_WORDS: Record<CurrencyCode, [unit: string, units: string, sub: string, subs: string]> = {
  INR: ["Rupee", "Rupees", "Paisa", "Paise"],
  USD: ["US Dollar", "US Dollars", "Cent", "Cents"],
  GBP: ["Pound", "Pounds", "Penny", "Pence"],
  EUR: ["Euro", "Euros", "Cent", "Cents"],
  AED: ["UAE Dirham", "UAE Dirhams", "Fils", "Fils"],
};

/** "Rupees Sixty One Thousand Nine Hundred Fifty Only" (lakh and crore for INR); other currencies count in thousands and millions. */
export function amountInWords(minor: number, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`minor units must be a non-negative integer, got ${minor}`);
  const major = Math.floor(minor / 100);
  const cents = minor % 100;
  const [unit, units, sub, subs] = CURRENCY_WORDS[currency];
  const words = (n: number) => (n === 0 ? "Zero" : (currency === "INR" ? indianWords(n) : internationalWords(n)).join(" "));
  const fraction = cents ? ` and ${words(cents)} ${cents === 1 ? sub : subs}` : "";
  return currency === "INR" ? `Rupees ${words(major)}${fraction} Only` : `${words(major)} ${major === 1 ? unit : units}${fraction} Only`;
}

// ── UPI ────────────────────────────────────────────────────────────────────

/** A UPI "pay" link (QR or tap target) for an invoice: the exact rupee amount, with the invoice number as the note. */
export function upiPayUrl(input: { upiId: string; payeeName: string; amountMinor: number; invoiceNumber: string }): string {
  if (!isValidUpiId(input.upiId)) throw new DomainError("invalid_upi_id", 400);
  return `upi://pay?pa=${input.upiId}&pn=${encodeURIComponent(input.payeeName)}&am=${moneyInputValue(input.amountMinor)}&cu=INR&tn=${encodeURIComponent(input.invoiceNumber)}`;
}
