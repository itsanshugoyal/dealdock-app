import type { CurrencyCode } from "./money";

/**
 * "Big ones" (DESIGN §5.4) and the high-value push threshold: the lowest
 * price of an active brand offer, else a per-currency default. One rule so
 * the inbox grouping, the command palette and push notifications agree.
 */

/** Default threshold per currency, in minor units, when no brand offer sets the bar. */
export const BIG_ONE_DEFAULT_MINOR: Readonly<Record<CurrencyCode, number>> = {
  INR: 1_00_000_00,
  USD: 1_000_00,
  EUR: 1_000_00,
  GBP: 800_00,
  AED: 4_000_00,
};

/** The offer fields the threshold reads (OfferDto and the offer repository rows both fit). */
export interface ThresholdOffer {
  dealType: string;
  priceMinMinor: number | null;
  active: boolean;
}

export function highValueThresholdMinor(currency: CurrencyCode, offers?: readonly ThresholdOffer[] | null): number {
  const brandPrices = (offers ?? [])
    .filter((offer) => offer.active && offer.dealType === "brand" && typeof offer.priceMinMinor === "number" && offer.priceMinMinor > 0)
    .map((offer) => offer.priceMinMinor as number);
  return brandPrices.length ? Math.min(...brandPrices) : BIG_ONE_DEFAULT_MINOR[currency];
}
