import { isoWeekKey, zonedParts } from "./zoned-time";

/**
 * Pure scheduling rules shared by the inbox/thread read models and the worker
 * schedulers, so "follow-up due" means the same thing on every surface. The
 * nudge clock itself is core's, which the web demo store uses too.
 */

export { isNudgeDue, nudgeDueAt, type NudgeClock } from "@dealdock/core";

/** Pushes go out 08:00–22:59 in the org's timezone (PRD §6.8 quiet hours). */
export function isQuietHour(localHour: number): boolean {
  return localHour < 8 || localHour >= 23;
}

/**
 * The weekly digest is due from Monday 09:00 local for the rest of that ISO
 * week, but only inside push hours: a slot missed or blocked by quiet hours
 * is deferred to the next allowed tick, never dropped. The caller sends at
 * most once per returned isoWeek.
 */
export function weeklyDigestSlot(now: Date, timeZone: string): { isoWeek: string } | null {
  const local = zonedParts(now, timeZone);
  if (isQuietHour(local.hour)) return null;
  if (local.weekday === 1 && local.hour < 9) return null;
  return { isoWeek: isoWeekKey(now, timeZone) };
}
