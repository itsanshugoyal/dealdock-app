import { describe, expect, it, vi } from "vitest";

// No database client is ever constructed: these read nothing from it.
vi.mock("../src/client", () => ({ prisma: {} }));
import { rateCardUrlOf } from "../src/repos/creator-context";
import { storedAddOns } from "../src/repos/offers";

describe("the rate-card link drafts share", () => {
  it("is the web app's /rates/<token>, only when the link is on and the address is a web address", () => {
    expect(rateCardUrlOf("AbC_dEf-123", "https://app.dealdock.example")).toBe("https://app.dealdock.example/rates/AbC_dEf-123");
    expect(rateCardUrlOf("AbC", "https://app.dealdock.example/some/path/")).toBe("https://app.dealdock.example/rates/AbC");
    expect(rateCardUrlOf(null, "https://app.dealdock.example")).toBeNull();
    expect(rateCardUrlOf("AbC", undefined)).toBeNull();
    expect(rateCardUrlOf("AbC", "not a url")).toBeNull();
    expect(rateCardUrlOf("AbC", "javascript:alert(1)")).toBeNull();
  });
});

describe("stored add-on prices", () => {
  it("read back every key, or none set when the row is empty or no longer valid", () => {
    expect(storedAddOns({ rushMinor: 500_00 })).toMatchObject({ rushMinor: 500_00, usagePerMonthMinor: null });
    expect(storedAddOns(null)).toBeNull();
    expect(storedAddOns({ rushMinor: -5 })).toBeNull();
    expect(storedAddOns({ usagePerMonthMinor: null })).toBeNull();
  });
});
