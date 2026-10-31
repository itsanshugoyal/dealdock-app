import { describe, expect, it } from "vitest";
import { CLASSIFICATION_LABELS, DEAL_TYPES, dealTypeForLabel, type ClassificationLabel } from "@dealdock/core";
import { DEAL_TYPE_FILL, LABEL_META, LABEL_META_FALLBACK, labelMeta } from "../src/components/ui/label-chip";
import { labelNoun, labelText } from "../src/lib/format";

describe("label meta", () => {
  it("covers every label with its words and deal type", () => {
    expect(Object.keys(LABEL_META).sort()).toEqual([...CLASSIFICATION_LABELS].sort());
    for (const label of CLASSIFICATION_LABELS) {
      expect(LABEL_META[label].text).toBe(labelText(label));
      expect(LABEL_META[label].noun).toBe(labelNoun(label));
      expect(LABEL_META[label].dealType).toBe(dealTypeForLabel(label));
    }
  });

  it("keeps LabelDot's colours: commerce and Not sure coloured, the rest neutral", () => {
    const dots = Object.fromEntries(CLASSIFICATION_LABELS.map((label) => [label, LABEL_META[label].dot]));
    expect(dots).toEqual({
      brand_deal: "bg-label-brand", coaching_lead: "bg-label-coaching", course_inquiry: "bg-label-course", other_commerce: "bg-label-commerce",
      fan: "bg-ink-3", spam: "bg-ink-3", personal: "bg-ink-3", uncertain: "bg-label-uncertain",
    });
  });

  it("fills commerce with its label colour and everything else with a real neutral token", () => {
    const fills = Object.fromEntries(CLASSIFICATION_LABELS.map((label) => [label, LABEL_META[label].fill]));
    expect(fills).toEqual({
      brand_deal: "var(--dd-label-brand)", coaching_lead: "var(--dd-label-coaching)", course_inquiry: "var(--dd-label-course)", other_commerce: "var(--dd-label-commerce)",
      fan: "var(--dd-text-3)", spam: "var(--dd-text-3)", personal: "var(--dd-text-3)", uncertain: "var(--dd-text-3)",
    });
    expect(labelMeta(null).fill).toBe("var(--dd-text-3)");
    expect(JSON.stringify([LABEL_META, LABEL_META_FALLBACK])).not.toContain("--dd-ink-3");
  });

  it("falls back for a missing or unknown label like labelText and LabelChip do", () => {
    for (const label of [null, undefined, "promo", "toString"] as Array<ClassificationLabel | null | undefined>) {
      expect(labelMeta(label)).toBe(LABEL_META_FALLBACK);
    }
    expect(LABEL_META_FALLBACK).toMatchObject({ text: "Other sale", icon: LABEL_META.other_commerce.icon, dealType: null, dot: "bg-ink-3" });
    expect(labelMeta("coaching_lead")).toBe(LABEL_META.coaching_lead);
  });

  it("keeps the label accents and derives DEAL_TYPE_FILL with the values they always had", () => {
    expect(LABEL_META.brand_deal).toMatchObject({ accent: "text-label-brand", tint: "bg-label-brand-tint" });
    expect(LABEL_META.uncertain).toMatchObject({ accent: "text-label-uncertain", tint: "bg-label-uncertain-tint" });
    expect(DEAL_TYPE_FILL).toEqual({ brand: "bg-label-brand", coaching: "bg-label-coaching", course: "bg-label-course", other: "bg-label-commerce" });
    expect(Object.keys(DEAL_TYPE_FILL)).toEqual([...DEAL_TYPES]);
  });
});
