"use client";

import {
  DEAL_TYPES,
  isDealType,
  type AudioPreviewResponse,
  type AuditRow,
  type ChooseAlternativeRequest,
  type ClassificationLabel,
  type CreateSpeakingVoiceRequest,
  type CurrencyCode,
  type DealType,
  type DraftDto,
  type DraftRequest,
  type InboxResponse,
  type InboxRow,
  type Insights,
  type LeakScanSummary,
  type MoneyContext,
  type OfferDto,
  type OfferInput,
  type ReplyWindow,
  type ReviewQueueResponse,
  type ReviewQueueRow,
  type SendResponse,
  type SpeakingVoiceDto,
  type StyleCard,
  type ThreadDetail,
  type ThreadMessage,
  type ThreadState,
  type VoicePreviewRequest,
  type VoicePreviewResponse,
  type VoiceRuleDto,
  type VoiceRuleScope,
  type VoiceRuleStatus,
  type VoiceStudio,
} from "@dealdock/core";
import { emptySnapshot, errorMessage, errorStatus, failed, IDLE, loading, ready } from "./snapshot";
import type {
  AppSnapshot,
  AppStoreApi,
  BillingView,
  DashboardView,
  DataSummary,
  DemoLedgerEntry,
  DemoMessage,
  DemoThread,
  LedgerView,
  MeView,
  NotificationPrefs,
  OnboardingInput,
  OnboardingView,
  RegionInput,
  RosterRow,
  RuleInput,
  SeatView,
  SendResult,
  SettingsView,
  Slice,
  SliceKey,
} from "./types";

type TokenProvider = () => Promise<string | null>;
type Listener = () => void;
type SliceData<K extends SliceKey> = AppSnapshot[K] extends Slice<infer T> ? T : never;
type Json = Record<string, unknown>;

/** The core refresh: one GET per part. Everything else is a lazy slice. */
const CORE = {
  dashboard: "/dashboard",
  inbox: "/inbox",
  review: "/review-queue",
  ledger: "/ledger",
  waiting: "/inbox?state=waiting",
  onboarding: "/onboarding",
} as const;
type CorePart = keyof typeof CORE;
const CORE_PARTS = Object.keys(CORE) as CorePart[];
/** The core parts `threads` is built from, in this order. */
type ListPart = "inbox" | "waiting" | "review";

/** Slices derived from threads and the ledger: a full refresh after the first marks them stale. */
const CORE_DERIVED: SliceKey[] = ["insights", "ledgerView", "closed", "audit", "roster"];
/** Every write adds an audit row or moves the stored-data counts. */
const WRITE_TOUCHED: SliceKey[] = ["audit", "dataSummary"];

const REQUEST_FAILURES = {
  offline: "You are offline. DealDock does not queue sends or edits; reconnect and try again.",
  cancelled: "This request was cancelled because you changed accounts.",
  changed: "Account changed while loading this request.",
};
const EXPORT_FAILURES = {
  offline: "You are offline. Reconnect before exporting data.",
  cancelled: "Account changed while loading this export.",
  changed: "Account changed while loading this export.",
};

/**
 * Browser client for the authenticated API. It owns no persistent cache: a
 * Clerk identity change clears the in-memory snapshot (and every lazy slice)
 * and aborts requests before another render can show the old tenant's data.
 * Demo state deliberately lives in demo-store instead.
 *
 * A write never reloads everything: it applies what its response says (the
 * one thread row, ledger entry, offer or rule), refetches only the core parts
 * it changed, reloads the open conversation, and marks the lazy slices it
 * changed stale so screens showing them reload (useLazy) and the rest reload
 * on their next mount.
 */
export class ApiStore implements AppStoreApi {
  private listeners = new Set<Listener>();
  private snapshot: AppSnapshot = emptySnapshot("idle");
  private tokenProvider: TokenProvider | null = null;
  private identity: string | null = null;
  private epoch = 0;
  private controllers = new Set<AbortController>();
  private localDevelopment = false;
  private refreshing: Promise<void> | null = null;
  private pushCleanup: Promise<void> = Promise.resolve();
  private inflight = new Map<string, Promise<unknown>>();
  /** Send idempotency key per draft: stable across retries of the same approval. */
  private sendKeys = new Map<string, string>();
  private lists: Record<ListPart, DemoThread[]> = { inbox: [], waiting: [], review: [] };
  /** The org time zone as GET /onboarding and GET /ledger report it; onboarding's wins. */
  private zones = { onboarding: "", ledger: "" };
  /** Lazy slices a screen loaded; until one loads the ledger view, the core refresh seeds it. */
  private requested = new Set<SliceKey>();
  /**
   * Load ordering, per slot (a slice key, `detail:<threadId>` or `core:<part>`).
   * Every load and local patch takes the next number. A response lands only
   * if no later load of its slot started; one that started before a write
   * touched the slot (a local patch or a stale mark) is fetched again instead,
   * so pre-write data never lands and a stale slice ends fresh.
   */
  private seq = 0;
  private latest = new Map<string, number>();
  private patchedAt = new Map<string, number>();
  private staleAt = new Map<string, number>();

  setLocalDevelopment(enabled: boolean) {
    this.localDevelopment = enabled && process.env.NODE_ENV === "development";
    this.authenticate(this.localDevelopment ? "local-integration" : null, null);
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  private emit() { this.listeners.forEach((listener) => listener()); }
  private patch(partial: Partial<AppSnapshot>) {
    this.snapshot = { ...this.snapshot, ...partial };
    this.emit();
  }

  authenticate(identity: string | null, tokenProvider: TokenProvider | null) {
    if (this.identity !== identity) {
      this.clearPreviousPushOwner(identity);
      this.controllers.forEach((controller) => controller.abort());
      this.controllers.clear();
      this.refreshing = null;
      this.inflight.clear();
      this.sendKeys.clear();
      this.lists = { inbox: [], waiting: [], review: [] };
      this.zones = { onboarding: "", ledger: "" };
      this.requested.clear();
      this.latest.clear();
      this.patchedAt.clear();
      this.staleAt.clear();
      this.identity = identity;
      this.epoch += 1;
      this.snapshot = emptySnapshot(identity ? "loading" : "idle", this.epoch);
      this.emit();
    }
    this.tokenProvider = tokenProvider;
    if (identity && (tokenProvider || this.localDevelopment)) void this.refresh();
  }

  private clearPreviousPushOwner(nextIdentity: string | null) {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let owner: string | null = null;
    try { owner = localStorage.getItem("dealdock.push.owner"); } catch { /* unavailable storage: conservatively unsubscribe */ }
    if (owner && owner === nextIdentity) return;
    this.pushCleanup = this.pushCleanup.catch(() => {}).then(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
      try { if (localStorage.getItem("dealdock.push.owner") === owner) localStorage.removeItem("dealdock.push.owner"); } catch { /* no persisted owner */ }
    });
    // Keep a failed cleanup visible to explicit opt-in without an unhandled rejection.
    void this.pushCleanup.catch(() => {});
  }

  async preparePush() {
    const identity = this.identity;
    if (!identity) throw new Error("Sign in before enabling notifications.");
    await this.pushCleanup;
    this.assertPushIdentity(identity);
    return identity;
  }
  assertPushIdentity(identity: string) {
    if (this.identity !== identity) throw new Error("Account changed while enabling notifications. Try again in the current workspace.");
  }
  confirmPushIdentity(identity: string) {
    this.assertPushIdentity(identity);
    localStorage.setItem("dealdock.push.owner", identity);
  }

  async init() { if (this.snapshot.state === "idle" && this.identity && (this.tokenProvider || this.localDevelopment)) await this.refresh(); }

  /**
   * The one way this store reaches the API: refuses offline, captures the
   * account before awaiting its token and re-checks it after, adds the token
   * and base URL, and tracks the request — body read included — so an account
   * switch aborts it.
   */
  private async authorizedFetch<T>(path: string, init: RequestInit, read: (response: Response) => Promise<T>, failures: typeof REQUEST_FAILURES): Promise<T> {
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error(failures.offline);
    const requestedFor = this.identity;
    const token = await this.tokenProvider?.();
    if (this.identity !== requestedFor) throw new Error("Account changed while authorizing this request.");
    if (!token && !this.localDevelopment) throw new Error("Your session is unavailable. Sign in again to continue.");
    const base = this.localDevelopment ? "/api/dev" : process.env.NEXT_PUBLIC_API_URL;
    if (!base) throw new Error("DealDock is not configured for this environment.");
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const result = await read(await fetch(`${base.replace(/\/$/, "")}${path}`, {
        ...init, headers, cache: "no-store", credentials: "omit", signal: controller.signal,
      }));
      if (controller.signal.aborted) throw new Error(failures.cancelled);
      if (this.identity !== requestedFor) throw new Error(failures.changed);
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(failures.cancelled);
      throw error;
    } finally {
      this.controllers.delete(controller);
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.authorizedFetch(path, init, async (response) => {
      if (!response.ok) {
        let detail = "";
        let code = "";
        try {
          const body = (await response.json()) as { error?: string; hint?: string; message?: string };
          code = body.error ?? "";
          detail = body.hint ?? body.message ?? body.error ?? "";
        } catch { /* response is not JSON */ }
        throw httpError(response.status, code, detail);
      }
      return (await response.json()) as T;
    }, REQUEST_FAILURES);
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    const current = this.loadSnapshot();
    this.refreshing = current;
    try { await current; } finally { if (this.refreshing === current) this.refreshing = null; }
  }

  /** The full core refresh (sign-in, retry, back online, onboarding): every part at once. */
  private async loadSnapshot() {
    if (!this.identity || (!this.tokenProvider && !this.localDevelopment)) return;
    const requestedFor = this.identity;
    // A retry, coming back online or onboarding — not the first load, whose screens are loading their slices right now.
    const reloaded = this.snapshot.loadedAt !== null || this.snapshot.state === "error";
    this.patch({ state: "loading", error: null });
    try {
      const { next, refetch } = await this.fetchCore(CORE_PARTS);
      if (this.identity !== requestedFor) return;
      this.patch({ ...next, state: "ready", error: null, loadedAt: Date.now() });
      if (refetch.length) void this.refreshParts(refetch);
      // What threads and the ledger feed may have moved as well: screens showing it reload now, the rest on their next mount.
      if (reloaded) this.markStale(...CORE_DERIVED);
    } catch (error) {
      if (this.identity === requestedFor) this.failCore(error);
    }
  }

  /** After a write: refetch only the core parts it changed, keeping everything on screen meanwhile. Never throws. */
  private async refreshParts(parts: CorePart[]): Promise<void> {
    if (!parts.length || !this.identity) return;
    const requestedFor = this.identity;
    try {
      const { next, refetch } = await this.fetchCore(parts);
      if (this.identity !== requestedFor) return;
      this.patch(next);
      if (refetch.length) await this.refreshParts(refetch);
    } catch (error) {
      if (this.identity === requestedFor) this.failCore(error);
    }
  }

  /** GETs core parts; returns the fields of the ones that landed and the ones to fetch again (see `seq`). */
  private async fetchCore(parts: CorePart[]): Promise<{ next: Partial<AppSnapshot>; refetch: CorePart[] }> {
    const seq = ++this.seq;
    for (const part of parts) this.latest.set(`core:${part}`, seq);
    const responses = await Promise.all(parts.map((part) => this.request<unknown>(CORE[part])));
    const landed = new Map<CorePart, unknown>();
    const refetch: CorePart[] = [];
    parts.forEach((part, index) => {
      const landing = this.landing(`core:${part}`, seq);
      if (landing === "apply") landed.set(part, responses[index]);
      else if (landing === "again") refetch.push(part);
    });
    return { next: this.coreFields(landed), refetch };
  }

  /** Snapshot fields from core responses; also files the lists and time zones they carry. */
  private coreFields(landed: Map<CorePart, unknown>): Partial<AppSnapshot> {
    const next: Partial<AppSnapshot> = {};
    if (landed.has("dashboard")) {
      const dashboard = obj(landed.get("dashboard"));
      const org = obj(dashboard.org);
      next.dashboard = toDashboard(dashboard);
      next.money = toMoney(dashboard.org ? org : dashboard);
      next.workspaceName = str(org.name) || null;
    }
    const lists = { ...this.lists };
    if (landed.has("inbox")) lists.inbox = (landed.get("inbox") as InboxResponse).rows.map(fromInboxRow);
    if (landed.has("waiting")) lists.waiting = (landed.get("waiting") as InboxResponse).rows.map(fromInboxRow);
    if (landed.has("review")) lists.review = (landed.get("review") as ReviewQueueResponse).rows.map(fromReviewRow);
    const zones = { ...this.zones };
    if (landed.has("onboarding")) {
      const onboarding = obj(landed.get("onboarding"));
      zones.onboarding = str(onboarding.timezone);
      next.onboarded = Boolean(onboarding.complete);
    }
    if (landed.has("ledger")) {
      const ledger = obj(landed.get("ledger"));
      zones.ledger = str(ledger.timezone);
      next.ledger = toLedger(ledger);
      // A month the creator picked stays picked; until a screen loads one, the ledger view follows the current month.
      if (!this.requested.has("ledgerView")) next.ledgerView = ready(toLedgerView(ledger, (next.money ?? this.snapshot.money).currency));
    }
    this.lists = lists;
    this.zones = zones;
    if (landed.has("inbox") || landed.has("waiting") || landed.has("review")) next.threads = threadsOf(lists);
    if (landed.has("onboarding") || landed.has("ledger")) next.timezone = zones.onboarding || zones.ledger || this.snapshot.timezone;
    return next;
  }

  /** A core load failed: keep what this account already saw on a transient failure; never after an auth or permission failure. */
  private failCore(error: unknown) {
    const status = errorStatus(error);
    if (this.snapshot.loadedAt !== null && status !== 401 && status !== 403) {
      this.patch({ state: "error", error: errorMessage(error) });
      return;
    }
    this.lists = { inbox: [], waiting: [], review: [] };
    this.zones = { onboarding: "", ledger: "" };
    this.snapshot = { ...emptySnapshot("error", this.epoch), error: errorMessage(error) };
    this.emit();
  }

  /** Waits out a full refresh that started before a write, then runs one that sees it. */
  private async refreshAfterWrite() {
    if (this.refreshing) await this.refreshing;
    await this.refresh();
  }

  // ── Load ordering and staleness ────────────────────────────────────────

  private begin(slot: string): number {
    const seq = ++this.seq;
    this.latest.set(slot, seq);
    return seq;
  }
  private landing(slot: string, seq: number): "apply" | "again" | "drop" {
    if (this.latest.get(slot) !== seq) return "drop";
    return (this.patchedAt.get(slot) ?? 0) > seq || (this.staleAt.get(slot) ?? 0) >= seq ? "again" : "apply";
  }
  /** A write was applied to `slot` locally. */
  private touched(slot: string) {
    this.patchedAt.set(slot, ++this.seq);
  }
  /** Drops a slot's requests in flight, so the next load sends its own instead of joining one from before a write. */
  private forget(slot: string) {
    for (const key of [...this.inflight.keys()]) if (key.startsWith(`${slot}|`)) this.inflight.delete(key);
  }
  /**
   * A write changed what these slices show. Screens showing one reload it now
   * (useLazy watches `stale`); the rest reload when a screen next mounts them.
   * A slice a failed refresh cleared back to idle is flagged too when a
   * screen had loaded it, so the screen still showing it loads it again.
   */
  private markStale(...keys: SliceKey[]) {
    const next: Partial<Record<SliceKey, Slice<unknown>>> = {};
    for (const key of keys) {
      this.staleAt.set(key, this.seq);
      this.forget(key);
      const slice = this.snapshot[key] as Slice<unknown>;
      if ((slice.status !== "idle" || this.requested.has(key)) && !slice.stale) next[key] = { ...slice, stale: true };
    }
    if (Object.keys(next).length) this.patch(next as Partial<AppSnapshot>);
  }

  private dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = run().finally(() => { if (this.inflight.get(key) === promise) this.inflight.delete(key); });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Loads one lazy slice; never throws (the outcome lives in the slice). */
  private loadSlice<K extends SliceKey>(key: K, path: string, map: (raw: unknown) => SliceData<K>): Promise<SliceData<K> | null> {
    this.requested.add(key);
    return this.dedupe(`${key}|${path}`, async () => {
      if (!this.identity) return null;
      const requestedFor = this.identity;
      const seq = this.begin(key);
      const slice = this.snapshot[key] as Slice<SliceData<K>>;
      // Data already on screen stays there while it reloads.
      if (slice.data === null) this.patch({ [key]: loading(slice) } as Partial<AppSnapshot>);
      try {
        const data = map(await this.request<unknown>(path));
        const landing = this.landing(key, seq);
        if (this.identity !== requestedFor || landing === "drop") return null;
        if (landing === "again") {
          this.forget(key);
          return this.loadSlice(key, path, map);
        }
        this.patch({ [key]: ready(data) } as Partial<AppSnapshot>);
        return data;
      } catch (error) {
        if (this.identity === requestedFor && this.landing(key, seq) !== "drop") this.patch({ [key]: failed(this.snapshot[key] as Slice<SliceData<K>>, errorMessage(error), errorStatus(error)) } as Partial<AppSnapshot>);
        return null;
      }
    });
  }
  /** A write applied to a loaded slice's data now. */
  private patchSlice<K extends SliceKey>(key: K, update: (data: SliceData<K>) => SliceData<K>) {
    const slice = this.snapshot[key] as Slice<SliceData<K>>;
    if (slice.data === null) return;
    this.touched(key);
    this.patch({ [key]: { ...slice, data: update(slice.data) } } as Partial<AppSnapshot>);
  }
  /** A write that answers with the whole slice: it lands like a load that started after every earlier one. */
  private replaceSlice<K extends SliceKey>(key: K, data: SliceData<K>) {
    this.begin(key);
    this.patch({ [key]: ready(data) } as Partial<AppSnapshot>);
  }

  /** A write; its result patches local state only if the account did not change meanwhile. */
  private async write<T>(path: string, init: RequestInit, apply?: (result: T) => void): Promise<T> {
    const requestedFor = this.identity;
    const result = await this.request<T>(path, init);
    if (this.identity !== requestedFor) throw new Error("Account changed while saving.");
    apply?.(result);
    this.markStale(...WRITE_TOUCHED);
    return result;
  }

  /**
   * The rest of a write's effect: refetch the core parts it changed, reload
   * the conversation when it is open, mark the lazy slices it changed stale.
   * Never throws — the write itself already succeeded.
   */
  private async settle(effects: { parts?: CorePart[]; thread?: string; stale?: SliceKey[] }) {
    this.markStale(...(effects.stale ?? []));
    await Promise.all([this.refreshParts(effects.parts ?? []), effects.thread ? this.reloadDetail(effects.thread) : null]);
  }

  // ── Core lists ─────────────────────────────────────────────────────────

  /** Applies a write to the core lists now (see `seq` for loads already in flight). */
  private patchLists(parts: ListPart[], update: (lists: Record<ListPart, DemoThread[]>) => Record<ListPart, DemoThread[]>) {
    this.lists = update(this.lists);
    for (const part of parts) this.touched(`core:${part}`);
    this.patch({ threads: threadsOf(this.lists) });
  }
  private patchLedger(update: (entries: DemoLedgerEntry[]) => DemoLedgerEntry[]) {
    this.touched("core:ledger");
    this.patch({ ledger: update(this.snapshot.ledger) });
  }
  private inboxRow(threadId: string): DemoThread | undefined {
    return this.lists.inbox.find((row) => row.id === threadId) ?? this.lists.waiting.find((row) => row.id === threadId);
  }
  /** Patches one conversation's inbox row; a state change moves it to Waiting, back to the inbox, or out when closed. */
  private patchRow(threadId: string, update: (row: DemoThread) => DemoThread) {
    const row = this.inboxRow(threadId);
    if (row) this.placeRow(update(row));
  }
  private placeRow(row: DemoThread) {
    const target: ListPart | null = row.state === "open" ? "inbox" : row.state === "waiting" ? "waiting" : null;
    const file = (list: DemoThread[], part: ListPart) => {
      const listed = list.some((item) => item.id === row.id);
      if (part !== target) return listed ? list.filter((item) => item.id !== row.id) : list;
      return listed ? list.map((item) => (item.id === row.id ? row : item)) : [...list, row];
    };
    this.patchLists(["inbox", "waiting"], (lists) => ({ ...lists, inbox: file(lists.inbox, "inbox"), waiting: file(lists.waiting, "waiting") }));
  }
  /** Files the conversation's inbox row from its freshly loaded detail, as GET /inbox would list it. */
  private syncRow(detail: ThreadDetail) {
    // The Review Queue owns a conversation with an undecided item; the inbox lists leave it out.
    if (this.lists.review.some((row) => row.id === detail.id)) return;
    if (!this.inboxRow(detail.id) && (detail.state === "closed" || detail.topLabel == null)) return;
    this.placeRow(fromInboxRow(inboxRowFromDetail(detail)));
  }

  // ── Threads ────────────────────────────────────────────────────────────

  loadThread(threadId: string): Promise<DemoThread | null> {
    return this.loadDetail(threadId).then((loaded) => loaded?.thread ?? null);
  }
  /** GET /threads/:id into `details`; never throws (the outcome lives in the slice). */
  private loadDetail(threadId: string): Promise<{ raw: ThreadDetail; thread: DemoThread } | null> {
    const slot = `detail:${threadId}`;
    return this.dedupe(`${slot}|`, async () => {
      if (!this.identity) return null;
      const requestedFor = this.identity;
      const seq = this.begin(slot);
      const current = this.snapshot.details[threadId];
      if (!current?.data) this.setDetail(threadId, loading(current ?? IDLE));
      try {
        const raw = await this.request<ThreadDetail>(`/threads/${enc(threadId)}`);
        const thread = fromThreadDetail(raw);
        const landing = this.landing(slot, seq);
        if (this.identity !== requestedFor || landing === "drop") return null;
        if (landing === "again") {
          this.forget(slot);
          return this.loadDetail(threadId);
        }
        this.setDetail(threadId, ready(thread));
        return { raw, thread };
      } catch (error) {
        if (this.identity === requestedFor && this.landing(slot, seq) !== "drop") this.setDetail(threadId, failed(this.snapshot.details[threadId] ?? IDLE, errorMessage(error), errorStatus(error)));
        return null;
      }
    });
  }
  private setDetail(threadId: string, slice: Slice<DemoThread>) {
    this.patch({ details: { ...this.snapshot.details, [threadId]: slice } });
  }
  /** After a write to a conversation that is open: reload it with a request of its own and file its row to match. */
  private async reloadDetail(threadId: string) {
    if (!this.snapshot.details[threadId]) return;
    this.forget(`detail:${threadId}`);
    const loaded = await this.loadDetail(threadId);
    if (loaded) this.syncRow(loaded.raw);
  }
  private patchDetail(threadId: string, update: (thread: DemoThread) => DemoThread) {
    const slice = this.snapshot.details[threadId];
    if (!slice?.data) return;
    this.touched(`detail:${threadId}`);
    this.setDetail(threadId, { ...slice, data: update(slice.data) });
  }
  loadClosed() {
    return this.loadSlice("closed", "/inbox?state=closed", (raw) => (raw as InboxResponse).rows.map(fromInboxRow));
  }
  async generateDraft(threadId: string, request: DraftRequest = {}) {
    const steered = Boolean(request.chips?.length || request.instruction);
    const hasBody = steered || Boolean(request.variants);
    const draft = await this.write<DraftDto>(`/threads/${enc(threadId)}/draft`, hasBody ? jsonInit("POST", request) : { method: "POST" });
    if (!draft?.id) throw new Error("DealDock could not prepare a draft for this conversation.");
    this.patchDetail(threadId, (thread) => ({ ...thread, draft, draftReady: true }));
    if (this.inboxRow(threadId)?.draftReady === false) this.patchRow(threadId, (row) => ({ ...row, draftReady: true }));
    // Steering a draft is feedback on the one it replaces; style chips teach the voice.
    if (steered) this.markStale("voice");
    return draft;
  }
  async chooseAlternative(threadId: string, request: ChooseAlternativeRequest) {
    const draft = await this.write<DraftDto>(`/threads/${enc(threadId)}/draft/choose`, jsonInit("POST", request));
    if (!draft?.id) throw new Error("That take is no longer available. Generate a new draft.");
    this.patchDetail(threadId, (thread) => ({ ...thread, draft }));
    return draft;
  }
  async send(threadId: string, finalText: string, options: { asVoice?: boolean } = {}): Promise<SendResult> {
    const thread = this.snapshot.details[threadId]?.data ?? this.snapshot.threads.find((item) => item.id === threadId);
    const draftId = thread?.draft?.id;
    if (!draftId) throw new Error("A fresh draft is required before you can approve a send.");
    let idempotencyKey = this.sendKeys.get(draftId);
    if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); this.sendKeys.set(draftId, idempotencyKey); }
    const result = await this.write<SendResponse>(`/threads/${enc(threadId)}/send`, jsonInit("POST", {
      draftId, finalText, idempotencyKey, ...(options.asVoice ? { asVoice: true } : {}),
    }));
    // The sent message, the cleared draft and the row's new preview come back with the conversation.
    await this.settle({ thread: threadId, stale: ["insights", "roster", "voice"] });
    return { ...result, learned: result.learned ?? [], pending: result.status === "pending" || result.status === "remote_accepted", ambiguous: result.status === "unknown" };
  }
  async setState(threadId: string, state: ThreadState) {
    const listed = this.inboxRow(threadId) !== undefined;
    const result = await this.write<{ state: ThreadState; waitingSince: string | null }>(`/threads/${enc(threadId)}`, jsonInit("PATCH", { state }));
    // A new state starts a new follow-up clock, so nothing is due yet.
    this.patchRow(threadId, (row) => ({ ...row, state: result.state, waitingSince: ms(result.waitingSince), nudgeDue: false }));
    // Reopened from Closed with the conversation not loaded: only its list can supply the row.
    const unlisted: CorePart[] = !listed && !this.snapshot.details[threadId] && result.state !== "closed" ? [result.state === "open" ? "inbox" : "waiting"] : [];
    await this.settle({ parts: unlisted, thread: threadId, stale: ["closed", "insights", "roster"] });
    return result;
  }
  async dismissNudge(threadId: string) {
    const result = await this.write<{ dismissed: boolean }>(`/threads/${enc(threadId)}/nudge/dismiss`, { method: "POST" });
    // Dismissing restarts the waiting clock (PRD §6.5); the follow-up draft is discarded with it.
    this.patchRow(threadId, (row) => ({ ...row, nudgeDue: false, ...(row.state === "waiting" ? { waitingSince: Date.now() } : {}) }));
    await this.settle({ thread: threadId, stale: ["insights"] });
    return result;
  }
  async closeDeal(threadId: string, amountMinor: number, dealType: DealType, options: { note?: string; idempotencyKey?: string } = {}) {
    const result = await this.write<{ entryId: string; amountMinor: number }>(`/threads/${enc(threadId)}/close`, {
      method: "POST",
      headers: { "Idempotency-Key": options.idempotencyKey ?? `close-${threadId}` },
      body: JSON.stringify({ amountMinor, dealType, ...(options.note ? { note: options.note } : {}) }),
    });
    // Recording a sale closes the conversation; the new ledger entry comes back with the ledger.
    this.patchRow(threadId, (row) => ({ ...row, state: "closed", waitingSince: null, nudgeDue: false, hasDealSignal: false }));
    await this.settle({ parts: ["ledger", "dashboard"], thread: threadId, stale: ["closed", "insights", "ledgerView", "roster"] });
    return result;
  }
  async review(classificationId: string, outcome: "confirmed" | "overridden", label?: ClassificationLabel) {
    const queued = this.lists.review.some((row) => row.classificationId === classificationId);
    const result = await this.write<{ label: ClassificationLabel; outcome: string }>(`/classifications/${enc(classificationId)}/review`, jsonInit("POST", { outcome, overrideLabel: label }));
    // The decided item leaves the queue; its conversation may join an inbox list now.
    if (queued) this.patchLists(["review"], (lists) => ({ ...lists, review: lists.review.filter((row) => row.classificationId !== classificationId) }));
    await this.settle({ parts: queued ? ["inbox", "waiting"] : ["inbox", "waiting", "review"], stale: ["closed", "insights", "roster"] });
    return result;
  }

  // ── Ledger, insights, audit ────────────────────────────────────────────

  loadLedger(month?: string) {
    return this.loadSlice("ledgerView", `/ledger${month ? `?month=${enc(month)}` : ""}`, (raw) => toLedgerView(obj(raw), this.snapshot.money.currency));
  }
  async updateLedger(entryId: string, body: Partial<Pick<DemoLedgerEntry, "amountMinor" | "dealType" | "note">>) {
    const thisMonth = this.snapshot.ledger.some((entry) => entry.id === entryId);
    const result = await this.write<{ id: string; amountMinor: number }>(`/ledger/${enc(entryId)}`, jsonInit("PATCH", body));
    // Fields left undefined were not sent, so the server kept them.
    const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as Partial<DemoLedgerEntry>;
    const update = (entry: DemoLedgerEntry) => (entry.id === entryId ? { ...entry, ...changes, amountMinor: result.amountMinor } : entry);
    this.patchLedger((entries) => entries.map(update));
    this.patchSlice("ledgerView", (view) => ({ ...view, entries: view.entries.map(update) }));
    // Totals are the server's: the month's dashboard comes back, the ledger view and insights reload.
    await this.settle({ parts: thisMonth ? ["dashboard"] : [], stale: ["ledgerView", "insights", "roster"] });
    return result;
  }
  async deleteLedger(entryId: string) {
    const thisMonth = this.snapshot.ledger.some((entry) => entry.id === entryId);
    const result = await this.write<{ deleted: boolean }>(`/ledger/${enc(entryId)}`, { method: "DELETE" });
    this.patchLedger((entries) => entries.filter((entry) => entry.id !== entryId));
    this.patchSlice("ledgerView", (view) => ({ ...view, entries: view.entries.filter((entry) => entry.id !== entryId) }));
    await this.settle({ parts: thisMonth ? ["dashboard"] : [], stale: ["ledgerView", "insights", "roster"] });
    return result;
  }
  async download(path: string, fallbackName: string) {
    const blob = await this.authorizedFetch(path, { method: path === "/settings/export" ? "POST" : "GET" }, async (response) => {
      if (!response.ok) throw new Error("DealDock could not prepare that export.");
      return response.blob();
    }, EXPORT_FAILURES);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fallbackName;
      link.click();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  loadInsights(months = 6) {
    return this.loadSlice("insights", `/insights?months=${months}`, toInsights);
  }
  async setGoal(monthlyGoalMinor: number | null) {
    await this.write<{ monthlyGoalMinor: number | null }>("/settings/goal", jsonInit("PUT", { monthlyGoalMinor }), (result) =>
      this.patchSlice("settings", (settings) => ({ ...settings, monthlyGoalMinor: result.monthlyGoalMinor })));
    // The goal ring's percentage is the server's (it floors): reload it rather than recompute it here.
    this.markStale("insights");
  }
  loadAudit(limit = 100) {
    return this.loadSlice("audit", `/audit?limit=${limit}`, (raw) => rows(raw) as AuditRow[]);
  }

  // ── Offers ─────────────────────────────────────────────────────────────

  loadOffers() {
    return this.loadSlice("offers", "/offers", (raw) => sortOffers(arr(obj(raw).offers) as OfferDto[]));
  }
  createOffer(input: OfferInput) {
    return this.write<OfferDto>("/offers", jsonInit("POST", input), (offer) => this.patchSlice("offers", (offers) => sortOffers([...offers, offer])));
  }
  updateOffer(offerId: string, patch: Partial<OfferInput>) {
    return this.write<OfferDto>(`/offers/${enc(offerId)}`, jsonInit("PATCH", patch), (offer) => this.patchSlice("offers", (offers) => sortOffers(offers.map((item) => (item.id === offer.id ? offer : item)))));
  }
  async deleteOffer(offerId: string) {
    await this.write(`/offers/${enc(offerId)}`, { method: "DELETE" }, () => this.patchSlice("offers", (offers) => offers.filter((item) => item.id !== offerId)));
  }

  // ── Your voice ─────────────────────────────────────────────────────────

  private voiceAccount(igAccountId?: string) { return igAccountId ?? this.snapshot.voice.data?.igAccountId; }
  loadVoice(igAccountId?: string) {
    return this.loadSlice("voice", `/voice${igAccountId ? `?igAccountId=${enc(igAccountId)}` : ""}`, toVoiceStudio);
  }
  setStyleOverrides(overrides: Partial<StyleCard>, igAccountId?: string) {
    return this.write<VoiceStudio>("/voice/style", jsonInit("PUT", { igAccountId: this.voiceAccount(igAccountId), overrides }), (studio) => this.replaceSlice("voice", toVoiceStudio(studio)));
  }
  createRule(input: RuleInput) {
    return this.write<VoiceRuleDto>("/voice/rules", jsonInit("POST", { ...input, igAccountId: this.voiceAccount(input.igAccountId) }), (rule) =>
      this.patchSlice("voice", (studio) => ({ ...studio, rules: [rule, ...studio.rules.filter((item) => item.id !== rule.id && !(item.key === rule.key && item.scope === rule.scope))] })));
  }
  updateRule(ruleId: string, patch: { text?: string; status?: VoiceRuleStatus; scope?: VoiceRuleScope }) {
    return this.write<VoiceRuleDto>(`/voice/rules/${enc(ruleId)}`, jsonInit("PATCH", patch), (rule) =>
      this.patchSlice("voice", (studio) => ({ ...studio, rules: studio.rules.map((item) => (item.id === rule.id ? rule : item)) })));
  }
  async deleteRule(ruleId: string) {
    await this.write(`/voice/rules/${enc(ruleId)}`, { method: "DELETE" }, () =>
      this.patchSlice("voice", (studio) => ({ ...studio, rules: studio.rules.filter((item) => item.id !== ruleId) })));
  }
  async setSampleExcluded(messageId: string, excluded: boolean, igAccountId?: string) {
    await this.write(`/voice/samples/${enc(messageId)}`, jsonInit("PUT", { igAccountId: this.voiceAccount(igAccountId), excluded }), () =>
      this.patchSlice("voice", (studio) => ({ ...studio, samples: studio.samples.map((sample) => (sample.messageId === messageId ? { ...sample, excluded } : sample)) })));
  }
  async refreshVoice(igAccountId?: string) {
    await this.write("/voice/refresh", jsonInit("POST", { igAccountId: this.voiceAccount(igAccountId) }));
    await this.loadVoice(this.voiceAccount(igAccountId));
  }
  async setLearningPaused(paused: boolean, igAccountId?: string) {
    await this.write("/voice/learning", jsonInit("PUT", { igAccountId: this.voiceAccount(igAccountId), paused }), () =>
      this.patchSlice("voice", (studio) => ({ ...studio, learningPaused: paused })));
  }
  previewVoice(request: VoicePreviewRequest) {
    return this.write<VoicePreviewResponse>("/voice/preview", jsonInit("POST", { ...request, igAccountId: this.voiceAccount(request.igAccountId) }));
  }
  createSpeakingVoice(request: CreateSpeakingVoiceRequest) {
    return this.write<SpeakingVoiceDto>("/voice/speaking", jsonInit("POST", { ...request, igAccountId: this.voiceAccount(request.igAccountId) }), (speaking) =>
      this.patchSlice("voice", (studio) => ({ ...studio, speaking })));
  }
  async deleteSpeakingVoice(igAccountId?: string) {
    const account = this.voiceAccount(igAccountId);
    await this.write(`/voice/speaking${account ? `?igAccountId=${enc(account)}` : ""}`, { method: "DELETE" });
    await this.loadVoice(account);
  }
  setSpeakingDisclosure(enabled: boolean, igAccountId?: string) {
    return this.write<SpeakingVoiceDto>("/voice/speaking/settings", jsonInit("PUT", { igAccountId: this.voiceAccount(igAccountId), disclosureEnabled: enabled }), (speaking) =>
      this.patchSlice("voice", (studio) => ({ ...studio, speaking })));
  }
  previewSpeaking(text: string, igAccountId?: string) {
    return this.write<AudioPreviewResponse>("/voice/speaking/preview", jsonInit("POST", { igAccountId: this.voiceAccount(igAccountId), text }));
  }

  // ── Settings, account, team ────────────────────────────────────────────

  loadSettings() { return this.loadSlice("settings", "/settings", toSettings); }
  loadMe() { return this.loadSlice("me", "/me", toMe); }
  async updateRegion(body: RegionInput) {
    const zone = this.snapshot.timezone;
    const delay = this.snapshot.settings.data?.nudgeDelayDays;
    await this.write<Json>("/settings/region", jsonInit("PUT", body), (result) => {
      const locale = str(result.locale) || this.snapshot.money.locale;
      const timezone = str(result.timezone) || this.snapshot.timezone;
      // Later core refetches report the new zone too; keep them from restoring the old one meanwhile.
      this.zones = { onboarding: timezone, ledger: timezone };
      this.patch({ money: { ...this.snapshot.money, locale }, timezone });
      this.patchSlice("settings", (settings) => ({ ...settings, locale: locale ?? settings.locale, timezone, nudgeDelayDays: num(result.nudgeDelayDays) ?? settings.nudgeDelayDays }));
    });
    // A new zone moves the month boundary; a new follow-up delay moves which waiting threads are due.
    const zoneMoved = this.snapshot.timezone !== zone;
    const delayMoved = body.nudgeDelayDays !== undefined && body.nudgeDelayDays !== delay;
    await this.settle({
      parts: [...(zoneMoved ? (["ledger", "dashboard"] as const) : []), ...(delayMoved ? (["waiting"] as const) : [])],
      stale: ["insights", ...(zoneMoved ? (["ledgerView", "roster"] as const) : [])],
    });
  }
  async setVoiceConsent(igAccountId: string, consented: boolean) {
    await this.write("/settings/voice/consent", jsonInit("PUT", { igAccountId, consented }), () =>
      this.patchSlice("settings", (settings) => ({ ...settings, voiceConsent: [...settings.voiceConsent.filter((item) => item.igAccountId !== igAccountId), { igAccountId, consented }] })));
    this.markStale("voice");
  }
  loadIgnoreList() { return this.loadSlice("ignoreList", "/settings/ignore-list", (raw) => arr(obj(raw).handles).map(String)); }
  setIgnoreList(handles: string[]) {
    return this.write("/settings/ignore-list", jsonInit("PUT", { handles }), () => this.replaceSlice("ignoreList", handles));
  }
  loadNotificationPrefs() { return this.loadSlice("notificationPrefs", "/notifications/prefs", toPrefs); }
  setNotificationPrefs(prefs: Partial<Omit<NotificationPrefs, "subscribed">>) {
    return this.write("/notifications/prefs", jsonInit("PUT", prefs), () => this.patchSlice("notificationPrefs", (current) => ({ ...current, ...prefs })));
  }
  subscribePush(subscription: PushSubscriptionJSON) { return this.request("/notifications/subscribe", jsonInit("POST", subscription)); }
  loadBilling() { return this.loadSlice("billing", "/billing", toBilling); }
  async cancelBilling() {
    const result = await this.write("/billing/cancel", { method: "POST" });
    this.markStale("billing");
    return result;
  }
  loadSeats() { return this.loadSlice("seats", "/seats", (raw) => arr(obj(raw).seats) as SeatView[]); }
  async inviteSeat(body: { email: string; name?: string; role: "assistant" | "manager" }) {
    const result = await this.write("/seats/invite", jsonInit("POST", body));
    this.markStale("seats");
    return result;
  }
  async removeSeat(seatId: string) {
    await this.write(`/seats/${enc(seatId)}`, { method: "DELETE" }, () => this.patchSlice("seats", (seats) => seats.filter((seat) => seat.id !== seatId)));
  }
  loadRoster() { return this.loadSlice("roster", "/roster", (raw) => rows(raw) as RosterRow[]); }
  loadDataSummary() { return this.loadSlice("dataSummary", "/settings/data", (raw) => raw as DataSummary); }
  async scheduleDeletion() {
    const result = await this.write("/account", { method: "DELETE" });
    this.markStale("settings");
    return result;
  }
  async cancelDeletion() {
    await this.write("/account/cancel-deletion", { method: "POST" });
    this.markStale("settings");
  }

  // ── Instagram + onboarding ─────────────────────────────────────────────

  connectInstagram() { return this.request<{ authorizeUrl: string }>("/ig/connect", { method: "POST" }); }
  async disconnectInstagram(igAccountId?: string) {
    await this.write("/ig/disconnect", igAccountId ? jsonInit("POST", { igAccountId }) : { method: "POST" });
    // Only the account's status changes; its conversations stay where they are.
    this.markStale("settings", "roster", "voice");
  }
  loadOnboarding() { return this.loadSlice("onboarding", "/onboarding", (raw) => toOnboarding(obj(raw))); }
  async saveOnboarding(input: OnboardingInput) {
    await this.write("/onboarding", jsonInit("PUT", input));
    this.markStale("onboarding", "settings", "ignoreList", "voice");
    await this.refreshAfterWrite();
  }
  async bootstrapWorkspace(body: { currencyCode: CurrencyCode; locale: string; timezone: string }) {
    await this.write("/organizations/bootstrap", jsonInit("POST", body));
    this.markStale("onboarding", "settings", "me");
    await this.refreshAfterWrite();
  }
  startLeakScan() { return this.request<{ enqueued: number }>("/onboarding/leak-scan", { method: "POST" }); }
  async getLeakScan(): Promise<LeakScanSummary> {
    const summary = await this.request<Omit<LeakScanSummary, "status"> & Partial<Pick<LeakScanSummary, "status">>>("/onboarding/leak-scan");
    // An API from before `status`: the scan reads as running until it has counted something.
    return { ...summary, status: summary.status ?? (summary.scannedCount > 0 ? "done" : "running") };
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

const FRIENDLY_CODES: Record<string, string> = {
  send_window_closed: "Instagram's reply window has closed. Reply from Instagram instead.",
  voice_consent_required: "Drafts need permission to learn from your sent replies. Turn it on in Your voice.",
  voice_modeling_disabled: "Drafting is turned off for this workspace.",
  draft_send_in_flight: "This reply has already been approved. DealDock will not send it again automatically.",
  draft_not_sendable_or_already_claimed: "This draft was already approved. Refresh the conversation before sending again.",
  not_enough_samples: "Not enough replies yet — send a few more first.",
  currency_immutable_for_organization: "Currency is set once for this workspace and can't change.",
  no_connected_account: "Connect an Instagram account first.",
  seat_limit_reached: "Your plan has no free seats left.",
  account_not_active: "Instagram is disconnected for this account. Reconnect it in Settings.",
};

function httpError(status: number, code: string, detail: string): Error {
  const plain = detail && !/^[a-z0-9_:]+$/.test(detail) ? detail : "";
  let message: string;
  if (status === 401) message = "Your session expired. Sign in again to continue.";
  else if (status === 403) message = code === "no_seat_in_org" || detail === "no_seat_in_org" ? "Your workspace needs setup. Open onboarding to continue." : "This account is read-only or your seat does not have permission for that action.";
  else if (status === 404) message = "This isn't available. It may belong to another account or have been removed.";
  else if (status === 409) message = FRIENDLY_CODES[code] ?? (plain || "This action is no longer available. Refresh and try again.");
  else if (status === 429) message = "DealDock is temporarily rate limited. Wait a moment, then try again.";
  else message = FRIENDLY_CODES[code] ?? (plain || `DealDock could not complete that request (${status}).`);
  return Object.assign(new Error(message), { status, code: code || detail });
}
function jsonInit(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}
function enc(value: string) { return encodeURIComponent(value); }

// ── Contract mappers: @dealdock/core shapes → the shared view-model ──────

function threadsOf(lists: Record<ListPart, DemoThread[]>): DemoThread[] {
  return [...lists.inbox, ...lists.waiting, ...lists.review];
}
/** Epoch ms of an ISO timestamp; null stays null. */
function ms(at: string | null): number | null {
  if (at === null) return null;
  const value = Date.parse(at);
  return Number.isFinite(value) ? value : null;
}
/** What a message says: its text, or the voice-note transcript when it has none (the inbox repository's rule). */
function messageBody(message: Pick<ThreadMessage, "text" | "audio">): string {
  return message.text.trim() ? message.text : message.audio?.transcript ?? "";
}
/** Review items have no reply window; the review queue doesn't send one. */
const NO_REPLY_WINDOW: ReplyWindow = { status: "unknown", lastInboundAt: null, standardClosesAt: null, extendedClosesAt: null, humanAgentEnabled: false };

/** GET /inbox row → view-model: one preview message, no draft or deal facts until the conversation loads. */
export function fromInboxRow(row: InboxRow): DemoThread {
  const lastMessageAt = ms(row.lastMessageAt) ?? Date.now();
  return {
    id: row.threadId,
    igAccountId: row.igAccountId,
    handle: row.participantHandle,
    participant: row.participant,
    state: row.state,
    waitingSince: ms(row.waitingSince),
    lastMessageAt,
    lastInboundAt: ms(row.lastInboundAt),
    unreplied: row.unreplied,
    topLabel: row.topLabel,
    estValueMinMinor: row.estValueMinMinor,
    estValueMaxMinor: row.estValueMaxMinor,
    estCurrencyCode: row.estCurrencyCode,
    rationale: null,
    routedTo: "inbox",
    reviewed: false,
    classificationId: null,
    preview: row.preview,
    previewOutbound: row.previewOutbound,
    messageCount: row.messageCount,
    nudgeDue: row.nudgeDue,
    draftReady: row.draftReady,
    hasAudio: row.hasAudio,
    hasDealSignal: row.dealSignal,
    dealSignal: null,
    source: row.source,
    replyWindow: row.replyWindow,
    sendInFlight: false,
    closedDeals: [],
    canSendVoice: false,
    detail: false,
    messages: row.preview ? [{
      id: row.threadId, direction: row.previewOutbound ? "outbound" : "inbound", text: row.preview, sentAt: lastMessageAt,
      contentType: "text", origin: null, audio: null,
    }] : [],
    draft: null,
  };
}

/** GET /review-queue item → view-model: one inbound message carrying the best guess. */
export function fromReviewRow(row: ReviewQueueRow): DemoThread {
  const sentAt = ms(row.sentAt) ?? Date.now();
  return {
    id: row.threadId,
    igAccountId: row.igAccountId,
    handle: row.handle,
    participant: { handle: row.handle, name: null, avatarUrl: null, followerCount: null, verified: null, followsYou: null, closedTotalMinor: 0, closedDeals: 0, fetchedAt: null },
    state: "open",
    waitingSince: null,
    lastMessageAt: sentAt,
    lastInboundAt: null,
    unreplied: false,
    topLabel: row.bestGuess,
    estValueMinMinor: null,
    estValueMaxMinor: null,
    estCurrencyCode: null,
    rationale: row.rationale,
    routedTo: "review_queue",
    reviewed: false,
    classificationId: row.classificationId,
    preview: row.text,
    previewOutbound: false,
    messageCount: row.text ? 1 : 0,
    nudgeDue: false,
    draftReady: false,
    hasAudio: false,
    hasDealSignal: false,
    dealSignal: null,
    source: null,
    replyWindow: NO_REPLY_WINDOW,
    sendInFlight: false,
    closedDeals: [],
    canSendVoice: false,
    detail: false,
    messages: row.text ? [{
      id: row.classificationId, direction: "inbound", text: row.text, sentAt, contentType: "text", origin: null, audio: null,
      classification: { id: row.classificationId, label: row.bestGuess, confidence: row.confidence, rationale: row.rationale, valueMinMinor: null, valueMaxMinor: null, reviewedAt: null },
    }] : [],
    draft: null,
  };
}

/** The row GET /inbox would list for this conversation, by the inbox repository's rules. */
export function inboxRowFromDetail(detail: ThreadDetail): InboxRow {
  const messages = detail.messages;
  const last = messages[messages.length - 1];
  const lastInbound = [...messages].reverse().find((message) => message.direction === "inbound");
  const lastOutbound = [...messages].reverse().find((message) => message.direction === "outbound");
  const inboundAt = ms(detail.lastInboundAt);
  return {
    threadId: detail.id,
    igAccountId: detail.igAccountId,
    participantHandle: detail.participantHandle,
    participant: detail.participant,
    state: detail.state,
    lastMessageAt: last?.sentAt ?? detail.lastInboundAt ?? new Date().toISOString(),
    lastInboundAt: detail.lastInboundAt,
    topLabel: detail.topLabel,
    estValueMinMinor: detail.estValueMinMinor,
    estValueMaxMinor: detail.estValueMaxMinor,
    estCurrencyCode: detail.estCurrencyCode,
    preview: last ? messageBody(last) : "",
    previewOutbound: last?.direction === "outbound",
    messageCount: messages.length,
    unreplied: inboundAt !== null && (lastOutbound === undefined || inboundAt > (ms(lastOutbound.sentAt) ?? 0)),
    waitingSince: detail.waitingSince,
    nudgeDue: detail.nudgeDue,
    draftReady: detail.currentDraft !== null,
    hasAudio: messages.some((message) => message.contentType === "audio"),
    // The list only reads the latest inbound message for a closing phrase.
    dealSignal: detail.dealSignal !== null && detail.dealSignal.messageId === lastInbound?.id,
    source: detail.source,
    replyWindow: detail.replyWindow,
  };
}

function fromMessage(message: ThreadMessage): DemoMessage {
  return {
    id: message.id,
    direction: message.direction,
    text: message.text,
    sentAt: ms(message.sentAt) ?? Date.now(),
    contentType: message.contentType,
    origin: message.origin,
    audio: message.audio,
    ...(message.classification ? { classification: message.classification } : {}),
  };
}

/** GET /threads/:id → view-model: the row fields plus the full history, live draft and deal facts. */
export function fromThreadDetail(detail: ThreadDetail): DemoThread {
  return {
    ...fromInboxRow(inboxRowFromDetail(detail)),
    rationale: detail.rationale,
    hasDealSignal: detail.dealSignal !== null,
    dealSignal: detail.dealSignal,
    sendInFlight: detail.sendInFlight,
    closedDeals: detail.closedDeals,
    canSendVoice: detail.canSendVoice,
    detail: true,
    messages: detail.messages.map(fromMessage),
    draft: detail.currentDraft,
  };
}

// ── Defensive mappers for the read models without a contract type ────────

function obj(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}; }
function arr(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function rows(raw: unknown): unknown[] { return arr(obj(raw).rows); }
function str(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function num(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function dateMs(value: unknown): number | null { const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; }
function iso(value: unknown): string | null { const at = dateMs(value); return at === null ? null : new Date(at).toISOString(); }
/** An unknown deal type reads as "other", like every other fallback in the app. */
function dealType(value: unknown): DealType { return isDealType(value) ? value : "other"; }

function toLedgerEntry(raw: unknown): DemoLedgerEntry {
  const item = obj(raw);
  return {
    id: str(item.id), threadId: str(item.threadId), handle: str(item.handle) || "unknown",
    dealType: dealType(item.dealType),
    amountMinor: num(item.amountMinor) ?? 0, closedAt: dateMs(item.closedAt) ?? Date.now(), note: typeof item.note === "string" ? item.note : undefined,
  };
}
function toLedger(raw: Json): DemoLedgerEntry[] {
  return arr(raw.entries).map(toLedgerEntry);
}
function toLedgerView(raw: Json, currency: CurrencyCode): LedgerView {
  const byType = obj(raw.byType);
  return {
    selectedMonth: str(raw.selectedMonth),
    timezone: str(raw.timezone),
    currencyCode: (str(raw.currencyCode) as CurrencyCode) || currency,
    totalMinor: num(raw.totalMinor) ?? 0,
    biggestMinor: num(raw.biggestMinor) ?? 0,
    avgMinor: num(raw.avgMinor) ?? 0,
    months: arr(raw.months).map((item) => { const month = obj(item); return { month: str(month.month), totalMinor: num(month.totalMinor) ?? 0, count: num(month.count) ?? 0 }; }),
    byType: Object.fromEntries(DEAL_TYPES.flatMap((type) => (num(byType[type]) === null ? [] : [[type, num(byType[type])!]]))),
    entries: toLedger(raw),
  };
}
function toDashboard(raw: Json): DashboardView {
  const fields = ["mtdRecoveredMinor", "biggestMinor", "avgMinor", "mtdDealCount"] as const;
  for (const field of fields) {
    if (typeof raw[field] !== "number" || !Number.isSafeInteger(raw[field]) || raw[field] < 0) throw new Error("The dashboard totals could not be loaded.");
  }
  return { mtdRecoveredMinor: raw.mtdRecoveredMinor as number, biggestMinor: raw.biggestMinor as number, avgMinor: raw.avgMinor as number, mtdDealCount: raw.mtdDealCount as number };
}
function toMoney(raw: Json): MoneyContext {
  const currency = raw.currencyCode;
  const known = currency === "INR" || currency === "USD" || currency === "GBP" || currency === "EUR" || currency === "AED" ? currency : "INR";
  return { currency: known, locale: typeof raw.locale === "string" ? raw.locale : "en-IN" };
}
function toInsights(raw: unknown): Insights {
  const row = obj(raw);
  if (!row.goal || !Array.isArray(row.months)) throw new Error("Insights could not be read.");
  return raw as Insights;
}
function sortOffers(offers: OfferDto[]): OfferDto[] {
  return [...offers].sort((a, b) => a.sortOrder - b.sortOrder);
}
function toVoiceStudio(raw: unknown): VoiceStudio {
  const row = obj(raw);
  if (!str(row.igAccountId) || !Array.isArray(row.rules) || !Array.isArray(row.samples)) throw new Error("Your voice could not be read.");
  return { ...(raw as VoiceStudio), overrides: obj(row.overrides) as Partial<StyleCard>, measured: arr(row.measured) as VoiceStudio["measured"] };
}
function toSettings(raw: unknown): SettingsView {
  const row = obj(raw);
  const tier = row.tier === "studio" || row.tier === "roster" ? row.tier : "solo";
  return {
    currencyCode: toMoney(row).currency,
    locale: str(row.locale) || "en-IN",
    timezone: str(row.timezone) || "Asia/Kolkata",
    nudgeDelayDays: num(row.nudgeDelayDays) ?? 3,
    accounts: arr(row.accounts).map((item) => {
      const account = obj(item);
      const status = account.status === "disconnected" || account.status === "token_expired" ? account.status : "active";
      return { id: str(account.id), handle: str(account.handle), status, provider: str(account.provider) || "instagram_graph" };
    }),
    voiceConsent: arr(row.voiceConsent).map((item) => { const consent = obj(item); return { igAccountId: str(consent.igAccountId), consented: Boolean(consent.consented) }; }),
    deletionRequestedAt: iso(row.deletionRequestedAt),
    monthlyGoalMinor: num(row.monthlyGoalMinor),
    humanAgentEnabled: Boolean(row.humanAgentEnabled),
    speechAvailable: Boolean(row.speechAvailable),
    tier,
  };
}
function toMe(raw: unknown): MeView {
  const row = obj(raw);
  // Unknown roles get the least privilege; the API enforces permissions regardless.
  const role = row.role === "creator" || row.role === "manager" ? row.role : "assistant";
  const tier = row.tier === "solo" || row.tier === "studio" || row.tier === "roster" ? row.tier : null;
  return { clerkUserId: str(row.clerkUserId), orgId: str(row.orgId), role, name: str(row.name) || null, email: str(row.email) || null, tier };
}
function toPrefs(raw: unknown): NotificationPrefs {
  const row = obj(raw);
  return { notifyHighValue: row.notifyHighValue !== false, notifyNudge: row.notifyNudge !== false, notifyWeeklySummary: row.notifyWeeklySummary !== false, subscribed: Boolean(row.subscribed) };
}
function toBilling(raw: unknown): BillingView {
  const row = obj(raw);
  const tier = row.tier === "solo" || row.tier === "studio" || row.tier === "roster" ? row.tier : null;
  return {
    status: str(row.status) || "pilot_manual",
    rail: row.rail === "razorpay" || row.rail === "paddle" ? row.rail : null,
    tier,
    checkoutUrl: str(row.checkoutUrl) || null,
    activeUseStartedAt: iso(row.activeUseStartedAt),
    currentPeriodEnd: iso(row.currentPeriodEnd),
    cancelledAt: iso(row.cancelledAt),
  };
}
function toOnboarding(row: Json): OnboardingView {
  return {
    currencyCode: toMoney(row).currency,
    locale: str(row.locale) || "en-IN",
    timezone: str(row.timezone) || "Asia/Kolkata",
    businessContext: row.businessContext ? obj(row.businessContext) : null,
    igAccounts: arr(row.igAccounts).map((item) => {
      const account = obj(item);
      const voice = account.voice ? obj(account.voice) : null;
      return { id: str(account.id), handle: str(account.handle), voice: voice ? { enabled: Boolean(voice.enabled), consentedAt: iso(voice.consentedAt), revokedAt: iso(voice.revokedAt) } : null };
    }),
    voiceConsent: arr(row.voiceConsent).map((item) => { const consent = obj(item); return { igAccountId: str(consent.igAccountId), consented: Boolean(consent.consented) }; }),
    complete: Boolean(row.complete),
  };
}

export const apiStore = new ApiStore();
