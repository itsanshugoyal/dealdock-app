import type { Offer } from "@prisma/client";
import { DomainError, type CurrencyCode, type OfferDto, type OfferInput } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { minorUnitsToNumber } from "../money";
import { requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";

/**
 * Offers & rate card (F3): private draft context and estimate seeds, never a
 * public page. Prices are org-currency minor units; the currency is the org's
 * frozen one, never caller-supplied.
 */

function toDto(row: Offer): OfferDto {
  return {
    id: row.id,
    igAccountId: row.igAccountId,
    name: row.name,
    dealType: row.dealType,
    priceMinMinor: row.priceMinMinor === null ? null : minorUnitsToNumber(row.priceMinMinor),
    priceMaxMinor: row.priceMaxMinor === null ? null : minorUnitsToNumber(row.priceMaxMinor),
    currencyCode: row.currencyCode as CurrencyCode,
    link: row.link,
    details: row.details,
    availability: row.availability,
    active: row.active,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function price(value: number | null | undefined): bigint | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new DomainError("offer_price_must_be_a_non_negative_safe_integer", 400), { statusCode: 400 });
  }
  return BigInt(value);
}

function assertRange(min: bigint | null, max: bigint | null) {
  if (min !== null && max !== null && min > max) {
    throw Object.assign(new DomainError("offer_price_min_exceeds_max", 400), { statusCode: 400 });
  }
}

export async function listOffers(orgId: OrgId): Promise<OfferDto[]> {
  const rows = await prisma.offer.findMany({ where: { orgId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.map(toDto);
}

export async function createOffer(
  orgId: OrgId,
  seatId: string,
  input: Pick<OfferInput, "name" | "dealType"> & Partial<OfferInput>,
): Promise<OfferDto> {
  await requireSeatInOrg(orgId, seatId);
  // No account means a workspace-wide offer.
  if (input.igAccountId) await requireIgAccountInOrg(orgId, input.igAccountId);
  const priceMinMinor = price(input.priceMinMinor) ?? null;
  const priceMaxMinor = price(input.priceMaxMinor) ?? null;
  assertRange(priceMinMinor, priceMaxMinor);
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { currencyCode: true } });
    if (!org) throw new DomainError("org_not_found", 404);
    const last = await tx.offer.aggregate({ where: { orgId }, _max: { sortOrder: true } });
    const row = await tx.offer.create({
      data: {
        orgId,
        igAccountId: input.igAccountId ?? null,
        name: input.name,
        dealType: input.dealType,
        priceMinMinor,
        priceMaxMinor,
        currencyCode: org.currencyCode,
        link: input.link ?? null,
        details: input.details ?? null,
        availability: input.availability ?? null,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
      },
    });
    await writeAudit(tx, {
      orgId, seatId, action: "offer.created", entityType: "offer", entityId: row.id, detail: { name: row.name, dealType: row.dealType },
    });
    return toDto(row);
  });
}

export async function updateOffer(orgId: OrgId, seatId: string, offerId: string, patch: Partial<OfferInput>): Promise<OfferDto> {
  await requireSeatInOrg(orgId, seatId);
  if (patch.igAccountId) await requireIgAccountInOrg(orgId, patch.igAccountId);
  return prisma.$transaction(async (tx) => {
    const current = await tx.offer.findFirst({ where: { id: offerId, orgId } });
    if (!current) throw new DomainError("offer_not_in_org", 404);
    const priceMinMinor = price(patch.priceMinMinor);
    const priceMaxMinor = price(patch.priceMaxMinor);
    // Validate the range the row will actually hold after a partial update.
    assertRange(priceMinMinor === undefined ? current.priceMinMinor : priceMinMinor, priceMaxMinor === undefined ? current.priceMaxMinor : priceMaxMinor);
    const row = await tx.offer.update({
      where: { id: current.id },
      data: {
        ...(patch.igAccountId !== undefined ? { igAccountId: patch.igAccountId } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.dealType !== undefined ? { dealType: patch.dealType } : {}),
        ...(priceMinMinor !== undefined ? { priceMinMinor } : {}),
        ...(priceMaxMinor !== undefined ? { priceMaxMinor } : {}),
        ...(patch.link !== undefined ? { link: patch.link } : {}),
        ...(patch.details !== undefined ? { details: patch.details } : {}),
        ...(patch.availability !== undefined ? { availability: patch.availability } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      },
    });
    await writeAudit(tx, {
      orgId, seatId, action: "offer.updated", entityType: "offer", entityId: row.id, detail: { fields: Object.keys(patch) },
    });
    return toDto(row);
  });
}

export async function deleteOffer(orgId: OrgId, seatId: string, offerId: string): Promise<void> {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const current = await tx.offer.findFirst({ where: { id: offerId, orgId }, select: { id: true, name: true } });
    if (!current) throw new DomainError("offer_not_in_org", 404);
    await tx.offer.delete({ where: { id: current.id } });
    await writeAudit(tx, {
      orgId, seatId, action: "offer.deleted", entityType: "offer", entityId: current.id, detail: { name: current.name },
    });
  });
}
