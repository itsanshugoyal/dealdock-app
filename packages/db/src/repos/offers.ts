import { Prisma, type Offer } from "@prisma/client";
import { DomainError, normalizeOfferAddOns, type CurrencyCode, type OfferAddOns, type OfferDto, type OfferInput, type PublicRateCard, type RateCardLinkResponse } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { minorUnitsToNumber } from "../money";
import { requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";

/**
 * Offers & rate card (F3): draft context and estimate seeds. Prices are
 * org-currency minor units; the currency is the org's frozen one, never
 * caller-supplied. The only public view is a creator's rate-card link.
 */

/** Stored add-ons as the API shows them; a row that no longer validates reads as none set. */
export function storedAddOns(value: Prisma.JsonValue | null): OfferAddOns | null {
  try {
    return normalizeOfferAddOns(value);
  } catch {
    return null;
  }
}

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
    addOns: row.dealType === "brand" ? storedAddOns(row.addOns) : null,
    active: row.active,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The add-ons column a write stores: only brand offers carry add-ons, so
 * prices on any other type are refused and a type change away from brand
 * clears them. Undefined leaves the column alone.
 */
function addOnsColumn(input: unknown, dealType: string, typeChanged: boolean): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  let addOns: OfferAddOns | null | undefined;
  try {
    addOns = input === undefined ? undefined : normalizeOfferAddOns(input);
  } catch {
    throw new DomainError("offer_add_on_price_must_be_a_non_negative_safe_integer", 400);
  }
  if (addOns && dealType !== "brand") throw new DomainError("offer_add_ons_are_for_brand_offers", 400);
  if (addOns === undefined) return typeChanged && dealType !== "brand" ? Prisma.DbNull : undefined;
  return addOns === null ? Prisma.DbNull : (addOns as unknown as Prisma.InputJsonValue);
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
  const addOns = addOnsColumn(input.addOns, input.dealType, false);
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
        ...(addOns !== undefined ? { addOns } : {}),
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
    const dealType = patch.dealType ?? current.dealType;
    const addOns = addOnsColumn(patch.addOns, dealType, dealType !== current.dealType);
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
        ...(addOns !== undefined ? { addOns } : {}),
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

/**
 * Turn a creator account's rate-card link on with `token` (a new token ends
 * the old link) or off with null. Only a creator account has one, never an
 * email inbox.
 */
export async function setRateCardToken(orgId: OrgId, seatId: string, igAccountId: string, token: string | null): Promise<RateCardLinkResponse> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const account = await tx.igAccount.findFirst({ where: { id: igAccountId, orgId }, select: { id: true, platform: true, ownerAccountId: true } });
    if (!account) throw new DomainError("ig_account_not_in_org", 404);
    if (account.platform === "email" || account.ownerAccountId !== null) throw new DomainError("creator_account_required", 400);
    await tx.igAccount.update({ where: { id: account.id }, data: { rateCardToken: token } });
    // The token itself is a capability: it never enters the audit log.
    await writeAudit(tx, {
      orgId, seatId, action: token ? "rate_card.link_created" : "rate_card.link_turned_off", entityType: "ig_account", entityId: account.id,
    });
    return { igAccountId: account.id, token };
  });
}

/**
 * SYSTEM CONTEXT: a rate-card link (the unguessable token is the
 * capability). Public data only: the creator's handle, the currency and the
 * active offers that apply to that creator, theirs and workspace-wide. Null
 * when the link is off, rotated or the account was disconnected.
 */
export async function getPublicRateCard(token: string): Promise<PublicRateCard | null> {
  const account = await prisma.igAccount.findUnique({
    where: { rateCardToken: token },
    select: { id: true, orgId: true, handle: true, status: true, org: { select: { currencyCode: true, locale: true } } },
  });
  if (!account || account.status === "disconnected") return null;
  const offers = await prisma.offer.findMany({
    where: { orgId: account.orgId, active: true, currencyCode: account.org.currencyCode, OR: [{ igAccountId: account.id }, { igAccountId: null }] },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: 50,
  });
  return {
    handle: account.handle,
    currencyCode: account.org.currencyCode as CurrencyCode,
    locale: account.org.locale,
    offers: offers.map((row) => {
      const offer = toDto(row);
      return {
        name: offer.name, dealType: offer.dealType, priceMinMinor: offer.priceMinMinor, priceMaxMinor: offer.priceMaxMinor,
        details: offer.details, link: offer.link, availability: offer.availability, addOns: offer.addOns ?? null,
      };
    }),
  };
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
