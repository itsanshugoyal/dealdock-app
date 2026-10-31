import { describe, expect, it } from 'vitest';
import { MinorUnits, ValueRange } from '../src/index';
import { formatMoneyExact, formatMoneyCompact } from '../src/money';

describe('money integrity at public boundaries', () => {
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe minor units %s', (value) => {
    expect(MinorUnits.safeParse(value).success).toBe(false);
    expect(() => formatMoneyExact(value, { currency: 'INR' })).toThrow();
    expect(() => formatMoneyCompact(value, { currency: 'INR' })).toThrow();
  });

  it('rejects reversed value estimates and accepts zero and exact minor units', () => {
    expect(ValueRange.safeParse({ minMinor: 200, maxMinor: 100 }).success).toBe(false);
    expect(ValueRange.parse({ minMinor: 0, maxMinor: 12345 })).toEqual({ minMinor: 0, maxMinor: 12345 });
    expect(formatMoneyExact(2200050, { currency: 'INR', locale: 'en-IN' })).toBe('₹22,000.50');
  });
});
