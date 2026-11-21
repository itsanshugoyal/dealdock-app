/**
 * "What you sell" (onboarding's businessContext): the workspace's answers and,
 * on Roster, a creator's own answers in businessContext.creators[igAccountId].
 * A creator's missing answer means "use the workspace's", so it is left out
 * rather than saved empty.
 */

export type PriceRange = { min: number; max: number } | null;
export interface BusinessFacts {
  summary: string;
  sells: string[];
  brand: PriceRange;
  coaching: PriceRange;
  course: PriceRange;
}

export function priceRange(value: unknown): PriceRange {
  if (!value || typeof value !== "object") return null;
  const { min, max } = value as { min?: unknown; max?: unknown };
  return typeof min === "number" && typeof max === "number" ? { min, max } : null;
}

export function businessFacts(context: Record<string, unknown> | null): BusinessFacts {
  return {
    summary: typeof context?.businessSummary === "string" ? context.businessSummary : "",
    sells: Array.isArray(context?.sells) ? context.sells.filter((item): item is string => typeof item === "string") : [],
    brand: priceRange(context?.typicalBrandDealMinor),
    coaching: priceRange(context?.typicalCoachingMinor),
    course: priceRange(context?.typicalCourseMinor),
  };
}

function creatorMap(context: Record<string, unknown> | null): Record<string, unknown> {
  const creators = context?.creators;
  return creators && typeof creators === "object" && !Array.isArray(creators) ? (creators as Record<string, unknown>) : {};
}

/** One creator's own answers, or null when they have none. */
export function creatorAnswers(context: Record<string, unknown> | null, igAccountId: string): Record<string, unknown> | null {
  const own = creatorMap(context)[igAccountId];
  return own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : null;
}

/** What a profile reads as (a creator's answers over the workspace's), and which parts came from the workspace. */
export function profileFor(context: Record<string, unknown> | null, igAccountId: string | null): BusinessFacts & { inherited: Set<keyof BusinessFacts> } {
  const workspace = businessFacts(context);
  const inherited = new Set<keyof BusinessFacts>();
  if (!igAccountId) return { ...workspace, inherited };
  const own = businessFacts(creatorAnswers(context, igAccountId));
  const pick = <K extends keyof BusinessFacts>(key: K, empty: boolean): BusinessFacts[K] => {
    if (empty) inherited.add(key);
    return empty ? workspace[key] : own[key];
  };
  return {
    summary: pick("summary", !own.summary),
    sells: pick("sells", !own.sells.length),
    brand: pick("brand", !own.brand),
    coaching: pick("coaching", !own.coaching),
    course: pick("course", !own.course),
    inherited,
  };
}

/**
 * The business context with one creator's answers saved: only what they
 * answered is kept, and a creator with nothing of their own is removed, so
 * every empty answer keeps falling back to the workspace's.
 */
export function withCreatorProfile(context: Record<string, unknown> | null, igAccountId: string, answers: BusinessFacts): Record<string, unknown> {
  const own = {
    ...(answers.summary.trim() ? { businessSummary: answers.summary.trim() } : {}),
    ...(answers.sells.length ? { sells: answers.sells } : {}),
    ...(answers.brand ? { typicalBrandDealMinor: answers.brand } : {}),
    ...(answers.coaching ? { typicalCoachingMinor: answers.coaching } : {}),
    ...(answers.course ? { typicalCourseMinor: answers.course } : {}),
  };
  const creators = { ...creatorMap(context) };
  if (Object.keys(own).length) creators[igAccountId] = own;
  else delete creators[igAccountId];
  return { ...(context ?? {}), creators };
}
