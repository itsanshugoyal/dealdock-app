import type {
  ClassificationResult,
  DraftChip,
  DraftContextSummary,
  MeasuredStyle,
  StyleCard,
  VoiceRuleScope,
  VoiceRuleStatus,
} from "@dealdock/core";

/** An active offer the draft may quote (prices in org-currency minor units). */
export interface OfferContext {
  id: string;
  name: string;
  dealType: "brand" | "coaching" | "course" | "other";
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  link: string | null;
  details: string | null;
  availability: string | null;
}

/** An active or pinned writing-style rule (candidates and muted rules never reach a prompt). */
export interface VoiceRuleContext {
  id: string;
  key: string;
  text: string;
  scope: VoiceRuleScope;
  status: Extract<VoiceRuleStatus, "active" | "pinned">;
  source?: string;
  evidence: number;
}

/** Measured habits per scope (StyleCard v2 `measured`); the extra fields are optional for older cards. */
export type MeasuredStyleInput = MeasuredStyle & {
  medianWords?: number;
  devanagariRate?: number;
  lowercaseStartRate?: number;
};

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
  /** Org locale, for money formatting in prompts (defaults to the currency's locale). */
  locale?: string;
  /** Active offers for this account (account-scoped or workspace-wide). */
  offers?: OfferContext[];
  /** Active + pinned writing-style rules for this account. */
  voiceRules?: VoiceRuleContext[];
  measured?: MeasuredStyleInput[];
  /** Hand edits from Voice Studio, merged over the extracted card. */
  styleOverrides?: Partial<StyleCard> | null;
}

export interface ClassifyInput {
  messageText: string;
  senderHandle: string;
  creator: CreatorContext;
  /** Ignore rules are enforced before model context is sent. */
  isIgnoredHandle?: boolean;
}

export type DraftKind = "reply" | "nudge";

export interface DraftThreadMessage {
  direction: "inbound" | "outbound";
  text: string;
  contentType?: "text" | "audio" | "attachment";
  /** Voice notes: the transcript stands in for the (empty) text. */
  transcript?: string | null;
}

/** A retrieved past reply by the creator (selectExemplars). */
export interface DraftExemplar {
  messageId: string;
  text: string;
  inboundText: string | null;
  label: string | null;
}

export interface DraftInput {
  kind: DraftKind;
  threadHistory: DraftThreadMessage[];
  /** The label the reply is for; null/"" gets a neutral reply structure (never a silent brand_deal). */
  classificationLabel: string | null;
  creator: CreatorContext;
  /** Drafting is prohibited when the creator withdrew voice-model consent. */
  voiceConsent?: boolean;
  /** Ignored handles are never classified into a draft or surfaced for sending. */
  isIgnoredHandle?: boolean;
  /** Least → most relevant (most relevant ends up closest to the task). */
  exemplars?: DraftExemplar[];
  /** One-line lessons from the creator's past edits. */
  lessons?: string[];
  chips?: DraftChip[];
  /** Free-text steering, ≤ 200 chars. */
  instruction?: string | null;
  /** 1 (default) to 3 versions. */
  variants?: number;
}

export interface DraftResult {
  body: string;
  modelVersion: string;
  promptVersion: string;
  /** Every version when more than one was asked for (body === alternatives[0]); otherwise empty. */
  alternatives?: string[];
  /** What the draft was built from — the "Why this draft" sheet. */
  context?: DraftContextSummary;
  /** Rule-check violations left after the single retry (a quality metric, never a blocker). */
  lintViolations?: string[];
}

export interface AiPipeline {
  classify(input: ClassifyInput): Promise<ClassificationResult>;
  draft(input: DraftInput): Promise<DraftResult>;
}
