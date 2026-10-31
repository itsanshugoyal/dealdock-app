import type {
  AudioAttachment,
  AuditRow,
  ChooseAlternativeRequest,
  ClassificationLabel,
  ClosedDealDto,
  ContentType,
  CreateSpeakingVoiceRequest,
  CurrencyCode,
  DealSignal,
  DealType,
  DraftDto,
  DraftRequest,
  Insights,
  AudioPreviewResponse,
  LeakScanSummary,
  MessageOrigin,
  MessageSource,
  MoneyContext,
  OfferDto,
  OfferInput,
  ParticipantProfile,
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
  canSendVoice: boolean;
  /** True once GET /threads/:id filled messages, draft and deal facts. */
  detail: boolean;
  messages: DemoMessage[];
  draft: DraftDto | null;
}

export interface DemoLedgerEntry {
  id: string;
  threadId: string;
  handle: string;
  dealType: DealType;
  amountMinor: number;
  /** Epoch ms. */
  closedAt: number;
  note?: string;
}

export interface DashboardView {
  mtdRecoveredMinor: number;
  biggestMinor: number;
  avgMinor: number;
  mtdDealCount: number;
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
  accounts: Array<{ id: string; handle: string; status: AccountStatus; provider: string }>;
  voiceConsent: Array<{ igAccountId: string; consented: boolean }>;
  deletionRequestedAt: string | null;
  monthlyGoalMinor: number | null;
  humanAgentEnabled: boolean;
  speechAvailable: boolean;
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
  storingSince: string | null;
  deletionRequestedAt: string | null;
}

export interface RegionInput {
  locale?: string;
  timezone?: string;
  nudgeDelayDays?: number;
}

/** POST /threads/:id/send result, plus the two flags the composer copy needs. */
export type SendResult = SendResponse & { pending: boolean; ambiguous: boolean };

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
  loadLedger(month?: string): Promise<LedgerView | null>;
  updateLedger(entryId: string, body: Partial<Pick<DemoLedgerEntry, "amountMinor" | "dealType" | "note">>): Promise<unknown>;
  deleteLedger(entryId: string): Promise<unknown>;
  download(path: string, fallbackName: string): Promise<void>;
  loadInsights(months?: number): Promise<Insights | null>;
  setGoal(monthlyGoalMinor: number | null): Promise<void>;
  loadAudit(limit?: number): Promise<AuditRow[] | null>;

  // Offers
  loadOffers(): Promise<OfferDto[] | null>;
  createOffer(input: OfferInput): Promise<OfferDto>;
  updateOffer(offerId: string, patch: Partial<OfferInput>): Promise<OfferDto>;
  deleteOffer(offerId: string): Promise<void>;

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

  // Instagram + onboarding
  connectInstagram(): Promise<{ authorizeUrl: string }>;
  disconnectInstagram(igAccountId?: string): Promise<void>;
  loadOnboarding(): Promise<OnboardingView | null>;
  saveOnboarding(input: OnboardingInput): Promise<void>;
  bootstrapWorkspace(body: { currencyCode: CurrencyCode; locale: string; timezone: string }): Promise<void>;
  startLeakScan(): Promise<{ enqueued: number }>;
  getLeakScan(): Promise<LeakScanSummary>;
}
