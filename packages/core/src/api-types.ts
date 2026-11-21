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
/** Where a conversation lives. WhatsApp and TikTok can join later on the same model. */
export type Channel = "instagram" | "email";

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

/** "none": the channel has no reply window (email), so a send is never blocked by time. */
export type ReplyWindowStatus = "open" | "extended" | "closed" | "unknown" | "none";
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
  channel: Channel;
  /** Email subject; null for DMs. */
  subject: string | null;
  /** Why the latest inbound message looks like a scam (asks the creator to pay, wants a password…); null when it doesn't. */
  scamReason: string | null;
  /** Coach pipeline stage as stored; null shows as "lead" on coaching and course conversations (core pipelineStage). Absent from older APIs. */
  leadStage?: LeadStage | null;
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

/** GET /review-queue — unreviewed items, oldest classification first, paginated. */
export interface ReviewQueueResponse {
  rows: ReviewQueueRow[];
  nextCursor?: string | null;
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
  /** Files attached to an email; opened through GET /email/messages/:id/attachments/:partId. Absent for DMs. */
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  partId: string;
  filename: string;
  mimeType: string;
  /** Bytes, as the sender's mail reported it. */
  size: number;
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
  /** Set for drafts with a job beyond replying (terms recap, payment reminder). */
  purpose: DraftPurpose | null;
  /** An invoice cover note: sending it attaches this invoice's PDF. */
  invoiceId?: string | null;
  /** The deal a purpose draft is for (a renewal pitch's paid deal included). */
  dealId?: string | null;
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
  channel: Channel;
  /** Email subject; null for DMs. */
  subject: string | null;
  /** Same rule as InboxRow.scamReason. */
  scamReason: string | null;
  /** Deals agreed in this conversation, newest first (deleted ones excluded). */
  deals: DealDto[];
  /** Brand conversations: exclusivities the same creator agreed with someone else that are still running. */
  exclusivities?: ExclusivityNote[];
  /** Same as InboxRow.leadStage. */
  leadStage?: LeadStage | null;
  /** Payments a booking or payment tool reported for this conversation that aren't recorded or dismissed yet, newest first. */
  leadPayments?: LeadEventDto[];
}

/** POST /threads/:id/draft */
export interface DraftRequest {
  chips?: DraftChip[];
  /** Free-text steering, max 200 chars ("mention I'm free next week"). */
  instruction?: string;
  /** 1 (default) or up to 3 alternates. */
  variants?: number;
  /** Draft with a job: restate a deal's agreed terms, or ask for its payment. Needs dealId. */
  purpose?: DraftPurpose;
  dealId?: string;
  /** purpose "invoice": the issued invoice the cover note sends (its PDF is attached on send). */
  invoiceId?: string;
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
  /** Invoice cover notes: whether the PDF went with the text. False means share it by hand (see hint). */
  attachmentSent?: boolean;
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

// ── Offers & rate card (draft context; public only through a rate-card link) ──

/** Add-on prices on a brand offer, org-currency minor units. Null = not set: drafts never quote it and flag it as missing. */
export interface OfferAddOns {
  usagePerMonthMinor: number | null;
  /** Partnership ads (whitelisting), per month. */
  partnershipAdsPerMonthMinor: number | null;
  exclusivityPerMonthMinor: number | null;
  /** One revision round beyond those included. */
  extraRevisionMinor: number | null;
  rushMinor: number | null;
  rawFootageMinor: number | null;
}

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
  /** Brand offers only; absent or null when none are set. */
  addOns?: OfferAddOns | null;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}
export type OfferInput = Omit<OfferDto, "id" | "currencyCode" | "updatedAt">;

/** One active offer as a rate-card link shows it: no ids, nothing internal. */
export type PublicRateCardOffer = Pick<OfferDto, "name" | "dealType" | "priceMinMinor" | "priceMaxMinor" | "details" | "link" | "availability"> & { addOns: OfferAddOns | null };

/** GET /public/rate-cards/:token — unauthenticated; 404 once the link is turned off or rotated. */
export interface PublicRateCard {
  handle: string;
  currencyCode: CurrencyCode;
  /** Org locale, so amounts read the way the creator writes them (lakh grouping in en-IN). */
  locale: string;
  offers: PublicRateCardOffer[];
}

/** POST /offers/rate-card (create or rotate) and DELETE /offers/rate-card/:igAccountId (turn off). */
export interface RateCardLinkResponse {
  igAccountId: string;
  /** Null once turned off. */
  token: string | null;
}

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
  /** threadId is null for money from a deal agreed outside DealDock; handle is then its counterparty. */
  topDeals: Array<{ id: string; threadId: string | null; handle: string; dealType: DealType; amountMinor: number; closedAt: string }>;
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

// ── Deals: one agreement carried from the conversation to the money ─────────

/** agreed → invoiced (payment requested) → paid; cancelled ends it. "Overdue" is derived, never stored. */
export type DealStage = "agreed" | "invoiced" | "paid" | "cancelled";

/** A post's results as Instagram's insights show them; null where a number wasn't read. */
export interface DeliverableMetrics {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

export interface DealDeliverable {
  id: string;
  /** "1 reel", "2 stories", "Usage report" */
  label: string;
  /** ISO date-time it is owed by, when agreed. */
  dueAt: string | null;
  done: boolean;
  /** The live post (https). Absent in deals saved before posts were tracked. */
  postUrl?: string | null;
  postedAt?: string | null;
  /** Results typed from Instagram's insights (or fetched); null until added. */
  metrics?: DeliverableMetrics | null;
  /** When those results were read. */
  metricsAt?: string | null;
}

export interface DealTerms {
  deliverables: DealDeliverable[];
  /** Where and how long the payer may use the content ("Organic only", "Paid ads, 3 months"). */
  usage: string | null;
  /** When those usage rights end; null when not agreed. */
  usageEndsAt: string | null;
  /** "No other skincare brands for 30 days" */
  exclusivity: string | null;
  exclusivityEndsAt: string | null;
  revisionsIncluded: number | null;
  /** Upfront share, 0–100. */
  advancePercent: number | null;
  /** Days the payer has after being asked ("net 30"). */
  paymentDays: number | null;
  notes: string | null;
  /** Disclosure checklist items ticked (DISCLOSURE_ITEMS ids, after India's ASCI guidelines). */
  disclosure: string[];
}

export interface DealDto {
  id: string;
  /** The conversation the deal came from; null for a deal recorded outside DealDock (agreed on a call, WhatsApp…). */
  threadId: string | null;
  /** The creator account (roster filtering, creator chip). */
  igAccountId: string;
  /** The other side (brand or client): their handle, email address or name. */
  counterpartyHandle: string;
  counterpartyName: string | null;
  /** Null when the deal has no conversation in DealDock. */
  channel: Channel | null;
  title: string;
  dealType: DealType;
  /** Agreed fee in org-currency minor units. */
  amountMinor: number;
  currencyCode: string;
  stage: DealStage;
  terms: DealTerms;
  agreedAt: string;
  /** When payment is due. */
  dueAt: string | null;
  invoicedAt: string | null;
  paidAt: string | null;
  /** Set when paid: what actually arrived, and tax the payer withheld (India TDS). Revenue records their sum. */
  receivedMinor: number | null;
  tdsMinor: number | null;
  createdAt: string;
  updatedAt: string;
  /** Invoices issued for this deal, oldest first (void ones included). */
  invoices?: InvoiceDto[];
  /** Revenue recorded for this deal so far (a paid advance counts before the deal is paid). Excludes GST/VAT. */
  paidMinor?: number;
  /** The creator dealt with the usage-rights reminder (renewed, stopped or dismissed it). */
  usageHandledAt?: string | null;
  /** When the creator pitched this brand again or said "Not now" to the renewal prompt; null until then. */
  renewalHandledAt?: string | null;
}

/** Another of the creator account's deals whose exclusivity is still running (ThreadDetail.exclusivities). */
export interface ExclusivityNote {
  dealId: string;
  /** Null for a deal agreed outside DealDock: then the counterparty is as typed. */
  threadId: string | null;
  counterpartyHandle: string;
  counterpartyName: string | null;
  /** "No other skincare brands" */
  exclusivity: string;
  endsAt: string;
}

/** GET /deals?status=open|all&igAccountId= */
export interface DealsResponse {
  deals: DealDto[];
}

/** What arrived when a deal or an invoice is paid. receivedMinor defaults to the amount due (the fee left, or the invoice total) less TDS. */
export interface DealPaidInput {
  receivedMinor?: number;
  tdsMinor?: number;
  paidAt?: string;
}

/**
 * POST /deals — from a conversation, or without one for a deal agreed elsewhere.
 * `paid` records the money at once (the old "Record a sale").
 */
export interface DealCreateRequest {
  /** Omit for a deal agreed outside DealDock; then igAccountId and counterpartyHandle are required. */
  threadId?: string;
  /** The creator the deal belongs to (required without threadId). */
  igAccountId?: string;
  /** Who it's with, without a conversation: a handle, email address or name. */
  counterpartyHandle?: string;
  counterpartyName?: string | null;
  title: string;
  dealType: DealType;
  amountMinor: number;
  terms?: Partial<DealTerms>;
  dueAt?: string | null;
  paid?: DealPaidInput;
  /** Caller-generated; a retry resolves to the same deal. */
  idempotencyKey: string;
  /** Recording the sale a payment tool reported in this conversation: that payment is handled with it. */
  leadEventId?: string;
}

/** PATCH /deals/:id. Paid goes through POST /deals/:id/paid. */
export interface DealUpdateRequest {
  title?: string;
  dealType?: DealType;
  amountMinor?: number;
  terms?: Partial<DealTerms>;
  dueAt?: string | null;
  stage?: Exclude<DealStage, "paid">;
}

/** POST /deals/:id/paid — one Revenue entry for what its paid invoices left (the whole fee without invoices). 409 deal_has_open_invoices while an invoice is unpaid. */
export interface DealPaidRequest extends DealPaidInput {
  idempotencyKey: string;
}

/** POST /threads/:id/deal-suggestion — filled from the conversation, never saved. */
export interface DealSuggestion {
  title: string | null;
  dealType: DealType | null;
  /** Only an amount the conversation actually agreed; null otherwise. */
  amountMinor: number | null;
  dueAt: string | null;
  terms: DealTerms;
  /** What the conversation didn't settle, in plain words ("payment date", "usage rights"). */
  missing: string[];
  modelVersion: string;
}

/** Drafts with a job beyond replying: restating agreed terms, asking to be paid, or sending an invoice. */
/** usage_renewal: usage rights are ending (Phase 2); renewal: pitch a paid brand again (Phase 3). */
export type DraftPurpose = "recap" | "payment_reminder" | "invoice" | "usage_renewal" | "renewal";

// ── Invoices: a PDF from a deal, sent through the approve-and-send path ─────

/** "full" bills the whole fee; "advance" the agreed upfront share; "balance" what is left. */
export type InvoiceKind = "full" | "advance" | "balance";
/** issued → paid; void withdraws it. Numbers are never reused. */
export type InvoiceStatus = "issued" | "paid" | "void";
/**
 * How tax applies: "domestic" (GST within India, or VAT), "export_lut" (India
 * export without IGST under a Letter of Undertaking), "export_tax" (India
 * export with IGST), "untaxed" (no tax registration).
 */
export type SupplyType = "domestic" | "export_lut" | "export_tax" | "untaxed";
export type TaxKind = "gst_in" | "vat" | "none";

export interface TaxRegistration {
  kind: TaxKind;
  /** GSTIN (gst_in) or VAT number (vat). */
  number: string | null;
  /** VAT rate; for gst_in, an override of the default 18%. Up to 2 decimals. */
  ratePercent: number | null;
  /** India: ARN of the Letter of Undertaking that lets exports go without IGST. */
  lutArn: string | null;
}

export interface PaymentDetails {
  upiId: string | null;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  /** https only. */
  paymentLink: string | null;
}

/** PUT /settings/billing-profile — the legal identity printed on invoices. */
export interface BillingProfileInput {
  legalName: string;
  /** Street lines, postal code included. */
  addressLines: string[];
  city: string | null;
  /** India: GST state code ("27" for Maharashtra); elsewhere free text. */
  state: string | null;
  /** ISO 3166-1 alpha-2, e.g. "IN". */
  country: string;
  email: string | null;
  phone: string | null;
  tax: TaxRegistration;
  /** India PAN. */
  pan: string | null;
  /** India Udyam (MSME) registration number. */
  udyamNumber: string | null;
  /** SAC/HSN code on invoice lines, e.g. 998361 (advertising services). */
  sacCode: string | null;
  payment: PaymentDetails;
  /** Letters and digits. In India at most 4, so numbers fit GST's 16 characters. */
  invoicePrefix: string;
}

export interface BillingProfileDto extends BillingProfileInput {
  /** Null for the workspace profile; a creator account's own profile on Roster. */
  igAccountId: string | null;
  /** The number the next invoice gets, e.g. "INV-2026-27-004". */
  nextInvoiceNumber: string;
  updatedAt: string;
}

/** GET /settings/billing-profile?igAccountId= */
export interface BillingProfileResponse {
  /** Null until billing details are set up. */
  profile: BillingProfileDto | null;
  /** True when the workspace profile stands in for a creator account without its own. */
  inherited: boolean;
}

/** Who an invoice is addressed to. */
export interface InvoiceParty {
  name: string;
  addressLines: string[];
  city: string | null;
  /** India: GST state code (sets the place of supply); elsewhere free text. */
  state: string | null;
  /** ISO 3166-1 alpha-2. Outside India from an Indian GST registration makes an export invoice. */
  country: string;
  /** GSTIN for Indian businesses, VAT or tax number elsewhere. */
  taxNumber: string | null;
}

export interface InvoiceLine {
  description: string;
  sacCode: string | null;
  quantity: number;
  amountMinor: number;
}

export interface InvoiceTaxLine {
  kind: "cgst" | "sgst" | "utgst" | "igst" | "vat";
  /** "CGST 9%" */
  label: string;
  ratePercent: number;
  amountMinor: number;
}

/** The issuer as printed: the billing profile at issue, with the calendar and number style it was issued in. */
export type InvoiceSupplier = Omit<BillingProfileInput, "invoicePrefix"> & { timezone: string; locale: string };

export interface InvoiceDto {
  id: string;
  dealId: string;
  kind: InvoiceKind;
  number: string;
  status: InvoiceStatus;
  /** "Tax invoice" (GST within India), "Export invoice" or "Invoice". */
  title: string;
  issuedAt: string;
  dueAt: string;
  currencyCode: string;
  supplier: InvoiceSupplier;
  billTo: InvoiceParty;
  lines: InvoiceLine[];
  /** Fee share before tax. subtotal + tax = total, exactly. */
  subtotalMinor: number;
  taxes: InvoiceTaxLine[];
  taxMinor: number;
  totalMinor: number;
  supplyType: SupplyType;
  /** India: GST state code of the place of supply, "96" for exports; null outside India's GST. */
  placeOfSupply: string | null;
  /** Printed endorsement for exports (under LUT, or on payment of IGST). */
  declaration: string | null;
  notes: string | null;
  paidAt: string | null;
  receivedMinor: number | null;
  tdsMinor: number | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /deals/:id/invoices */
export interface InvoiceCreateRequest {
  kind: InvoiceKind;
  /** Default: an advance is due on issue; full and balance on the deal's due date, else its payment days from today. */
  dueAt?: string;
  billTo: InvoiceParty;
  notes?: string | null;
}

/** GET /deals/:id/invoices */
export interface InvoicesResponse {
  invoices: InvoiceDto[];
}

/** POST /invoices/:id/paid — received defaults to the total less TDS. A retry with the same key returns the same result. */
export interface InvoicePaidRequest extends DealPaidInput {
  idempotencyKey: string;
}

/** The paid invoice and its deal, which is paid once its paid invoices cover the fee. */
export interface InvoicePaidResponse {
  invoice: InvoiceDto;
  deal: DealDto;
}

// ── Renewals: pitch a brand that paid again (core renewalsDue) ─────────────

export interface RenewalDto {
  /** The latest deal with the brand, paid; "Not now" and the pitch's send mark it handled. */
  deal: DealDto;
  /** 1 Sep – 15 Oct, when brands set festive (Oct–Dec) budgets: due after 30 days instead of 60. */
  festive: boolean;
}

/** GET /renewals — one per creator account and brand, biggest past deal first. */
export interface RenewalsResponse {
  renewals: RenewalDto[];
}

/** POST /deals/:id/draft — a deal with no conversation: the pitch as text to copy, never stored or sent. */
export interface DealDraftResponse {
  body: string;
}

// ── Coach pipeline: stages, and booking and payment tools that report back ──

/** lead → qualified → booked → paid. A tool's report only moves it forward; the creator can set any stage. */
export type LeadStage = "lead" | "qualified" | "booked" | "paid";
/** "other" is a plain JSON address for Zapier, Make or the creator's own tools. */
export type LeadSourceProvider = "calendly" | "cal_com" | "razorpay" | "stripe" | "other";
export type LeadEventKind = "booked" | "paid";

/** PUT /threads/:id/lead-stage */
export interface LeadStageRequest {
  stage: LeadStage;
}

export interface LeadSourceDto {
  id: string;
  provider: LeadSourceProvider;
  label: string | null;
  lastEventAt: string | null;
  createdAt: string;
  /** Razorpay or Stripe without its signing secret yet: nothing it sends is accepted until it is saved. */
  needsSecret: boolean;
}

/** PUT /lead-sources/:id/secret — Stripe shows its signing secret only after the address is saved there. */
export interface LeadSourceSecretRequest {
  secret: string;
}

/** A booking or payment a connected tool reported. */
export interface LeadEventDto {
  id: string;
  sourceId: string;
  provider: LeadSourceProvider;
  kind: LeadEventKind;
  /** The conversation it was matched to; null while unmatched. */
  threadId: string | null;
  /** Payments only, in minor units of their own currency (which can differ from the org's). */
  amountMinor: number | null;
  currencyCode: string | null;
  payerName: string | null;
  occurredAt: string;
}

/** GET /lead-sources — the connected tools, and payments not matched to a conversation yet. */
export interface LeadSourcesResponse {
  sources: LeadSourceDto[];
  unmatched: LeadEventDto[];
}

/** POST /lead-sources. `secret` is the tool's signing secret (Cal.com optional; Razorpay and Stripe now or later); `accessKey` is Calendly's personal access key, used once and never stored. */
export interface LeadSourceCreateRequest {
  provider: LeadSourceProvider;
  label?: string | null;
  secret?: string;
  accessKey?: string;
}

/** The address to paste into the tool, shown this once (Calendly is set up by DealDock and has none to paste). */
export interface LeadSourceCreated {
  source: LeadSourceDto;
  address: string | null;
}

/** POST /lead-events/:id/match */
export interface LeadEventMatchRequest {
  threadId: string;
}

// ── Comment leads: keyword comments, each answered by one approved private reply ──

/** new → sending → sent, or skipped. "Too late" (7 days after the comment) is derived, never stored. */
export type CommentLeadStatus = "new" | "sending" | "sent" | "skipped";

/** Someone who commented one of a creator's keywords, with the private reply drafted for them. */
export interface CommentLeadDto {
  id: string;
  /** The creator account whose post it was. */
  igAccountId: string;
  commenterHandle: string;
  /** The comment as they wrote it. */
  text: string;
  /** The keyword it matched, as the creator wrote it. */
  keyword: string;
  /** The post's link, once Instagram gave it; null until then. */
  mediaUrl: string | null;
  commentedAt: string;
  /** commentedAt + 7 days: Instagram takes the private reply until then. */
  replyBy: string;
  status: CommentLeadStatus;
  /** The drafted reply, or once sent the words that went. Null while drafting, or when drafts are off. */
  draftBody: string | null;
  /** Facts the draft needed but the offers don't give ("your price"). */
  missingFacts: string[];
  sentAt: string | null;
}

/** GET /comment-leads */
export interface CommentLeadsResponse {
  /** False where comment leads aren't turned on (META_COMMENTS_ENABLED): screens hide them. */
  configured: boolean;
  /** Each Instagram account's keywords. */
  keywords: Array<{ igAccountId: string; keywords: string[] }>;
  /** Newest first; skipped leads are left out. */
  leads: CommentLeadDto[];
}

/** PUT /comment-leads/keywords — replaces one creator's keywords (up to 10, 1–30 characters each). */
export interface CommentKeywordsRequest {
  igAccountId?: string;
  keywords: string[];
}

/** POST /comment-leads/:id/send — the reply as the person approved it, edits included. */
export interface CommentLeadSendRequest {
  text: string;
}
