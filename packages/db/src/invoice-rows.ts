import type { BillingProfile, Prisma } from "@prisma/client";
import {
  DomainError,
  formatInvoiceNumber,
  invoiceDeclaration,
  invoiceNumberYear,
  invoiceTitle,
  type BillingProfileDto,
  type BillingProfileInput,
  type InvoiceDto,
  type InvoiceLine,
  type InvoiceParty,
  type InvoiceSupplier,
  type InvoiceTaxLine,
  type PaymentDetails,
  type TaxRegistration,
} from "@dealdock/core";
import { minorUnitsToNumber } from "./money";

/**
 * Row ↔ DTO mapping for invoices and billing profiles, shared by the deal and
 * invoice repositories. Internal: not exported from the package. The JSON
 * columns were validated by core's schemas before they were written.
 */

export const INVOICE_SELECT = {
  id: true,
  dealId: true,
  kind: true,
  number: true,
  status: true,
  issuedAt: true,
  dueAt: true,
  currencyCode: true,
  supplier: true,
  billTo: true,
  lines: true,
  taxes: true,
  subtotalMinor: true,
  taxMinor: true,
  totalMinor: true,
  supplyType: true,
  placeOfSupply: true,
  notes: true,
  paidAt: true,
  receivedMinor: true,
  tdsMinor: true,
  voidedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.InvoiceSelect;
export type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

const iso = (date: Date | null) => (date === null ? null : date.toISOString());
const minor = (value: bigint | null, field: string) => (value === null ? null : minorUnitsToNumber(value, field));

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  const supplier = row.supplier as unknown as InvoiceSupplier;
  return {
    id: row.id,
    dealId: row.dealId,
    kind: row.kind,
    number: row.number,
    status: row.status,
    title: invoiceTitle(row.supplyType, supplier.tax.kind),
    issuedAt: row.issuedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    currencyCode: row.currencyCode,
    supplier,
    billTo: row.billTo as unknown as InvoiceParty,
    lines: row.lines as unknown as InvoiceLine[],
    subtotalMinor: minorUnitsToNumber(row.subtotalMinor, "subtotalMinor"),
    taxes: row.taxes as unknown as InvoiceTaxLine[],
    taxMinor: minorUnitsToNumber(row.taxMinor, "taxMinor"),
    totalMinor: minorUnitsToNumber(row.totalMinor, "totalMinor"),
    supplyType: row.supplyType,
    placeOfSupply: row.placeOfSupply,
    declaration: invoiceDeclaration(row.supplyType, supplier.tax.lutArn),
    notes: row.notes,
    paidAt: iso(row.paidAt),
    receivedMinor: minor(row.receivedMinor, "receivedMinor"),
    tdsMinor: minor(row.tdsMinor, "tdsMinor"),
    voidedAt: iso(row.voidedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function profileFields(row: BillingProfile): Omit<BillingProfileInput, "invoicePrefix"> {
  return {
    legalName: row.legalName,
    addressLines: row.addressLines,
    city: row.city,
    state: row.state,
    country: row.country,
    email: row.email,
    phone: row.phone,
    tax: row.tax as unknown as TaxRegistration,
    pan: row.pan,
    udyamNumber: row.udyamNumber,
    sacCode: row.sacCode,
    payment: row.payment as unknown as PaymentDetails,
  };
}

/** What an invoice prints about its issuer: the profile without its numbering, with the calendar and number style it is issued in. */
export function supplierOf(row: BillingProfile, org: { timezone: string; locale: string }): InvoiceSupplier {
  return { ...profileFields(row), timezone: org.timezone, locale: org.locale };
}

/** The year and sequence the profile's next invoice gets: a new (financial) year starts again at 1. */
export function nextNumberOf(row: BillingProfile, timezone: string, now: Date) {
  const year = invoiceNumberYear(now, timezone, row.country);
  const sequence = row.numberYear === year ? row.nextNumber : 1;
  return { year, sequence, number: formatInvoiceNumber(row.invoicePrefix, year, sequence) };
}

export function toBillingProfileDto(row: BillingProfile, timezone: string, now = new Date()): BillingProfileDto {
  return {
    ...profileFields(row),
    invoicePrefix: row.invoicePrefix,
    igAccountId: row.igAccountId,
    nextInvoiceNumber: nextNumberOf(row, timezone, now).number,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The billing profile an invoice for this creator account is issued from (its
 * own on Roster, else the workspace's), locked so its number sequence moves
 * one invoice at a time.
 */
export async function lockIssuerProfile(tx: Prisma.TransactionClient, orgId: string, creatorAccountId: string): Promise<BillingProfile> {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BillingProfile"
    WHERE "orgId" = ${orgId} AND ("igAccountId" = ${creatorAccountId} OR "igAccountId" IS NULL)
    ORDER BY "igAccountId" NULLS LAST
    LIMIT 1
    FOR UPDATE`;
  if (!locked) throw new DomainError("billing_profile_required", 409);
  return tx.billingProfile.findUniqueOrThrow({ where: { id: locked.id } });
}
