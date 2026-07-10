import { z } from "zod";

/**
 * Money formatting — the single source of formatting truth (PLAN.md risk #12:
 * currency/locale bugs erode trust, so NO ad-hoc formatting anywhere else).
 *
 * Rules (DESIGN.md §2.2):
 *  - amounts are integer minor units (paise/cents/fils — all 100:1 for supported currencies)
 *  - org locale decides grouping: en-IN → lakh/crore (₹3,20,000 · ₹3.2L · ₹1.2Cr),
 *    everything else → standard (K/M/B)
 *  - creator-facing UI shows symbols, never ISO codes
 */

export const CURRENCY_CODES = ["INR", "USD", "GBP", "EUR", "AED"] as const;
export const CurrencyCode = z.enum(CURRENCY_CODES);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** Minor units per major unit — all supported currencies are 100:1. */
export const MINOR_PER_MAJOR = 100;

export const CURRENCY_SYMBOL: Record<CurrencyCode, string> = {
  INR: "₹",
  USD: "$",
  GBP: "£",
  EUR: "€",
  AED: "AED ",
};

/** Default UI locale per currency (org can override locale independently). */
export const DEFAULT_LOCALE: Record<CurrencyCode, string> = {
  INR: "en-IN",
  USD: "en-US",
  GBP: "en-GB",
  EUR: "en-IE",
  AED: "en-AE",
};

export interface MoneyContext {
  currency: CurrencyCode;
  /** BCP-47, e.g. "en-IN". Falls back to the currency's default. */
  locale?: string;
}

function isIndianGrouping(ctx: MoneyContext): boolean {
  return (ctx.locale ?? DEFAULT_LOCALE[ctx.currency]).toLowerCase() === "en-in";
}

function trimTrailingZero(n: number): string {
  // 3.0 → "3", 3.2 → "3.2"
  const fixed = n.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * Exact display: ledger rows, exports, close-deal confirmation.
 * en-IN → "₹3,20,000" (lakh grouping via Intl); others → "$120,000".
 * Whole amounts drop decimals; fractional amounts keep 2.
 */
export function formatMoneyExact(minor: number, ctx: MoneyContext): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new RangeError(`minor units must be a non-negative integer, got ${minor}`);
  }
  const locale = ctx.locale ?? DEFAULT_LOCALE[ctx.currency];
  const major = minor / MINOR_PER_MAJOR;
  const isWhole = minor % MINOR_PER_MAJOR === 0;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  }).format(major);
  return `${CURRENCY_SYMBOL[ctx.currency]}${formatted}`;
}

/**
 * Compact display: inbox rows, dashboard tiles, notifications.
 * en-IN → ₹80K / ₹3.2L / ₹1.2Cr; others → $800 / $4.2K / $1.2M / $2B.
 * Deterministic (no Intl compact — ICU output varies across runtimes).
 */
export function formatMoneyCompact(minor: number, ctx: MoneyContext): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new RangeError(`minor units must be a non-negative integer, got ${minor}`);
  }
  const symbol = CURRENCY_SYMBOL[ctx.currency];
  const major = minor / MINOR_PER_MAJOR;

  if (isIndianGrouping(ctx)) {
    if (major >= 1_00_00_000) return `${symbol}${trimTrailingZero(major / 1_00_00_000)}Cr`;
    if (major >= 1_00_000) return `${symbol}${trimTrailingZero(major / 1_00_000)}L`;
    if (major >= 1_000) return `${symbol}${trimTrailingZero(major / 1_000)}K`;
    return `${symbol}${Math.round(major)}`;
  }

  if (major >= 1_000_000_000) return `${symbol}${trimTrailingZero(major / 1_000_000_000)}B`;
  if (major >= 1_000_000) return `${symbol}${trimTrailingZero(major / 1_000_000)}M`;
  if (major >= 1_000) return `${symbol}${trimTrailingZero(major / 1_000)}K`;
  return `${symbol}${Math.round(major)}`;
}

/** Range display for value estimates: "₹2L–₹4L", "$2.4K–$5K". */
export function formatMoneyRange(
  minMinor: number,
  maxMinor: number,
  ctx: MoneyContext
): string {
  return `${formatMoneyCompact(minMinor, ctx)}–${formatMoneyCompact(maxMinor, ctx)}`;
}
