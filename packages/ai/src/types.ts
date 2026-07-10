import type { ClassificationResult } from "@dealdock/core";

/** Per-creator context assembled (org-scoped!) by the caller — never crosses creators. */
export interface CreatorContext {
  businessSummary: string;
  /** Org currency — value estimates are produced in this currency (ADR-9). */
  currencyCode: string;
  typicalBrandDealMinor: { min: number; max: number } | null;
  typicalCoachingMinor: { min: number; max: number } | null;
  typicalCourseMinor: { min: number; max: number } | null;
  styleCard: Record<string, unknown> | null;
  /** Few-shot correction examples distilled from Review Queue overrides (ADR-5). */
  correctionExamples: Array<{ text: string; correctLabel: string }>;
}

export interface ClassifyInput {
  messageText: string;
  senderHandle: string;
  creator: CreatorContext;
}

export type DraftKind = "reply" | "nudge";

export interface DraftInput {
  kind: DraftKind;
  threadHistory: Array<{ direction: "inbound" | "outbound"; text: string }>;
  classificationLabel: string;
  creator: CreatorContext;
}

export interface DraftResult {
  body: string;
  modelVersion: string;
  promptVersion: string;
}

export interface AiPipeline {
  classify(input: ClassifyInput): Promise<ClassificationResult>;
  draft(input: DraftInput): Promise<DraftResult>;
}
