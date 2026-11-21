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
  if (!Number.isSafeInteger(minor) || minor < 0) {
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
 * Documents (invoice PDFs): always two decimals, so a column of amounts lines
 * up — "₹61,950.00". BigInt division keeps it exact for any safe amount.
 */
export function formatMoneyFixed(minor: number, ctx: MoneyContext): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError(`minor units must be a non-negative integer, got ${minor}`);
  }
  const value = BigInt(minor);
  const format = new Intl.NumberFormat(ctx.locale ?? DEFAULT_LOCALE[ctx.currency]);
  const decimal = format.formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
  return `${CURRENCY_SYMBOL[ctx.currency]}${format.format(value / 100n)}${decimal}${String(value % 100n).padStart(2, "0")}`;
}

/**
 * Compact display: inbox rows, dashboard tiles, notifications.
 * en-IN → ₹80K / ₹3.2L / ₹1.2Cr; others → $800 / $4.2K / $1.2M / $2B.
 * Deterministic (no Intl compact — ICU output varies across runtimes).
 */
export function formatMoneyCompact(minor: number, ctx: MoneyContext): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
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

/** ISO 4217 currencies without minor units, and those with three; every other currency has two. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** Digits after the decimal point in a currency's major unit (2 for INR, 0 for JPY, 3 for KWD). */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2;
}

/**
 * A major-unit amount ("49.99", or a JSON number) in minor units of its
 * currency, without float arithmetic: the decimal digits are shifted as text
 * and anything past the currency's precision rounds half to even. Null for a
 * negative, malformed or unsafe amount, or a currency code that isn't three letters.
 */
export function majorToMinor(amount: number | string, currency: string): number | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  let text: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) return null;
    // String() gives the shortest form that reads back as this number ("49.99"); tiny values come as 1e-7.
    text = /e/i.test(String(amount)) ? amount.toFixed(20) : String(amount);
  } else {
    text = amount.trim();
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || text.length > 40) return null;
  const exponent = currencyExponent(currency);
  const fraction = match[2] ?? "";
  const kept = fraction.slice(0, exponent).padEnd(exponent, "0");
  const rest = fraction.slice(exponent).replace(/0+$/, "");
  let minor = BigInt(`${match[1]}${kept}`);
  // Round half to even: up past the half, and at exactly half only when that makes the last digit even.
  if (rest && (rest[0]! > "5" || (rest[0] === "5" && (rest.length > 1 || minor % 2n === 1n)))) minor += 1n;
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}
