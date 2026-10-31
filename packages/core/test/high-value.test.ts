import { describe, expect, it } from "vitest";
import { BIG_ONE_DEFAULT_MINOR, highValueThresholdMinor } from "../src/high-value";
import { CURRENCY_CODES } from "../src/money";

const offer = (dealType: string, priceMinMinor: number | null, active = true) => ({ dealType, priceMinMinor, active });

describe("high-value threshold (Big ones)", () => {
  it("is the lowest active brand offer price", () => {
    const offers = [offer("brand", 90_000_00), offer("brand", 60_000_00), offer("brand", 10_000_00, false), offer("coaching", 1_000_00)];
    expect(highValueThresholdMinor("INR", offers)).toBe(60_000_00);
  });

  it("ignores unpriced, zero-priced, inactive and non-brand offers", () => {
    const offers = [offer("brand", null), offer("brand", 0), offer("brand", 5_00, false), offer("course", 2_00)];
    expect(highValueThresholdMinor("USD", offers)).toBe(1_000_00);
  });

  it("falls back to the per-currency default", () => {
    expect(highValueThresholdMinor("INR", [])).toBe(1_00_000_00);
    expect(highValueThresholdMinor("USD")).toBe(1_000_00);
    expect(highValueThresholdMinor("EUR", null)).toBe(1_000_00);
    expect(highValueThresholdMinor("GBP")).toBe(800_00);
    expect(highValueThresholdMinor("AED")).toBe(4_000_00);
  });

  it("has a positive integer default for every supported currency", () => {
    for (const currency of CURRENCY_CODES) {
      expect(Number.isSafeInteger(BIG_ONE_DEFAULT_MINOR[currency])).toBe(true);
      expect(BIG_ONE_DEFAULT_MINOR[currency]).toBeGreaterThan(0);
    }
  });
});
