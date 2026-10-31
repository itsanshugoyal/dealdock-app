/**
 * API v2 contract — the shapes apps/api returns and apps/web consumes
 * (docs/redesign/02-api-contract.md). Types only: routes validate inputs with
 * zod at the trust boundary and return objects that `satisfies` these types.
 * Every change here is additive to the v1 fields the web already reads.
 *
 * Conventions: money is integer minor units in the org currency; timestamps
 * are ISO-8601 strings; ids are opaque strings; nullable means "unknown".
 */
import type { ClassificationLabel, ThreadState, DraftStatus } from "./index";
import type { CurrencyCode } from "./money";

export type DealType = "brand" | "coaching" | "course" | "other";
export type DraftKind = "reply" | "nudge";
export type ContentType = "text" | "audio" | "attachment";
export type MessageOrigin = "native" | "dealdock" | "automation";
/** Where an inbound conversation started, when Instagram tells us (story reply, reel share, ad, link ref). */
export type MessageSource = "dm" | "story" | "reel" | "ad" | "link";

// ── Sender context (read-only, never a contact record) ────────────────────

export interface ParticipantProfile {
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  followerCount: number | null;
  verified: boolean | null;
  followsYou: boolean | null;
  /** Lifetime confirmed revenue from this sender in this workspace. */
  closedTotalMinor: number;
  closedDeals: number;
  fetchedAt: string | null;
}

// ── Instagram reply window (24h standard, 7d with an approved HUMAN_AGENT tag) ─

export type ReplyWindowStatus = "open" | "extended" | "closed" | "unknown";
export interface ReplyWindow {
  status: ReplyWindowStatus;
  lastInboundAt: string | null;
  /** lastInboundAt + 24h */
  standardClosesAt: string | null;
  /** lastInboundAt + 7d — only meaningful when humanAgentEnabled */
  extendedClosesAt: string | null;
  /** Workspace has Meta's Human Agent permission configured (META_HUMAN_AGENT_ENABLED). */
  humanAgentEnabled: boolean;
}

// ── Inbox ─────────────────────────────────────────────────────────────────

export interface InboxRow {
  threadId: string;
  /** The connected Instagram account the conversation belongs to (roster filtering, account chip). */
  igAccountId: string;
  participantHandle: string;
  participant: ParticipantProfile;
  state: ThreadState;
  lastMessageAt: string;
  lastInboundAt: string | null;
  topLabel: ClassificationLabel | null;
  estValueMinMinor: number | null;
  estValueMaxMinor: number | null;
  estCurrencyCode: string | null;
  /** Latest message text in the conversation. */
  preview: string;
  /** The preview is our own outbound message (rows show "You: …"). */
  previewOutbound: boolean;
  messageCount: number;
  unreplied: boolean;
  waitingSince: string | null;
  nudgeDue: boolean;
  draftReady: boolean;
  hasAudio: boolean;
  /** Latest inbound message reads like a confirmed deal (payment done, "let's proceed"…). */
  dealSignal: boolean;
  source: MessageSource | null;
  replyWindow: ReplyWindow;
}

/** GET /inbox?state=open|waiting|closed&label=&q=&limit=(1-200, default 100)&cursor= */
export interface InboxResponse {
  rows: InboxRow[];
  nextCursor: string | null;
}

// ── Review queue ──────────────────────────────────────────────────────────

/** One message awaiting a human label decision (low confidence or "uncertain"). */
export interface ReviewQueueRow {
  /** POST /classifications/:id/review takes this id. */
  classificationId: string;
  threadId: string;
  /** The conversation's Instagram account (per-creator inbox views filter by it). */
  igAccountId: string;
  handle: string;
  /** The classified message. */
  text: string;
  sentAt: string;
  bestGuess: ClassificationLabel;
  confidence: number;
  rationale: string | null;
}

/** GET /review-queue — unreviewed items, oldest classification first, at most 50. */
export interface ReviewQueueResponse {
  rows: ReviewQueueRow[];
}

// ── Onboarding Leak Scan ──────────────────────────────────────────────────

/** GET /onboarding/leak-scan — the reveal: unanswered commerce found in the backfill (PRD §5.1.6). */
export interface LeakScanSummary {
  /** idle: no scan started; running: the backfill is still classifying; done: final numbers. */
  status: "idle" | "running" | "done";
  scannedCount: number;
  commerceCount: number;
  /** Sum of the low ends of the unanswered estimates. */
  totalMinMinor: number;
  /** Up to 3, largest estimate first. */
  topThreads: Array<{ threadId: string; handle: string; label: ClassificationLabel | null; estValueMaxMinor: number | null }>;
}

// ── Thread detail ─────────────────────────────────────────────────────────

export interface MessageClassificationDto {
  id: string;
  label: ClassificationLabel;
  confidence: number;
  rationale: string | null;
  valueMinMinor: number | null;
  valueMaxMinor: number | null;
  reviewedAt: string | null;
}

export interface AudioAttachment {
  /** Signed, expiring URL served by GET /media/a/:id — playable directly in <audio>. */
  url: string | null;
  mimeType: string | null;
  durationMs: number | null;
  transcript: string | null;
  transcriptLanguage: string | null;
  status: "ready" | "pending" | "unavailable" | "failed";
}

export interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  contentType: ContentType;
  text: string;
  sentAt: string;
  origin: MessageOrigin | null;
  audio: AudioAttachment | null;
  classification: MessageClassificationDto | null;
}

export type DraftChip =
  | "shorter"
  | "longer"
  | "warmer"
  | "more_formal"
  | "more_casual"
  | "more_hinglish"
  | "more_english"
  | "add_emoji"
  | "no_emoji"
  | "ask_budget"
  | "quote_rate"
  | "decline_politely"
  | "wrong_facts";

/** What a draft was built from — powers the "Why this draft" sheet. */
export interface DraftContextSummary {
  rules: Array<{ id: string; text: string }>;
  exemplars: Array<{ messageId: string; text: string; inboundText: string | null }>;
  offers: Array<{ id: string; name: string }>;
  lessons: string[];
  /** Facts the model needed but the creator hasn't provided (e.g. "your coaching price"). */
  missingFacts: string[];
}

export interface DraftDto {
  id: string;
  body: string;
  kind: DraftKind;
  status: DraftStatus;
  version: number;
  label: ClassificationLabel | null;
  instruction: string | null;
  chips: DraftChip[];
  /** Up to 3 alternates (body is alternatives[chosenAlternative] when chosen). */
  alternatives: string[];
  chosenAlternative: number | null;
  context: DraftContextSummary | null;
}

export interface DealSignal {
  messageId: string;
  phrase: string;
  /** Amount mentioned in the conversation near the signal, if any. */
  suggestedAmountMinor: number | null;
  suggestedDealType: DealType | null;
}

export interface ClosedDealDto {
  id: string;
  amountMinor: number;
  currencyCode: string;
  dealType: DealType;
  note: string | null;
  closedAt: string;
}

/** GET /threads/:id — v1 fields kept (participantHandle, currentDraft, closedDeals, sendInFlight…). */
export interface ThreadDetail {
  id: string;
  igAccountId: string;
  participantHandle: string;
  participant: ParticipantProfile;
  state: ThreadState;
  waitingSince: string | null;
  nudgeDue: boolean;
  topLabel: ClassificationLabel | null;
  estValueMinMinor: number | null;
  estValueMaxMinor: number | null;
  estCurrencyCode: string | null;
  rationale: string | null;
  lastInboundAt: string | null;
  replyWindow: ReplyWindow;
  source: MessageSource | null;
  messages: ThreadMessage[];
  sendInFlight: boolean;
  currentDraft: DraftDto | null;
  closedDeals: ClosedDealDto[];
  dealSignal: DealSignal | null;
  /** Voice-note sending is possible for this thread (speaking voice ready + provider configured). */
  canSendVoice: boolean;
}

/** POST /threads/:id/draft */
export interface DraftRequest {
  chips?: DraftChip[];
  /** Free-text steering, max 200 chars ("mention I'm free next week"). */
  instruction?: string;
  /** 1 (default) or up to 3 alternates. */
  variants?: number;
}

/** POST /threads/:id/draft/choose */
export interface ChooseAlternativeRequest {
  draftId: string;
  alternative: number;
}

/** POST /drafts/:id/feedback */
export interface DraftFeedbackRequest {
  chips: DraftChip[];
  note?: string;
}

/** POST /threads/:id/send body: v1 { draftId, finalText, idempotencyKey } + asVoice. */
export interface SendRequest {
  draftId: string;
  finalText: string;
  idempotencyKey?: string;
  /** Send as a voice note in the creator's cloned voice (requires a ready speaking voice). */
  asVoice?: boolean;
}

/** A style observation from this send's edit, offered back to the creator ("Noted: you open with 'Heyy'"). */
export interface LearnedSignal {
  key: string;
  text: string;
  scope: VoiceRuleScope;
}

export interface SendResponse {
  status: "accepted" | "pending" | "remote_accepted" | "unknown" | "persisted";
  sent?: boolean;
  intentId: string;
  messageId?: string;
  editDistance?: number;
  learned?: LearnedSignal[];
  hint?: string;
  error?: string;
}

// ── Voice studio (writing style) ──────────────────────────────────────────

export interface StyleCard {
  greeting: string;
  tone: string;
  sentenceLength: "short" | "medium" | "long";
  signoff: string;
  emojiUsage: "none" | "light" | "heavy";
  codeSwitching: string;
  characteristicPhrases: string[];
  avoidPhrases?: string[];
}

export type VoiceRuleScope = "all" | "nudge" | ClassificationLabel;
export type VoiceRuleStatus = "candidate" | "active" | "pinned" | "muted";
export type VoiceRuleSource = "samples" | "edits" | "feedback" | "user";

export interface VoiceRuleDto {
  id: string;
  key: string;
  text: string;
  scope: VoiceRuleScope;
  status: VoiceRuleStatus;
  source: VoiceRuleSource;
  evidence: number;
  against: number;
  examples: Array<{ before: string; after: string }>;
  updatedAt: string;
}

export interface VoiceSampleDto {
  messageId: string;
  text: string;
  sentAt: string;
  origin: MessageOrigin;
  excluded: boolean;
  /** 0-1 influence on the style reference (native 1.0, lightly edited drafts lower). */
  weight: number;
}

export interface MeasuredStyle {
  scope: VoiceRuleScope;
  samples: number;
  avgWords: number;
  emojiRate: number;
  /** Code-Mixing Index 0-1 (share of Hindi/Hinglish tokens). */
  hinglishIndex: number;
  topOpeners: string[];
  topSignoffs: string[];
}

export interface VoiceMetrics {
  sentCount: number;
  /** % of drafts sent with < 20% character change (PRD §7.4 voice fidelity). */
  voiceMatchPct: number | null;
  sentAsIsPct: number | null;
  avgEditRatio: number | null;
  weekly: Array<{ weekStart: string; sent: number; voiceMatchPct: number | null }>;
  byLabel: Array<{ label: ClassificationLabel | "nudge"; sent: number; voiceMatchPct: number | null }>;
}

export type SpeakingVoiceStatus = "none" | "pending" | "ready" | "failed" | "revoked";
export interface SpeakingVoiceDto {
  status: SpeakingVoiceStatus;
  provider: string | null;
  consentedAt: string | null;
  sampleSeconds: number;
  disclosureEnabled: boolean;
  lastError: string | null;
  createdAt: string | null;
}

/** GET /voice?igAccountId= (defaults to the first connected account) */
export interface VoiceStudio {
  igAccountId: string;
  handle: string;
  accounts: Array<{ id: string; handle: string }>;
  consent: { granted: boolean; consentedAt: string | null; revokedAt: string | null };
  learningPaused: boolean;
  refreshedAt: string | null;
  lastDistilledAt: string | null;
  styleCard: StyleCard | null;
  overrides: Partial<StyleCard>;
  measured: MeasuredStyle[];
  rules: VoiceRuleDto[];
  samples: VoiceSampleDto[];
  metrics: VoiceMetrics;
  speaking: SpeakingVoiceDto;
  /** A speech provider (ElevenLabs / self-hosted) is configured server-side. */
  speechAvailable: boolean;
}

/** POST /voice/preview — a draft for a sample message, never saved or sendable. */
export interface VoicePreviewRequest {
  igAccountId?: string;
  inboundText: string;
  label: ClassificationLabel;
  chips?: DraftChip[];
  instruction?: string;
}
export interface VoicePreviewResponse {
  body: string;
  context: DraftContextSummary;
}

/** POST /voice/speaking — recorded in-app; base64 WAV/PCM. */
export interface RecordedClip {
  base64: string;
  mimeType: string;
  durationMs: number;
}
export interface CreateSpeakingVoiceRequest {
  igAccountId?: string;
  /** The exact consent sentence the creator read aloud. */
  consentStatement: string;
  consentClip: RecordedClip;
  samples: RecordedClip[];
}

export interface AudioPreviewResponse {
  url: string;
  mimeType: string;
  expiresAt: string;
}

// ── Offers & rate card (private draft context, never a public page) ───────

export interface OfferDto {
  id: string;
  igAccountId: string | null;
  name: string;
  dealType: DealType;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  currencyCode: CurrencyCode;
  link: string | null;
  details: string | null;
  availability: string | null;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}
export type OfferInput = Omit<OfferDto, "id" | "currencyCode" | "updatedAt">;

// ── Insights (Today + Revenue screens) ────────────────────────────────────

export interface Insights {
  currencyCode: CurrencyCode;
  locale: string;
  timezone: string;
  goal: {
    monthlyGoalMinor: number | null;
    mtdMinor: number;
    pct: number | null;
    /** Straight-line month-end projection from MTD pace; null early in the month. */
    projectedMinor: number | null;
  };
  /** Oldest → newest, org-timezone months, YYYY-MM. */
  months: Array<{ month: string; recoveredMinor: number; deals: number }>;
  byType: Array<{ dealType: DealType; totalMinor: number; deals: number }>;
  pipeline: {
    openCommerceThreads: number;
    openValueMaxMinor: number;
    /** Unreplied commerce threads whose standard reply window closes within 6h. */
    atRiskThreads: number;
    atRiskValueMaxMinor: number;
    nudgesDue: number;
    reviewCount: number;
  };
  speed: {
    medianFirstReplyMinutes: number | null;
    prevMedianFirstReplyMinutes: number | null;
    within4hPct: number | null;
    within24hPct: number | null;
    sampleSize: number;
  };
  voice: { voiceMatchPct: number | null; prevVoiceMatchPct: number | null; sentThisWeek: number };
  leak: { baselineMinMinor: number | null; recoveredSinceJoinMinor: number; joinedAt: string };
  topDeals: Array<{ id: string; threadId: string; handle: string; dealType: DealType; amountMinor: number; closedAt: string }>;
}

// ── Audit trail (creators see who sent what) ──────────────────────────────

export interface AuditRow {
  id: string;
  at: string;
  /** An AuditAction (AUDIT_ACTIONS) for rows this API writes; a string so older and newer actions still render. */
  action: string;
  actor: { seatId: string; name: string | null; role: string } | null;
  threadId: string | null;
  handle: string | null;
  editDistance: number | null;
  originalDraft: string | null;
  finalText: string | null;
  asVoice: boolean;
}
