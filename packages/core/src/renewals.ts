import type { DealDto } from "./api-types";
import { isDealOpen } from "./deals";

/**
 * Renewal prompts: which brands to pitch again. Per creator account and brand,
 * the latest deal must be a paid brand deal, paid 60 or more days ago and
 * within the last 365, with no open deal beside it and no "Not now" or pitch
 * yet. From 1 September to 15 October, when brands set their festive
 * (October–December) budgets, 30 days is enough. Days are calendar days in the
 * org's time zone, so a payment late on the 3rd counts from the 3rd there.
 */

export const RENEWAL_AFTER_DAYS = 60;
export const FESTIVE_RENEWAL_AFTER_DAYS = 30;
export const RENEWAL_LOOKBACK_DAYS = 365;

const DAY_MS = 86_400_000;

export type RenewalDeal = Pick<
  DealDto,
  "id" | "igAccountId" | "counterpartyHandle" | "dealType" | "stage" | "amountMinor" | "agreedAt" | "createdAt" | "paidAt" | "renewalHandledAt"
>;

/** A calendar date in the zone, and its day number (days since 1970-01-01) for counting days between dates. */
function calendarDay(at: Date | number | string, timeZone: string): { month: number; day: number; index: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  const part = (type: "year" | "month" | "day") => Number(parts.find((item) => item.type === type)?.value);
  return { month: part("month"), day: part("day"), index: Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS };
}

/** 1 September to 15 October in the org's zone: brands are setting festive budgets, so pitch sooner. */
export function isFestivePitchSeason(now: Date | number, timeZone: string): boolean {
  const { month, day } = calendarDay(now, timeZone);
  return month === 9 || (month === 10 && day <= 15);
}

/** The same brand, however the handle was typed ("@GlowCo " and "glowco" match). */
function brandKey(deal: Pick<RenewalDeal, "igAccountId" | "counterpartyHandle">): string {
  return `${deal.igAccountId}\u0000${deal.counterpartyHandle.trim().replace(/^@/, "").toLowerCase()}`;
}

const ms = (at: string) => Date.parse(at);

/** The deal agreed last (then recorded last) is the latest with that brand. */
function later(a: RenewalDeal, b: RenewalDeal): boolean {
  return ms(a.agreedAt) - ms(b.agreedAt) > 0 || (ms(a.agreedAt) === ms(b.agreedAt) && ms(a.createdAt) > ms(b.createdAt));
}

/** Brands to pitch again, biggest past deal first: one per creator account and brand. */
export function renewalsDue<T extends RenewalDeal>(deals: readonly T[], now: Date | number, timeZone: string): Array<{ deal: T; festive: boolean; daysSincePaid: number }> {
  const today = calendarDay(now, timeZone).index;
  const festive = isFestivePitchSeason(now, timeZone);
  const after = festive ? FESTIVE_RENEWAL_AFTER_DAYS : RENEWAL_AFTER_DAYS;
  const brands = new Map<string, T[]>();
  for (const deal of deals) {
    const key = brandKey(deal);
    brands.set(key, [...(brands.get(key) ?? []), deal]);
  }
  const due: Array<{ deal: T; festive: boolean; daysSincePaid: number }> = [];
  for (const group of brands.values()) {
    if (group.some(isDealOpen)) continue;
    const latest = group.reduce((best, deal) => (later(deal, best) ? deal : best));
    if (latest.stage !== "paid" || latest.dealType !== "brand" || !latest.paidAt || latest.renewalHandledAt) continue;
    const days = today - calendarDay(latest.paidAt, timeZone).index;
    if (days >= after && days <= RENEWAL_LOOKBACK_DAYS) due.push({ deal: latest, festive, daysSincePaid: days });
  }
  return due.sort((a, b) => b.deal.amountMinor - a.deal.amountMinor || b.daysSincePaid - a.daysSincePaid);
}
