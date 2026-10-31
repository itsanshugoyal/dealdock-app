"use client";

import {
  computeReplyWindow,
  editDistance,
  isNudgeDue,
  LABEL_FOR_DEAL_TYPE,
  type AudioPreviewResponse,
  type AuditAction,
  type AuditRow,
  type ChooseAlternativeRequest,
  type ClassificationLabel,
  type CreateSpeakingVoiceRequest,
  type CurrencyCode,
  type DealType,
  type DraftContextSummary,
  type DraftDto,
  type DraftRequest,
  type Insights,
  type MoneyContext,
  type OfferDto,
  type OfferInput,
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
  applyChip, applyInstruction, baseDraft, DAY, DEMO_ACCOUNT_ID, DEMO_ACCOUNTS, DEMO_CREATOR, DEMO_GOAL_MINOR, DEMO_LEAK_BASELINE_MINOR,
  DEMO_MONEY, DEMO_SCAN_COMMERCE, DEMO_SCANNED, DEMO_TIMEZONE, HOUR, learnedSignals, measureStyle, MINUTE, offerFor, SAMPLE_INBOUND,
  saleConversation, SEED_SALES, SEED_THREADS, seedOffers, seedRules, seedSamples, styleCardFrom, toneWav, wavDataUrl, wavDurationMs,
  WEEKLY_MATCH, WEEKLY_SENT, type DraftSubject, type SeedThread,
} from "./demo-data";
import { isCommerceLabel, labelNoun } from "./format";
import { emptySnapshot, failed, IDLE, ready } from "./snapshot";
import type {
  AppSnapshot, AppStoreApi, BillingView, DashboardView, DataSummary, DemoLedgerEntry, DemoMessage, DemoThread,
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

type Listener = () => void;
const STORAGE_KEY = "dealdock-demo-v2";
const ACTOR = { seatId: "seat-diya", name: DEMO_CREATOR.name, role: "creator" };
const MANAGER = { seatId: "seat-kabir", name: "Kabir Rao", role: "manager" };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  learningPaused: boolean;
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
      ledgerView: ready(ledgerViewOf(state, this.ledgerMonth ?? currentMonth)),
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
    const replyWindow = computeReplyWindow(thread.lastInboundAt === null ? null : new Date(thread.lastInboundAt), new Date(now), state.settings.humanAgentEnabled);
    const last = thread.messages[thread.messages.length - 1];
    const closed = state.ledger.filter((entry) => entry.handle === thread.handle);
    return {
      ...thread,
      replyWindow,
      nudgeDue: this.nudgeDue(record, now),
      draftReady: thread.draft !== null,
      hasAudio: thread.messages.some((message) => message.contentType === "audio"),
      hasDealSignal: thread.dealSignal !== null && thread.state !== "closed",
      preview: last ? (last.contentType === "audio" ? last.audio?.transcript ?? "" : last.text) : "",
      previewOutbound: last?.direction === "outbound",
      messageCount: thread.messages.length,
      lastMessageAt: last?.sentAt ?? thread.lastMessageAt,
      canSendVoice: state.speaking.status === "ready" && replyWindow.status !== "closed",
      participant: { ...thread.participant, closedTotalMinor: closed.reduce((sum, entry) => sum + entry.amountMinor, 0), closedDeals: closed.length },
      closedDeals: state.ledger.filter((entry) => entry.threadId === thread.id).map((entry) => ({ id: entry.id, amountMinor: entry.amountMinor, currencyCode: state.money.currency, dealType: entry.dealType, note: entry.note ?? null, closedAt: new Date(entry.closedAt).toISOString() })),
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
      learningPaused: state.learningPaused,
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
        && Array.isArray(data.ledger) && Array.isArray(data.offers) && Array.isArray(data.rules) && Array.isArray(data.samples) && Boolean(data.settings);
      return valid ? data : null;
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
    const subject = subjectOf(thread, this.nudgeDue(thread, Date.now()) ? "nudge" : "reply");
    const steering = Boolean(request.chips?.length || request.instruction);
    let body = steering && thread.draft ? thread.draft.body : baseDraft(subject, this.s.offers, this.s.money);
    for (const chip of request.chips ?? []) body = applyChip(body, chip, subject, this.s.offers, this.s.money);
    if (request.instruction) body = applyInstruction(body, request.instruction.slice(0, 200));
    const variants = Math.min(3, Math.max(1, request.variants ?? 1));
    const alternatives = variants > 1
      ? [...new Set([body, applyChip(body, "shorter", subject, this.s.offers, this.s.money), applyChip(body, "warmer", subject, this.s.offers, this.s.money), applyChip(body, "longer", subject, this.s.offers, this.s.money)])].slice(0, variants)
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
      context: this.contextFor(thread),
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
    if (window.status === "closed") throw demoError(409, "send_window_closed", "Instagram's reply window has closed. Reply from Instagram instead.");
    if (options.asVoice && this.s.speaking.status !== "ready") throw demoError(409, "speaking_voice_not_ready", "Set up your speaking voice before sending voice notes.");
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
    this.emit();
    return { status: "accepted", sent: true, intentId: `intent-${now}`, messageId, editDistance: distance, learned, pending: false, ambiguous: false };
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
    const entry: DemoLedgerEntry = { id: `sale-${Date.now()}`, threadId: thread.id, handle: thread.handle, dealType, amountMinor, closedAt: Date.now(), note: options.note || undefined };
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

  async loadLedger(month?: string) {
    await this.init();
    this.ledgerMonth = month ?? null;
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
    if (entry) this.audit("ledger.deleted", { threadId: entry.threadId, handle: entry.handle });
    this.emit();
  }
  async download(path: string, fallbackName: string) {
    if (typeof document === "undefined") return;
    const state = this.s;
    const body = path === "/ledger/export.csv"
      ? ["date,handle,deal_type,amount_minor,currency,note", ...state.ledger.map((entry) => [new Date(entry.closedAt).toISOString().slice(0, 10), entry.handle, entry.dealType, entry.amountMinor, state.money.currency, csvCell(entry.note ?? "")].join(","))].join("\n")
      : JSON.stringify({ exportedAt: new Date().toISOString(), demo: true, ledger: state.ledger, threads: state.threads.map((thread) => ({ handle: thread.handle, messages: thread.messages.map((message) => ({ direction: message.direction, text: message.text, sentAt: message.sentAt })) })) }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: path.endsWith(".csv") ? "text/csv" : "application/json" }));
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

  // ── Offers ─────────────────────────────────────────────────────────────

  async loadOffers() { return this.load("offers"); }
  async createOffer(input: OfferInput) {
    const offer: OfferDto = { ...input, id: `offer-${Date.now()}`, currencyCode: this.s.money.currency, updatedAt: new Date().toISOString() };
    this.s.offers.push(offer);
    this.audit("offer.created");
    this.emit();
    return offer;
  }
  async updateOffer(offerId: string, patch: Partial<OfferInput>) {
    const offer = this.s.offers.find((item) => item.id === offerId);
    if (!offer) throw demoError(404, "not_found", "This offer was removed.");
    Object.assign(offer, patch, { updatedAt: new Date().toISOString() });
    this.audit("offer.updated");
    this.emit();
    return { ...offer };
  }
  async deleteOffer(offerId: string) {
    this.s.offers = this.s.offers.filter((item) => item.id !== offerId);
    this.audit("offer.deleted");
    this.emit();
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
  async setLearningPaused(paused: boolean) {
    this.s.learningPaused = paused;
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

  private contextFor(thread: Pick<DemoThread, "topLabel" | "id">): DraftContextSummary {
    const label = thread.topLabel;
    const rules = this.s.rules.filter((rule) => (rule.status === "active" || rule.status === "pinned") && (rule.scope === "all" || rule.scope === label));
    const offer = offerFor(label, this.s.offers);
    const exemplars = this.s.samples.filter((sample) => !sample.excluded && SAMPLE_INBOUND[sample.messageId]).slice(0, 2)
      .map((sample) => ({ messageId: sample.messageId, text: sample.text, inboundText: SAMPLE_INBOUND[sample.messageId] ?? null }));
    const lessons = label === "brand_deal" ? ["You shorten brand replies by about 30%.", "You ask for the brief before you quote."]
      : label === "coaching_lead" ? ["You put the price and the link in the first reply to coaching leads."] : [];
    const missingFacts = this.s.missingFacts[thread.id] ?? (label && isCommerceLabel(label) && !offer ? [`your price for ${labelNoun(label).replace(/^an? /, "")}`] : []);
    return { rules: rules.map((rule) => ({ id: rule.id, text: rule.text })), exemplars, offers: offer ? [{ id: offer.id, name: offer.name }] : [], lessons, missingFacts };
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────

function seed(now: number): DemoState {
  const offers = seedOffers(now);
  const threads: DemoRecord[] = SEED_THREADS.map((item) => seedThread(item, now));
  const ledger: DemoLedgerEntry[] = [];
  SEED_SALES.forEach((sale, index) => {
    const closedAt = saleTime(now, sale.monthsAgo, sale.day, index);
    const entry: DemoLedgerEntry = { id: `sale-${index + 1}`, threadId: `t-sale-${index + 1}`, handle: sale.handle, dealType: sale.dealType, amountMinor: sale.rupees * 100, closedAt, note: sale.note };
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
    learningPaused: false,
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
    businessContext: { sells: ["Coaching", "Brand deals", "Courses"], businessSummary: "Fitness coach, Hindi + English, 120K followers" },
    onboarded: true,
    leakScanStartedAt: null,
    usedCloseKeys: [],
    joinedAt: now - 180 * DAY,
    money: { ...DEMO_MONEY },
  };
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
    canSendVoice: false,
    detail: true,
    messages,
    draft: null,
  };
  if (item.draft) {
    const subject = subjectOf(thread, item.draft);
    thread.draft = {
      id: `d-${item.id}-seed`, body: baseDraft(subject, seedOffers(now), DEMO_MONEY), kind: item.draft, status: "ready", version: 1,
      label: thread.topLabel, instruction: null, chips: [], alternatives: [], chosenAlternative: null,
      context: { rules: [{ id: "rule-signoff", text: "Sign off with “– D”" }], exemplars: [], offers: [], lessons: [], missingFacts: [] },
    };
  }
  return thread;
}

/** Demo voice note: a soft tone per word (clearly not a voice), with its real duration. */
function demoAudio(transcript: string, language: string | null) {
  const bytes = toneWav(transcript, 6);
  return { url: wavDataUrl(bytes), mimeType: "audio/wav", durationMs: wavDurationMs(bytes), transcript, transcriptLanguage: language, status: "ready" as const };
}

function closedThread(entry: DemoLedgerEntry, name: string, closedAt: number): DemoRecord {
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
    sendInFlight: false, closedDeals: [], canSendVoice: false, detail: true, messages, draft: null,
  };
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

function ledgerViewOf(state: DemoState, month: string): LedgerView {
  const byMonth = new Map<string, { totalMinor: number; count: number }>();
  for (const entry of state.ledger) {
    const key = monthKey(entry.closedAt);
    const bucket = byMonth.get(key) ?? { totalMinor: 0, count: 0 };
    bucket.totalMinor += entry.amountMinor;
    bucket.count += 1;
    byMonth.set(key, bucket);
  }
  const entries = state.ledger.filter((entry) => monthKey(entry.closedAt) === month).sort((a, b) => b.closedAt - a.closedAt);
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
  return state.settings.accounts.map((account, index) => {
    const mine = threads.filter((thread) => (thread.igAccountId ?? DEMO_ACCOUNT_ID) === account.id);
    return {
      igAccountId: account.id,
      handle: account.handle,
      status: account.status,
      // Sample months for the other creators; the first creator's month is the live ledger.
      mtdRecoveredMinor: index === 0 ? mtd.reduce((sum, entry) => sum + entry.amountMinor, 0) : index === 1 ? 11_200_000 : 4_850_000,
      unreadHighPriority: mine.filter((thread) => thread.routedTo === "inbox" && thread.state === "open" && thread.unreplied && isCommerceLabel(thread.topLabel)).length,
      reviewQueueSize: mine.filter((thread) => thread.routedTo === "review_queue" && !thread.reviewed).length,
    };
  });
}

function dataSummaryOf(state: DemoState): DataSummary {
  const messages = state.threads.reduce((sum, thread) => sum + thread.messages.length, 0);
  return {
    messagesProcessed: 1_140 + messages,
    classifications: 1_090 + messages,
    draftsGenerated: 38 + state.sentThisSession,
    ledgerEntries: state.ledger.length,
    auditRows: state.audit.length,
    storingSince: new Date(state.joinedAt).toISOString(),
    deletionRequestedAt: state.settings.deletionRequestedAt,
  };
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function demoError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

export const demoStore = new DemoStore();
