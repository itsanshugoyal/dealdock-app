import type {
  Channel,
  ClassificationResult,
  DealDto,
  DealSuggestion,
  DraftPurpose,
  DraftChip,
  DraftContextSummary,
  ExclusivityNote,
  InvoiceDto,
  MeasuredStyle,
  OfferAddOns,
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
  /** Brand offers: add-on prices; a draft quotes only those set. */
  addOns?: OfferAddOns | null;
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
  /** This creator's private rate-card link, shared when someone asks for their rates or media kit. */
  rateCardUrl?: string | null;
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
  /** Where the message arrived; absent means an Instagram DM. */
  channel?: Channel;
  /** Email subject line, read along with the message ("Paid collab: 1 reel, budget ₹50k"). */
  subject?: string | null;
}

export type DraftKind = "reply" | "nudge";

export interface DraftThreadMessage {
  direction: "inbound" | "outbound";
  text: string;
  contentType?: "text" | "audio" | "attachment";
  /** Voice notes: the transcript stands in for the (empty) text. */
  transcript?: string | null;
  /** ISO time it was sent; a deal suggestion counts the message's relative dates ("by Friday") from that day. */
  sentAt?: string;
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
  /**
   * A draft with a job beyond replying: "recap" restates the deal's agreed
   * terms, "payment_reminder" asks for its payment, "invoice" is the cover
   * note sent with an invoice's PDF. Needs `deal` (and `invoice` for "invoice").
   */
  purpose?: DraftPurpose;
  deal?: DealDto;
  invoice?: InvoiceDto;
  /** Clock for purpose drafts (how late a payment is). Defaults to the current time. */
  now?: Date;
  /** Org IANA time zone, so purpose drafts name due dates on the org's calendar day. Defaults to UTC. */
  timezone?: string;
  /** "email" writes an email (greeting, short paragraphs, sign-off); absent means an Instagram DM, or the deal's channel for purpose drafts. */
  channel?: Channel;
  /** The email thread's subject, for context only: drafts never write a subject line. */
  subject?: string | null;
  /** Brand replies: this creator's exclusivities with other brands that are still running (never another creator's). */
  exclusivities?: ExclusivityNote[];
  /**
   * A private reply to a public comment that used this keyword (comment
   * leads): the comment is the thread's one inbound message. Ignored with `purpose`.
   */
  comment?: { keyword: string };
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

/** Deal terms read from a conversation for the creator to check before saving. Never saved by itself. */
export interface DealSuggestionInput {
  threadHistory: DraftThreadMessage[];
  creator: CreatorContext;
  /** "Today" for relative dates ("by Friday"); results carry ISO dates. */
  now: Date;
  /** Org IANA time zone for those dates. */
  timezone?: string;
}

export interface AiPipeline {
  classify(input: ClassifyInput): Promise<ClassificationResult>;
  draft(input: DraftInput): Promise<DraftResult>;
  /** Amounts only when the conversation agreed one; unsettled facts go in `missing`. */
  suggestDeal(input: DealSuggestionInput): Promise<DealSuggestion>;
}
