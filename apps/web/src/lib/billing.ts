import { isValidGstin, type BillingProfileInput, type InvoiceParty, type TaxKind } from "@dealdock/core";

/**
 * Billing details and bill-to forms (no React): the text each field holds,
 * and the request built from it. Fields a country or tax registration hides
 * are dropped from the request, so a value typed before switching can never
 * fail validation out of sight. Validation itself is core's schemas.
 */

/** Region codes Intl names that aren't places an invoice goes (pseudo-locales, groupings). */
const NOT_COUNTRIES = new Set(["EU", "EZ", "QO", "UN", "XA", "XB", "ZZ"]);
let countries: Array<{ code: string; name: string }> | null = null;

/** Every country, by name, from the platform's own region names. */
export function countryOptions(): Array<{ code: string; name: string }> {
  if (countries) return countries;
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const list: Array<{ code: string; name: string }> = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = NOT_COUNTRIES.has(code) ? undefined : names.of(code);
      if (name && name !== code) list.push({ code, name });
    }
  }
  countries = list.sort((x, y) => x.name.localeCompare(y.name));
  return countries;
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The first message per field, keyed by the field's path ("tax.number"), from core's schema issues. */
export function issueErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[issue.path.map(String).join(".")] ??= issue.message;
  return errors;
}

/** The API's field errors on a 400 (zod's flatten(): { fieldErrors: { key: [message] } }). */
export function apiFieldErrors(error: unknown): Record<string, string> {
  const fields = (error as { detail?: { fieldErrors?: Record<string, unknown> } } | null)?.detail?.fieldErrors;
  if (!fields || typeof fields !== "object") return {};
  return Object.fromEntries(Object.entries(fields).flatMap(([key, messages]) => (Array.isArray(messages) && typeof messages[0] === "string" ? [[key, messages[0]]] : [])));
}

/* ── Billing details ───────────────────────────────────────────────────── */

export interface BillingForm {
  legalName: string;
  address: string;
  city: string;
  state: string;
  country: string;
  email: string;
  phone: string;
  taxKind: TaxKind;
  taxNumber: string;
  vatRate: string;
  /** A GST rate other than 18%, kept as saved: the form doesn't offer it. */
  gstRate: number | null;
  lutArn: string;
  pan: string;
  udyam: string;
  sac: string;
  upiId: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
  swift: string;
  iban: string;
  paymentLink: string;
  prefix: string;
}

export function billingForm(profile: BillingProfileInput | null, defaults: { country: string; email?: string | null }): BillingForm {
  const tax = profile?.tax;
  const pay = profile?.payment;
  const text = (value: string | null | undefined) => value ?? "";
  return {
    legalName: text(profile?.legalName),
    address: (profile?.addressLines ?? []).join("\n"),
    city: text(profile?.city),
    state: text(profile?.state),
    country: profile?.country ?? defaults.country,
    email: text(profile?.email ?? defaults.email),
    phone: text(profile?.phone),
    taxKind: tax?.kind ?? "none",
    taxNumber: text(tax?.number),
    vatRate: tax?.kind === "vat" && tax.ratePercent !== null ? String(tax.ratePercent) : "",
    gstRate: tax?.kind === "gst_in" ? tax.ratePercent : null,
    lutArn: text(tax?.lutArn),
    pan: text(profile?.pan),
    udyam: text(profile?.udyamNumber),
    sac: text(profile?.sacCode),
    upiId: text(pay?.upiId),
    bankName: text(pay?.bankName),
    accountName: text(pay?.accountName),
    accountNumber: text(pay?.accountNumber),
    ifsc: text(pay?.ifsc),
    swift: text(pay?.swift),
    iban: text(pay?.iban),
    paymentLink: text(pay?.paymentLink),
    prefix: profile?.invoicePrefix ?? "INV",
  };
}

/** The request for core's BillingProfileInputSchema; blank means not set, and hidden fields are left out. */
export function billingInput(form: BillingForm): BillingProfileInput {
  const india = form.country === "IN";
  const kind: TaxKind = form.taxKind === "gst_in" && !india ? "none" : form.taxKind === "vat" && india ? "none" : form.taxKind;
  const value = (text: string, shown = true) => (shown && text.trim() ? text.trim() : null);
  const rate = Number(form.vatRate.replace(",", "."));
  return {
    legalName: form.legalName.trim(),
    addressLines: form.address.split("\n").map((line) => line.trim()).filter(Boolean),
    city: value(form.city),
    state: value(form.state),
    country: form.country,
    email: value(form.email),
    phone: value(form.phone),
    tax: {
      kind,
      number: value(form.taxNumber, kind !== "none"),
      ratePercent: kind === "vat" ? (form.vatRate.trim() && Number.isFinite(rate) ? rate : null) : kind === "gst_in" ? form.gstRate : null,
      lutArn: value(form.lutArn, kind === "gst_in"),
    },
    pan: value(form.pan, india),
    udyamNumber: value(form.udyam, india),
    sacCode: value(form.sac, india),
    payment: {
      upiId: value(form.upiId, india),
      bankName: value(form.bankName),
      accountName: value(form.accountName),
      accountNumber: value(form.accountNumber),
      ifsc: value(form.ifsc, india),
      swift: value(form.swift),
      iban: value(form.iban, !india),
      paymentLink: value(form.paymentLink),
    },
    invoicePrefix: form.prefix.trim().toUpperCase(),
  };
}

/** A typed GSTIN fills what it already says: its state, and the PAN inside it. */
export function withGstin(form: BillingForm, typed: string): BillingForm {
  const number = typed.replace(/\s+/g, "").toUpperCase();
  return isValidGstin(number) ? { ...form, taxNumber: number, state: number.slice(0, 2), pan: number.slice(2, 12) } : { ...form, taxNumber: typed };
}

/* ── Bill to ───────────────────────────────────────────────────────────── */

export interface PartyForm {
  name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  taxNumber: string;
}

export function partyForm(party: InvoiceParty | null, defaults: { name: string; country: string }): PartyForm {
  return {
    name: party?.name ?? defaults.name,
    address: (party?.addressLines ?? []).join("\n"),
    city: party?.city ?? "",
    state: party?.state ?? "",
    country: party?.country ?? defaults.country,
    taxNumber: party?.taxNumber ?? "",
  };
}

export function partyInput(form: PartyForm): InvoiceParty {
  const value = (text: string) => text.trim() || null;
  return {
    name: form.name.trim(),
    addressLines: form.address.split("\n").map((line) => line.trim()).filter(Boolean),
    city: value(form.city),
    state: value(form.state),
    country: form.country,
    taxNumber: value(form.taxNumber.replace(/\s+/g, "").toUpperCase()),
  };
}
