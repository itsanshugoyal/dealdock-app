import { describe, expect, it } from "vitest";
import {
  DEAL_TYPE_FOR_LABEL,
  DEAL_TYPES,
  DRAFT_CHIPS,
  LABEL_FOR_DEAL_TYPE,
  dealTypeForLabel,
  isDealType,
  isDraftChip,
} from "../src/catalog";
import { inferDealType } from "../src/deal-signals";
import { CLASSIFICATION_LABELS, HIGH_INTENT_LABELS } from "../src/index";

describe("deal types", () => {
  it("lists each deal type once and recognises only those", () => {
    expect(DEAL_TYPES).toEqual(["brand", "coaching", "course", "other"]);
    for (const type of DEAL_TYPES) expect(isDealType(type)).toBe(true);
    for (const value of ["Brand", "", "brand_deal", null, undefined, 1]) expect(isDealType(value)).toBe(false);
  });

  it("maps exactly the commerce labels to a deal type, and back", () => {
    expect(Object.keys(DEAL_TYPE_FOR_LABEL).sort()).toEqual([...HIGH_INTENT_LABELS].sort());
    expect(dealTypeForLabel("brand_deal")).toBe("brand");
    expect(dealTypeForLabel("coaching_lead")).toBe("coaching");
    expect(dealTypeForLabel("course_inquiry")).toBe("course");
    expect(dealTypeForLabel("other_commerce")).toBe("other");
    for (const type of DEAL_TYPES) expect(DEAL_TYPE_FOR_LABEL[LABEL_FOR_DEAL_TYPE[type]]).toBe(type);
  });

  it("has no deal type for other labels, a missing label or unknown strings", () => {
    for (const label of ["fan", "spam", "personal", "uncertain", null, undefined, "", "toString", "constructor"]) {
      expect(dealTypeForLabel(label)).toBeNull();
    }
  });

  it("agrees with the close-out suggestion for every label", () => {
    for (const label of [...CLASSIFICATION_LABELS, null]) expect(inferDealType(label)).toBe(dealTypeForLabel(label));
  });
});

describe("draft chips", () => {
  it("lists all 13 chips once each", () => {
    expect(DRAFT_CHIPS).toHaveLength(13);
    expect(new Set(DRAFT_CHIPS).size).toBe(DRAFT_CHIPS.length);
    for (const chip of DRAFT_CHIPS) expect(isDraftChip(chip)).toBe(true);
    for (const value of ["Shorter", "short", "", null, 3]) expect(isDraftChip(value)).toBe(false);
  });
});
