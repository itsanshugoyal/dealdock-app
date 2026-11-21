import { z } from "zod";
import type { OfferAddOns } from "./api-types";

/**
 * Rate-card add-ons: the extras a brand pays for on top of an offer's fee.
 * One list drives the Offers form, the drafting prompt, the public rate card
 * and the "they asked about it" check, so every place names them the same way.
 */

export const OFFER_ADD_ONS = [
  // `hint` is a typical range, never advice (research checked 7 Nov 2026); `percent` computes it from the offer's price.
  // `missing` is how a draft flags it when a brand asks and no price is set.
  { key: "usagePerMonthMinor", label: "Usage rights", unit: "per month", hint: "Typical: 15–35% of your fee per 30 days (in India often about 30%).", percent: [15, 35],
    missing: "your usage-rights price per month",
    asked: /(?<![\p{L}])(?:usage(?: rights?)?|rights? to (?:use|run|repost)|repost(?:ing)?|re-?use|licen[cs](?:e|ing))(?![\p{L}])/iu },
  { key: "partnershipAdsPerMonthMinor", label: "Partnership ads", unit: "per month", hint: "Typical: 20–40% of your fee per 30 days (India quotes often 30–50%).", percent: [20, 40],
    missing: "your partnership-ads price per month",
    asked: /(?<![\p{L}])(?:white-?list\w*|partnership ads?|spark ads?|boost(?:ing|ed)?|dark posts?|paid ads?|ad rights|run (?:it |this |them )?(?:as|in) (?:an )?ads?|ads? (?:from|on|through) your (?:handle|account|page))(?![\p{L}])/iu },
  { key: "exclusivityPerMonthMinor", label: "Exclusivity", unit: "per month", hint: "Typical: 15–50% of your fee for 30 days, more for longer.", percent: [15, 50],
    missing: "your exclusivity price per month",
    asked: /(?<![\p{L}])(?:exclusiv\w*|non-?compete)(?![\p{L}])/iu },
  { key: "extraRevisionMinor", label: "Extra revision round", unit: null, hint: "Typical: 10–25% of your fee per round.", percent: [10, 25],
    missing: "your price for an extra revision round",
    asked: /(?<![\p{L}])(?:extra|additional|another|more|one more|third|second) (?:round of |rounds of )?(?:revisions?|edits?|changes)(?![\p{L}])|(?<![\p{L}])revision rounds?(?![\p{L}])/iu },
  { key: "rushMinor", label: "Rush delivery", unit: null, hint: "Typical: 25–50% of your fee (India 25–40%).", percent: [25, 50],
    missing: "your rush-delivery price",
    asked: /(?<![\p{L}])(?:rush|urgent(?:ly)?|express delivery|quick turnaround|tight (?:deadline|timeline)|faster delivery|within 24 ?(?:h|hrs?|hours?))(?![\p{L}])/iu },
  { key: "rawFootageMinor", label: "Raw footage", unit: null, hint: "Typical: 20–50% of your fee.", percent: [20, 50],
    missing: "your raw-footage price",
    asked: /(?<![\p{L}])(?:raw (?:footage|files?|videos?|clips?)|unedited (?:footage|files?|videos?|clips?)|b-?roll|source files?)(?![\p{L}])/iu },
] as const satisfies ReadonlyArray<{ key: keyof OfferAddOns; label: string; unit: string | null; hint: string; percent: readonly [number, number]; missing: string; asked: RegExp }>;
export type OfferAddOnKey = (typeof OFFER_ADD_ONS)[number]["key"];

const Price = z.number().int().nonnegative().safe().nullable();

/** Add-on prices as a request or a stored row holds them; a missing key means not set. */
export const OfferAddOnsSchema = z.object({
  usagePerMonthMinor: Price.optional(),
  partnershipAdsPerMonthMinor: Price.optional(),
  exclusivityPerMonthMinor: Price.optional(),
  extraRevisionMinor: Price.optional(),
  rushMinor: Price.optional(),
  rawFootageMinor: Price.optional(),
});

/** Every key present (null when not set), or null when none is set. Throws (zod) on an invalid price, so bad input is refused at the boundary. */
export function normalizeOfferAddOns(input: unknown): OfferAddOns | null {
  if (input === null || input === undefined) return null;
  const parsed = OfferAddOnsSchema.parse(input);
  const addOns = Object.fromEntries(OFFER_ADD_ONS.map(({ key }) => [key, parsed[key] ?? null])) as unknown as OfferAddOns;
  return OFFER_ADD_ONS.some(({ key }) => addOns[key] !== null) ? addOns : null;
}

/** The add-ons a message asks about ("can we whitelist it?", "what about usage rights?"), in OFFER_ADD_ONS order. */
export function addOnsAsked(text: string): OfferAddOnKey[] {
  return OFFER_ADD_ONS.filter((addOn) => addOn.asked.test(text)).map((addOn) => addOn.key);
}

/** The creator's price for an add-on: the first offer (in the order given) that sets it, else null. */
export function addOnPrice(offers: ReadonlyArray<{ dealType: string; addOns?: OfferAddOns | null }>, key: OfferAddOnKey): number | null {
  for (const offer of offers) {
    const price = offer.dealType === "brand" ? offer.addOns?.[key] : null;
    if (price !== null && price !== undefined) return price;
  }
  return null;
}

/** What a reply to a brand's message must flag: the add-ons it asks about that no offer prices ("your usage-rights price per month"). */
export function missingAddOnPrices(text: string, offers: ReadonlyArray<{ dealType: string; addOns?: OfferAddOns | null }>): string[] {
  return OFFER_ADD_ONS.filter((addOn) => addOn.asked.test(text) && addOnPrice(offers, addOn.key) === null).map((addOn) => addOn.missing);
}
