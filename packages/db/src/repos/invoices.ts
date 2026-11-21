import type { Prisma } from "@prisma/client";
import { DomainError, type BillingProfileDto, type BillingProfileInput, type BillingProfileResponse, type InvoiceDto } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { creatorAccountOf, requireSeatInOrg } from "../seat-scope";
import { INVOICE_SELECT, toBillingProfileDto, toInvoiceDto } from "../invoice-rows";

/**
 * Billing profiles (the legal identity on invoices) and invoice reads.
 * Issuing, voiding and paying invoices change their deal, so they live with
 * the deal's money in ./deals.
 */

/**
 * A creator account's billing profile, else the workspace's (inherited). An
 * email inbox reads its creator's. `profile` is null until one is set up.
 */
export async function getBillingProfile(orgId: OrgId, igAccountId?: string): Promise<BillingProfileResponse> {
  const creator = igAccountId === undefined ? null : await creatorAccountOf(orgId, igAccountId);
  const [org, rows] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }),
    prisma.billingProfile.findMany({ where: { orgId, OR: [{ igAccountId: null }, ...(creator ? [{ igAccountId: creator }] : [])] } }),
  ]);
  if (!org) throw new DomainError("org_not_found", 404);
  const own = creator ? rows.find((row) => row.igAccountId === creator) : undefined;
  const chosen = own ?? rows.find((row) => row.igAccountId === null);
  return { profile: chosen ? toBillingProfileDto(chosen, org.timezone) : null, inherited: creator !== null && !own && chosen !== undefined };
}

/**
 * Save the workspace profile, or (Roster only) a creator account's own. Each
 * profile needs its own prefix: invoice numbers are unique per workspace.
 * The numbering carries on across edits.
 */
export async function upsertBillingProfile(orgId: OrgId, seatId: string, igAccountId: string | undefined, input: BillingProfileInput): Promise<BillingProfileDto> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    // The workspace row has no unique key to upsert on: one writer per org at a time.
    const [org] = await tx.$queryRaw<Array<{ tier: string; timezone: string }>>`
      SELECT "tier", "timezone" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`;
    if (!org) throw new DomainError("org_not_found", 404);
    const scope = igAccountId === undefined ? null : await creatorAccountOf(orgId, igAccountId, tx);
    if (scope !== null && org.tier !== "roster") throw new DomainError("roster_plan_required", 403);

    const samePrefix = await tx.billingProfile.findMany({ where: { orgId, invoicePrefix: input.invoicePrefix }, select: { igAccountId: true } });
    if (samePrefix.some((profile) => profile.igAccountId !== scope)) throw new DomainError("invoice_prefix_in_use", 409);

    const data = { ...input, tax: input.tax as unknown as Prisma.InputJsonValue, payment: input.payment as unknown as Prisma.InputJsonValue };
    const existing = await tx.billingProfile.findFirst({ where: { orgId, igAccountId: scope }, select: { id: true } });
    const row = existing
      ? await tx.billingProfile.update({ where: { id: existing.id }, data })
      : await tx.billingProfile.create({ data: { ...data, orgId, igAccountId: scope } });
    // Bank and tax numbers stay out of the audit log.
    await writeAudit(tx, { orgId, seatId, action: "billing.updated", entityType: "billing_profile", entityId: row.id, detail: { igAccountId: scope, created: !existing } });
    return toBillingProfileDto(row, org.timezone);
  });
}

/** A live deal's invoices, oldest first (void ones included). */
export async function listDealInvoices(orgId: OrgId, dealId: string): Promise<InvoiceDto[]> {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, orgId, deletedAt: null },
    select: { invoices: { select: INVOICE_SELECT, orderBy: [{ issuedAt: "asc" }, { id: "asc" }] } },
  });
  if (!deal) throw new DomainError("deal not in org", 404);
  return deal.invoices.map(toInvoiceDto);
}

/** One invoice of a live deal, or null when it isn't this org's. */
export async function getInvoice(orgId: OrgId, invoiceId: string): Promise<InvoiceDto | null> {
  const row = await prisma.invoice.findFirst({ where: { id: invoiceId, orgId, deal: { deletedAt: null } }, select: INVOICE_SELECT });
  return row ? toInvoiceDto(row) : null;
}

/**
 * SYSTEM CONTEXT: the invoice behind a signed PDF link (the signature is the
 * capability, as for audio). Void invoices and deleted deals are never served.
 */
export async function getInvoiceForDelivery(invoiceId: string): Promise<InvoiceDto | null> {
  const row = await prisma.invoice.findFirst({ where: { id: invoiceId, status: { not: "void" }, deal: { deletedAt: null } }, select: INVOICE_SELECT });
  return row ? toInvoiceDto(row) : null;
}
