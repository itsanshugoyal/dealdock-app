import { describe, expect, it } from "vitest";
import { exactLabelAccuracy } from "../evals/scoring";

describe("golden evaluation denominator", () => {
  it("counts abstaining on a known class as an error instead of inflating accuracy", () => {
    expect(exactLabelAccuracy([
      { c: { label: "brand_deal" }, predicted: "brand_deal" },
      { c: { label: "coaching_lead" }, predicted: "uncertain" },
      { c: { label: "spam" }, predicted: "uncertain" },
      { c: { label: "uncertain" }, predicted: "uncertain" },
    ])).toBe(0.5);
  });
  it("cannot pass an empty evaluation", () => expect(exactLabelAccuracy([])).toBe(0));
});
