import { describe, expect, it } from "vitest";
import { creatorBusinessContext } from "../src/repos/creator-context";

const workspace = {
  businessSummary: "Talent agency for fitness creators",
  typicalBrandDealMinor: { min: 50_000_00, max: 1_50_000_00 },
  typicalCoachingMinor: { min: 24_000_00, max: 24_000_00 },
  creators: {
    "ig-diya": { businessSummary: "Diya: dance creator", typicalBrandDealMinor: { min: 80_000_00, max: 2_00_000_00 }, typicalCoachingMinor: null },
  },
};

describe("creatorBusinessContext", () => {
  it("lets a creator's own answers win key by key", () => {
    const ctx = creatorBusinessContext(workspace, "ig-diya");
    expect(ctx.businessSummary).toBe("Diya: dance creator");
    expect(ctx.typicalBrandDealMinor).toEqual({ min: 80_000_00, max: 2_00_000_00 });
    // null means this creator doesn't sell coaching; it must not fall back to the workspace price.
    expect(ctx.typicalCoachingMinor).toBeNull();
  });

  it("falls back to the workspace profile for other creators and odd stored values", () => {
    expect(creatorBusinessContext(workspace, "ig-rohan").businessSummary).toBe("Talent agency for fitness creators");
    expect(creatorBusinessContext({ ...workspace, creators: ["bad"] }, "ig-diya").businessSummary).toBe("Talent agency for fitness creators");
    expect(creatorBusinessContext(null, "ig-diya")).toEqual({});
  });
});
