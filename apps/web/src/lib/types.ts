import type {
  AudioAttachment,
  AuditRow,
  BillingProfileDto,
  BillingProfileInput,
  BillingProfileResponse,
  Channel,
  ChooseAlternativeRequest,
  ClassificationLabel,
  ClosedDealDto,
  CommentLeadDto,
  ContentType,
  CreateSpeakingVoiceRequest,
  CurrencyCode,
  DealCreateRequest,
  DealDto,
  DealPaidRequest,
  DealSignal,
  DealSuggestion,
  DealType,
  DealUpdateRequest,
  DraftDto,
  DraftRequest,
  ExclusivityNote,
  Insights,
  InvoiceCreateRequest,
  InvoiceDto,
  InvoicePaidRequest,
  InvoicePaidResponse,
  LeadEventDto,
  LeadSourceCreated,
  LeadSourceCreateRequest,
  LeadSourcesResponse,
  LeadStage,
  RenewalDto,
  AudioPreviewResponse,
  MessageAttachment,
  LeakScanSummary,
  MessageOrigin,
  MessageSource,
  MoneyContext,
  OfferDto,
  OfferInput,
  ParticipantProfile,
  PublicRateCard,
  ReplyWindow,
  SeatRole,
  SendResponse,
  SpeakingVoiceDto,
  StyleCard,
  ThreadState,
  Tier,
  VoicePreviewRequest,
  VoicePreviewResponse,
  VoiceRuleDto,
  VoiceRuleScope,
  VoiceRuleStatus,
  VoiceStudio,
} from "@dealdock/core";

/**
 * Web view-models shared by the API store and the demo store. Both stores
 * publish the same AppSnapshot and implement the same AppStoreApi, so a screen
 * built and verified in demo mode works unchanged against the live API.
 */

export type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * A lazily loaded part of the snapshot. Cleared to idle on every account switch.
 * A slice that already has data keeps showing it while it reloads: "loading"
 * only ever appears while `data` is still null.
 */
export interface Slice<T> {
  status: LoadState;
  data: T | null;
  error: string | null;
  /** HTTP status of the last failure (404 = not found / not in this workspace). */
  errorStatus: number | null;
  /** Epoch ms of the last successful load (null = never loaded). */
  loadedAt: number | null;
  /** A write changed what this shows since it loaded; mounted screens reload it, the rest on their next mount. */
  stale: boolean;
}

export interface DemoMessage {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  /** Epoch ms. */
  sentAt: number;
  contentType: ContentType;
  origin: MessageOrigin | null;
  audio: AudioAttachment | null;
  /** Files on an email (GET /email/messages/:id/attachments/:partId); absent for DMs. */
  attachments?: MessageAttachment[];
  classification?: {
    id?: string;
    label: ClassificationLabel;
    confidence: number;
    rationale: string | null;
    valueMinMinor: number | null;
    valueMaxMinor: number | null;
    reviewedAt?: string | null;
  };
}

/**
 * One conversation. Inbox/review rows fill the row fields (InboxRow and
 * ReviewQueueRow in @dealdock/core); GET /threads/:id (`detail: true`, the
 * ThreadDetail contract) adds the full history, draft and deal facts.
 */
export interface DemoThread {
  id: string;
  /** The connected account the conversation belongs to; null only on review rows until the review queue carries it. */
  igAccountId: string | null;
  handle: string;
  participant: ParticipantProfile;
  state: ThreadState;
  waitingSince: number | null;
  lastMessageAt: number;
  lastInboundAt: number | null;
  unreplied: boolean;
  topLabel: ClassificationLabel | null;
  estValueMinMinor: number | null;
  estValueMaxMinor: number | null;
  estCurrencyCode: string | null;
  rationale: string | null;
  routedTo: "inbox" | "review_queue";
  /** Decided in the Review Queue (demo rows keep it; the API drops a reviewed item instead). */
  reviewed: boolean;
  /** Review-queue rows: the classification a decision applies to. */
  classificationId: string | null;
  /** Latest message text; `previewOutbound` says it was the creator's own reply. */
  preview: string;
  previewOutbound: boolean;
  messageCount: number;
  nudgeDue: boolean;
  draftReady: boolean;
  hasAudio: boolean;
  /** Row flag ("Looks closed"); `dealSignal` carries the details once the thread detail is loaded. */
  hasDealSignal: boolean;
  dealSignal: DealSignal | null;
  source: MessageSource | null;
  replyWindow: ReplyWindow;
  sendInFlight: boolean;
  closedDeals: ClosedDealDto[];
  /** Deals agreed in this conversation, newest first (thread detail only; rows carry none). */
  deals: DealDto[];
  canSendVoice: boolean;
  /** True once GET /threads/:id filled messages, draft and deal facts. */
  detail: boolean;
  /** Instagram DM or email; email has no reply window and its handle is an address. */
  channel: Channel;
  /** Email subject; null for DMs. */
  subject: string | null;
  /** Why the latest inbound message looks like a scam; null when it doesn't. */
  scamReason: string | null;
  /** Coach pipeline stage as stored (core pipelineStage reads null as "lead" on coaching and course conversations). */
  leadStage?: LeadStage | null;
  /** Payments a booking or payment tool reported here, not recorded or dismissed yet (thread detail only). */
  leadPayments?: LeadEventDto[];
  /** Brand conversations: exclusivities this creator agreed with other brands that are still running (thread detail only). */
  exclusivities?: ExclusivityNote[];
  messages: DemoMessage[];
  draft: DraftDto | null;
}

export interface DemoLedgerEntry {
  id: string;
  /** Null for a deal agreed outside DealDock. */
  threadId: string | null;
  /** Where that conversation lives (an email counterparty's handle is an address); null without one. Sessions saved before it lack it. */
  channel?: Channel | null;
  handle: string;
  dealType: DealType;
  amountMinor: number;
  /** Epoch ms. */
  closedAt: number;
  note?: string;
  /** The deal this payment recorded (demo store; deleting either one follows the API's rules). */
  dealId?: string;
  /** The invoice this payment settled (demo store): deleting the entry reopens it, as the API does. */
  invoiceId?: string;
}

export interface DashboardView {
  mtdRecoveredMinor: number;
  biggestMinor: number;
  avgMinor: number;
  mtdDealCount: number;
}

/** GET /email/accounts: one connected Gmail inbox, owned by a creator account. */
export interface EmailAccountView {
  id: string;
  address: string;
  status: "active" | "token_expired";
  connectedAt: string;
  lastSyncedAt: string | null;
  /** The creator (Instagram account) the inbox belongs to. */
  ownerAccountId: string | null;
}
export interface EmailInboxes {
  accounts: EmailAccountView[];
  /** False once the API says email isn't set up for this deployment: Settings hides the section. */
  available: boolean;
}

/** GET /comment-leads: people who commented a creator's keyword, each with one private reply to approve. */
export interface CommentLeadsView {
  /** False where the API says comment leads aren't turned on: every screen hides them. */
  available: boolean;
  /** Keywords by Instagram account id. */
  keywords: Record<string, string[]>;
  /** Newest first; skipped ones are gone. */
  leads: CommentLeadDto[];
}

/** GET /ledger?month=YYYY-MM (months are org-timezone months, oldest first). */
export interface LedgerView {
  selectedMonth: string;
  timezone: string;
  currencyCode: CurrencyCode;
  totalMinor: number;
  biggestMinor: number;
  avgMinor: number;
  months: Array<{ month: string; totalMinor: number; count: number }>;
  byType: Partial<Record<DealType, number>>;
  entries: DemoLedgerEntry[];
}

export type AccountStatus = "active" | "disconnected" | "token_expired";

/** GET /settings — v1 fields plus the v2 additions (defaulted when absent). */
export interface SettingsView {
  currencyCode: CurrencyCode;
  locale: string;
  timezone: string;
  nudgeDelayDays: number;
  /** rateCardToken: the creator's private rate-card link (/rates/<token>); null when off. */
  accounts: Array<{ id: string; handle: string; status: AccountStatus; provider: string; rateCardToken?: string | null }>;
  voiceConsent: Array<{ igAccountId: string; consented: boolean }>;
  deletionRequestedAt: string | null;
  monthlyGoalMinor: number | null;
  humanAgentEnabled: boolean;
  speechAvailable: boolean;
  /** "Fetch from Instagram" for post results (META_INSIGHTS_ENABLED on the API). */
  insightsAvailable?: boolean;
  tier: Tier;
}

/** GET /me — v1 is { clerkUserId, orgId, role }; name/email/tier when the API adds them. */
export interface MeView {
  clerkUserId: string;
  orgId: string;
  role: SeatRole;
  name: string | null;
  email: string | null;
  tier: Tier | null;
}

export interface NotificationPrefs {
  notifyHighValue: boolean;
  notifyNudge: boolean;
  notifyWeeklySummary: boolean;
  subscribed: boolean;
}

export interface BillingView {
  status: "pilot_manual" | "pending_first_invoice" | "active" | "past_due" | "cancelled" | string;
  rail: "razorpay" | "paddle" | null;
  tier: Tier | null;
  checkoutUrl: string | null;
  activeUseStartedAt: string | null;
  currentPeriodEnd: string | null;
  cancelledAt: string | null;
}

export interface SeatView {
  id: string;
  role: SeatRole;
  email: string;
  name: string | null;
  activated: boolean;
  createdAt: string;
}

export interface RosterRow {
  igAccountId: string;
  handle: string;
  status: AccountStatus | string;
  mtdRecoveredMinor: number;
  unreadHighPriority: number;
  reviewQueueSize: number;
}

export interface OnboardingView {
  currencyCode: CurrencyCode;
  locale: string;
  timezone: string;
  businessContext: Record<string, unknown> | null;
  igAccounts: Array<{ id: string; handle: string; voice: { enabled: boolean; consentedAt: string | null; revokedAt: string | null } | null }>;
  voiceConsent: Array<{ igAccountId: string; consented: boolean }>;
  complete: boolean;
}

export interface OnboardingInput {
  businessContext: Record<string, unknown>;
  currencyCode: CurrencyCode;
  locale: string;
  timezone: string;
  ignoreHandles?: string[];
  voiceConsent?: boolean;
  igAccountId?: string;
}

/** GET /onboarding/leak-scan: the contract type now lives in @dealdock/core. */
export type { LeakScanSummary };

export interface DataSummary {
  messagesProcessed: number;
  classifications: number;
  draftsGenerated: number;
  ledgerEntries: number;
  auditRows: number;
  deals: number;
  invoices: number;
  billingProfiles: number;
  /** Connected Gmail inboxes, disconnected ones included: the address and its state, never its tokens. */
  emailInboxes: Array<{ id: string; address: string; status: AccountStatus; connectedAt: string }>;
  storingSince: string | null;
  deletionRequestedAt: string | null;
}

export interface RegionInput {
  locale?: string;
  timezone?: string;
  nudgeDelayDays?: number;
}

/** POST /threads/:id/send result, plus the two flags the composer copy needs. */
export type SendResult = Omit<SendResponse, "intentId"> & { intentId?: string; pending: boolean; ambiguous: boolean };

export interface AppSnapshot {
  /** Open + waiting inbox threads and unreviewed review-queue items (the core refresh). */
  threads: DemoThread[];
  /** Current-month ledger entries (the core refresh). */
  ledger: DemoLedgerEntry[];
  money: MoneyContext;
  /** Org time zone — format every date with it, never the browser's. */
  timezone: string;
  workspaceName: string | null;
  dashboard: DashboardView | null;
  onboarded: boolean;
  /**
   * Core refresh status. "loading" also covers a later full refresh (retry, back online) — use `loadedAt`
   * to tell first load apart. Writes refetch only the parts they change and leave it as it is.
   */
  state: LoadState;
  error: string | null;
  /** Increments on every account switch; effects that load lazy slices depend on it. */
  epoch: number;
  /** Epoch ms of the last successful core refresh for this account (null = never loaded). */
  loadedAt: number | null;
  /** GET /threads/:id per thread id. */
  details: Record<string, Slice<DemoThread>>;
  closed: Slice<DemoThread[]>;
  ledgerView: Slice<LedgerView>;
  /** GET /deals: open (or all) deals, optionally for one creator. */
  deals: Slice<DealDto[]>;
  /** GET /renewals: brands to pitch again (Today). */
  renewals: Slice<RenewalDto[]>;
  /** GET /lead-sources: connected booking and payment tools, and what they reported that matched no conversation. */
  leadSources: Slice<LeadSourcesResponse>;
  /** GET /settings/billing-profile: the workspace's, or one creator's (falling back to the workspace's). */
  billingProfile: Slice<BillingProfileResponse>;
  emailAccounts: Slice<EmailInboxes>;
  /** GET /comment-leads: keywords and the leads they caught, every creator's. */
  commentLeads: Slice<CommentLeadsView>;
  insights: Slice<Insights>;
  offers: Slice<OfferDto[]>;
  voice: Slice<VoiceStudio>;
  audit: Slice<AuditRow[]>;
  settings: Slice<SettingsView>;
  me: Slice<MeView>;
  notificationPrefs: Slice<NotificationPrefs>;
  billing: Slice<BillingView>;
  seats: Slice<SeatView[]>;
  roster: Slice<RosterRow[]>;
  onboarding: Slice<OnboardingView>;
  ignoreList: Slice<string[]>;
  dataSummary: Slice<DataSummary>;
}

export type SliceKey = {
  [K in keyof AppSnapshot]: AppSnapshot[K] extends Slice<unknown> ? K : never;
}[keyof AppSnapshot];

export interface RuleInput {
  text: string;
  scope?: VoiceRuleScope;
  key?: string;
  status?: Extract<VoiceRuleStatus, "active" | "pinned">;
  igAccountId?: string;
}

/**
 * Every store operation a screen may call (through `appStore`). Loaders
 * (`load*`) never throw: they record the outcome in their slice and resolve to
 * the data or null. Actions throw an Error whose message is safe to show; HTTP
 * failures also carry `status` and `code` (the API's error string). An action
 * keeps the snapshot current itself — it applies what the response says, reloads
 * the open conversation and marks the lazy slices it changed stale — so a
 * screen never needs a full refresh after a write.
 */
export interface AppStoreApi {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AppSnapshot;
  init(): Promise<void>;
  refresh(): Promise<void>;

  // Threads
  loadThread(threadId: string): Promise<DemoThread | null>;
  loadClosed(): Promise<DemoThread[] | null>;
  generateDraft(threadId: string, request?: DraftRequest): Promise<DraftDto>;
  chooseAlternative(threadId: string, request: ChooseAlternativeRequest): Promise<DraftDto>;
  send(threadId: string, finalText: string, options?: { asVoice?: boolean }): Promise<SendResult>;
  setState(threadId: string, state: ThreadState): Promise<unknown>;
  dismissNudge(threadId: string): Promise<unknown>;
  closeDeal(threadId: string, amountMinor: number, dealType: DealType, options?: { note?: string; idempotencyKey?: string }): Promise<unknown>;
  review(classificationOrThreadId: string, outcome: "confirmed" | "overridden", label?: ClassificationLabel): Promise<unknown>;

  // Ledger, insights, goal
  loadLedger(month?: string, igAccountId?: string): Promise<LedgerView | null>;
  updateLedger(entryId: string, body: Partial<Pick<DemoLedgerEntry, "amountMinor" | "dealType" | "note">>): Promise<unknown>;
  deleteLedger(entryId: string): Promise<unknown>;
  download(path: string, fallbackName: string): Promise<void>;
  loadInsights(months?: number): Promise<Insights | null>;
  setGoal(monthlyGoalMinor: number | null): Promise<void>;
  loadAudit(limit?: number): Promise<AuditRow[] | null>;

  // Deals (agreed → payment requested → paid)
  loadDeals(options?: { status?: "open" | "all"; igAccountId?: string }): Promise<DealDto[] | null>;
  createDeal(request: DealCreateRequest): Promise<DealDto>;
  updateDeal(dealId: string, patch: DealUpdateRequest): Promise<DealDto>;
  markDealPaid(dealId: string, request: DealPaidRequest): Promise<DealDto>;
  deleteDeal(dealId: string): Promise<void>;
  /** Filled from the conversation; never saved. */
  suggestDeal(threadId: string): Promise<DealSuggestion>;

  // Renewals: pitch a brand that paid again
  loadRenewals(): Promise<RenewalDto[] | null>;
  /** "Not now", or the pitch copied to send outside DealDock: the brand leaves Today. */
  handleRenewal(dealId: string, how: "not_now" | "copied"): Promise<void>;
  /** A paid deal agreed outside DealDock: its pitch as text to copy, never stored or sent. */
  draftForDeal(dealId: string): Promise<string>;

  // Coach pipeline: stages, and booking and payment tools that report back
  setLeadStage(threadId: string, stage: LeadStage): Promise<void>;
  loadLeadSources(): Promise<LeadSourcesResponse | null>;
  connectLeadSource(request: LeadSourceCreateRequest): Promise<LeadSourceCreated>;
  /** Razorpay's or Stripe's signing secret, saved after the address (Stripe shows it only then). */
  saveLeadSourceSecret(sourceId: string, secret: string): Promise<void>;
  removeLeadSource(sourceId: string): Promise<void>;
  matchLeadEvent(eventId: string, threadId: string): Promise<void>;
  dismissLeadEvent(eventId: string): Promise<void>;

  // Comment leads: one private reply per keyword comment, each approved by a person
  loadCommentLeads(): Promise<CommentLeadsView | null>;
  /** Replaces one creator's keywords (the workspace's account when omitted). */
  setCommentKeywords(keywords: string[], igAccountId?: string): Promise<string[]>;
  /** Sends the approved, possibly edited, reply. Throws when it was not sent. */
  sendCommentLead(leadId: string, text: string): Promise<void>;
  skipCommentLead(leadId: string): Promise<void>;
  /** Drafts the reply again from the creator's offers. */
  redraftCommentLead(leadId: string): Promise<void>;
  /** Removes leads whose 7 days ran out without a reply; returns how many. */
  clearExpiredCommentLeads(igAccountId?: string): Promise<number>;

  // Invoices (a PDF from a deal) and the billing details printed on them
  loadBillingProfile(igAccountId?: string): Promise<BillingProfileResponse | null>;
  saveBillingProfile(input: BillingProfileInput, igAccountId?: string): Promise<BillingProfileDto>;
  createInvoice(dealId: string, request: InvoiceCreateRequest): Promise<InvoiceDto>;
  voidInvoice(invoiceId: string): Promise<InvoiceDto>;
  markInvoicePaid(invoiceId: string, request: InvoicePaidRequest): Promise<InvoicePaidResponse>;

  // Offers
  loadOffers(): Promise<OfferDto[] | null>;
  createOffer(input: OfferInput): Promise<OfferDto>;
  updateOffer(offerId: string, patch: Partial<OfferInput>): Promise<OfferDto>;
  deleteOffer(offerId: string): Promise<void>;
  /** A creator's private rate-card link: on makes a new one (ending the old), off turns it off. Returns the token, or null. */
  setRateCardLink(igAccountId: string, on: boolean): Promise<string | null>;
  /** The public page behind a link, without a session; null when the link is off or unknown. */
  loadPublicRateCard(token: string): Promise<PublicRateCard | null>;

  // Usage rights and proof of results
  /** Today's usage-rights reminder: Done, or back again (Undo). */
  setUsageHandled(dealId: string, handled: boolean): Promise<DealDto>;
  /** "Fetch from Instagram": a posted deliverable's results, saved on the deal. */
  fetchInsights(dealId: string, deliverableId: string): Promise<DealDto>;

  // Your voice (writing style)
  loadVoice(igAccountId?: string): Promise<VoiceStudio | null>;
  setStyleOverrides(overrides: Partial<StyleCard>, igAccountId?: string): Promise<VoiceStudio>;
  createRule(input: RuleInput): Promise<VoiceRuleDto>;
  updateRule(ruleId: string, patch: { text?: string; status?: VoiceRuleStatus; scope?: VoiceRuleScope }): Promise<VoiceRuleDto>;
  deleteRule(ruleId: string): Promise<void>;
  setSampleExcluded(messageId: string, excluded: boolean, igAccountId?: string): Promise<void>;
  refreshVoice(igAccountId?: string): Promise<void>;
  setLearningPaused(paused: boolean, igAccountId?: string): Promise<void>;
  previewVoice(request: VoicePreviewRequest): Promise<VoicePreviewResponse>;

  // Speaking voice
  createSpeakingVoice(request: CreateSpeakingVoiceRequest): Promise<SpeakingVoiceDto>;
  deleteSpeakingVoice(igAccountId?: string): Promise<void>;
  setSpeakingDisclosure(enabled: boolean, igAccountId?: string): Promise<SpeakingVoiceDto>;
  previewSpeaking(text: string, igAccountId?: string): Promise<AudioPreviewResponse>;

  // Settings, account, team
  loadSettings(): Promise<SettingsView | null>;
  loadMe(): Promise<MeView | null>;
  updateRegion(body: RegionInput): Promise<void>;
  setVoiceConsent(igAccountId: string, consented: boolean): Promise<void>;
  loadIgnoreList(): Promise<string[] | null>;
  setIgnoreList(handles: string[]): Promise<unknown>;
  loadNotificationPrefs(): Promise<NotificationPrefs | null>;
  setNotificationPrefs(prefs: Partial<Omit<NotificationPrefs, "subscribed">>): Promise<unknown>;
  loadBilling(): Promise<BillingView | null>;
  cancelBilling(): Promise<unknown>;
  loadSeats(): Promise<SeatView[] | null>;
  inviteSeat(body: { email: string; name?: string; role: "assistant" | "manager" }): Promise<unknown>;
  removeSeat(seatId: string): Promise<void>;
  loadRoster(): Promise<RosterRow[] | null>;
  loadDataSummary(): Promise<DataSummary | null>;
  scheduleDeletion(): Promise<unknown>;
  cancelDeletion(): Promise<void>;

  // Email (Gmail) inboxes
  loadEmailAccounts(): Promise<EmailInboxes | null>;
  /** Google's consent URL for one creator's inbox (required on Roster). */
  connectEmail(igAccountId?: string): Promise<{ authorizeUrl: string }>;
  disconnectEmail(accountId: string): Promise<void>;

  // Instagram + onboarding
  connectInstagram(): Promise<{ authorizeUrl: string }>;
  disconnectInstagram(igAccountId?: string): Promise<void>;
  loadOnboarding(): Promise<OnboardingView | null>;
  saveOnboarding(input: OnboardingInput): Promise<void>;
  bootstrapWorkspace(body: { currencyCode: CurrencyCode; locale: string; timezone: string }): Promise<void>;
  startLeakScan(): Promise<{ enqueued: number }>;
  getLeakScan(): Promise<LeakScanSummary>;
}
