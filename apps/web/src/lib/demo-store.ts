"use client";

import {
  HIGH_INTENT_LABELS,
  REVIEW_CONFIDENCE_THRESHOLD,
  type ClassificationLabel,
  type MoneyContext,
} from "@dealdock/core";
import { HeuristicPipeline, type CreatorContext } from "@dealdock/ai";
import { CORPUS } from "@dealdock/messaging";

/**
 * Demo mode: the entire core loop running in the browser against the fixture
 * corpus using the REAL HeuristicPipeline — no API, no DB, no keys. Used for
 * local UI verification and sales demos; the API-backed client replaces this
 * per-environment (NEXT_PUBLIC_API_URL).
 */

export interface DemoMessage {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  sentAt: number;
  classification?: {
    label: ClassificationLabel;
    confidence: number;
    rationale: string;
    valueMinMinor: number | null;
    valueMaxMinor: number | null;
  };
}

export interface DemoThread {
  id: string;
  handle: string;
  state: "open" | "waiting" | "closed";
  waitingSince: number | null;
  nudgeDismissedAt: number | null;
  lastMessageAt: number;
  unreplied: boolean;
  topLabel: ClassificationLabel | null;
  estValueMinMinor: number | null;
  estValueMaxMinor: number | null;
  routedTo: "inbox" | "review_queue";
  reviewed: boolean;
  messages: DemoMessage[];
  draft: { id: string; body: string; version: number; kind: "reply" | "nudge" } | null;
}

export const NUDGE_DELAY_MS = 3 * 24 * 60 * 60_000; // org default: 3 days

export function isNudgeDue(t: DemoThread, now = Date.now()): boolean {
  return (
    t.state === "waiting" &&
    t.waitingSince !== null &&
    t.nudgeDismissedAt === null &&
    now - t.waitingSince >= NUDGE_DELAY_MS
  );
}

export interface DemoLedgerEntry {
  id: string;
  threadId: string;
  handle: string;
  dealType: "brand" | "coaching" | "course" | "other";
  amountMinor: number;
  closedAt: number;
  note?: string;
}

const CREATOR: CreatorContext = {
  businessSummary:
    "Fitness coach selling a 12-week transformation program, 1-on-1 coaching, and a creator course.",
  currencyCode: "INR",
  typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 },
  typicalCoachingMinor: { min: 2_500_000, max: 8_000_000 },
  typicalCourseMinor: { min: 800_000, max: 1_500_000 },
  styleCard: { greeting: "Hey hey!", signoff: "– D" },
  correctionExamples: [],
};

export const DEMO_MONEY: MoneyContext = { currency: "INR", locale: "en-IN" };

type Listener = () => void;

interface Snapshot {
  threads: DemoThread[];
  ledger: DemoLedgerEntry[];
  money: MoneyContext;
  onboarded: boolean;
}

class DemoStore {
  threads = new Map<string, DemoThread>();
  ledger: DemoLedgerEntry[] = [];
  money: MoneyContext = { ...DEMO_MONEY };
  onboarded = true; // direct visitors skip the wizard; /onboarding resets this
  private listeners = new Set<Listener>();
  private pipeline = new HeuristicPipeline();
  private ready = false;
  private snapshotCache: Snapshot | null = null;

  async init() {
    if (this.ready) return;
    this.ready = true;

    // Demo state survives reloads within the tab (sessionStorage).
    if (this.restore()) {
      this.emit();
      return;
    }
    const now = Date.now();

    for (let i = 0; i < CORPUS.length; i++) {
      const f = CORPUS[i]!;
      const sentAt = now - f.minutesAgo * 60_000;
      const c = await this.pipeline.classify({
        messageText: f.text,
        senderHandle: f.handle,
        creator: CREATOR,
      });
      const routedTo =
        c.confidence >= REVIEW_CONFIDENCE_THRESHOLD ? "inbox" : "review_queue";

      this.threads.set(`t${i}`, {
        id: `t${i}`,
        handle: f.handle,
        state: "open",
        waitingSince: null,
        nudgeDismissedAt: null,
        lastMessageAt: sentAt,
        unreplied: true,
        topLabel: routedTo === "inbox" ? c.label : null,
        estValueMinMinor: c.valueRange?.minMinor ?? null,
        estValueMaxMinor: c.valueRange?.maxMinor ?? null,
        routedTo,
        reviewed: false,
        messages: [
          {
            id: `m${i}`,
            direction: "inbound",
            text: f.text,
            sentAt,
            classification: {
              label: c.label,
              confidence: c.confidence,
              rationale: c.rationale,
              valueMinMinor: c.valueRange?.minMinor ?? null,
              valueMaxMinor: c.valueRange?.maxMinor ?? null,
            },
          },
        ],
        draft: null,
      });
    }

    // Seed two waiting-gone-silent threads so the nudge flow is demoable:
    // the creator replied 4 days ago, the brand went quiet → nudge is due.
    const waitingSeeds = [...this.threads.values()]
      .filter((t) => t.topLabel === "brand_deal" && t.routedTo === "inbox")
      .slice(0, 2);
    for (const t of waitingSeeds) {
      const repliedAt = now - 4 * 24 * 60 * 60_000;
      t.messages.push({
        id: `m-seed-out-${t.id}`,
        direction: "outbound",
        text: "Hey hey! Sounds interesting — sharing my deliverables and rates. Let me know what works for your timeline. – D",
        sentAt: repliedAt,
      });
      t.state = "waiting";
      t.waitingSince = repliedAt;
      t.unreplied = false;
      const nd = await this.pipeline.draft({
        kind: "nudge",
        classificationLabel: "brand_deal",
        threadHistory: t.messages.map((m) => ({ direction: m.direction, text: m.text })),
        creator: CREATOR,
      });
      t.draft = { id: `d-nudge-${t.id}`, body: nd.body, version: 1, kind: "nudge" };
    }

    // A little ledger history so the dashboard/ledger look alive on first open.
    const seedDeals: Array<[string, DemoLedgerEntry["dealType"], number, number]> = [
      ["glowherbals.in", "brand", 32_000_000, 26],
      ["fitfuel_official", "brand", 25_000_000, 12],
      ["rahul_j92", "coaching", 4_500_000, 8],
      ["sneha.builds", "course", 1_200_000, 3],
    ];
    for (const [handle, dealType, amountMinor, daysAgo] of seedDeals) {
      this.ledger.push({
        id: `seed-${handle}`,
        threadId: "",
        handle,
        dealType,
        amountMinor,
        closedAt: now - daysAgo * 24 * 60 * 60_000,
      });
    }

    this.emit();
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        threads: [...this.threads.values()],
        ledger: [...this.ledger],
        money: this.money,
        onboarded: this.onboarded,
      };
    }
    return this.snapshotCache;
  };

  /** Region step (PRD §6.1): one currency per org; reformats the whole app live. */
  setRegion(money: MoneyContext) {
    this.money = money;
    this.emit();
  }

  completeOnboarding() {
    this.onboarded = true;
    this.emit();
  }

  /** Leak Scan aggregate (PRD §5.1.6): unanswered commerce value, last 30 days. */
  leakScan() {
    const commerce = [...this.threads.values()].filter(
      (t) =>
        t.routedTo === "inbox" &&
        t.topLabel !== null &&
        ["brand_deal", "coaching_lead", "course_inquiry", "other_commerce"].includes(t.topLabel) &&
        t.unreplied &&
        t.state === "open" &&
        t.estValueMinMinor !== null
    );
    const totalMinMinor = commerce.reduce((a, t) => a + (t.estValueMinMinor ?? 0), 0);
    const top = [...commerce].sort(
      (a, b) => (b.estValueMaxMinor ?? 0) - (a.estValueMaxMinor ?? 0)
    );
    return {
      scannedCount: this.threads.size,
      commerceCount: commerce.length,
      totalMinMinor,
      topThreads: top.slice(0, 3),
    };
  }

  private emit() {
    this.snapshotCache = null;
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  private storageKey() {
    return `dealdock-demo-v1-${CORPUS.length}`;
  }

  private persist() {
    try {
      sessionStorage.setItem(
        this.storageKey(),
        JSON.stringify({
          threads: [...this.threads.values()],
          ledger: this.ledger,
          money: this.money,
          onboarded: this.onboarded,
        })
      );
    } catch {
      // storage full/unavailable — demo continues in memory
    }
  }

  private restore(): boolean {
    try {
      const raw = sessionStorage.getItem(this.storageKey());
      if (!raw) return false;
      const data = JSON.parse(raw) as Snapshot;
      if (!Array.isArray(data.threads) || data.threads.length === 0) return false;
      this.threads = new Map(data.threads.map((t) => [t.id, t]));
      this.ledger = data.ledger ?? [];
      this.money = data.money ?? { ...DEMO_MONEY };
      this.onboarded = data.onboarded ?? true;
      return true;
    } catch {
      return false;
    }
  }

  async ensureDraft(threadId: string) {
    const t = this.threads.get(threadId);
    if (!t || t.draft || !t.topLabel) return;
    if (!(HIGH_INTENT_LABELS as readonly string[]).includes(t.topLabel)) return;
    const d = await this.pipeline.draft({
      kind: "reply",
      classificationLabel: t.topLabel,
      threadHistory: t.messages.map((m) => ({ direction: m.direction, text: m.text })),
      creator: CREATOR,
    });
    t.draft = { id: `d-${threadId}-${Date.now() % 100000}`, body: d.body, version: 1, kind: "reply" };
    this.emit();
  }

  async regenerateDraft(threadId: string) {
    const t = this.threads.get(threadId);
    if (!t) return;
    const d = await this.pipeline.draft({
      kind: "reply",
      classificationLabel: t.topLabel ?? "brand_deal",
      threadHistory: t.messages.map((m) => ({ direction: m.direction, text: m.text })),
      creator: CREATOR,
    });
    t.draft = {
      id: `d-${threadId}-${Date.now() % 100000}`,
      body: d.body,
      version: (t.draft?.version ?? 0) + 1,
      kind: "reply",
    };
    this.emit();
  }

  send(threadId: string, finalText: string) {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.messages.push({
      id: `m-out-${Date.now() % 100000}`,
      direction: "outbound",
      text: finalText,
      sentAt: Date.now(),
    });
    t.draft = null;
    t.unreplied = false;
    t.lastMessageAt = Date.now();
    // Sending while waiting (e.g. a nudge) restarts the silence clock.
    if (t.state === "waiting") {
      t.waitingSince = Date.now();
      t.nudgeDismissedAt = null;
    }
    this.emit();
  }

  dismissNudge(threadId: string) {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.nudgeDismissedAt = Date.now();
    if (t.draft?.kind === "nudge") t.draft = null;
    this.emit();
  }

  setState(threadId: string, state: DemoThread["state"]) {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.state = state;
    t.waitingSince = state === "waiting" ? Date.now() : null;
    t.nudgeDismissedAt = null;
    if (state !== "waiting" && t.draft?.kind === "nudge") t.draft = null;
    this.emit();
  }

  closeDeal(
    threadId: string,
    amountMinor: number,
    dealType: DemoLedgerEntry["dealType"]
  ) {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.state = "closed";
    this.ledger.unshift({
      id: `l-${Date.now() % 100000}`,
      threadId,
      handle: t.handle,
      dealType,
      amountMinor,
      closedAt: Date.now(),
    });
    this.emit();
  }

  review(threadId: string, outcome: "confirmed" | "overridden", label?: ClassificationLabel) {
    const t = this.threads.get(threadId);
    if (!t) return;
    const c = t.messages[0]?.classification;
    const effective = outcome === "overridden" && label ? label : (c?.label ?? "uncertain");
    t.reviewed = true;
    t.routedTo = "inbox";
    t.topLabel = effective;
    if (c) c.label = effective;
    this.emit();
  }
}

export const demoStore = new DemoStore();
