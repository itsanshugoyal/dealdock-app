import type { ClassificationLabel } from "./index";
import type { DealType, DraftChip } from "./api-types";

/**
 * Runtime lists for string unions declared in api-types.ts (a types-only
 * module), so validators, menus and mappers share one copy instead of
 * re-typing the literals. Each list is checked at compile time against its
 * union: adding a member to one without the other fails the build.
 */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// ── Deal (offer / ledger) types ─────────────────────────────────────────────

export const DEAL_TYPES = ["brand", "coaching", "course", "other"] as const;
type _DealTypesCoverDealType = Assert<Same<(typeof DEAL_TYPES)[number], DealType>>;

export function isDealType(value: unknown): value is DealType {
  return typeof value === "string" && (DEAL_TYPES as readonly string[]).includes(value);
}

/** The commerce labels: the classifications that imply a deal type. */
export type CommerceLabel = "brand_deal" | "coaching_lead" | "course_inquiry" | "other_commerce";

/** The deal type a sale from a commerce conversation records as (and the offers that answer it). */
export const DEAL_TYPE_FOR_LABEL: Readonly<Record<CommerceLabel, DealType>> = {
  brand_deal: "brand",
  coaching_lead: "coaching",
  course_inquiry: "course",
  other_commerce: "other",
};

/** The inverse: the label whose glyph and colour stand for a deal type (offers, ledger rows). */
export const LABEL_FOR_DEAL_TYPE: Readonly<Record<DealType, CommerceLabel>> = {
  brand: "brand_deal",
  coaching: "coaching_lead",
  course: "course_inquiry",
  other: "other_commerce",
};

/** Deal type for a commerce label; null for every other label, a missing one or an unknown string. */
export function dealTypeForLabel(label: ClassificationLabel | string | null | undefined): DealType | null {
  switch (label) {
    case "brand_deal":
    case "coaching_lead":
    case "course_inquiry":
    case "other_commerce":
      return DEAL_TYPE_FOR_LABEL[label];
    default:
      return null;
  }
}

// ── Draft steering chips ────────────────────────────────────────────────────

/** Every steering chip, in contract order (request validation, chip menus). */
export const DRAFT_CHIPS = [
  "shorter",
  "longer",
  "warmer",
  "more_formal",
  "more_casual",
  "more_hinglish",
  "more_english",
  "add_emoji",
  "no_emoji",
  "ask_budget",
  "quote_rate",
  "decline_politely",
  "wrong_facts",
] as const;
type _DraftChipsCoverDraftChip = Assert<Same<(typeof DRAFT_CHIPS)[number], DraftChip>>;

export function isDraftChip(value: unknown): value is DraftChip {
  return typeof value === "string" && (DRAFT_CHIPS as readonly string[]).includes(value);
}
