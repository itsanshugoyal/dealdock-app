"use client";

import { DEAL_TYPES, LABEL_FOR_DEAL_TYPE, dealTypeForLabel, type ClassificationLabel, type DealType } from "@dealdock/core";
import { Ban, CalendarCheck, CircleHelp, GraduationCap, Handshake, Heart, ShoppingBag, UserRound, type LucideIcon } from "lucide-react";
import { labelNoun, labelText } from "../../lib/format";
import { cx } from "./cx";

/**
 * Everything a classification label looks like (DESIGN §2.1, §3.4), in one
 * place: words, glyph and colours. Class names stay complete static strings
 * so Tailwind generates them.
 */
export interface LabelMeta {
  /** Name in the UI ("Brand deal"); never the raw enum. */
  text: string;
  /** Lower-case noun for sentences ("a brand deal"). */
  noun: string;
  /** What a sale from this conversation records as; null for labels that are not commerce. */
  dealType: DealType | null;
  icon: LucideIcon;
  /** Glyph colour class: the accent colours only the glyph. */
  accent: string;
  /** Chip background class. */
  tint: string;
  /** Dot background class (LabelDot, deal-type bars): the label colour for commerce and "Not sure", neutral otherwise. */
  dot: string;
  /** CSS colour for inline styles (ValueStrip): the label colour for commerce, neutral otherwise. */
  fill: string;
}

/** Neutral dot and fill: kit.tsx fell back to var(--dd-ink-3), which is not a token (the ink-3 text colour is --dd-text-3). */
const NEUTRAL_DOT = "bg-ink-3";
const NEUTRAL_FILL = "var(--dd-text-3)";

function meta(label: ClassificationLabel, look: Pick<LabelMeta, "icon" | "accent" | "tint" | "dot" | "fill">): LabelMeta {
  return { text: labelText(label), noun: labelNoun(label), dealType: dealTypeForLabel(label), ...look };
}

export const LABEL_META: Readonly<Record<ClassificationLabel, LabelMeta>> = {
  brand_deal: meta("brand_deal", { icon: Handshake, accent: "text-label-brand", tint: "bg-label-brand-tint", dot: "bg-label-brand", fill: "var(--dd-label-brand)" }),
  coaching_lead: meta("coaching_lead", { icon: CalendarCheck, accent: "text-label-coaching", tint: "bg-label-coaching-tint", dot: "bg-label-coaching", fill: "var(--dd-label-coaching)" }),
  course_inquiry: meta("course_inquiry", { icon: GraduationCap, accent: "text-label-course", tint: "bg-label-course-tint", dot: "bg-label-course", fill: "var(--dd-label-course)" }),
  other_commerce: meta("other_commerce", { icon: ShoppingBag, accent: "text-label-commerce", tint: "bg-label-commerce-tint", dot: "bg-label-commerce", fill: "var(--dd-label-commerce)" }),
  fan: meta("fan", { icon: Heart, accent: "text-label-fan", tint: "bg-label-fan-tint", dot: NEUTRAL_DOT, fill: NEUTRAL_FILL }),
  spam: meta("spam", { icon: Ban, accent: "text-label-spam", tint: "bg-label-spam-tint", dot: NEUTRAL_DOT, fill: NEUTRAL_FILL }),
  personal: meta("personal", { icon: UserRound, accent: "text-label-personal", tint: "bg-label-personal-tint", dot: NEUTRAL_DOT, fill: NEUTRAL_FILL }),
  uncertain: meta("uncertain", { icon: CircleHelp, accent: "text-label-uncertain", tint: "bg-label-uncertain-tint", dot: "bg-label-uncertain", fill: NEUTRAL_FILL }),
};

/**
 * For a missing or unrecognised label: the "Other sale" words and glyph that
 * labelText and LabelChip already fall back to, with the neutral dot and fill.
 */
export const LABEL_META_FALLBACK: LabelMeta = { ...LABEL_META.other_commerce, dealType: null, dot: NEUTRAL_DOT, fill: NEUTRAL_FILL };

export function labelMeta(label: ClassificationLabel | null | undefined): LabelMeta {
  return label && Object.prototype.hasOwnProperty.call(LABEL_META, label) ? LABEL_META[label] : LABEL_META_FALLBACK;
}

/** Background class for charts split by deal type (StackedBar, legends): the dot of the deal type's label. */
export const DEAL_TYPE_FILL = Object.fromEntries(
  DEAL_TYPES.map((type) => [type, LABEL_META[LABEL_FOR_DEAL_TYPE[type]].dot]),
) as Readonly<Record<DealType, string>>;

/**
 * Classification label as text + glyph, never a saturated pill and never the
 * raw enum (DESIGN §3.4). Replaces v1's Badge.
 */
export function LabelChip({ label, className }: { label: ClassificationLabel; className?: string }) {
  const meta = labelMeta(label);
  const Icon = meta.icon;
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap text-label text-ink-2", className)}>
      <Icon size={14} className={cx("shrink-0", meta.accent)} />
      {meta.text}
    </span>
  );
}
