import { DomainError } from "@dealdock/core";
import { zonedMonthKey } from "./zoned-time";

/**
 * Money crosses the repository boundary as a JavaScript number, so reject
 * values that would lose a paise/cent while converting from PostgreSQL BIGINT.
 */
export function requireMinorUnits(value: number, field = "amountMinor"): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError(`${field}_must_be_a_positive_safe_integer`, 400);
  }
  return BigInt(value);
}

export function minorUnitsToNumber(value: bigint, field = "amountMinor"): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new Error(`${field}_exceeds_javascript_safe_integer`);
  }
  return numberValue;
}

// Month keys live in zoned-time.ts (one cached formatter per zone); these are the old names.
export { zonedMonthKey as monthKeyInTimeZone } from "./zoned-time";

export function currentMonthKeyInTimeZone(timeZone: string, now = new Date()): string {
  return zonedMonthKey(now, timeZone);
}

/** Reject preferences that would make every ledger/dashboard read fail. */
export function validateRegionPreferences(input: { locale?: string; timezone?: string }) {
  try {
    new Intl.DateTimeFormat(input.locale ?? "en-US", input.timezone === undefined ? {} : { timeZone: input.timezone }).format(0);
  } catch {
    throw Object.assign(new Error("Enter a valid language tag and time zone, such as en-IN and Asia/Kolkata."), { statusCode: 400 });
  }
}
