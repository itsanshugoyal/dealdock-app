import { describe, expect, it } from "vitest";
import {
  formatMoneyCompact,
  formatMoneyExact,
  formatMoneyRange,
} from "../src/money";

const INR = { currency: "INR" as const };
const USD = { currency: "USD" as const };
const GBP = { currency: "GBP" as const };

describe("formatMoneyExact", () => {
  it("uses lakh grouping for en-IN", () => {
    expect(formatMoneyExact(3_20_000_00, INR)).toBe("₹3,20,000");
    expect(formatMoneyExact(1_20_00_000_00, INR)).toBe("₹1,20,00,000");
  });

  it("uses standard grouping for en-US", () => {
    expect(formatMoneyExact(120_000_00, USD)).toBe("$120,000");
  });

  it("keeps 2 decimals only for fractional amounts", () => {
    expect(formatMoneyExact(1050, USD)).toBe("$10.50");
    expect(formatMoneyExact(1000, USD)).toBe("$10");
  });

  it("rejects negative and non-integer minor units", () => {
    expect(() => formatMoneyExact(-1, INR)).toThrow(RangeError);
    expect(() => formatMoneyExact(10.5, INR)).toThrow(RangeError);
  });
});

describe("formatMoneyCompact", () => {
  it("formats INR with K/L/Cr", () => {
    expect(formatMoneyCompact(800_00, INR)).toBe("₹800");
    expect(formatMoneyCompact(80_000_00, INR)).toBe("₹80K");
    expect(formatMoneyCompact(3_20_000_00, INR)).toBe("₹3.2L");
    expect(formatMoneyCompact(1_20_00_000_00, INR)).toBe("₹1.2Cr");
  });

  it("drops trailing .0", () => {
    expect(formatMoneyCompact(2_00_000_00, INR)).toBe("₹2L");
    expect(formatMoneyCompact(1_000_00, USD)).toBe("$1K");
  });

  it("formats non-INR with K/M/B", () => {
    expect(formatMoneyCompact(4_200_00, USD)).toBe("$4.2K");
    expect(formatMoneyCompact(1_200_000_00, USD)).toBe("$1.2M");
    expect(formatMoneyCompact(3_100_00, GBP)).toBe("£3.1K");
  });

  it("respects explicit locale override on any currency", () => {
    // USD org that chose Indian grouping
    expect(formatMoneyCompact(3_20_000_00, { currency: "USD", locale: "en-IN" })).toBe(
      "$3.2L"
    );
  });
});

describe("formatMoneyRange", () => {
  it("formats estimate ranges", () => {
    expect(formatMoneyRange(2_00_000_00, 4_00_000_00, INR)).toBe("₹2L–₹4L");
    expect(formatMoneyRange(2_400_00, 5_000_00, USD)).toBe("$2.4K–$5K");
  });
});
