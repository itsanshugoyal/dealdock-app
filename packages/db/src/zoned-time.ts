/**
 * Org-timezone calendar math (month starts and keys, ISO weeks, local hour)
 * for the ledger, insights, voice metrics, the weekly digest and roster
 * rollups. Pure: Intl's tz database handles DST, so a "month" or "Monday
 * 09:00" is always the creator's own. One cached formatter per zone.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 1 = Monday … 7 = Sunday (ISO)
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
  const weekday = WEEKDAY[parts.weekday ?? ""];
  if (!weekday) throw new Error("invalid_organization_timezone");
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday,
  };
}

/** How far the zone's wall clock is ahead of UTC at this instant. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSeconds;
}

/**
 * The instant a local wall-clock time occurs in `timeZone`. Out-of-range
 * fields roll over like Date.UTC (month 0 = previous December, day 0 = the
 * previous month's last day), which keeps calendar arithmetic trivial.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = wall - offsetMs(new Date(wall), timeZone);
  // Second pass settles instants whose first guess landed across a DST change.
  return new Date(wall - offsetMs(new Date(guess), timeZone));
}

export function startOfZonedMonth(date: Date, timeZone: string, monthsBack = 0): Date {
  const p = zonedParts(date, timeZone);
  return zonedTimeToUtc(p.year, p.month - monthsBack, 1, 0, 0, timeZone);
}

/** Monday 00:00 local of the ISO week containing `date` (optionally weeks earlier). */
export function startOfZonedWeek(date: Date, timeZone: string, weeksBack = 0): Date {
  const p = zonedParts(date, timeZone);
  return zonedTimeToUtc(p.year, p.month, p.day - (p.weekday - 1) - 7 * weeksBack, 0, 0, timeZone);
}

/** "2026-W44": the ISO-8601 week of the local calendar date. */
export function isoWeekKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  // ISO weeks belong to the year of their Thursday.
  const thursday = new Date(Date.UTC(p.year, p.month - 1, p.day + 4 - p.weekday));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** "YYYY-MM": the local calendar month of `date`, so a close-out at 01:00 on the 1st is never last month's. */
export function zonedMonthKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

export function daysInZonedMonth(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
}

/** "YYYY-MM" keys for the `count` local months ending with the one containing `date`, oldest first. */
export function zonedMonthKeys(date: Date, timeZone: string, count: number): string[] {
  const p = zonedParts(date, timeZone);
  return Array.from({ length: count }, (_, i) => {
    const first = new Date(Date.UTC(p.year, p.month - 1 - (count - 1 - i), 1));
    return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}
