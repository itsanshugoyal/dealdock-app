import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { listRecentOverrides } from "./classifications";

export interface CreatorContextRow {
  businessSummary: string;
  currencyCode: string;
  typicalBrandDealMinor: { min: number; max: number } | null;
  typicalCoachingMinor: { min: number; max: number } | null;
  typicalCourseMinor: { min: number; max: number } | null;
  styleCard: Record<string, unknown> | null;
  correctionExamples: Array<{ text: string; correctLabel: string }>;
  voiceEnabled: boolean;
}

/**
 * Assembles the per-creator AI context — strictly org-scoped; this is the ONLY
 * place prompt context is gathered, so cross-creator leakage is structurally
 * impossible (ARCHITECTURE.md §3.3).
 */
export async function getCreatorContext(
  orgId: OrgId,
  igAccountId: string
): Promise<CreatorContextRow> {
  const [org, voice, corrections] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true, businessContext: true },
    }),
    prisma.voiceProfile.findFirst({
      where: { orgId, igAccountId },
      select: { enabled: true, styleCard: true },
    }),
    listRecentOverrides(orgId, 10),
  ]);
  if (!org) throw new Error("org not found");

  const ctx = (org.businessContext ?? {}) as Record<string, unknown>;
  const range = (key: string) => {
    const r = ctx[key] as { min?: number; max?: number } | undefined;
    return r && typeof r.min === "number" && typeof r.max === "number"
      ? { min: r.min, max: r.max }
      : null;
  };

  return {
    businessSummary:
      (ctx["businessSummary"] as string | undefined) ??
      "Commerce creator selling through Instagram DMs.",
    currencyCode: org.currencyCode,
    typicalBrandDealMinor: range("typicalBrandDealMinor"),
    typicalCoachingMinor: range("typicalCoachingMinor"),
    typicalCourseMinor: range("typicalCourseMinor"),
    styleCard: (voice?.styleCard as Record<string, unknown> | null) ?? null,
    correctionExamples: corrections,
    voiceEnabled: voice?.enabled ?? true,
  };
}

export async function upsertBusinessContext(
  orgId: OrgId,
  businessContext: Record<string, unknown>
) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { businessContext: businessContext as never },
  });
}
