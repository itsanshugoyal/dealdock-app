"use client";

import {
  BillingProfileInputSchema,
  canReplyPrivately,
  checkScam,
  computeInvoice,
  computeReplyWindow,
  defaultReceivedMinor,
  dueFromPaymentDays,
  editDistance,
  exclusivitiesAgainst,
  formatInvoiceNumber,
  forwardStage,
  GST_INVOICE_NUMBER_MAX,
  invoiceDeclaration,
  invoiceLineDescription,
  invoiceNumberYear,
  InvoicePartySchema,
  invoiceRevenueMinor,
  invoiceShareMinor,
  invoiceTitle,
  isDealOpen,
  isDomainError,
  isNudgeDue,
  isStoryDeliverable,
  missingAddOnPrices,
  LABEL_FOR_DEAL_TYPE,
  noReplyWindow,
  normalizeCommentKeywords,
  normalizeDealTerms,
  normalizeOfferAddOns,
  renewalsDue,
  tagLinks,
  threadRef,
  voiceDisclosureRequired,
  type AudioPreviewResponse,
  type AuditAction,
  type AuditRow,
  type BillingProfileDto,
  type BillingProfileInput,
  type BillingProfileResponse,
  type ChooseAlternativeRequest,
  type ClassificationLabel,
  type CommentLeadDto,
  type CreateSpeakingVoiceRequest,
  type CurrencyCode,
  type DealCreateRequest,
  type DealDto,
  type DealPaidInput,
  type DealPaidRequest,
  type DealTerms,
  type DealType,
  type DealUpdateRequest,
  type DraftContextSummary,
  type DraftDto,
  type DraftRequest,
  type Insights,
  type InvoiceCreateRequest,
  type InvoiceDto,
  type InvoicePaidRequest,
  type InvoicePaidResponse,
  type LeadSourceCreated,
  type LeadSourceCreateRequest,
  type LeadSourceDto,
  type LeadSourcesResponse,
  type RenewalDto,
  type LeadStage,
  type MoneyContext,
  type OfferAddOns,
  type OfferDto,
  type OfferInput,
  type PublicRateCard,
  type SpeakingVoiceDto,
  type StyleCard,
  type ThreadState,
  type VoicePreviewRequest,
  type VoicePreviewResponse,
  type VoiceRuleDto,
  type VoiceRuleScope,
  type VoiceRuleStatus,
  type VoiceSampleDto,
  type VoiceStudio,
} from "@dealdock/core";
import {
  applyChip, applyInstruction, asEmail, baseDraft, DAY, dealDraft, DEMO_ACCOUNT_ID, DEMO_ACCOUNTS, DEMO_BILL_TO, DEMO_BILLING, DEMO_CREATOR, DEMO_EMAIL_INBOX, DEMO_GOAL_MINOR, DEMO_LEAK_BASELINE_MINOR, demoPdf,
  DEMO_MONEY, DEMO_SCAN_COMMERCE, DEMO_SCANNED, DEMO_TIMEZONE, HOUR, learnedSignals, measureStyle, MINUTE, offerFor, SAMPLE_INBOUND,
  saleConversation, SEED_SALES, SEED_THREADS, seedOffers, seedRules, seedSamples, styleCardFrom, suggestDealFrom, toneWav, wavDataUrl, wavDurationMs,
  WEEKLY_MATCH, WEEKLY_SENT, type DraftSubject, type SeedThread,
} from "./demo-data";
import { invoiceDueDefault, liveInvoices, usagePriceFor, whoFrom } from "./deals";
import { leadPaymentsOf, leadSourcesView, seedPipeline, type DemoLeadEvent } from "./demo-pipeline";
import { commentReplyDraft, seedCommentKeywords, seedCommentLeads } from "./demo-comment-leads";
import { isCommerceLabel, labelNoun } from "./format";
import { emptySnapshot, failed, IDLE, ready } from "./snapshot";
import type {
  AppSnapshot, AppStoreApi, BillingView, CommentLeadsView, DashboardView, DataSummary, DemoLedgerEntry, DemoMessage, DemoThread, EmailAccountView, EmailInboxes,
  LeakScanSummary, LedgerView, MeView, NotificationPrefs, OnboardingInput, OnboardingView, RegionInput, RosterRow, RuleInput,
  SeatView, SendResult, SettingsView, SliceKey,
} from "./types";

/**
 * Demo mode: the whole product loop in the browser on fictional data — no
 * API, no keys. It publishes the same AppSnapshot shape as the API store
 * (rows are row-shaped, details come from `details`), so a screen verified
 * here behaves the same live. Build-time only; never a fallback.
 */

/** A stored demo conversation: the view-model plus the follow-up clock the API keeps server-side. */
type DemoRecord = DemoThread & { nudgeDismissedAt: number | null };
/** Billing details as the API stores them: the workspace's (igAccountId null) or a creator's own, with its numbering. */
interface DemoBillingProfile { igAccountId: string | null; input: BillingProfileInput; numberYear: string; nextNumber: number; updatedAt: string }

type Listener = () => void;
const STORAGE_KEY = "dealdock-demo-v2";
const ACTOR = { seatId: "seat-diya", name: DEMO_CREATOR.name, role: "creator" };
const MANAGER = { seatId: "seat-kabir", name: "Kabir Rao", role: "manager" };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The stage moves the API allows (paid is only entered by marking paid, and left only by deleting its sale). */
const STAGE_MOVES: Record<DealDto["stage"], ReadonlyArray<DealDto["stage"]>> = { agreed: ["invoiced", "cancelled"], invoiced: ["agreed", "cancelled"], cancelled: ["agreed"], paid: [] };

interface DemoState {
  /** Bumped when stored rows change meaning (3: canonical audit action names), so older sessions re-seed. */
  version: 3;
  threads: DemoRecord[];
  missingFacts: Record<string, string[]>;
  ledger: DemoLedgerEntry[];
  offers: OfferDto[];
  rules: VoiceRuleDto[];
  samples: VoiceSampleDto[];
  overrides: Partial<StyleCard>;
  /** Per Instagram account, as in the API. Sessions saved before this field existed lack it. */
  learningPausedBy?: Record<string, boolean>;
  /** Deals, newest first. Sessions saved before deals existed lack it; restore seeds them. */
  deals?: DealDto[];
  /** Save idempotency key → deal id, so a retried save resolves to the same deal. */
  dealKeys?: Record<string, string>;
  /** Connected Gmail inboxes. Sessions saved before email existed lack it; restore adds the demo inbox and email threads. */
  emailAccounts?: EmailAccountView[];
  /** Billing details for invoices. Sessions saved before invoices lack it; restore adds the workspace's and the sample invoices. */
  billingProfiles?: DemoBillingProfile[];
  /** Booking and payment tools and what they reported (coach pipeline). Sessions saved before them lack these; restore seeds them. */
  leadSources?: LeadSourceDto[];
  leadEvents?: DemoLeadEvent[];
  /** Comment keywords by Instagram account, and the leads they caught. Sessions saved before comment leads lack both; restore seeds them. */
  commentKeywords?: Record<string, string[]>;
  commentLeads?: CommentLeadDto[];
  refreshedAt: string;
  lastDistilledAt: string;
  consent: Record<string, { granted: boolean; consentedAt: string | null; revokedAt: string | null }>;
  speaking: SpeakingVoiceDto;
  sentThisSession: number;
  settings: SettingsView;
  audit: AuditRow[];
  prefs: NotificationPrefs;
  billing: BillingView;
  seats: SeatView[];
  ignoreList: string[];
  businessContext: Record<string, unknown>;
  onboarded: boolean;
  leakScanStartedAt: number | null;
  usedCloseKeys: string[];
  joinedAt: number;
  money: MoneyContext;
}

class DemoStore implements AppStoreApi {
  private state: DemoState | null = null;
  private listeners = new Set<Listener>();
  private snapshotCache: AppSnapshot | null = null;
  private requested = new Set<SliceKey>();
  private detailIds = new Set<string>();
  private ledgerMonth: string | null = null;
  private ledgerAccount: string | null = null;
  private ledgerAccountInvalid = false;
  private dealsQuery: { status?: "open" | "all"; igAccountId?: string } = {};
  private billingAccount: string | null = null;
  private insightsMonths = 6;
  private auditLimit = 100;
  private voiceAccount = DEMO_ACCOUNT_ID;
  private initializing: Promise<void> | null = null;

  init() {
    if (!this.initializing) {
      this.initializing = Promise.resolve().then(() => {
        this.state = this.restore() ?? seed(Date.now());
        this.emit();
      });
    }
    return this.initializing;
  }
  async refresh() { await this.init(); this.emit(); }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getSnapshot = (): AppSnapshot => {
    if (!this.snapshotCache) this.snapshotCache = this.state ? this.project(this.state, Date.now()) : emptySnapshot("idle", 1);
    return this.snapshotCache;
  };

  private emit() {
    this.snapshotCache = null;
    this.persist();
    this.listeners.forEach((fn) => fn());
  }
  private get s(): DemoState {
    if (!this.state) this.state = this.restore() ?? seed(Date.now());
    return this.state;
  }
  private thread(id: string): DemoRecord | undefined {
    return this.s.threads.find((thread) => thread.id === id || thread.classificationId === id);
  }
  /** Audit rows carry the API's own action names (AUDIT_ACTIONS), so Activity reads the same in both modes. */
  private audit(action: AuditAction, extra: Partial<AuditRow> = {}, actor = ACTOR) {
    this.s.audit.unshift({ id: `audit-${Date.now()}-${this.s.audit.length}`, at: new Date().toISOString(), action, actor, threadId: null, handle: null, editDistance: null, originalDraft: null, finalText: null, asVoice: false, ...extra });
  }
  /** The API's follow-up rule (isNudgeDue in @dealdock/core) on this conversation's clock and the org's delay. */
  private nudgeDue(thread: DemoRecord, now: number): boolean {
    const lastOutbound = [...thread.messages].reverse().find((message) => message.direction === "outbound");
    return isNudgeDue({ state: thread.state, waitingSince: thread.waitingSince, lastOutboundAt: lastOutbound?.sentAt ?? null, nudgeDismissedAt: thread.nudgeDismissedAt }, this.s.settings.nudgeDelayDays, now);
  }

  // ── Projection: the same shapes the API store publishes ────────────────

  private project(state: DemoState, now: number): AppSnapshot {
    const decorated = state.threads.map((thread) => this.decorate(thread, now));
    const rows = decorated
      .filter((thread) => (thread.routedTo === "inbox" ? thread.state !== "closed" && isCommerceLabel(thread.topLabel) : !thread.reviewed))
      .map(rowOf);
    const currentMonth = monthKey(now);
    const ledger = state.ledger.filter((entry) => monthKey(entry.closedAt) === currentMonth);
    const details: AppSnapshot["details"] = {};
    for (const id of this.detailIds) {
      const thread = decorated.find((item) => item.id === id);
      details[id] = thread ? ready(thread) : failed(IDLE, "This isn't available. It may belong to another account or have been removed.", 404);
    }
    const has = (key: SliceKey) => this.requested.has(key);
    return {
      ...emptySnapshot("ready", 1),
      threads: rows,
      ledger,
      money: state.money,
      timezone: state.settings.timezone,
      workspaceName: DEMO_CREATOR.workspace,
      dashboard: dashboardOf(ledger),
      onboarded: state.onboarded,
      state: "ready",
      loadedAt: now,
      details,
      closed: has("closed") ? ready(decorated.filter((thread) => thread.state === "closed").map(rowOf).sort((a, b) => b.lastMessageAt - a.lastMessageAt)) : IDLE,
      ledgerView: this.ledgerAccountInvalid ? failed(IDLE, "Creator not found.", 404) : ready(ledgerViewOf(state, this.ledgerMonth ?? currentMonth, this.ledgerAccount)),
      emailAccounts: has("emailAccounts") ? ready({ accounts: state.emailAccounts ?? [], available: true }) : IDLE,
      commentLeads: has("commentLeads") ? ready(commentLeadsOf(state)) : IDLE,
      deals: has("deals") ? ready((state.deals ?? []).filter((deal) => (this.dealsQuery.status === "all" || isDealOpen(deal)) && (!this.dealsQuery.igAccountId || deal.igAccountId === this.dealsQuery.igAccountId)).map((deal) => withPaid(deal, state.ledger))) : IDLE,
      // The API's rule (core renewalsDue) on the org's calendar.
      renewals: has("renewals") ? ready(renewalsDue((state.deals ?? []).map((deal) => withPaid(deal, state.ledger)), now, state.settings.timezone).map(({ deal, festive }) => ({ deal, festive }))) : IDLE,
      leadSources: has("leadSources") ? ready(leadSourcesView(state.leadSources ?? [], state.leadEvents ?? [])) : IDLE,
      billingProfile: has("billingProfile") ? ready(billingOf(state, this.billingAccount, now)) : IDLE,
      insights: has("insights") ? ready(insightsOf(state, decorated, now, this.insightsMonths)) : IDLE,
      offers: has("offers") ? ready([...state.offers].sort((a, b) => a.sortOrder - b.sortOrder)) : IDLE,
      voice: has("voice") ? ready(this.studio(state, now)) : IDLE,
      audit: has("audit") ? ready(state.audit.slice(0, this.auditLimit)) : IDLE,
      settings: has("settings") ? ready(state.settings) : IDLE,
      me: has("me") ? ready<MeView>({ clerkUserId: "user_demo", orgId: "org_demo", role: "creator", name: DEMO_CREATOR.name, email: DEMO_CREATOR.email, tier: state.settings.tier }) : IDLE,
      notificationPrefs: has("notificationPrefs") ? ready(state.prefs) : IDLE,
      billing: has("billing") ? ready(state.billing) : IDLE,
      seats: has("seats") ? ready(state.seats) : IDLE,
      roster: has("roster") ? ready(rosterOf(state, decorated, ledger)) : IDLE,
      onboarding: has("onboarding") ? ready(this.onboardingView(state)) : IDLE,
      ignoreList: has("ignoreList") ? ready(state.ignoreList) : IDLE,
      dataSummary: has("dataSummary") ? ready(dataSummaryOf(state)) : IDLE,
    };
  }

  /** Recomputes the time- and state-derived fields of one thread; the stored clock stays out of what screens see. */
  private decorate(record: DemoRecord, now: number): DemoThread {
    const state = this.s;
    const { nudgeDismissedAt: _clock, ...thread } = record;
    // Sessions saved before email existed have no channel: they were all Instagram.
    const channel = thread.channel ?? "instagram";
    const inboundAt = thread.lastInboundAt === null ? null : new Date(thread.lastInboundAt);
    const replyWindow = channel === "email" ? noReplyWindow(inboundAt) : computeReplyWindow(inboundAt, new Date(now), state.settings.humanAgentEnabled);
    const last = thread.messages[thread.messages.length - 1];
    const lastInbound = [...thread.messages].reverse().find((message) => message.direction === "inbound");
    const closed = state.ledger.filter((entry) => entry.handle === thread.handle);
    const deals = (state.deals ?? []).filter((deal) => deal.threadId === thread.id).map((deal) => withPaid(deal, state.ledger));
    // As the API: a sale or deal recorded at/after the closing message answers its "looks like a deal" prompt.
    const signalAt = thread.dealSignal ? thread.messages.find((message) => message.id === thread.dealSignal!.messageId)?.sentAt ?? null : null;
    const recorded = [...state.ledger.filter((entry) => entry.threadId === thread.id).map((entry) => entry.closedAt), ...deals.map((deal) => Date.parse(deal.agreedAt))];
    const dealSignal = signalAt !== null && recorded.some((at) => at >= signalAt) ? null : thread.dealSignal;
    return {
      ...thread,
      channel,
      subject: thread.subject ?? null,
      scamReason: checkScam(lastInbound ? lastInbound.text || lastInbound.audio?.transcript : null).reason,
      replyWindow,
      dealSignal,
      nudgeDue: this.nudgeDue(record, now),
      draftReady: thread.draft !== null,
      hasAudio: thread.messages.some((message) => message.contentType === "audio"),
      hasDealSignal: dealSignal !== null && thread.state !== "closed",
      preview: last ? (last.contentType === "audio" ? last.audio?.transcript ?? "" : last.text) : "",
      previewOutbound: last?.direction === "outbound",
      messageCount: thread.messages.length,
      lastMessageAt: last?.sentAt ?? thread.lastMessageAt,
      canSendVoice: channel === "instagram" && state.speaking.status === "ready" && replyWindow.status !== "closed",
      participant: { ...thread.participant, closedTotalMinor: closed.reduce((sum, entry) => sum + entry.amountMinor, 0), closedDeals: closed.length },
      closedDeals: state.ledger.filter((entry) => entry.threadId === thread.id).map((entry) => ({ id: entry.id, amountMinor: entry.amountMinor, currencyCode: state.money.currency, dealType: entry.dealType, note: entry.note ?? null, closedAt: new Date(entry.closedAt).toISOString() })),
      deals,
      leadStage: thread.leadStage ?? null,
      leadPayments: leadPaymentsOf(state.leadEvents ?? [], thread.id),
      // As the API: a brand conversation shows this creator's running exclusivities with other brands.
      exclusivities: thread.topLabel === "brand_deal" ? exclusivitiesAgainst(state.deals ?? [], { igAccountId: thread.igAccountId ?? DEMO_ACCOUNT_ID, counterpartyHandle: thread.handle }, now) : [],
    };
  }

  private studio(state: DemoState, now: number): VoiceStudio {
    const account = DEMO_ACCOUNTS.find((item) => item.id === this.voiceAccount) ?? DEMO_ACCOUNTS[0]!;
    const consent = state.consent[account.id] ?? { granted: false, consentedAt: null, revokedAt: null };
    const primary = account.id === DEMO_ACCOUNT_ID && consent.granted;
    const included = primary ? state.samples.filter((sample) => !sample.excluded).map((sample) => sample.text) : [];
    const scoped = (scope: VoiceRuleScope, pattern: RegExp) => measureStyle(included.filter((text) => pattern.test(text)), scope);
    const weekStart = mondayOf(now);
    const sentCount = primary ? 86 + state.sentThisSession : 0;
    return {
      igAccountId: account.id,
      handle: account.handle,
      accounts: DEMO_ACCOUNTS,
      consent,
      learningPaused: state.learningPausedBy?.[account.id] ?? false,
      refreshedAt: primary ? state.refreshedAt : null,
      lastDistilledAt: primary ? state.lastDistilledAt : null,
      styleCard: included.length >= 3 ? styleCardFrom(included) : null,
      overrides: primary ? state.overrides : {},
      measured: included.length ? [
        measureStyle(included, "all"),
        scoped("brand_deal", /rate|brief|collab|deliverables/i),
        scoped("coaching_lead", /slot|weeks|coaching|fees/i),
        scoped("course_inquiry", /batch|cohort|recorded|link/i),
        scoped("nudge", /circling|update/i),
      ] : [],
      rules: primary ? state.rules : [],
      samples: primary ? state.samples : [],
      metrics: primary ? {
        sentCount,
        voiceMatchPct: WEEKLY_MATCH[WEEKLY_MATCH.length - 1]!,
        sentAsIsPct: 41,
        avgEditRatio: 0.16,
        weekly: WEEKLY_MATCH.map((pct, index) => ({
          weekStart: new Date(weekStart - (WEEKLY_MATCH.length - 1 - index) * 7 * DAY).toISOString(),
          sent: WEEKLY_SENT[index]! + (index === WEEKLY_MATCH.length - 1 ? state.sentThisSession : 0),
          voiceMatchPct: pct,
        })),
        byLabel: [
          { label: "brand_deal", sent: 9, voiceMatchPct: 71 },
          { label: "coaching_lead", sent: 14, voiceMatchPct: 79 },
          { label: "course_inquiry", sent: 6, voiceMatchPct: 83 },
          { label: "other_commerce", sent: 3, voiceMatchPct: 67 },
          { label: "nudge", sent: 4, voiceMatchPct: 75 },
        ],
      } : { sentCount: 0, voiceMatchPct: null, sentAsIsPct: null, avgEditRatio: null, weekly: [], byLabel: [] },
      speaking: primary ? state.speaking : { status: "none", provider: null, consentedAt: null, sampleSeconds: 0, disclosureEnabled: true, lastError: null, createdAt: null },
      speechAvailable: state.settings.speechAvailable,
    };
  }

  private onboardingView(state: DemoState): OnboardingView {
    return {
      currencyCode: state.money.currency,
      locale: state.money.locale ?? "en-IN",
      timezone: state.settings.timezone,
      businessContext: state.businessContext,
      igAccounts: state.settings.accounts.map((account) => ({ id: account.id, handle: account.handle, voice: { enabled: true, consentedAt: state.consent[account.id]?.consentedAt ?? null, revokedAt: state.consent[account.id]?.revokedAt ?? null } })),
      voiceConsent: state.settings.voiceConsent,
      complete: state.onboarded,
    };
  }

  // ── Persistence (demo only; sessionStorage, never tenant data) ─────────

  private persist() {
    if (!this.state) return;
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* storage full/unavailable — demo continues in memory */ }
  }
  private restore(): DemoState | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as DemoState;
      // Validate before trusting persisted data; any drift re-seeds instead of rendering a poisoned row.
      const valid = data.version === 3 && Array.isArray(data.threads) && data.threads.every((thread) => typeof thread?.id === "string" && Array.isArray(thread.messages) && thread.participant && thread.replyWindow)
        && Array.isArray(data.ledger) && Array.isArray(data.offers) && Array.isArray(data.rules) && Array.isArray(data.samples) && Boolean(data.settings)
        && (data.deals === undefined || (Array.isArray(data.deals) && data.deals.every((deal) => typeof deal?.id === "string" && Boolean(deal.terms))));
      if (!valid) return null;
      // A session saved before deals existed keeps its data and gains the sample deals.
      data.deals ??= seedDeals(Date.now(), data.threads, data.ledger);
      // One saved before email gains the demo inbox and the seed conversations it lacks (the email threads, the scam DM).
      if (data.emailAccounts === undefined) {
        const now = Date.now();
        data.emailAccounts = seedEmailAccounts(now);
        for (const item of SEED_THREADS) if (!data.threads.some((thread) => thread.id === item.id)) data.threads.push(seedThread(item, now));
      }
      // One saved before invoices gains the billing details and the sample invoices.
      data.billingProfiles ??= [seedInvoices(Date.now(), data)];
      // One saved before the coach pipeline gains the sample tools, reports, stages and renewal.
      if (data.leadSources === undefined || data.leadEvents === undefined) {
        const pipeline = seedPipeline(Date.now(), data);
        data.leadSources = pipeline.sources;
        data.leadEvents = pipeline.events;
      }
      // One saved before comment leads gains the sample keywords and leads.
      data.commentKeywords ??= seedCommentKeywords();
      data.commentLeads ??= seedCommentLeads(Date.now(), data.offers, data.money);
      return data;
    } catch {
      return null;
    }
  }

  // ── Threads ────────────────────────────────────────────────────────────

  async loadThread(threadId: string) {
    await this.init();
    this.detailIds.add(threadId);
    this.emit();
    return this.getSnapshot().details[threadId]?.data ?? null;
  }
  async loadClosed() {
    await this.init();
    this.requested.add("closed");
    this.emit();
    return this.getSnapshot().closed.data;
  }

  async generateDraft(threadId: string, request: DraftRequest = {}) {
    await this.init();
    await wait(650);
    const thread = this.thread(threadId);
    if (!thread) throw demoError(404, "not_found", "This isn't available. It may belong to another account or have been removed.");
    const consent = this.s.consent[thread.igAccountId ?? DEMO_ACCOUNT_ID];
    if (!consent?.granted) throw demoError(409, "voice_consent_required", "Drafts need permission to learn from your sent replies. Turn it on in Your voice.");
    const purpose = request.purpose ?? null;
    const deal = purpose ? (this.s.deals ?? []).find((item) => item.id === request.dealId && item.threadId === thread.id) : undefined;
    if (purpose && !deal) throw demoError(404, "deal_not_found", "This deal isn't in this conversation any more.");
    // As the API: a cover note goes with an invoice that is still owed.
    const invoice = purpose === "invoice" ? deal?.invoices?.find((item) => item.id === request.invoiceId) : undefined;
    if (purpose === "invoice" && !invoice) throw demoError(404, "not_found", "This invoice isn't on this deal any more.");
    if (invoice && invoice.status !== "issued") throw demoError(409, "invoice_not_open", "This invoice was paid or voided. Draft a new note to send.");
    // As the API: a renewal pitches a brand that already paid.
    if (purpose === "renewal" && deal?.stage !== "paid") throw demoError(409, "deal_not_paid", "Only a paid deal can be pitched again.");
    // Usage rights outlast the payment: a usage note fits any deal that wasn't cancelled.
    if (purpose === "usage_renewal" && deal?.stage === "cancelled") throw demoError(409, "deal_not_open", "This deal was cancelled.");
    // A recap is a reply; a payment reminder, a renewal pitch or a usage note goes out as a follow-up.
    const subject = subjectOf(thread, purpose === "payment_reminder" || purpose === "renewal" || purpose === "usage_renewal" || (!purpose && this.nudgeDue(thread, Date.now())) ? "nudge" : "reply");
    const steering = Boolean(request.chips?.length || request.instruction);
    const email = thread.channel === "email";
    let body = steering && thread.draft ? thread.draft.body
      : purpose && deal ? dealDraft(purpose, withPaid(deal, this.s.ledger), this.s.money, this.s.settings.timezone, Date.now(), invoice, this.s.offers)
      : baseDraft(subject, this.s.offers, this.s.money);
    if (email && !(steering && thread.draft)) body = asEmail(body);
    for (const chip of request.chips ?? []) body = applyChip(body, chip, subject, this.s.offers, this.s.money);
    if (request.instruction) body = applyInstruction(body, request.instruction.slice(0, 200));
    const variants = Math.min(3, Math.max(1, request.variants ?? 1));
    // As the API stores drafts: links to a connected booking or payment tool carry this conversation back.
    const tools = (this.s.leadSources ?? []).map((source) => source.provider);
    const tag = (text: string) => tagLinks(text, threadRef(thread.id), tools);
    body = tag(body);
    const alternatives = variants > 1
      ? [...new Set([body, applyChip(body, "shorter", subject, this.s.offers, this.s.money), applyChip(body, "warmer", subject, this.s.offers, this.s.money), applyChip(body, "longer", subject, this.s.offers, this.s.money)].map(tag))].slice(0, variants)
      : [];
    const draft: DraftDto = {
      id: `d-${thread.id}-${Date.now()}`,
      body,
      kind: subject.kind,
      status: "ready",
      version: (thread.draft?.version ?? 0) + 1,
      label: thread.topLabel,
      instruction: request.instruction ?? null,
      chips: request.chips ?? [],
      alternatives,
      chosenAlternative: alternatives.length ? 0 : null,
      // Offers and price gaps don't shape a recap or a reminder; the deal's own terms do. A usage note without a usage price flags it.
      context: purpose
        ? { ...this.contextFor(thread), offers: [], missingFacts: purpose === "usage_renewal" && deal && usagePriceFor(deal, this.s.offers) === null ? ["your usage-rights price per month"] : [] }
        : this.contextFor(thread),
      purpose,
      invoiceId: invoice?.id ?? null,
      dealId: deal?.id ?? null,
    };
    thread.draft = draft;
    this.emit();
    return draft;
  }
  async chooseAlternative(threadId: string, request: ChooseAlternativeRequest) {
    const thread = this.thread(threadId);
    const draft = thread?.draft;
    if (!thread || !draft || draft.id !== request.draftId || !draft.alternatives[request.alternative]) throw demoError(409, "draft_conflict", "That take is no longer available. Generate a new draft.");
    thread.draft = { ...draft, body: draft.alternatives[request.alternative]!, chosenAlternative: request.alternative };
    this.emit();
    return thread.draft;
  }
  async send(threadId: string, finalText: string, options: { asVoice?: boolean } = {}): Promise<SendResult> {
    await this.init();
    const thread = this.thread(threadId);
    const draft = thread?.draft;
    if (!thread || !draft) throw new Error("A fresh draft is required before you can approve a send.");
    if (!finalText.trim()) throw demoError(400, "send_text_required", "Write a reply before sending.");
    const now = Date.now();
    const window = computeReplyWindow(thread.lastInboundAt === null ? null : new Date(thread.lastInboundAt), new Date(now), this.s.settings.humanAgentEnabled);
    if (thread.channel !== "email" && window.status === "closed") throw demoError(409, "send_window_closed", "Instagram's reply window has closed. Reply from Instagram instead.");
    if (options.asVoice && this.s.speaking.status !== "ready") throw demoError(409, "speaking_voice_not_ready", "Set up your speaking voice before sending voice notes.");
    const invoice = draft.invoiceId ? (this.s.deals ?? []).flatMap((deal) => deal.invoices ?? []).find((item) => item.id === draft.invoiceId) : undefined;
    if (draft.invoiceId && invoice?.status !== "issued") throw demoError(409, "invoice_not_open", "This invoice was paid or voided. Draft a new note to send.");
    if (invoice && options.asVoice) throw demoError(409, "voice_not_supported", "An invoice goes as text with its PDF, not as a voice note.");
    await wait(400);
    const messageId = `m-out-${now}`;
    thread.messages.push({
      id: messageId,
      direction: "outbound",
      text: options.asVoice ? "" : finalText,
      sentAt: now,
      contentType: options.asVoice ? "audio" : "text",
      origin: "dealdock",
      audio: options.asVoice ? demoAudio(finalText, null) : null,
      ...(invoice ? { attachments: [{ partId: invoice.id, filename: `${invoice.number}.pdf`, mimeType: "application/pdf", size: 48_000 }] } : {}),
    });
    thread.draft = null;
    thread.unreplied = false;
    thread.lastMessageAt = now;
    if (thread.state === "waiting") { thread.waitingSince = now; thread.nudgeDismissedAt = null; }
    const distance = editDistance(draft.body, finalText);
    const activeKeys = new Set(this.s.rules.filter((rule) => rule.status !== "candidate").map((rule) => rule.key));
    const learned = learnedSignals(draft.body, finalText, thread.topLabel).filter((signal) => !activeKeys.has(signal.key)).slice(0, 2);
    this.s.sentThisSession += 1;
    this.audit("message.sent", { threadId: thread.id, handle: thread.handle, editDistance: distance, originalDraft: draft.body, finalText, asVoice: Boolean(options.asVoice) });
    // As the API: a renewal pitch that went out answers its prompt.
    const pitched = draft.purpose === "renewal" && draft.dealId ? this.s.deals?.find((deal) => deal.id === draft.dealId && !deal.renewalHandledAt) : undefined;
    if (pitched) this.saveDeal({ ...pitched, renewalHandledAt: new Date(now).toISOString() });
    this.emit();
    return { status: "accepted", sent: true, intentId: `intent-${now}`, messageId, editDistance: distance, learned, pending: false, ambiguous: false, ...(invoice ? { attachmentSent: true } : {}) };
  }
  async setState(threadId: string, state: ThreadState) {
    const thread = this.thread(threadId);
    if (!thread) return;
    thread.state = state;
    thread.waitingSince = state === "waiting" ? Date.now() : null;
    thread.nudgeDismissedAt = null;
    if (state !== "waiting" && thread.draft?.kind === "nudge") thread.draft = null;
    this.audit("thread.state_changed", { threadId: thread.id, handle: thread.handle, finalText: state });
    this.emit();
  }
  async dismissNudge(threadId: string) {
    const thread = this.thread(threadId);
    if (!thread) return;
    // Like the API: keep waiting with a fresh clock, so the next follow-up falls due a full delay from now.
    if (thread.state === "waiting") { thread.waitingSince = Date.now(); thread.nudgeDismissedAt = null; }
    if (thread.draft?.kind === "nudge") thread.draft = null;
    this.audit("nudge.dismissed", { threadId: thread.id, handle: thread.handle });
    this.emit();
  }
  async closeDeal(threadId: string, amountMinor: number, dealType: DealType, options: { note?: string; idempotencyKey?: string } = {}) {
    const thread = this.thread(threadId);
    if (!thread) throw demoError(404, "not_found", "This isn't available. It may belong to another account or have been removed.");
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw demoError(400, "invalid_body", "Enter an amount above zero.");
    const key = options.idempotencyKey ?? `close-${threadId}`;
    if (this.s.usedCloseKeys.includes(key)) return; // same sheet submit twice: recorded once
    this.s.usedCloseKeys.push(key);
    await wait(300);
    thread.state = "closed";
    thread.unreplied = false;
    thread.dealSignal = null;
    const entry: DemoLedgerEntry = { id: `sale-${Date.now()}`, threadId: thread.id, channel: thread.channel ?? "instagram", handle: thread.handle, dealType, amountMinor, closedAt: Date.now(), note: options.note || undefined };
    this.s.ledger.unshift(entry);
    this.audit("ledger.created", { threadId: thread.id, handle: thread.handle });
    this.emit();
  }
  async review(id: string, outcome: "confirmed" | "overridden", label?: ClassificationLabel) {
    const thread = this.thread(id);
    if (!thread) return;
    const classification = thread.messages[0]?.classification;
    const effective = outcome === "overridden" && label ? label : (classification?.label ?? "uncertain");
    thread.reviewed = true;
    thread.routedTo = "inbox";
    thread.topLabel = effective;
    if (classification) { classification.label = effective; classification.reviewedAt = new Date().toISOString(); }
    this.audit("classification.reviewed", { threadId: thread.id, handle: thread.handle, finalText: effective });
    this.emit();
  }

  // ── Ledger, insights, audit ────────────────────────────────────────────

  async loadLedger(month?: string, igAccountId?: string) {
    await this.init();
    this.ledgerAccountInvalid = Boolean(igAccountId && !this.s.settings.accounts.some((account) => account.id === igAccountId));
    this.ledgerMonth = month ?? null;
    this.ledgerAccount = igAccountId ?? null;
    this.emit();
    return this.getSnapshot().ledgerView.data;
  }
  async updateLedger(entryId: string, body: Partial<Pick<DemoLedgerEntry, "amountMinor" | "dealType" | "note">>) {
    const entry = this.s.ledger.find((item) => item.id === entryId);
    if (!entry) throw demoError(404, "not_found", "This sale isn't in the record any more.");
    if (body.amountMinor !== undefined && (!Number.isSafeInteger(body.amountMinor) || body.amountMinor <= 0)) throw demoError(400, "invalid_body", "Enter an amount above zero.");
    Object.assign(entry, body);
    this.audit("ledger.updated", { threadId: entry.threadId, handle: entry.handle });
    this.emit();
  }
  async deleteLedger(entryId: string) {
    const entry = this.s.ledger.find((item) => item.id === entryId);
    this.s.ledger = this.s.ledger.filter((item) => item.id !== entryId);
    // As the API: a deal's payment entry going reopens the deal (and the invoice it paid), since the money no longer stands.
    const owner = entry?.dealId ? this.s.deals?.find((item) => item.id === entry.dealId) : undefined;
    if (owner) {
      const invoices = owner.invoices?.map((item) => (item.id === entry?.invoiceId && item.status === "paid" ? { ...item, status: "issued" as const, paidAt: null, receivedMinor: null, tdsMinor: null } : item));
      this.saveDeal({ ...owner, invoices, ...(owner.stage === "paid" ? { stage: owner.invoicedAt ? "invoiced" as const : "agreed" as const, paidAt: null, receivedMinor: null, tdsMinor: null } : {}), updatedAt: new Date().toISOString() });
    }
    if (entry) this.audit("ledger.deleted", { threadId: entry.threadId, handle: entry.handle });
    this.emit();
  }
  async download(path: string, fallbackName: string) {
    if (typeof document === "undefined") return;
    const state = this.s;
    const request = new URL(path, "http://demo.local");
    const account = request.searchParams.get("igAccountId");
    const month = request.searchParams.get("month");
    if (request.pathname === "/ledger/export.csv" && account && !state.settings.accounts.some((item) => item.id === account)) throw demoError(404, "ig_account_not_in_org", "Creator not found.");
    const selected = scopedLedger(state, account).filter((entry) => !month || monthKey(entry.closedAt) === month);
    // No PDF renderer in the browser: an invoice downloads as a clearly labelled placeholder, like an email attachment.
    const attachment = request.pathname.startsWith("/email/messages/") || /^\/invoices\/[^/]+\/pdf$/.test(request.pathname);
    const body = attachment ? demoPdf(fallbackName) : request.pathname === "/ledger/export.csv"
      ? ["date,handle,deal_type,amount_minor,currency,note", ...selected.map((entry) => [new Date(entry.closedAt).toISOString().slice(0, 10), whoFrom(entry.handle, entry.threadId !== null), entry.dealType, String(entry.amountMinor), state.money.currency, entry.note ?? ""].map(csvCell).join(","))].join("\n")
      : JSON.stringify({ exportedAt: new Date().toISOString(), demo: true, ledger: state.ledger, deals: state.deals ?? [], invoices: (state.deals ?? []).flatMap((deal) => deal.invoices ?? []), billingProfiles: (state.billingProfiles ?? []).map((profile) => profileDto(profile, state.settings.timezone, Date.now())), emailInboxes: dataSummaryOf(state).emailInboxes, threads: state.threads.map((thread) => ({ handle: thread.handle, messages: thread.messages.map((message) => ({ direction: message.direction, text: message.text, sentAt: message.sentAt })) })) }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: attachment ? "application/pdf" : request.pathname.endsWith(".csv") ? "text/csv" : "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fallbackName;
    link.click();
    URL.revokeObjectURL(url);
  }
  async loadInsights(months = 6) {
    await this.init();
    this.insightsMonths = months;
    this.requested.add("insights");
    this.emit();
    return this.getSnapshot().insights.data;
  }
  async setGoal(monthlyGoalMinor: number | null) {
    if (monthlyGoalMinor !== null && (!Number.isSafeInteger(monthlyGoalMinor) || monthlyGoalMinor <= 0)) throw demoError(400, "invalid_body", "Enter a goal above zero.");
    this.s.settings = { ...this.s.settings, monthlyGoalMinor };
    this.audit("settings.goal_changed");
    this.emit();
  }
  async loadAudit(limit = 100) {
    await this.init();
    this.auditLimit = limit;
    this.requested.add("audit");
    this.emit();
    return this.getSnapshot().audit.data;
  }

  // ── Deals ──────────────────────────────────────────────────────────────

  async loadDeals(options: { status?: "open" | "all"; igAccountId?: string } = {}) {
    await this.init();
    this.dealsQuery = options;
    this.requested.add("deals");
    this.emit();
    return this.getSnapshot().deals.data;
  }
  private deal(dealId: string): DealDto {
    const deal = (this.s.deals ?? []).find((item) => item.id === dealId);
    if (!deal) throw demoError(404, "not_found", "This deal isn't in DealDock any more.");
    return deal;
  }
  /** Deals are replaced, never edited in place, so an earlier snapshot keeps what it showed. */
  private saveDeal(deal: DealDto) {
    const deals = this.s.deals ?? [];
    this.s.deals = deals.some((item) => item.id === deal.id) ? deals.map((item) => (item.id === deal.id ? deal : item)) : [deal, ...deals];
  }
  private dealTerms(input: unknown, base?: DealTerms): DealTerms {
    try { return normalizeDealTerms(input, base); } catch { throw demoError(400, "invalid_body", "Check the deal terms: numbers and dates must be valid."); }
  }
  /**
   * A deal marked paid for what its paid invoices left (all of it without
   * invoices), or the API's 400 for amounts and dates it refuses. The deal's
   * totals include what its invoices brought in; revenueMinor is this payment.
   */
  private paidDeal(deal: DealDto, input: DealPaidInput, at: string): { deal: DealDto; revenueMinor: number } {
    const settled = (deal.invoices ?? []).filter((invoice) => invoice.status === "paid");
    const sum = (pick: (invoice: InvoiceDto) => number | null) => settled.reduce((total, invoice) => total + (pick(invoice) ?? 0), 0);
    const tdsMinor = input.tdsMinor ?? null;
    const receivedMinor = input.receivedMinor ?? defaultReceivedMinor(deal.amountMinor - sum((invoice) => invoice.subtotalMinor), tdsMinor);
    const amount = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);
    if (!amount(tdsMinor) || !amount(receivedMinor) || receivedMinor + (tdsMinor ?? 0) <= 0) throw demoError(400, "invalid_body", "Enter what you received.");
    const paidAt = input.paidAt ?? at;
    if (!Number.isFinite(Date.parse(paidAt)) || Date.parse(paidAt) > Date.now() + MINUTE) throw demoError(400, "invalid_body", "Choose the day it was paid: today or earlier.");
    const tds = tdsMinor === null && !settled.some((invoice) => invoice.tdsMinor !== null) ? null : (tdsMinor ?? 0) + sum((invoice) => invoice.tdsMinor);
    return { deal: { ...deal, stage: "paid", paidAt, receivedMinor: receivedMinor + sum((invoice) => invoice.receivedMinor), tdsMinor: tds, updatedAt: at }, revenueMinor: receivedMinor + (tdsMinor ?? 0) };
  }
  /** One Revenue entry per payment: the gross the payer paid, TDS included (less GST/VAT for an invoice). */
  private recordRevenue(deal: DealDto, amountMinor: number, paidAt: string, invoice?: InvoiceDto) {
    this.s.ledger.unshift(revenueEntry(deal, amountMinor, paidAt, invoice));
    if (invoice) this.audit("invoice.paid", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    if (deal.stage === "paid") this.audit("deal.paid", { threadId: deal.threadId, handle: deal.counterpartyHandle });
  }
  async createDeal(request: DealCreateRequest) {
    await this.init();
    // A deal agreed outside DealDock has no conversation: it names its creator and who it's with.
    const thread = request.threadId ? this.thread(request.threadId) : undefined;
    if (request.threadId && !thread) throw demoError(404, "not_found", "This isn't available. It may belong to another account or have been removed.");
    if (!thread && !this.s.settings.accounts.some((account) => account.id === request.igAccountId)) throw demoError(404, "ig_account_not_in_org", "That creator isn't in this workspace.");
    if (!thread && !request.counterpartyHandle?.trim()) throw demoError(400, "invalid_body", "Say who the deal is with.");
    const retried = this.s.dealKeys?.[request.idempotencyKey];
    const existing = retried ? this.s.deals?.find((item) => item.id === retried) : undefined;
    if (existing) return withPaid(existing, this.s.ledger);
    if (!request.title.trim()) throw demoError(400, "invalid_body", "Say what the deal is for.");
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) throw demoError(400, "invalid_body", "Enter an amount above zero.");
    const at = new Date().toISOString();
    const agreed: DealDto = {
      id: `deal-${Date.now()}`, threadId: thread?.id ?? null, igAccountId: thread ? thread.igAccountId ?? DEMO_ACCOUNT_ID : request.igAccountId!,
      counterpartyHandle: thread?.handle ?? request.counterpartyHandle!.trim(), counterpartyName: thread ? thread.participant.name : request.counterpartyName?.trim() || null,
      channel: thread ? thread.channel ?? "instagram" : null, title: request.title.trim(), dealType: request.dealType, amountMinor: request.amountMinor, currencyCode: this.s.money.currency, stage: "agreed",
      terms: this.dealTerms(request.terms), agreedAt: at, dueAt: request.dueAt ?? null, invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null, createdAt: at, updatedAt: at, invoices: [],
    };
    const paid = request.paid ? this.paidDeal(agreed, request.paid, at) : null;
    const deal = paid?.deal ?? agreed;
    await wait(300);
    this.saveDeal(deal);
    this.s.dealKeys = { ...this.s.dealKeys, [request.idempotencyKey]: deal.id };
    if (thread) {
      // Recording a deal closes the conversation, as recording a sale does.
      thread.state = "closed";
      thread.unreplied = false;
      thread.waitingSince = null;
      thread.dealSignal = null;
    }
    this.audit("deal.created", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    // As the API: recording the sale a payment tool reported in this conversation handles that payment.
    const reported = request.leadEventId && thread ? this.s.leadEvents?.find((event) => event.id === request.leadEventId && event.threadId === thread.id && !event.handledAt) : undefined;
    if (reported) reported.handledAt = at;
    if (paid) this.recordRevenue(deal, paid.revenueMinor, deal.paidAt!);
    this.emit();
    return withPaid(deal, this.s.ledger);
  }
  async updateDeal(dealId: string, patch: DealUpdateRequest) {
    await this.init();
    const deal = this.deal(dealId);
    if (patch.title !== undefined && !patch.title.trim()) throw demoError(400, "invalid_body", "Say what the deal is for.");
    if (patch.amountMinor !== undefined && (!Number.isSafeInteger(patch.amountMinor) || patch.amountMinor <= 0)) throw demoError(400, "invalid_body", "Enter an amount above zero.");
    const stage = patch.stage && patch.stage !== deal.stage ? patch.stage : undefined;
    if (stage && !STAGE_MOVES[deal.stage].includes(stage)) throw demoError(409, "deal_stage_change_not_allowed", "This deal can't move to that stage from where it is.");
    const moneyChanged = (patch.amountMinor !== undefined && patch.amountMinor !== deal.amountMinor) || (patch.dealType !== undefined && patch.dealType !== deal.dealType);
    if (moneyChanged && !isDealOpen({ stage: stage ?? deal.stage })) throw demoError(409, "deal_not_open", "This deal is paid or cancelled, so its amount can't change.");
    // Invoices bill shares of this fee: void them before changing it.
    if (stage === "cancelled" && deal.invoices?.some((invoice) => invoice.status === "issued")) throw demoError(409, "void_invoices_first", "This deal has an unpaid invoice. Void it before cancelling the deal.");
    if (patch.amountMinor !== undefined && patch.amountMinor !== deal.amountMinor && liveInvoices(deal).length) throw demoError(409, "deal_has_invoices", "This deal has invoices. Void them before changing the amount.");
    const at = new Date().toISOString();
    const terms = patch.terms ? this.dealTerms(patch.terms, deal.terms) : deal.terms;
    const dueAt = patch.dueAt !== undefined ? patch.dueAt : deal.dueAt;
    const next: DealDto = {
      ...deal,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.dealType ? { dealType: patch.dealType } : {}),
      ...(patch.amountMinor !== undefined ? { amountMinor: patch.amountMinor } : {}),
      terms,
      dueAt,
      // As the API: asking for payment stamps it and, with no due date, dates it from the agreed payment days; back to agreed clears the stamp.
      ...(stage === "invoiced" ? { stage, invoicedAt: at, dueAt: dueAt ?? (terms.paymentDays !== null ? dueFromPaymentDays(at, terms.paymentDays) : null) } : {}),
      ...(stage === "agreed" ? { stage, invoicedAt: null } : {}),
      ...(stage === "cancelled" ? { stage } : {}),
      updatedAt: at,
    };
    this.saveDeal(next);
    this.audit("deal.updated", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    this.emit();
    return { ...next };
  }
  async markDealPaid(dealId: string, request: DealPaidRequest) {
    await this.init();
    const deal = this.deal(dealId);
    // One Revenue entry per deal: a retry of the same payment returns the deal, any other is refused.
    const key = `paid:${request.idempotencyKey}`;
    if (deal.stage === "paid") {
      if (this.s.dealKeys?.[key] === deal.id) return { ...deal };
      throw demoError(409, "deal_already_paid", "This deal is already marked paid.");
    }
    if (!isDealOpen(deal)) throw demoError(409, "deal_not_open", "This deal was cancelled, so it can't be paid.");
    if (deal.invoices?.some((invoice) => invoice.status === "issued")) throw demoError(409, "deal_has_open_invoices", "This deal has an unpaid invoice. Mark that invoice paid instead.");
    const paid = this.paidDeal(deal, request, new Date().toISOString());
    await wait(300);
    this.saveDeal(paid.deal);
    this.s.dealKeys = { ...this.s.dealKeys, [key]: deal.id };
    this.recordRevenue(paid.deal, paid.revenueMinor, paid.deal.paidAt!);
    this.emit();
    return withPaid(paid.deal, this.s.ledger);
  }
  async deleteDeal(dealId: string) {
    await this.init();
    const deal = this.deal(dealId);
    this.s.deals = (this.s.deals ?? []).filter((item) => item.id !== dealId);
    this.audit("deal.deleted", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    // As the API: the deal's Revenue entries (every paid invoice, or its one payment) go with it.
    for (const sale of this.s.ledger.filter((entry) => entry.dealId === dealId)) this.audit("ledger.deleted", { threadId: sale.threadId, handle: sale.handle });
    this.s.ledger = this.s.ledger.filter((entry) => entry.dealId !== dealId);
    this.emit();
  }
  // ── Invoices and billing details ───────────────────────────────────────

  async loadBillingProfile(igAccountId?: string) {
    await this.init();
    this.billingAccount = igAccountId ?? null;
    this.requested.add("billingProfile");
    this.emit();
    return this.getSnapshot().billingProfile.data;
  }
  async saveBillingProfile(input: BillingProfileInput, igAccountId?: string) {
    await this.init();
    const parsed = BillingProfileInputSchema.safeParse(input);
    if (!parsed.success) throw Object.assign(demoError(400, "invalid_body", "Check the highlighted fields."), { detail: parsed.error.flatten() });
    const scope = igAccountId ?? null;
    if (scope !== null && this.s.settings.tier !== "roster") throw demoError(403, "roster_plan_required", "Separate billing details for each creator need the Roster plan.");
    const profiles = this.s.billingProfiles ?? [];
    if (profiles.some((profile) => profile.igAccountId !== scope && profile.input.invoicePrefix === parsed.data.invoicePrefix)) throw demoError(409, "invoice_prefix_in_use", "Another billing profile uses this prefix. Pick a different one.");
    const existing = profiles.find((profile) => profile.igAccountId === scope);
    // The numbering carries on across edits.
    const saved: DemoBillingProfile = { igAccountId: scope, input: parsed.data, numberYear: existing?.numberYear ?? "", nextNumber: existing?.nextNumber ?? 1, updatedAt: new Date().toISOString() };
    await wait(300);
    this.s.billingProfiles = existing ? profiles.map((profile) => (profile === existing ? saved : profile)) : [...profiles, saved];
    this.audit("billing.updated");
    this.emit();
    return profileDto(saved, this.s.settings.timezone, Date.now());
  }
  async createInvoice(dealId: string, request: InvoiceCreateRequest) {
    await this.init();
    const deal = this.deal(dealId);
    const profiles = this.s.billingProfiles ?? [];
    const profile = profiles.find((item) => item.igAccountId === deal.igAccountId) ?? profiles.find((item) => item.igAccountId === null);
    if (!profile) throw demoError(409, "billing_profile_required", "Add your billing details in Settings before making an invoice.");
    const issued = issueInvoice(deal, profile, request, Date.now(), { timezone: this.s.settings.timezone, locale: this.s.money.locale ?? "en-IN" });
    await wait(300);
    this.saveDeal(issued.deal);
    this.s.billingProfiles = profiles.map((item) => (item === profile ? issued.profile : item));
    this.audit("invoice.created", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    this.emit();
    return issued.invoice;
  }
  /** The invoice and the deal it is on, or the API's 404. */
  private invoice(invoiceId: string): { deal: DealDto; invoice: InvoiceDto } {
    const deal = (this.s.deals ?? []).find((item) => item.invoices?.some((invoice) => invoice.id === invoiceId));
    const invoice = deal?.invoices?.find((item) => item.id === invoiceId);
    if (!deal || !invoice) throw demoError(404, "not_found", "This invoice isn't in DealDock any more.");
    return { deal, invoice };
  }
  async voidInvoice(invoiceId: string) {
    await this.init();
    const { deal, invoice } = this.invoice(invoiceId);
    if (invoice.status === "void") return invoice;
    // A paid invoice's money stands until its Revenue entry is deleted.
    if (invoice.status === "paid") throw demoError(409, "invoice_already_paid", "This invoice is paid. Delete its payment in Revenue first.");
    const at = new Date().toISOString();
    const voided: InvoiceDto = { ...invoice, status: "void", voidedAt: at, updatedAt: at };
    const invoices = (deal.invoices ?? []).map((item) => (item.id === invoiceId ? voided : item));
    this.saveDeal({ ...deal, invoices, dueAt: dueAfter(deal, invoice, invoices), updatedAt: at });
    this.audit("invoice.voided", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    this.emit();
    return voided;
  }
  async markInvoicePaid(invoiceId: string, request: InvoicePaidRequest): Promise<InvoicePaidResponse> {
    await this.init();
    const { deal, invoice } = this.invoice(invoiceId);
    // One Revenue entry per invoice: a retry of the same payment returns it, any other is refused.
    const key = `invoice:${request.idempotencyKey}`;
    if (invoice.status === "paid") {
      if (this.s.dealKeys?.[key] === invoice.id) return { invoice, deal: withPaid(deal, this.s.ledger) };
      throw demoError(409, "invoice_already_paid", "This invoice is already paid.");
    }
    if (invoice.status === "void") throw demoError(409, "invoice_void", "This invoice was voided, so it can't be paid.");
    if (!isDealOpen(deal)) throw demoError(409, "deal_not_open", "This deal is paid or cancelled.");
    const paid = payInvoice(deal, invoice, request, Date.now());
    await wait(300);
    this.saveDeal(paid.deal);
    this.s.dealKeys = { ...this.s.dealKeys, [key]: invoice.id };
    this.recordRevenue(paid.deal, paid.revenueMinor, paid.invoice.paidAt!, paid.invoice);
    this.emit();
    return { invoice: paid.invoice, deal: withPaid(paid.deal, this.s.ledger) };
  }

  // ── Renewals ───────────────────────────────────────────────────────────

  loadRenewals(): Promise<RenewalDto[] | null> { return this.load("renewals"); }
  async handleRenewal(dealId: string, how: "not_now" | "copied") {
    await this.init();
    const deal = this.deal(dealId);
    if (deal.stage !== "paid") throw demoError(409, "deal_not_paid", "Only a paid deal can be pitched again.");
    if (deal.renewalHandledAt) return;
    this.saveDeal({ ...deal, renewalHandledAt: new Date().toISOString() });
    this.audit(how === "copied" ? "deal.renewal_copied" : "deal.renewal_dismissed", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    this.emit();
  }
  async draftForDeal(dealId: string) {
    await this.init();
    const deal = this.deal(dealId);
    if (deal.threadId !== null) throw demoError(409, "deal_has_conversation", "This deal has a conversation. Open it to draft the pitch there.");
    if (deal.stage !== "paid") throw demoError(409, "deal_not_paid", "Only a paid deal can be pitched again.");
    if (!this.s.consent[deal.igAccountId]?.granted) throw demoError(409, "voice_consent_required", "Drafts need permission to learn from your sent replies. Turn it on in Your voice.");
    await wait(500);
    return dealDraft("renewal", withPaid(deal, this.s.ledger), this.s.money, this.s.settings.timezone, Date.now(), undefined, this.s.offers);
  }

  // ── Coach pipeline ─────────────────────────────────────────────────────

  async setLeadStage(threadId: string, stage: LeadStage) {
    await this.init();
    const thread = this.thread(threadId);
    if (!thread) throw demoError(404, "not_found", "This isn't available. It may belong to another account or have been removed.");
    if (thread.leadStage === stage) return;
    thread.leadStage = stage;
    this.audit("thread.lead_stage_changed", { threadId: thread.id, handle: thread.handle, finalText: stage });
    this.emit();
  }
  loadLeadSources(): Promise<LeadSourcesResponse | null> { return this.load("leadSources"); }
  async connectLeadSource(request: LeadSourceCreateRequest): Promise<LeadSourceCreated> {
    await this.init();
    // The API's rules: Calendly needs its access key, Razorpay and Stripe sign with a secret (now or later), and the plain address takes neither.
    const secret = request.secret?.trim() ?? "";
    if (secret && secret.length < 8) throw demoError(400, "invalid_body", "Paste the whole signing secret.");
    if (secret && (request.provider === "calendly" || request.provider === "other")) throw demoError(400, "invalid_body", "This tool takes no signing secret.");
    if (request.provider === "calendly" && (request.accessKey?.trim().length ?? 0) < 20) throw demoError(400, "invalid_body", "Paste the personal access key from Calendly.");
    await wait(400);
    const at = new Date().toISOString();
    const source: LeadSourceDto = { id: `src-${Date.now()}`, provider: request.provider, label: request.label?.trim() || null, lastEventAt: null, createdAt: at, needsSecret: (request.provider === "razorpay" || request.provider === "stripe") && !secret };
    this.s.leadSources = [...(this.s.leadSources ?? []), source];
    this.audit("lead_source.connected");
    this.emit();
    const token = Array.from({ length: 43 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random() * 64)]).join("");
    // Fictional: no tool can reach the demo, so the address is a placeholder with the shape of a real one.
    return { source, address: request.provider === "calendly" ? null : `https://api.dealdock.example/webhooks/leads/${token}` };
  }
  async saveLeadSourceSecret(sourceId: string, secret: string) {
    await this.init();
    const source = (this.s.leadSources ?? []).find((item) => item.id === sourceId);
    if (!source) throw demoError(404, "not_found", "That tool isn't connected any more.");
    if (secret.trim().length < 8) throw demoError(400, "invalid_body", "Paste the whole signing secret.");
    this.s.leadSources = (this.s.leadSources ?? []).map((item) => (item.id === sourceId ? { ...item, needsSecret: false } : item));
    this.emit();
  }
  async removeLeadSource(sourceId: string) {
    await this.init();
    if (!(this.s.leadSources ?? []).some((source) => source.id === sourceId)) throw demoError(404, "not_found", "That tool isn't connected any more.");
    this.s.leadSources = (this.s.leadSources ?? []).filter((source) => source.id !== sourceId);
    // As the API: what the tool reported goes with it.
    this.s.leadEvents = (this.s.leadEvents ?? []).filter((event) => event.sourceId !== sourceId);
    this.audit("lead_source.removed");
    this.emit();
  }
  async matchLeadEvent(eventId: string, threadId: string) {
    await this.init();
    const event = (this.s.leadEvents ?? []).find((item) => item.id === eventId);
    const thread = this.thread(threadId);
    if (!event || !thread) throw demoError(404, "not_found", "This isn't available. It may belong to another account or have been removed.");
    if (event.handledAt) throw demoError(409, "lead_event_handled", "That payment was already recorded or dismissed.");
    if (event.threadId !== null && event.threadId !== thread.id) throw demoError(409, "lead_event_already_matched", "That payment is already matched to another conversation.");
    if (event.threadId === null) {
      event.threadId = thread.id;
      // A reported booking or payment only moves the stage forward.
      const next = forwardStage(thread.leadStage ?? null, event.kind);
      if (next) thread.leadStage = next;
      this.audit("lead_event.matched", { threadId: thread.id, handle: thread.handle });
    }
    this.emit();
  }
  async dismissLeadEvent(eventId: string) {
    await this.init();
    const event = (this.s.leadEvents ?? []).find((item) => item.id === eventId);
    if (!event) throw demoError(404, "not_found", "That payment isn't in DealDock any more.");
    if (event.handledAt) return;
    event.handledAt = new Date().toISOString();
    const thread = event.threadId ? this.thread(event.threadId) : undefined;
    this.audit("lead_event.dismissed", thread ? { threadId: thread.id, handle: thread.handle } : {});
    this.emit();
  }

  async suggestDeal(threadId: string) {
    await this.init();
    const thread = this.thread(threadId);
    if (!thread) throw demoError(404, "not_found", "This isn't available. It may belong to another account or have been removed.");
    await wait(500);
    return suggestDealFrom(thread.messages.map((message) => message.text || message.audio?.transcript || ""), thread.topLabel);
  }

  // ── Offers ─────────────────────────────────────────────────────────────

  async loadOffers(): Promise<OfferDto[] | null> { return this.load("offers"); }
  async createOffer(input: OfferInput) {
    const offer: OfferDto = { ...input, addOns: offerAddOns(input.addOns, input.dealType), id: `offer-${Date.now()}`, currencyCode: this.s.money.currency, updatedAt: new Date().toISOString() };
    this.s.offers.push(offer);
    this.audit("offer.created");
    this.emit();
    return offer;
  }
  async updateOffer(offerId: string, patch: Partial<OfferInput>) {
    const offer = this.s.offers.find((item) => item.id === offerId);
    if (!offer) throw demoError(404, "not_found", "This offer was removed.");
    const dealType = patch.dealType ?? offer.dealType;
    // As the API: add-ons are for brand offers, and a type change away from brand clears them.
    const addOns = patch.addOns !== undefined ? offerAddOns(patch.addOns, dealType) : dealType === "brand" ? offer.addOns ?? null : null;
    Object.assign(offer, patch, { addOns, updatedAt: new Date().toISOString() });
    this.audit("offer.updated");
    this.emit();
    return { ...offer };
  }
  async deleteOffer(offerId: string) {
    this.s.offers = this.s.offers.filter((item) => item.id !== offerId);
    this.audit("offer.deleted");
    this.emit();
  }
  async setRateCardLink(igAccountId: string, on: boolean) {
    await this.init();
    const account = this.s.settings.accounts.find((item) => item.id === igAccountId);
    if (!account) throw demoError(404, "not_found", "That creator isn't in this workspace.");
    // As the API: an unguessable token (192 bits, base64url); a new one ends the old link.
    const token = on ? randomToken() : null;
    this.s.settings = { ...this.s.settings, accounts: this.s.settings.accounts.map((item) => (item.id === igAccountId ? { ...item, rateCardToken: token } : item)) };
    this.audit(on ? "rate_card.link_created" : "rate_card.link_turned_off");
    this.emit();
    return token;
  }
  async loadPublicRateCard(token: string): Promise<PublicRateCard | null> {
    await this.init();
    const account = this.s.settings.accounts.find((item) => item.rateCardToken && item.rateCardToken === token);
    if (!account || account.status === "disconnected") return null;
    // Public data only: the creator's handle, the currency and the active offers that apply to them.
    const offers = this.s.offers.filter((offer) => offer.active && (offer.igAccountId === null || offer.igAccountId === account.id)).sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      handle: account.handle,
      currencyCode: this.s.money.currency,
      locale: this.s.money.locale ?? "en-IN",
      offers: offers.map((offer) => ({
        name: offer.name, dealType: offer.dealType, priceMinMinor: offer.priceMinMinor, priceMaxMinor: offer.priceMaxMinor,
        details: offer.details, link: offer.link, availability: offer.availability, addOns: offer.dealType === "brand" ? offer.addOns ?? null : null,
      })),
    };
  }

  // ── Usage rights and proof of results ──────────────────────────────────

  async setUsageHandled(dealId: string, handled: boolean) {
    await this.init();
    const deal = this.deal(dealId);
    const at = new Date().toISOString();
    const next: DealDto = { ...deal, usageHandledAt: handled ? at : null, updatedAt: at };
    this.saveDeal(next);
    this.audit("deal.updated", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    this.emit();
    return withPaid(next, this.s.ledger);
  }
  async fetchInsights(dealId: string, deliverableId: string) {
    await this.init();
    await wait(500);
    if (!this.s.settings.insightsAvailable) throw demoError(404, "insights_unavailable", "Instagram didn't share this post's results. Type them in from its insights.");
    const deal = this.deal(dealId);
    const item = deal.terms.deliverables.find((entry) => entry.id === deliverableId);
    if (!item) throw demoError(404, "not_found", "This deliverable isn't on the deal any more.");
    if (!item.postUrl) throw demoError(409, "post_link_required", "Add the post link first.");
    if (isStoryDeliverable(item.label)) throw demoError(409, "story_results_not_available", "Instagram keeps story results for a day only. Type them in from the story's insights.");
    const at = new Date().toISOString();
    // The API's mock Instagram numbers: fictional, the same for every post.
    const metrics = { views: 12_400, reach: 9_800, likes: 1_130, comments: 84, shares: 40, saves: 210 };
    const deliverables = deal.terms.deliverables.map((entry) => (entry.id === deliverableId ? { ...entry, metrics, metricsAt: at, postedAt: entry.postedAt ?? at } : entry));
    const next: DealDto = { ...deal, terms: this.dealTerms({ deliverables }, deal.terms), updatedAt: at };
    this.saveDeal(next);
    this.audit("deal.updated", { threadId: deal.threadId, handle: deal.counterpartyHandle });
    this.emit();
    return withPaid(next, this.s.ledger);
  }

  // ── Your voice ─────────────────────────────────────────────────────────

  async loadVoice(igAccountId?: string) {
    await this.init();
    this.voiceAccount = igAccountId ?? DEMO_ACCOUNT_ID;
    this.requested.add("voice");
    this.emit();
    return this.getSnapshot().voice.data;
  }
  async setStyleOverrides(overrides: Partial<StyleCard>) {
    this.s.overrides = { ...overrides };
    this.audit("voice.style_overridden");
    this.requested.add("voice");
    this.emit();
    return this.studio(this.s, Date.now());
  }
  async createRule(input: RuleInput) {
    const now = new Date().toISOString();
    const key = input.key ?? `user.${Date.now()}`;
    const scope = input.scope ?? "all";
    const existing = this.s.rules.find((rule) => rule.key === key && rule.scope === scope);
    const rule: VoiceRuleDto = existing
      ? { ...existing, text: input.text, status: input.status ?? "active", updatedAt: now }
      : { id: `rule-${Date.now()}`, key, text: input.text.slice(0, 120), scope, status: input.status ?? "active", source: input.key ? "edits" : "user", evidence: input.key ? 1 : 0, against: 0, examples: [], updatedAt: now };
    this.s.rules = [rule, ...this.s.rules.filter((item) => item.id !== rule.id)];
    this.audit("voice.rule_created");
    this.emit();
    return rule;
  }
  async updateRule(ruleId: string, patch: { text?: string; status?: VoiceRuleStatus; scope?: VoiceRuleScope }) {
    const rule = this.s.rules.find((item) => item.id === ruleId);
    if (!rule) throw demoError(404, "not_found", "This rule was removed.");
    Object.assign(rule, patch, { updatedAt: new Date().toISOString() });
    this.audit(patch.status === "pinned" ? "voice.rule_pinned" : patch.status === "muted" ? "voice.rule_muted" : "voice.rule_updated");
    this.emit();
    return { ...rule };
  }
  async deleteRule(ruleId: string) {
    const existed = this.s.rules.some((item) => item.id === ruleId);
    this.s.rules = this.s.rules.filter((item) => item.id !== ruleId);
    if (existed) this.audit("voice.rule_deleted");
    this.emit();
  }
  async setSampleExcluded(messageId: string, excluded: boolean) {
    const sample = this.s.samples.find((item) => item.messageId === messageId);
    if (sample) sample.excluded = excluded;
    this.audit(excluded ? "voice.sample_excluded" : "voice.sample_included");
    this.emit();
  }
  async refreshVoice() {
    await wait(900);
    if (this.s.samples.filter((sample) => !sample.excluded).length < 3) throw demoError(409, "not_enough_samples", "Not enough replies yet — send a few more first.");
    this.s.refreshedAt = new Date().toISOString();
    this.emit();
  }
  async setLearningPaused(paused: boolean, igAccountId?: string) {
    this.s.learningPausedBy = { ...this.s.learningPausedBy, [igAccountId ?? this.voiceAccount]: paused };
    this.audit(paused ? "voice.learning_paused" : "voice.learning_resumed");
    this.emit();
  }
  async previewVoice(request: VoicePreviewRequest): Promise<VoicePreviewResponse> {
    await wait(500);
    const subject: DraftSubject = { label: request.label, kind: "reply", firstName: null, hinglish: /\b(hai|kya|aap|bhai|kitna|haan)\b/i.test(request.inboundText) };
    let body = baseDraft(subject, this.s.offers, this.s.money);
    for (const chip of request.chips ?? []) body = applyChip(body, chip, subject, this.s.offers, this.s.money);
    if (request.instruction) body = applyInstruction(body, request.instruction);
    return { body, context: this.contextFor({ topLabel: request.label, id: "" }) };
  }

  // ── Speaking voice ─────────────────────────────────────────────────────

  async createSpeakingVoice(request: CreateSpeakingVoiceRequest) {
    if (!request.consentStatement.trim() || !request.consentClip.base64) throw demoError(400, "invalid_body", "Record the consent statement first.");
    await wait(600);
    const seconds = Math.round([request.consentClip, ...request.samples].reduce((sum, clip) => sum + clip.durationMs, 0) / 1000);
    const createdAt = new Date().toISOString();
    this.s.speaking = { status: "pending", provider: "demo", consentedAt: createdAt, sampleSeconds: seconds, disclosureEnabled: true, lastError: null, createdAt };
    this.emit();
    // Demo stand-in for the provider job: ready a moment later, recorded when it completes as the API does.
    setTimeout(() => {
      if (this.s.speaking.status !== "pending") return;
      this.s.speaking = { ...this.s.speaking, status: "ready" };
      this.audit("voice.clone_created");
      this.emit();
    }, 2_500);
    return this.s.speaking;
  }
  async deleteSpeakingVoice() {
    this.s.speaking = { ...this.s.speaking, status: "revoked", createdAt: this.s.speaking.createdAt };
    this.audit("voice.clone_revoked");
    this.emit();
  }
  async setSpeakingDisclosure(enabled: boolean) {
    if (!enabled && voiceDisclosureRequired(this.s.money.currency)) throw demoError(409, "disclosure_required", "In India, every voice note has to start by saying it's AI-generated.");
    this.s.speaking = { ...this.s.speaking, disclosureEnabled: enabled };
    this.audit(enabled ? "voice.disclosure_enabled" : "voice.disclosure_disabled");
    this.emit();
    return this.s.speaking;
  }
  async previewSpeaking(text: string): Promise<AudioPreviewResponse> {
    if (this.s.speaking.status !== "ready") throw demoError(409, "speaking_voice_not_ready", "Set up your speaking voice first.");
    await wait(400);
    // Demo audio is a tone per word (clearly not a voice); the real API returns the cloned voice.
    const bytes = toneWav(text);
    const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "audio/wav" })) : wavDataUrl(bytes);
    return { url, mimeType: "audio/wav", expiresAt: new Date(Date.now() + 15 * MINUTE).toISOString() };
  }

  // ── Settings, account, team ────────────────────────────────────────────

  private async load<K extends SliceKey>(key: K) {
    await this.init();
    this.requested.add(key);
    this.emit();
    return this.getSnapshot()[key].data as never;
  }
  loadSettings(): Promise<SettingsView | null> { return this.load("settings"); }
  loadMe(): Promise<MeView | null> { return this.load("me"); }
  async updateRegion(body: RegionInput) {
    const settings = this.s.settings;
    this.s.settings = { ...settings, locale: body.locale ?? settings.locale, timezone: body.timezone ?? settings.timezone, nudgeDelayDays: body.nudgeDelayDays ?? settings.nudgeDelayDays };
    this.s.money = { ...this.s.money, locale: this.s.settings.locale };
    this.audit("settings.region_changed");
    this.emit();
  }
  async setVoiceConsent(igAccountId: string, consented: boolean) {
    const at = new Date().toISOString();
    this.s.consent[igAccountId] = consented ? { granted: true, consentedAt: at, revokedAt: null } : { granted: false, consentedAt: this.s.consent[igAccountId]?.consentedAt ?? null, revokedAt: at };
    this.s.settings = { ...this.s.settings, voiceConsent: [...this.s.settings.voiceConsent.filter((item) => item.igAccountId !== igAccountId), { igAccountId, consented }] };
    if (!consented && igAccountId === DEMO_ACCOUNT_ID) {
      // Revoking wipes what was learned and unsent drafts, like the API.
      this.s.rules = [];
      this.s.overrides = {};
      for (const thread of this.s.threads) if (thread.igAccountId === igAccountId) thread.draft = null;
    } else if (consented && igAccountId === DEMO_ACCOUNT_ID && !this.s.rules.length) {
      this.s.rules = seedRules(Date.now());
    }
    this.audit(consented ? "voice.consent_granted" : "voice.consent_revoked");
    this.emit();
  }
  loadIgnoreList(): Promise<string[] | null> { return this.load("ignoreList"); }
  async setIgnoreList(handles: string[]) {
    this.s.ignoreList = handles.map((handle) => handle.replace(/^@/, "").trim()).filter(Boolean);
    this.audit("settings.ignore_list_changed");
    this.emit();
  }
  loadNotificationPrefs(): Promise<NotificationPrefs | null> { return this.load("notificationPrefs"); }
  async setNotificationPrefs(prefs: Partial<Omit<NotificationPrefs, "subscribed">>) {
    this.s.prefs = { ...this.s.prefs, ...prefs };
    this.emit();
  }
  loadBilling(): Promise<BillingView | null> { return this.load("billing"); }
  async cancelBilling() {
    const now = Date.now();
    this.s.billing = { ...this.s.billing, status: "cancelled", cancelledAt: new Date(now).toISOString(), currentPeriodEnd: new Date(now + 30 * DAY).toISOString() };
    this.audit("billing.cancel_requested");
    this.emit();
  }
  loadSeats(): Promise<SeatView[] | null> { return this.load("seats"); }
  async inviteSeat(body: { email: string; name?: string; role: "assistant" | "manager" }) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) throw demoError(400, "invalid_body", "Enter a valid email address.");
    this.s.seats.push({ id: `seat-${Date.now()}`, role: body.role, email: body.email, name: body.name ?? null, activated: false, createdAt: new Date().toISOString() });
    this.audit("seat.invited");
    this.emit();
  }
  async removeSeat(seatId: string) {
    const seat = this.s.seats.find((item) => item.id === seatId);
    if (seat?.role === "creator") throw demoError(409, "cannot_remove_creator", "The creator's own seat can't be removed.");
    this.s.seats = this.s.seats.filter((item) => item.id !== seatId);
    this.audit("seat.removed");
    this.emit();
  }
  loadRoster(): Promise<RosterRow[] | null> { return this.load("roster"); }
  loadDataSummary(): Promise<DataSummary | null> { return this.load("dataSummary"); }
  async scheduleDeletion() {
    this.s.settings = { ...this.s.settings, deletionRequestedAt: new Date().toISOString() };
    this.audit("account.deletion_requested");
    this.emit();
  }
  async cancelDeletion() {
    this.s.settings = { ...this.s.settings, deletionRequestedAt: null };
    this.audit("account.deletion_cancelled");
    this.emit();
  }

  // ── Email (Gmail) ──────────────────────────────────────────────────────

  loadEmailAccounts(): Promise<EmailInboxes | null> { return this.load("emailAccounts"); }
  async connectEmail(igAccountId?: string) {
    await this.init();
    const creators = this.s.settings.accounts;
    if (!igAccountId && this.s.settings.tier === "roster" && creators.length > 1) throw demoError(400, "ig_account_required", "Choose which creator this inbox belongs to.");
    const owner = creators.find((account) => account.id === (igAccountId ?? creators[0]?.id));
    if (!owner) throw demoError(404, "not_found", "That creator isn't in this workspace.");
    const at = new Date().toISOString();
    const inboxes = this.s.emailAccounts ?? [];
    const existing = inboxes.find((inbox) => inbox.ownerAccountId === owner.id);
    // No Google here: the creator's inbox is (re)connected now, and the "consent screen" returns straight to Settings as the real callback does.
    this.s.emailAccounts = existing
      ? inboxes.map((inbox) => (inbox === existing ? { ...inbox, status: "active", lastSyncedAt: at } : inbox))
      : [...inboxes, { id: `email-${owner.id}`, address: `collabs@${owner.handle.replace(/[^a-z0-9]/gi, "")}.example`, status: "active", connectedAt: at, lastSyncedAt: at, ownerAccountId: owner.id }];
    this.emit();
    return { authorizeUrl: "/settings?email=connected#email" };
  }
  async disconnectEmail(accountId: string) {
    await this.init();
    if (!(this.s.emailAccounts ?? []).some((inbox) => inbox.id === accountId)) throw demoError(404, "not_found", "That inbox isn't connected any more.");
    this.s.emailAccounts = (this.s.emailAccounts ?? []).filter((inbox) => inbox.id !== accountId);
    this.audit("email.disconnected");
    this.emit();
  }

  // ── Comment leads (the API's rules: one reply per comment, 7 days, a person sends) ──

  loadCommentLeads(): Promise<CommentLeadsView | null> { return this.load("commentLeads"); }
  private commentLead(leadId: string): CommentLeadDto {
    const lead = (this.s.commentLeads ?? []).find((item) => item.id === leadId);
    if (!lead) throw demoError(404, "not_found", "This isn't available. It may belong to another account or have been removed.");
    return lead;
  }
  private patchCommentLead(leadId: string, patch: Partial<CommentLeadDto>) {
    this.s.commentLeads = (this.s.commentLeads ?? []).map((lead) => (lead.id === leadId ? { ...lead, ...patch } : lead));
  }
  /** Only a lead still waiting for its reply, inside its 7 days, can be answered, skipped or drafted again. */
  private openCommentLead(leadId: string): CommentLeadDto {
    const lead = this.commentLead(leadId);
    if (lead.status === "sent") throw demoError(409, "comment_lead_already_sent", "This comment already has its private reply.");
    if (lead.status !== "new") throw demoError(409, "comment_lead_not_open", "This comment was already answered or skipped.");
    if (!canReplyPrivately(lead.commentedAt)) throw demoError(409, "comment_lead_too_late", "Too late to reply privately: Instagram allows it for 7 days after the comment.");
    return lead;
  }
  async setCommentKeywords(keywords: string[], igAccountId?: string) {
    await this.init();
    const result = normalizeCommentKeywords(keywords);
    if (!result.ok) throw demoError(400, result.error, KEYWORD_ERRORS[result.error]);
    const account = this.s.settings.accounts.find((item) => item.id === (igAccountId ?? this.s.settings.accounts[0]?.id));
    if (!account) throw demoError(404, "not_found", "That creator isn't in this workspace.");
    this.s.commentKeywords = { ...(this.s.commentKeywords ?? {}), [account.id]: result.keywords };
    this.audit("settings.comment_keywords_changed");
    this.emit();
    return result.keywords;
  }
  async sendCommentLead(leadId: string, text: string) {
    await this.init();
    await wait(400);
    const lead = this.openCommentLead(leadId);
    const finalText = text.trim();
    if (!finalText) throw demoError(400, "send_text_required", "Write the reply before sending it.");
    this.patchCommentLead(leadId, { status: "sent", sentAt: new Date().toISOString(), draftBody: finalText, missingFacts: [] });
    // As the API names it: an Instagram handle, with no conversation until they answer.
    this.audit("comment_lead.sent", { handle: `@${lead.commenterHandle}` });
    this.emit();
  }
  async skipCommentLead(leadId: string) {
    await this.init();
    const lead = this.commentLead(leadId);
    if (lead.status !== "new") throw demoError(409, "comment_lead_not_open", "This comment was already answered or skipped.");
    this.patchCommentLead(leadId, { status: "skipped" });
    this.audit("comment_lead.skipped", { handle: `@${lead.commenterHandle}` });
    this.emit();
  }
  async redraftCommentLead(leadId: string) {
    await this.init();
    await wait(650);
    const lead = this.openCommentLead(leadId);
    if (!this.s.consent[lead.igAccountId]?.granted) throw demoError(409, "voice_consent_required", "Drafts need permission to learn from your sent replies. Turn it on in Your voice.");
    // The stand-in model has two takes: drafting again switches between them.
    const full = commentReplyDraft(lead.text, this.s.offers, this.s.money);
    this.patchCommentLead(leadId, { draftBody: lead.draftBody === full ? commentReplyDraft(lead.text, this.s.offers, this.s.money, true) : full });
    this.emit();
  }
  async clearExpiredCommentLeads(igAccountId?: string) {
    await this.init();
    const now = Date.now();
    const gone = (lead: CommentLeadDto) => (lead.status === "new" || lead.status === "skipped") && !canReplyPrivately(lead.commentedAt, now) && (!igAccountId || lead.igAccountId === igAccountId);
    const cleared = (this.s.commentLeads ?? []).filter(gone).length;
    this.s.commentLeads = (this.s.commentLeads ?? []).filter((lead) => !gone(lead));
    if (cleared) this.audit("comment_lead.cleared");
    this.emit();
    return cleared;
  }

  // ── Instagram + onboarding ─────────────────────────────────────────────

  async connectInstagram() {
    // The demo "OAuth" returns straight to onboarding, as the real callback does.
    return { authorizeUrl: `/onboarding?step=connect&connected=${encodeURIComponent(DEMO_ACCOUNTS[0]!.handle)}` };
  }
  async disconnectInstagram(igAccountId?: string) {
    // As the API: an account that isn't this workspace's is a 404, never a silent no-op.
    if (igAccountId !== undefined && !this.s.settings.accounts.some((account) => account.id === igAccountId)) {
      throw demoError(404, "not_found", "That account isn't connected to this workspace.");
    }
    const id = igAccountId ?? DEMO_ACCOUNT_ID;
    this.s.settings = { ...this.s.settings, accounts: this.s.settings.accounts.map((account) => (account.id === id ? { ...account, status: "disconnected" } : account)) };
    this.audit("ig.disconnected");
    this.emit();
  }
  loadOnboarding(): Promise<OnboardingView | null> { return this.load("onboarding"); }
  async saveOnboarding(input: OnboardingInput) {
    // The same rows, in the same order, as the API's onboarding save.
    this.s.businessContext = input.businessContext;
    this.audit("onboarding.profile_saved");
    if (input.ignoreHandles) {
      this.s.ignoreList = input.ignoreHandles;
      this.audit("settings.ignore_list_changed");
    }
    if (input.voiceConsent !== undefined) await this.setVoiceConsent(input.igAccountId ?? DEMO_ACCOUNT_ID, input.voiceConsent);
    this.s.settings = { ...this.s.settings, locale: input.locale, timezone: input.timezone };
    this.s.onboarded = true;
    this.emit();
  }
  async bootstrapWorkspace(body: { currencyCode: CurrencyCode; locale: string; timezone: string }) {
    this.s.money = { currency: body.currencyCode, locale: body.locale };
    this.s.settings = { ...this.s.settings, currencyCode: body.currencyCode, locale: body.locale, timezone: body.timezone };
    this.emit();
  }
  async startLeakScan() {
    this.s.leakScanStartedAt = Date.now();
    this.emit();
    return { enqueued: 0 };
  }
  async getLeakScan(): Promise<LeakScanSummary> {
    const summary = this.leakScan();
    // The seeded workspace was scanned before this session ("done"); a new scan "reads" for six seconds so the live counters have something to count.
    const progress = this.s.leakScanStartedAt === null ? 1 : Math.min(1, (Date.now() - this.s.leakScanStartedAt) / 6_000);
    return {
      status: progress < 1 ? "running" : "done",
      scannedCount: Math.round(DEMO_SCANNED * progress),
      commerceCount: Math.round(DEMO_SCAN_COMMERCE * progress),
      totalMinMinor: Math.round((summary.totalMinMinor * progress) / 100) * 100,
      topThreads: progress < 1 ? [] : summary.topThreads.map((thread) => ({ threadId: thread.id, handle: thread.handle, label: thread.topLabel, estValueMaxMinor: thread.estValueMaxMinor })),
    };
  }

  /** Unanswered open commerce: what the demo Leak Scan reveals. */
  private leakScan() {
    const now = Date.now();
    const commerce = this.s.threads
      .map((thread) => this.decorate(thread, now))
      .filter((thread) => thread.routedTo === "inbox" && isCommerceLabel(thread.topLabel) && thread.unreplied && thread.state === "open" && thread.estValueMinMinor !== null);
    return {
      scannedCount: DEMO_SCANNED,
      commerceCount: DEMO_SCAN_COMMERCE,
      totalMinMinor: commerce.reduce((sum, thread) => sum + (thread.estValueMinMinor ?? 0), 0),
      topThreads: [...commerce].sort((a, b) => (b.estValueMaxMinor ?? 0) - (a.estValueMaxMinor ?? 0)).slice(0, 3).map(rowOf),
    };
  }

  private contextFor(thread: Pick<DemoThread, "topLabel" | "id"> & Partial<Pick<DemoThread, "messages" | "igAccountId" | "handle">>): DraftContextSummary {
    const label = thread.topLabel;
    const rules = this.s.rules.filter((rule) => (rule.status === "active" || rule.status === "pinned") && (rule.scope === "all" || rule.scope === label));
    const offer = offerFor(label, this.s.offers);
    const exemplars = this.s.samples.filter((sample) => !sample.excluded && SAMPLE_INBOUND[sample.messageId]).slice(0, 2)
      .map((sample) => ({ messageId: sample.messageId, text: sample.text, inboundText: SAMPLE_INBOUND[sample.messageId] ?? null }));
    const lessons = label === "brand_deal" ? ["You shorten brand replies by about 30%.", "You ask for the brief before you quote."]
      : label === "coaching_lead" ? ["You put the price and the link in the first reply to coaching leads."] : [];
    const missingFacts = [...this.brandFlags(thread), ...(this.s.missingFacts[thread.id] ?? (label && isCommerceLabel(label) && !offer ? [`your price for ${labelNoun(label).replace(/^an? /, "")}`] : []))];
    return { rules: rules.map((rule) => ({ id: rule.id, text: rule.text })), exemplars, offers: offer ? [{ id: offer.id, name: offer.name }] : [], lessons, missingFacts };
  }

  /** As the API flags a brand reply: add-ons they asked about with no price set, and exclusivities with other brands still running. */
  private brandFlags(thread: Partial<Pick<DemoThread, "topLabel" | "messages" | "igAccountId" | "handle">>): string[] {
    if (thread.topLabel !== "brand_deal" || !thread.messages) return [];
    const account = thread.igAccountId ?? DEMO_ACCOUNT_ID;
    const latest = [...thread.messages].reverse().find((message) => message.direction === "inbound");
    const offers = this.s.offers.filter((item) => item.active && (item.igAccountId === null || item.igAccountId === account)).sort((a, b) => a.sortOrder - b.sortOrder);
    const until = new Intl.DateTimeFormat(this.s.money.locale ?? "en-IN", { day: "numeric", month: "short", timeZone: this.s.settings.timezone });
    const exclusive = exclusivitiesAgainst(this.s.deals ?? [], { igAccountId: account, counterpartyHandle: thread.handle ?? "" }, Date.now());
    return [
      ...missingAddOnPrices(latest ? latest.text || latest.audio?.transcript || "" : "", offers),
      ...exclusive.map((note) => `check this brand doesn't compete with your exclusivity with ${note.threadId ? `@${note.counterpartyHandle}` : note.counterpartyName ?? note.counterpartyHandle} (until ${until.format(new Date(note.endsAt))})`),
    ];
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────

function seed(now: number): DemoState {
  const offers = seedOffers(now);
  const threads: DemoRecord[] = SEED_THREADS.map((item) => seedThread(item, now));
  const ledger: DemoLedgerEntry[] = [];
  SEED_SALES.forEach((sale, index) => {
    const closedAt = saleTime(now, sale.monthsAgo, sale.day, index);
    const entry = { id: `sale-${index + 1}`, threadId: `t-sale-${index + 1}`, channel: "instagram" as const, handle: sale.handle, dealType: sale.dealType, amountMinor: sale.rupees * 100, closedAt, note: sale.note } satisfies DemoLedgerEntry;
    ledger.push(entry);
    threads.push(closedThread(entry, sale.name, closedAt));
  });
  ledger.sort((a, b) => b.closedAt - a.closedAt);
  const state: DemoState = {
    version: 3,
    threads,
    missingFacts: Object.fromEntries(SEED_THREADS.filter((item) => item.missingFacts).map((item) => [item.id, item.missingFacts!])),
    ledger,
    offers,
    rules: seedRules(now),
    samples: seedSamples(now),
    overrides: {},
    learningPausedBy: {},
    refreshedAt: new Date(now - 2 * DAY).toISOString(),
    lastDistilledAt: new Date(now - DAY).toISOString(),
    consent: {
      [DEMO_ACCOUNTS[0]!.id]: { granted: true, consentedAt: new Date(now - 40 * DAY).toISOString(), revokedAt: null },
      [DEMO_ACCOUNTS[1]!.id]: { granted: false, consentedAt: null, revokedAt: null },
      [DEMO_ACCOUNTS[2]!.id]: { granted: false, consentedAt: null, revokedAt: null },
    },
    speaking: { status: "none", provider: null, consentedAt: null, sampleSeconds: 0, disclosureEnabled: true, lastError: null, createdAt: null },
    sentThisSession: 0,
    settings: {
      currencyCode: "INR",
      locale: "en-IN",
      timezone: DEMO_TIMEZONE,
      nudgeDelayDays: 3,
      accounts: [
        { id: DEMO_ACCOUNTS[0]!.id, handle: DEMO_ACCOUNTS[0]!.handle, status: "active", provider: "mock" },
        { id: DEMO_ACCOUNTS[1]!.id, handle: DEMO_ACCOUNTS[1]!.handle, status: "active", provider: "mock" },
        { id: DEMO_ACCOUNTS[2]!.id, handle: DEMO_ACCOUNTS[2]!.handle, status: "token_expired", provider: "mock" },
      ],
      voiceConsent: DEMO_ACCOUNTS.map((account, index) => ({ igAccountId: account.id, consented: index === 0 })),
      deletionRequestedAt: null,
      monthlyGoalMinor: DEMO_GOAL_MINOR,
      humanAgentEnabled: true,
      speechAvailable: true,
      // The demo's mock Instagram reports fixed post results, as the API's mock adapter does.
      insightsAvailable: true,
      tier: "roster",
    },
    audit: [],
    prefs: { notifyHighValue: true, notifyNudge: true, notifyWeeklySummary: true, subscribed: false },
    billing: { status: "pending_first_invoice", rail: "razorpay", tier: "roster", checkoutUrl: null, activeUseStartedAt: new Date(now - 3 * DAY).toISOString(), currentPeriodEnd: null, cancelledAt: null },
    seats: [
      { id: "seat-diya", role: "creator", email: DEMO_CREATOR.email, name: DEMO_CREATOR.name, activated: true, createdAt: new Date(now - 180 * DAY).toISOString() },
      { id: "seat-kabir", role: "manager", email: "kabir@example.com", name: "Kabir Rao", activated: true, createdAt: new Date(now - 60 * DAY).toISOString() },
      { id: "seat-invite", role: "manager", email: "ops@example.com", name: null, activated: false, createdAt: new Date(now - 2 * DAY).toISOString() },
    ],
    ignoreList: ["masi.ji", "cousin.aarav"],
    // The same shape and option names onboarding saves (fictional prices in paise).
    businessContext: {
      sells: ["Brand collaborations", "1:1 coaching", "Courses or cohorts"],
      businessSummary: "Fitness coach, Hindi + English, 120K followers",
      typicalBrandDealMinor: { min: 5_000_000, max: 15_000_000 },
      typicalCoachingMinor: { min: 2_400_000, max: 2_400_000 },
      typicalCourseMinor: { min: 799_900, max: 799_900 },
    },
    onboarded: true,
    leakScanStartedAt: null,
    usedCloseKeys: [],
    joinedAt: now - 180 * DAY,
    money: { ...DEMO_MONEY },
  };
  state.deals = seedDeals(now, threads, ledger);
  state.billingProfiles = [seedInvoices(now, state)];
  const pipeline = seedPipeline(now, state);
  state.leadSources = pipeline.sources;
  state.leadEvents = pipeline.events;
  state.commentKeywords = seedCommentKeywords();
  state.commentLeads = seedCommentLeads(now, state.offers, state.money);
  state.emailAccounts = seedEmailAccounts(now);
  state.audit = seedAudit(state, now);
  return state;
}

function seedThread(item: SeedThread, now: number): DemoRecord {
  const messages: DemoMessage[] = item.messages.map((message, index) => ({
    id: `${item.id}-m${index + 1}`,
    direction: message.inbound ? "inbound" : "outbound",
    text: message.text,
    sentAt: now - message.ago * MINUTE,
    contentType: message.audio ? "audio" : "text",
    origin: message.inbound ? null : message.origin ?? "native",
    audio: message.audio ? demoAudio(message.audio.transcript, message.audio.language) : null,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    classification: message.inbound && index === item.messages.length - 1 || (message.inbound && index === 0) ? {
      id: `c-${item.id}-${index + 1}`, label: item.label, confidence: item.confidence, rationale: item.rationale, valueMinMinor: item.min, valueMaxMinor: item.max, reviewedAt: null,
    } : undefined,
  }));
  const lastInbound = [...messages].reverse().find((message) => message.direction === "inbound");
  const last = messages[messages.length - 1]!;
  const signalMessage = item.signal ? lastInbound : undefined;
  const thread: DemoRecord = {
    id: item.id,
    igAccountId: item.account ?? DEMO_ACCOUNT_ID,
    handle: item.handle,
    participant: { handle: item.handle, name: item.name, avatarUrl: null, followerCount: item.followers, verified: item.verified, followsYou: item.followsYou, closedTotalMinor: 0, closedDeals: 0, fetchedAt: new Date(now - 2 * DAY).toISOString() },
    state: item.state,
    waitingSince: item.waitingAgo ? now - item.waitingAgo * MINUTE : null,
    nudgeDismissedAt: null,
    lastMessageAt: last.sentAt,
    lastInboundAt: lastInbound?.sentAt ?? null,
    unreplied: last.direction === "inbound",
    // Review rows carry the best guess as topLabel, exactly like the API's review-queue rows.
    topLabel: item.label,
    estValueMinMinor: item.min,
    estValueMaxMinor: item.max,
    estCurrencyCode: item.min === null ? null : "INR",
    rationale: item.rationale,
    routedTo: item.review ? "review_queue" : "inbox",
    reviewed: false,
    classificationId: item.review ? `c-${item.id}-${item.messages.length}` : null,
    preview: last.text,
    previewOutbound: last.direction === "outbound",
    messageCount: messages.length,
    nudgeDue: false,
    draftReady: false,
    hasAudio: Boolean(item.messages.some((message) => message.audio)),
    hasDealSignal: Boolean(item.signal),
    dealSignal: item.signal && signalMessage ? { messageId: signalMessage.id, phrase: item.signal.phrase, suggestedAmountMinor: item.signal.amountMinor, suggestedDealType: item.signal.dealType } : null,
    source: item.source,
    replyWindow: { status: "unknown", lastInboundAt: null, standardClosesAt: null, extendedClosesAt: null, humanAgentEnabled: true },
    sendInFlight: false,
    closedDeals: [],
    deals: [],
    canSendVoice: false,
    detail: true,
    channel: item.channel ?? "instagram",
    subject: item.subject ?? null,
    scamReason: null,
    messages,
    draft: null,
  };
  if (item.draft) {
    const subject = subjectOf(thread, item.draft);
    thread.draft = {
      id: `d-${item.id}-seed`, body: item.draftBody ?? baseDraft(subject, seedOffers(now), DEMO_MONEY), kind: item.draft, status: "ready", version: 1,
      label: thread.topLabel, instruction: null, chips: [], alternatives: [], chosenAlternative: null,
      context: { rules: [{ id: "rule-signoff", text: "Sign off with “– D”" }], exemplars: [], offers: [], lessons: [], missingFacts: [] }, purpose: null,
    };
  }
  return thread;
}

/** Demo voice note: a soft tone per word (clearly not a voice), with its real duration. */
function demoAudio(transcript: string, language: string | null) {
  const bytes = toneWav(transcript, 6);
  return { url: wavDataUrl(bytes), mimeType: "audio/wav", durationMs: wavDurationMs(bytes), transcript, transcriptLanguage: language, status: "ready" as const };
}

function closedThread(entry: DemoLedgerEntry & { threadId: string }, name: string, closedAt: number): DemoRecord {
  const conversation = saleConversation({ monthsAgo: 0, day: 0, handle: entry.handle, name, dealType: entry.dealType, rupees: entry.amountMinor / 100 });
  const times = [closedAt - 2 * DAY, closedAt - 2 * DAY + HOUR, closedAt - HOUR];
  const label: ClassificationLabel = LABEL_FOR_DEAL_TYPE[entry.dealType];
  const messages: DemoMessage[] = conversation.map((message, index) => ({
    id: `${entry.threadId}-m${index + 1}`, direction: message.inbound ? "inbound" : "outbound", text: message.text, sentAt: times[index]!,
    contentType: "text", origin: message.inbound ? null : "dealdock", audio: null,
    classification: index === 0 ? { id: `c-${entry.threadId}`, label, confidence: 0.9, rationale: "Asked to buy with clear intent.", valueMinMinor: entry.amountMinor, valueMaxMinor: entry.amountMinor, reviewedAt: null } : undefined,
  }));
  return {
    id: entry.threadId, igAccountId: DEMO_ACCOUNT_ID, handle: entry.handle,
    participant: { handle: entry.handle, name, avatarUrl: null, followerCount: entry.dealType === "brand" ? 20_000 + (entry.amountMinor % 70_000) : 400 + (entry.amountMinor % 4_000), verified: entry.dealType === "brand", followsYou: entry.dealType !== "brand", closedTotalMinor: 0, closedDeals: 0, fetchedAt: null },
    state: "closed", waitingSince: null, nudgeDismissedAt: null, lastMessageAt: times[2]!, lastInboundAt: times[2]!, unreplied: false,
    topLabel: label, estValueMinMinor: entry.amountMinor, estValueMaxMinor: entry.amountMinor, estCurrencyCode: "INR", rationale: "Asked to buy with clear intent.",
    routedTo: "inbox", reviewed: false, classificationId: null, preview: messages[2]!.text, previewOutbound: false, messageCount: 3,
    nudgeDue: false, draftReady: false, hasAudio: false, hasDealSignal: false, dealSignal: null, source: "dm",
    replyWindow: { status: "closed", lastInboundAt: null, standardClosesAt: null, extendedClosesAt: null, humanAgentEnabled: true },
    sendInFlight: false, closedDeals: [], deals: [], canSendVoice: false, detail: true, channel: "instagram", subject: null, scamReason: null, messages, draft: null,
  };
}

/** The demo's one connected Gmail inbox, for @diya.moves. */
function seedEmailAccounts(now: number): EmailAccountView[] {
  return [{ id: DEMO_EMAIL_INBOX.id, address: DEMO_EMAIL_INBOX.address, status: "active", connectedAt: new Date(now - 12 * DAY).toISOString(), lastSyncedAt: new Date(now - 4 * MINUTE).toISOString(), ownerAccountId: DEMO_ACCOUNT_ID }];
}

/**
 * Three sample deals on existing conversations: one agreed with a session due
 * in a couple of days, one whose payment is six days late, and one paid this
 * month (the GlowTonic sale already in Revenue). Recording a deal closes its
 * conversation, so the agreed one leaves the inbox. Also backfills sessions
 * saved before deals existed, so it skips whatever those no longer have.
 */
function seedDeals(now: number, threads: DemoRecord[], ledger: DemoLedgerEntry[]): DealDto[] {
  const iso = (at: number) => new Date(at).toISOString();
  const deals: DealDto[] = [];
  const add = (thread: DemoRecord, deal: Omit<DealDto, "threadId" | "igAccountId" | "counterpartyHandle" | "counterpartyName" | "channel" | "currencyCode" | "updatedAt">) =>
    deals.push({ ...deal, threadId: thread.id, igAccountId: thread.igAccountId ?? DEMO_ACCOUNT_ID, counterpartyHandle: thread.handle, counterpartyName: thread.participant.name, channel: "instagram", currencyCode: "INR", updatedAt: deal.createdAt });
  const terms = (patch: Partial<DealTerms>): DealTerms => normalizeDealTerms(patch);

  const founders = threads.find((thread) => thread.id === "t-founders");
  if (founders) {
    const agreedAt = iso(now - 90 * MINUTE);
    founders.state = "closed";
    founders.unreplied = false;
    founders.dealSignal = null;
    add(founders, {
      id: "deal-founders", title: "Founder fitness session", dealType: "other", amountMinor: 50_000_00, stage: "agreed",
      terms: terms({ deliverables: [{ id: "d1", label: "45-minute session", dueAt: iso(now + 2 * DAY + 6 * HOUR), done: false }], advancePercent: 50, paymentDays: 15, notes: "In person, for about 60 members." }),
      agreedAt, dueAt: null, invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null, createdAt: agreedAt,
    });
  }

  // A returning brand: round two was delivered and invoiced, and the payment is late.
  const tealeaf = threads.find((thread) => thread.handle === "tealeaf.co" && thread.state === "closed");
  if (tealeaf) {
    const text = (id: number, inbound: boolean, sentAt: number, body: string): DemoMessage => ({ id: `${tealeaf.id}-m${id}`, direction: inbound ? "inbound" : "outbound", text: body, sentAt, contentType: "text", origin: inbound ? null : "native", audio: null });
    tealeaf.messages.push(
      text(4, true, now - 48 * DAY, "Diya, loved the last campaign! Round two for our winter blend? Same as before: 1 reel + 2 stories, ₹60,000."),
      text(5, false, now - 48 * DAY + HOUR, "Heyy! Yes, let's do it. Shooting next week. – D"),
      text(6, false, now - 36 * DAY - 2 * HOUR, "Reel is live! Sharing the invoice for ₹60,000, payable in 30 days. – D"),
      text(7, true, now - 35 * DAY, "Got it, thank you! Passing it to our accounts team."),
    );
    tealeaf.lastInboundAt = now - 35 * DAY;
    tealeaf.lastMessageAt = now - 35 * DAY;
    const invoicedAt = now - 36 * DAY - 2 * HOUR;
    add(tealeaf, {
      id: "deal-tealeaf", title: "Winter blend reel + 2 stories", dealType: "brand", amountMinor: 60_000_00, stage: "invoiced",
      terms: terms({ deliverables: [{ id: "d1", label: "1 reel", dueAt: iso(now - 40 * DAY), done: true }, { id: "d2", label: "2 stories", dueAt: iso(now - 40 * DAY), done: true }], usage: "Organic only", revisionsIncluded: 1, paymentDays: 30 }),
      agreedAt: iso(now - 48 * DAY + HOUR), dueAt: dueFromPaymentDays(invoicedAt, 30), invoicedAt: iso(invoicedAt), paidAt: null, receivedMinor: null, tdsMinor: null, createdAt: iso(now - 48 * DAY + HOUR),
    });
  }

  // Paid this month: the deal behind Revenue's GlowTonic sale, with 10% TDS withheld.
  const glowSale = ledger.find((entry) => entry.handle === "glowtonic.in");
  const glowtonic = threads.find((thread) => thread.id === glowSale?.threadId);
  if (glowSale && glowtonic) {
    glowSale.dealId = "deal-glowtonic";
    const tdsMinor = Math.round(glowSale.amountMinor / 10);
    add(glowtonic, {
      id: "deal-glowtonic", title: glowSale.note ?? "Diwali reel + 2 stories", dealType: glowSale.dealType, amountMinor: glowSale.amountMinor, stage: "paid",
      terms: terms({ deliverables: [{ id: "d1", label: "1 reel", dueAt: iso(glowSale.closedAt - 6 * DAY), done: true }, { id: "d2", label: "2 stories", dueAt: iso(glowSale.closedAt - 6 * DAY), done: true }], usage: "Organic only", paymentDays: 15 }),
      agreedAt: iso(glowSale.closedAt - 12 * DAY), dueAt: dueFromPaymentDays(glowSale.closedAt - 4 * DAY, 15), invoicedAt: iso(glowSale.closedAt - 4 * DAY), paidAt: iso(glowSale.closedAt),
      receivedMinor: glowSale.amountMinor - tdsMinor, tdsMinor, createdAt: iso(glowSale.closedAt - 12 * DAY),
    });
  }
  return deals.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * The workspace's billing details and two invoiced deals, issued through the
 * same rules as a live invoice: TeaLeaf's overdue deal invoiced in full, and a
 * deal agreed on a call (no conversation in DealDock) whose 30% advance was
 * paid, less TDS, and whose balance is invoiced. Also backfills sessions saved
 * before invoices, skipping what those no longer have. Returns the profile
 * with its numbering moved on.
 */
function seedInvoices(now: number, state: Pick<DemoState, "deals" | "ledger">): DemoBillingProfile {
  const org = { timezone: DEMO_TIMEZONE, locale: "en-IN" };
  let profile: DemoBillingProfile = { igAccountId: null, input: DEMO_BILLING, numberYear: "", nextNumber: 1, updatedAt: new Date(now - 40 * DAY).toISOString() };
  const deals = state.deals ?? [];
  const save = (deal: DealDto) => { state.deals = (state.deals ?? []).some((item) => item.id === deal.id) ? (state.deals ?? []).map((item) => (item.id === deal.id ? deal : item)) : [deal, ...(state.deals ?? [])]; };
  const issue = (deal: DealDto, at: number, request: InvoiceCreateRequest) => {
    const issued = issueInvoice(deal, profile, request, at, org);
    profile = issued.profile;
    save(issued.deal);
    return issued;
  };

  const tealeaf = deals.find((deal) => deal.id === "deal-tealeaf" && deal.stage === "invoiced" && !deal.invoices?.length);
  if (tealeaf?.invoicedAt && tealeaf.dueAt) issue(tealeaf, Date.parse(tealeaf.invoicedAt), { kind: "full", billTo: DEMO_BILL_TO.tealeaf, dueAt: tealeaf.dueAt });

  if (!deals.some((deal) => deal.id === "deal-expo")) {
    const iso = (at: number) => new Date(at).toISOString();
    const agreedAt = iso(now - 20 * DAY);
    const expo: DealDto = {
      id: "deal-expo", threadId: null, igAccountId: DEMO_ACCOUNT_ID, counterpartyHandle: "Pune Run Expo", counterpartyName: "Pune Run Expo", channel: null,
      title: "Expo stage session + 2 reels", dealType: "brand", amountMinor: 80_000_00, currencyCode: "INR", stage: "agreed",
      terms: normalizeDealTerms({
        deliverables: [{ id: "d1", label: "Stage session", dueAt: iso(now - 9 * DAY), done: true }, { id: "d2", label: "2 reels", dueAt: iso(now + 5 * DAY), done: false }],
        advancePercent: 30, paymentDays: 15, notes: "Agreed on a call with their marketing team.",
      }),
      agreedAt, dueAt: null, invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null, createdAt: agreedAt, updatedAt: agreedAt, invoices: [],
    };
    const advance = issue(expo, now - 18 * DAY, { kind: "advance", billTo: DEMO_BILL_TO.expo, dueAt: iso(now - 15 * DAY) });
    // 10% TDS on the fee share, withheld by the payer.
    const paid = payInvoice(advance.deal, advance.invoice, { tdsMinor: advance.invoice.subtotalMinor / 10, paidAt: iso(now - 15 * DAY - 3 * HOUR) }, now - 15 * DAY);
    save(paid.deal);
    state.ledger.push(revenueEntry(paid.deal, paid.revenueMinor, paid.invoice.paidAt!, paid.invoice));
    state.ledger.sort((a, b) => b.closedAt - a.closedAt);
    issue(paid.deal, now - 2 * DAY, { kind: "balance", billTo: DEMO_BILL_TO.expo, dueAt: iso(now + 13 * DAY) });
  }
  return profile;
}

/** Billing details as GET /settings/billing-profile returns them: a creator's own, else the workspace's. */
function billingOf(state: DemoState, account: string | null, now: number): BillingProfileResponse {
  const profiles = state.billingProfiles ?? [];
  const own = account ? profiles.find((profile) => profile.igAccountId === account) : undefined;
  const chosen = own ?? profiles.find((profile) => profile.igAccountId === null);
  return { profile: chosen ? profileDto(chosen, state.settings.timezone, now) : null, inherited: account !== null && !own && chosen !== undefined };
}

/** The year and sequence the profile's next invoice gets: a new (financial) year starts again at 1. */
function nextNumberOf(profile: DemoBillingProfile, timeZone: string, at: number) {
  const year = invoiceNumberYear(new Date(at), timeZone, profile.input.country);
  const sequence = profile.numberYear === year ? profile.nextNumber : 1;
  return { year, sequence, number: formatInvoiceNumber(profile.input.invoicePrefix, year, sequence) };
}

function profileDto(profile: DemoBillingProfile, timeZone: string, now: number): BillingProfileDto {
  return { ...profile.input, igAccountId: profile.igAccountId, nextInvoiceNumber: nextNumberOf(profile, timeZone, now).number, updatedAt: profile.updatedAt };
}

/** The API's 409s for an invoice the deal's fee can't take (core's invoiceShareMinor). */
const SHARE_ERRORS: Record<string, string> = {
  deal_has_no_advance: "This deal has no advance. Make a full invoice instead.",
  advance_must_be_first_invoice: "An advance invoice has to come first. Invoice the balance instead.",
  nothing_left_to_invoice: "Everything on this deal is already invoiced.",
  invoice_exceeds_deal_amount: "That's more than what's left to invoice on this deal.",
};

/**
 * An invoice for (part of) a deal, as the API issues it: numbered from the
 * profile, taxed by core's rules and frozen as printed. An agreed deal moves
 * to invoiced and takes the invoice's due date when it has none. Throws the
 * API's errors.
 */
function issueInvoice(deal: DealDto, profile: DemoBillingProfile, request: InvoiceCreateRequest, at: number, org: { timezone: string; locale: string }) {
  if (!isDealOpen(deal)) throw demoError(409, "deal_not_open", "This deal is paid or cancelled, so it can't be invoiced.");
  const billTo = InvoicePartySchema.safeParse(request.billTo);
  if (!billTo.success) throw Object.assign(demoError(400, "invalid_body", "Check who the invoice is to."), { detail: billTo.error.flatten() });
  let baseMinor: number;
  try {
    baseMinor = invoiceShareMinor(request.kind, { amountMinor: deal.amountMinor, advancePercent: deal.terms.advancePercent }, liveInvoices(deal).reduce((sum, invoice) => sum + invoice.subtotalMinor, 0));
  } catch (error) {
    if (isDomainError(error)) throw demoError(error.status, error.code, SHARE_ERRORS[error.code] ?? "That invoice doesn't fit this deal.");
    throw error;
  }
  const { year, sequence, number } = nextNumberOf(profile, org.timezone, at);
  if (profile.input.country === "IN" && number.length > GST_INVOICE_NUMBER_MAX) throw demoError(409, "invoice_number_too_long", "Invoice numbers have to fit GST's 16 characters. Use a shorter prefix in Billing details.");
  const { invoicePrefix: _prefix, ...printed } = profile.input;
  const supplier = { ...printed, timezone: org.timezone, locale: org.locale };
  const computed = computeInvoice({ baseMinor, description: invoiceLineDescription(request.kind, deal.title, deal.terms.advancePercent), supplier, billTo: billTo.data });
  const issuedAt = new Date(at).toISOString();
  const dueAt = request.dueAt ?? invoiceDueDefault(request.kind, deal, at);
  const invoice: InvoiceDto = {
    id: `inv-${number}`, dealId: deal.id, kind: request.kind, number, status: "issued", title: invoiceTitle(computed.supplyType, supplier.tax.kind),
    issuedAt, dueAt, currencyCode: deal.currencyCode, supplier, billTo: billTo.data, ...computed,
    declaration: invoiceDeclaration(computed.supplyType, supplier.tax.lutArn), notes: request.notes?.trim() || null,
    paidAt: null, receivedMinor: null, tdsMinor: null, voidedAt: null, createdAt: issuedAt, updatedAt: issuedAt,
  };
  const moved: DealDto = { ...deal, invoices: [...(deal.invoices ?? []), invoice], ...(deal.stage === "agreed" ? { stage: "invoiced" as const, invoicedAt: issuedAt } : {}), dueAt: deal.dueAt ?? dueAt, updatedAt: issuedAt };
  return { invoice, deal: moved, profile: { ...profile, numberYear: year, nextNumber: sequence + 1 } };
}

/**
 * One invoice paid, as the API records it: received defaults to the total
 * less TDS; Revenue gets what arrived plus TDS, less the GST/VAT it collected.
 * The deal is paid once its paid invoices cover the fee; until then a due
 * date it took from this invoice moves on.
 */
function payInvoice(deal: DealDto, invoice: InvoiceDto, input: DealPaidInput, at: number) {
  const tdsMinor = input.tdsMinor ?? null;
  const receivedMinor = input.receivedMinor ?? defaultReceivedMinor(invoice.totalMinor, tdsMinor);
  const amount = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);
  if (!amount(tdsMinor) || !amount(receivedMinor)) throw demoError(400, "invalid_body", "Enter what you received.");
  const revenueMinor = invoiceRevenueMinor(invoice, { receivedMinor, tdsMinor });
  if (revenueMinor < 0) throw demoError(400, "invalid_body", "What arrived plus the tax withheld can't be less than the invoice's GST.");
  const paidAt = input.paidAt ?? new Date(at).toISOString();
  if (!Number.isFinite(Date.parse(paidAt)) || Date.parse(paidAt) > Date.now() + MINUTE) throw demoError(400, "invalid_body", "Choose the day it was paid: today or earlier.");
  const updatedAt = new Date(at).toISOString();
  const paid: InvoiceDto = { ...invoice, status: "paid", paidAt, receivedMinor, tdsMinor, updatedAt };
  const invoices = (deal.invoices ?? []).map((item) => (item.id === invoice.id ? paid : item));
  const settled = invoices.filter((item) => item.status === "paid");
  const sum = (pick: (item: InvoiceDto) => number | null) => settled.reduce((total, item) => total + (pick(item) ?? 0), 0);
  const covered = sum((item) => item.subtotalMinor) >= deal.amountMinor;
  const next: DealDto = covered
    ? { ...deal, invoices, stage: "paid", paidAt, receivedMinor: sum((item) => item.receivedMinor), tdsMinor: settled.some((item) => item.tdsMinor !== null) ? sum((item) => item.tdsMinor) : null, updatedAt }
    : { ...deal, invoices, dueAt: dueAfter(deal, invoice, invoices), updatedAt };
  return { invoice: paid, deal: next, revenueMinor };
}

/** A due date the deal took from this invoice moves to its next unpaid invoice's, or clears. */
function dueAfter(deal: DealDto, settled: InvoiceDto, invoices: InvoiceDto[]): string | null {
  if (deal.dueAt !== settled.dueAt) return deal.dueAt;
  return invoices.filter((item) => item.status === "issued" && item.id !== settled.id).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]?.dueAt ?? null;
}

/** A payment's Revenue entry: an invoice's carries its number in the note, so Revenue says which invoice it settled. */
function revenueEntry(deal: DealDto, amountMinor: number, paidAt: string, invoice?: InvoiceDto): DemoLedgerEntry {
  return {
    id: `sale-${invoice?.id ?? deal.id}-${Date.parse(paidAt)}`, threadId: deal.threadId, channel: deal.channel, handle: deal.counterpartyHandle, dealType: deal.dealType, amountMinor,
    closedAt: Date.parse(paidAt), note: invoice ? `${deal.title} · ${invoice.number}` : deal.title, dealId: deal.id, ...(invoice ? { invoiceId: invoice.id } : {}),
  };
}

/** A deal as the API returns it: its invoices, and the revenue recorded for it so far (paidMinor). */
function withPaid(deal: DealDto, ledger: DemoLedgerEntry[]): DealDto {
  return { ...deal, invoices: deal.invoices ?? [], paidMinor: ledger.filter((entry) => entry.dealId === deal.id).reduce((sum, entry) => sum + entry.amountMinor, 0) };
}

function seedAudit(state: DemoState, now: number): AuditRow[] {
  const rows: AuditRow[] = [];
  const row = (at: number, action: string, extra: Partial<AuditRow> = {}, actor: AuditRow["actor"] = ACTOR): AuditRow =>
    ({ id: `audit-seed-${rows.length + 1}`, at: new Date(at).toISOString(), action, actor, threadId: null, handle: null, editDistance: null, originalDraft: null, finalText: null, asVoice: false, ...extra });
  state.ledger.slice(0, 12).forEach((entry, index) => rows.push(row(entry.closedAt, "ledger.created", { threadId: entry.threadId, handle: entry.handle }, index % 4 === 3 ? MANAGER : ACTOR)));
  for (const thread of state.threads) {
    for (const message of thread.messages) {
      if (message.direction !== "outbound" || message.origin !== "dealdock" || thread.state === "closed") continue;
      const edited = message.text.replace(/^Heyy/, "Hey").replace(" – D", "");
      rows.push(row(message.sentAt, "message.sent", { threadId: thread.id, handle: thread.handle, editDistance: editDistance(edited, message.text), originalDraft: edited, finalText: message.text }));
    }
  }
  for (const deal of state.deals ?? []) rows.push(row(Date.parse(deal.createdAt), "deal.created", { threadId: deal.threadId, handle: deal.counterpartyHandle }));
  rows.push(row(now - 20 * DAY, "voice.rule_created"));
  rows.push(row(now - 26 * DAY, "settings.region_changed"));
  rows.push(row(now - 3 * DAY, "classification.reviewed", { handle: "fit.with.faiz" }, MANAGER));
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A day in a past (or the current) month, never in the future. */
function saleTime(now: number, monthsAgo: number, day: number, index: number): number {
  const date = new Date(now);
  date.setDate(1);
  date.setMonth(date.getMonth() - monthsAgo);
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, daysInMonth));
  date.setHours(13, 0, 0, 0);
  return Math.min(date.getTime(), now - (index + 1) * 2 * HOUR);
}

function subjectOf(thread: DemoThread, kind: "reply" | "nudge"): DraftSubject {
  const name = thread.participant.name;
  const person = thread.topLabel === "coaching_lead" || thread.topLabel === "course_inquiry";
  return {
    label: thread.topLabel,
    kind,
    firstName: person && name && /^[A-Za-z]/.test(name) ? name.split(" ")[0]! : null,
    hinglish: /\b(hai|kya|abhi|chahiye|kitna|aapke|bhai)\b/i.test(thread.messages.map((message) => message.text || message.audio?.transcript || "").join(" ")),
  };
}

// ── Pure projections ─────────────────────────────────────────────────────

/** A row looks exactly like an API inbox row: one pseudo message, no draft or deal facts. */
function rowOf(thread: DemoThread): DemoThread {
  const lastInbound = [...thread.messages].reverse().find((message) => message.direction === "inbound") ?? thread.messages[0];
  return {
    ...thread,
    detail: false,
    draft: null,
    dealSignal: null,
    closedDeals: [],
    deals: [],
    leadPayments: undefined,
    sendInFlight: false,
    canSendVoice: false,
    messages: lastInbound ? [{ ...lastInbound }] : [],
  };
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: DEMO_TIMEZONE, year: "numeric", month: "2-digit" });
function monthKey(at: number): string {
  return MONTH_FORMAT.format(new Date(at)).slice(0, 7);
}
function mondayOf(now: number): number {
  const date = new Date(now);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
function lastMonths(now: number, count: number): string[] {
  const months: string[] = [];
  const date = new Date(now);
  date.setDate(15);
  for (let i = count - 1; i >= 0; i--) {
    const at = new Date(date);
    at.setMonth(date.getMonth() - i);
    months.push(monthKey(at.getTime()));
  }
  return months;
}

function dashboardOf(ledger: DemoLedgerEntry[]): DashboardView {
  const total = ledger.reduce((sum, entry) => sum + entry.amountMinor, 0);
  return { mtdRecoveredMinor: total, biggestMinor: ledger.reduce((max, entry) => Math.max(max, entry.amountMinor), 0), avgMinor: ledger.length ? Math.round(total / ledger.length) : 0, mtdDealCount: ledger.length };
}

function scopedLedger(state: DemoState, account: string | null): DemoLedgerEntry[] {
  return account ? state.ledger.filter((entry) => entryAccount(state, entry) === account) : state.ledger;
}
/** The creator a payment belongs to: its conversation's, or its deal's when the deal was agreed elsewhere. */
function entryAccount(state: DemoState, entry: DemoLedgerEntry): string | null {
  if (entry.threadId) return state.threads.find((thread) => thread.id === entry.threadId)?.igAccountId ?? null;
  return state.deals?.find((deal) => deal.id === entry.dealId)?.igAccountId ?? null;
}

function ledgerViewOf(state: DemoState, month: string, account: string | null): LedgerView {
  const ledger = scopedLedger(state, account);
  const byMonth = new Map<string, { totalMinor: number; count: number }>();
  for (const entry of ledger) {
    const key = monthKey(entry.closedAt);
    const bucket = byMonth.get(key) ?? { totalMinor: 0, count: 0 };
    bucket.totalMinor += entry.amountMinor;
    bucket.count += 1;
    byMonth.set(key, bucket);
  }
  const entries = ledger.filter((entry) => monthKey(entry.closedAt) === month).sort((a, b) => b.closedAt - a.closedAt);
  const total = entries.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const byType: Partial<Record<DealType, number>> = {};
  for (const entry of entries) byType[entry.dealType] = (byType[entry.dealType] ?? 0) + entry.amountMinor;
  return {
    selectedMonth: month,
    timezone: state.settings.timezone,
    currencyCode: state.money.currency,
    totalMinor: total,
    biggestMinor: entries.reduce((max, entry) => Math.max(max, entry.amountMinor), 0),
    avgMinor: entries.length ? Math.round(total / entries.length) : 0,
    months: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ month: key, ...value })),
    byType,
    entries,
  };
}

function insightsOf(state: DemoState, threads: DemoThread[], now: number, monthCount: number): Insights {
  const months = lastMonths(now, monthCount);
  const current = months[months.length - 1]!;
  const inMonth = (key: string) => state.ledger.filter((entry) => monthKey(entry.closedAt) === key);
  const mtd = inMonth(current);
  const mtdMinor = mtd.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const goal = state.settings.monthlyGoalMinor;
  const date = new Date(now);
  const day = date.getDate();
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const open = threads.filter((thread) => thread.routedTo === "inbox" && thread.state === "open" && isCommerceLabel(thread.topLabel));
  const atRisk = open.filter((thread) => {
    const closes = Date.parse(thread.replyWindow.standardClosesAt ?? "");
    return thread.unreplied && thread.replyWindow.status === "open" && closes - now <= 6 * HOUR;
  });
  const byType = new Map<DealType, { totalMinor: number; deals: number }>();
  for (const entry of mtd) {
    const bucket = byType.get(entry.dealType) ?? { totalMinor: 0, deals: 0 };
    bucket.totalMinor += entry.amountMinor;
    bucket.deals += 1;
    byType.set(entry.dealType, bucket);
  }
  return {
    currencyCode: state.money.currency,
    locale: state.money.locale ?? "en-IN",
    timezone: state.settings.timezone,
    goal: {
      monthlyGoalMinor: goal,
      mtdMinor,
      // Floored, like the API: the ring reads 99% until the goal is actually met.
      pct: goal ? Math.floor((mtdMinor * 100) / goal) : null,
      projectedMinor: day >= 5 ? Math.round(((mtdMinor / day) * daysInMonth) / 100) * 100 : null,
    },
    months: months.map((month) => { const entries = inMonth(month); return { month, recoveredMinor: entries.reduce((sum, entry) => sum + entry.amountMinor, 0), deals: entries.length }; }),
    byType: [...byType.entries()].sort((a, b) => b[1].totalMinor - a[1].totalMinor).map(([dealType, value]) => ({ dealType, ...value })),
    pipeline: {
      openCommerceThreads: open.length,
      openValueMaxMinor: open.reduce((sum, thread) => sum + (thread.estValueMaxMinor ?? 0), 0),
      atRiskThreads: atRisk.length,
      atRiskValueMaxMinor: atRisk.reduce((sum, thread) => sum + (thread.estValueMaxMinor ?? 0), 0),
      nudgesDue: threads.filter((thread) => thread.nudgeDue).length,
      reviewCount: threads.filter((thread) => thread.routedTo === "review_queue" && !thread.reviewed).length,
    },
    speed: { medianFirstReplyMinutes: 130, prevMedianFirstReplyMinutes: 220, within4hPct: 78, within24hPct: 92, sampleSize: 14 },
    voice: { voiceMatchPct: WEEKLY_MATCH[WEEKLY_MATCH.length - 1]!, prevVoiceMatchPct: WEEKLY_MATCH[WEEKLY_MATCH.length - 2]!, sentThisWeek: WEEKLY_SENT[WEEKLY_SENT.length - 1]! + state.sentThisSession },
    leak: { baselineMinMinor: DEMO_LEAK_BASELINE_MINOR, recoveredSinceJoinMinor: state.ledger.filter((entry) => entry.closedAt >= state.joinedAt).reduce((sum, entry) => sum + entry.amountMinor, 0), joinedAt: new Date(state.joinedAt).toISOString() },
    topDeals: [...mtd].sort((a, b) => b.amountMinor - a.amountMinor).slice(0, 10).map((entry) => ({ id: entry.id, threadId: entry.threadId, handle: entry.handle, dealType: entry.dealType, amountMinor: entry.amountMinor, closedAt: new Date(entry.closedAt).toISOString() })),
  };
}

function rosterOf(state: DemoState, threads: DemoThread[], mtd: DemoLedgerEntry[]): RosterRow[] {
  return state.settings.accounts.map((account) => {
    const mine = threads.filter((thread) => (thread.igAccountId ?? DEMO_ACCOUNT_ID) === account.id);
    return {
      igAccountId: account.id,
      handle: account.handle,
      status: account.status,
      mtdRecoveredMinor: mtd.filter((entry) => entryAccount(state, entry) === account.id).reduce((sum, entry) => sum + entry.amountMinor, 0),
      unreadHighPriority: mine.filter((thread) => thread.routedTo === "inbox" && thread.state === "open" && thread.unreplied && isCommerceLabel(thread.topLabel)).length,
      reviewQueueSize: mine.filter((thread) => thread.routedTo === "review_queue" && !thread.reviewed).length,
    };
  });
}

/** GET /comment-leads as the API answers it: every creator's keywords, leads newest first, skipped ones left out. */
function commentLeadsOf(state: DemoState): CommentLeadsView {
  return {
    available: true,
    keywords: state.commentKeywords ?? {},
    leads: (state.commentLeads ?? []).filter((lead) => lead.status !== "skipped").sort((a, b) => Date.parse(b.commentedAt) - Date.parse(a.commentedAt)),
  };
}

const KEYWORD_ERRORS: Record<string, string> = {
  too_many_keywords: "Keep it to 10 keywords.",
  keyword_too_long: "Keep each keyword to 30 characters.",
  keyword_needs_a_word: "A keyword needs a letter, number or emoji.",
};

function dataSummaryOf(state: DemoState): DataSummary {
  const messages = state.threads.reduce((sum, thread) => sum + thread.messages.length, 0);
  return {
    messagesProcessed: 1_140 + messages,
    classifications: 1_090 + messages,
    draftsGenerated: 38 + state.sentThisSession,
    ledgerEntries: state.ledger.length,
    auditRows: state.audit.length,
    deals: state.deals?.length ?? 0,
    invoices: (state.deals ?? []).reduce((sum, deal) => sum + (deal.invoices?.length ?? 0), 0),
    billingProfiles: state.billingProfiles?.length ?? 0,
    emailInboxes: (state.emailAccounts ?? []).map((inbox) => ({ id: inbox.id, address: inbox.address, status: inbox.status, connectedAt: inbox.connectedAt })),
    storingSince: new Date(state.joinedAt).toISOString(),
    deletionRequestedAt: state.settings.deletionRequestedAt,
  };
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function demoError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Add-on prices as the API stores them: validated, every key present, null when none is set, and only on a brand offer. */
function offerAddOns(input: unknown, dealType: OfferDto["dealType"]): OfferAddOns | null {
  let addOns: OfferAddOns | null;
  try { addOns = normalizeOfferAddOns(input); } catch { throw demoError(400, "invalid_body", "Add-on prices must be whole amounts of zero or more."); }
  if (addOns && dealType !== "brand") throw demoError(400, "offer_add_ons_are_for_brand_offers", "Add-on prices are for brand offers.");
  return addOns;
}

/** A rate-card link token as the API makes one: 24 random bytes, base64url. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const demoStore = new DemoStore();
