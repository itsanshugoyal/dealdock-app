import {
  HIGH_INTENT_LABELS,
  dealTypeForLabel as commerceDealType,
  highValueThresholdMinor,
  type ClassificationLabel,
  type CurrencyCode,
  type DealType,
  type DraftChip,
  type OfferDto,
  type ParticipantProfile,
  type ReplyWindow,
  type SeatRole,
  type Tier,
  type VoiceRuleScope,
} from "@dealdock/core";
import type { DemoThread } from "./types";

/**
 * Pure display helpers (no React) so they are unit-testable and shared by
 * both stores and every screen. Money itself is only ever rendered by
 * <MoneyValue> through the @dealdock/core formatters.
 */

const LABEL_TEXT: Record<ClassificationLabel, string> = {
  brand_deal: "Brand deal",
  coaching_lead: "Coaching",
  course_inquiry: "Course",
  other_commerce: "Other sale",
  fan: "Fan",
  spam: "Spam",
  personal: "Personal",
  uncertain: "Not sure",
};
/** Lower-case nouns for sentences ("Probably a brand deal"). */
const LABEL_NOUN: Record<ClassificationLabel, string> = {
  brand_deal: "a brand deal",
  coaching_lead: "a coaching enquiry",
  course_inquiry: "a course enquiry",
  other_commerce: "another sale",
  fan: "a fan message",
  spam: "spam",
  personal: "a personal message",
  uncertain: "something to check",
};
const DEAL_TYPE_TEXT: Record<DealType, string> = { brand: "Brand deal", coaching: "Coaching", course: "Course", other: "Other" };

/** UI text for a classification label; never the raw enum. */
export function labelText(label: ClassificationLabel): string {
  return LABEL_TEXT[label] ?? "Other sale";
}
export function labelNoun(label: ClassificationLabel): string {
  return LABEL_NOUN[label] ?? "another sale";
}
export function dealTypeText(type: DealType): string {
  return DEAL_TYPE_TEXT[type] ?? "Other";
}
export function isCommerceLabel(label: ClassificationLabel | null | undefined): boolean {
  return Boolean(label && (HIGH_INTENT_LABELS as readonly string[]).includes(label));
}
/**
 * Default "Offer type" for a sale recorded from a thread with this label
 * (DESIGN §3.6): the commerce mapping from @dealdock/core, else "other".
 */
export function dealTypeForLabel(label: ClassificationLabel | null | undefined): DealType {
  return commerceDealType(label) ?? "other";
}

/** Confidence in words, never a percentage (DESIGN §3.4). Thresholds: ≥0.80 / 0.55–0.79 / <0.55. */
export function confidenceWords(confidence: number, label: ClassificationLabel): string {
  if (label === "uncertain") return "Not sure";
  const noun = labelNoun(label);
  if (confidence >= 0.8) return `Looks like ${noun}`;
  if (confidence >= 0.55) return `Probably ${noun}`;
  return `Not sure — maybe ${noun}`;
}
export function confidenceReason(rationale: string | null | undefined): string {
  return `Why: ${rationale?.trim() || "based on the message text."}`;
}

/** "Big ones" threshold: lowest active brand offer price, else a per-currency default (DESIGN §5.4). The rule lives in @dealdock/core. */
export { BIG_ONE_DEFAULT_MINOR, highValueThresholdMinor as bigOneThreshold } from "@dealdock/core";

/**
 * The bar for one account's conversations, as the high-value push applies it
 * (db getClassifyContext): that account's and workspace-wide offers, in the
 * org currency only.
 */
export function accountBigOneThreshold(currency: CurrencyCode, offers: readonly OfferDto[] | null | undefined, igAccountId: string | null): number {
  return highValueThresholdMinor(currency, (offers ?? []).filter((offer) => offer.currencyCode === currency && (offer.igAccountId === null || offer.igAccountId === igAccountId)));
}

/* ── Conversation groups (Today, Inbox, badges, palette) ──────────────────── */

/** "Needs you": unreplied, open commerce in the inbox. */
export function needsYou(thread: Pick<DemoThread, "routedTo" | "state" | "unreplied" | "topLabel">): boolean {
  return thread.routedTo === "inbox" && thread.state === "open" && thread.unreplied && isCommerceLabel(thread.topLabel);
}
/** "Check these": review-queue items nobody has decided yet. */
export function toCheck(thread: Pick<DemoThread, "routedTo" | "reviewed">): boolean {
  return thread.routedTo === "review_queue" && !thread.reviewed;
}
/** The inbox's Waiting group: conversations waiting on the other person. */
export function isWaiting(thread: Pick<DemoThread, "routedTo" | "state">): boolean {
  return thread.routedTo === "inbox" && thread.state === "waiting";
}
/** "Follow-up due": the server's nudge clock (nudgeDueAt in @dealdock/core) says it is time. */
export function followUpDue(thread: Pick<DemoThread, "nudgeDue">): boolean {
  return thread.nudgeDue;
}
/** A commerce conversation estimated at or above the Big-ones threshold. */
export function isBigOne(thread: Pick<DemoThread, "topLabel" | "estValueMaxMinor">, thresholdMinor: number): boolean {
  return isCommerceLabel(thread.topLabel) && (thread.estValueMaxMinor ?? 0) >= thresholdMinor;
}
/** Inbox order: the largest estimate first, then the most recent message. */
export function byValueDesc(a: Pick<DemoThread, "estValueMaxMinor" | "lastMessageAt">, b: Pick<DemoThread, "estValueMaxMinor" | "lastMessageAt">): number {
  return (b.estValueMaxMinor ?? 0) - (a.estValueMaxMinor ?? 0) || b.lastMessageAt - a.lastMessageAt;
}
/** The conservative total waiting in these threads: each low estimate, or the high one when that is all there is. */
export function waitingLowMinor(threads: ReadonlyArray<Pick<DemoThread, "estValueMinMinor" | "estValueMaxMinor">>): number {
  return threads.reduce((sum, thread) => sum + (thread.estValueMinMinor ?? thread.estValueMaxMinor ?? 0), 0);
}
/** A sender as people read them: their name when Instagram gave one, else "@handle". */
export function displayName(participant: Pick<ParticipantProfile, "name"> | null | undefined, handle: string): string {
  return participant?.name?.trim() || `@${handle}`;
}

/* ── Words for enums (never shown raw) ────────────────────────────────────── */

const SCOPE_TEXT: Record<VoiceRuleScope, string> = {
  all: "All replies",
  nudge: "Follow-ups",
  brand_deal: "Brand deals",
  coaching_lead: "Coaching",
  course_inquiry: "Courses",
  other_commerce: "Other sales",
  fan: "Fans",
  personal: "Personal",
  spam: "Spam",
  uncertain: "Not sure",
};
/** Which replies a voice rule applies to. */
export function scopeText(scope: VoiceRuleScope): string {
  return SCOPE_TEXT[scope] ?? "All replies";
}

const ROLE_TEXT: Record<SeatRole, string> = { creator: "Creator", assistant: "Assistant", manager: "Manager" };
export function roleText(role: SeatRole): string {
  return ROLE_TEXT[role] ?? "Team member";
}

const TIER_TEXT: Record<Tier, string> = { solo: "Solo", studio: "Studio", roster: "Roster" };
export function tierText(tier: Tier): string {
  return TIER_TEXT[tier] ?? "Solo";
}

/** Steering chips in words: the composer, the voice "Try it" panel and draft feedback. */
export const DRAFT_CHIP_TEXT: Readonly<Record<DraftChip, string>> = {
  shorter: "Shorter",
  longer: "Longer",
  warmer: "Warmer",
  more_formal: "More formal",
  more_casual: "More casual",
  more_hinglish: "More Hinglish",
  more_english: "English only",
  add_emoji: "Add emoji",
  no_emoji: "No emoji",
  ask_budget: "Ask their budget",
  quote_rate: "Add my rate",
  decline_politely: "Decline politely",
  wrong_facts: "Wrong facts",
};
export function chipText(chip: DraftChip): string {
  const known = DRAFT_CHIP_TEXT[chip];
  if (known) return known;
  // A chip from a newer API: sentence case rather than the raw id.
  const words = String(chip).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ── Time ──────────────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact time left/elapsed: "45m", "5h", "4d". */
export function shortDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < HOUR) return `${Math.max(1, Math.floor(value / MINUTE))}m`;
  if (value < DAY) return `${Math.floor(value / HOUR)}h`;
  return `${Math.floor(value / DAY)}d`;
}

/** Row ages: "now", "5m", "2h", "3d", then the date in the org's locale and zone. */
export function relativeAge(at: number, now: number, locale: string, timeZone: string): string {
  const age = now - at;
  if (age < MINUTE) return "now";
  if (age < 7 * DAY) return shortDuration(age);
  return formatDate(at, locale, timeZone, { day: "numeric", month: "short" });
}

/** "just now", "5m ago", "3d ago", then "on 12 Oct". */
export function agoText(at: number, now: number, locale: string, timeZone: string): string {
  const age = now - at;
  if (age < MINUTE) return "just now";
  if (age < 7 * DAY) return `${shortDuration(age)} ago`;
  return `on ${formatDate(at, locale, timeZone, { day: "numeric", month: "short" })}`;
}

// Intl formatters are slow to build and a list formats many values per
// render, so each (locale, zone, options) combination is built once.
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();
const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();
const FORMAT_CACHE_LIMIT = 100;

function memo<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // Bounded, so a session that keeps switching zones or locales cannot grow it forever.
  if (cache.size >= FORMAT_CACHE_LIMIT) cache.clear();
  const value = build();
  cache.set(key, value);
  return value;
}
function dateFormat(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return memo(DATE_FORMATS, `${locale}|${timeZone}|${JSON.stringify(options)}`, () => {
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      // An invalid org zone formats in the device zone rather than failing the screen.
      return new Intl.DateTimeFormat(locale, options);
    }
  });
}
function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return memo(NUMBER_FORMATS, `${locale}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options));
}

export function formatDate(at: number | string, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return dateFormat(locale, timeZone, options).format(date);
}
export function formatTime(at: number | string, locale: string, timeZone: string): string {
  return formatDate(at, locale, timeZone, { hour: "numeric", minute: "2-digit" });
}

/** A stable key for the calendar day of `at` in the zone: for grouping, never for display. */
export function dayKey(at: number | string, timeZone: string): string {
  return formatDate(at, "en-CA", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
}
/**
 * Day headings in the org's locale and zone: "Today", "Yesterday", else the
 * weekday and date ("Monday 12 October"; `width` "short" gives "Mon 12 Oct").
 * With no clock yet (`now` 0 or null, as while server rendering) only the date shows.
 */
export function dayLabel(at: number, now: number | null, locale: string, timeZone: string, width: "long" | "short" = "long"): string {
  if (now) {
    const day = dayKey(at, timeZone);
    if (day === dayKey(now, timeZone)) return "Today";
    if (day === dayKey(now - DAY, timeZone)) return "Yesterday";
  }
  return formatDate(at, locale, timeZone, { weekday: width, day: "numeric", month: width });
}

/** Audio durations: 42 000 ms → "0:42". */
export function clockDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Followers and other non-money counts: "48.2K" in the org locale. */
export function compactCount(value: number, locale: string): string {
  return numberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.toLowerCase();
  if (key === "hinglish" || key === "mixed") return "Hinglish";
  if (key.startsWith("hi")) return "Hindi";
  if (key.startsWith("en")) return "English";
  return null;
}

const DEVANAGARI = /[ऀ-ॿ]/;
/** `lang` for user text: Devanagari → "hi" (taller line-height); otherwise inherit. */
export function textLang(text: string | null | undefined): "hi" | undefined {
  return text && DEVANAGARI.test(text) ? "hi" : undefined;
}

/** Long handles truncate in the middle on narrow rows ("@very.long…handle"). */
export function middleTruncate(value: string, max = 22): string {
  if (value.length <= max) return value;
  const keep = max - 1;
  return `${value.slice(0, Math.ceil(keep / 2))}…${value.slice(value.length - Math.floor(keep / 2))}`;
}

export type ReplyWindowTone = "muted" | "strong" | "danger" | "soft";
export interface ReplyWindowInfo {
  /** Hidden cases render nothing. */
  visible: boolean;
  closed: boolean;
  text: string;
  tone: ReplyWindowTone;
  /** Header variant only: the 7-day Human Agent window explainer applies. */
  extended: boolean;
}

/**
 * ReplyWindowClock copy (DESIGN §3.6). `variant` "row" is the compact inbox
 * cluster; "header" is the thread header line.
 */
export function replyWindowInfo(window: ReplyWindow, now: number, variant: "row" | "header"): ReplyWindowInfo {
  const hidden: ReplyWindowInfo = { visible: false, closed: false, text: "", tone: "muted", extended: false };
  if (window.status === "unknown") return hidden;
  if (window.status === "closed") {
    return { visible: true, closed: true, text: variant === "row" ? "Reply in Instagram" : "Reply window closed", tone: "muted", extended: false };
  }
  if (window.status === "extended") {
    const left = Date.parse(window.extendedClosesAt ?? "") - now;
    if (!Number.isFinite(left)) return hidden;
    if (variant === "row") return left < DAY ? { visible: true, closed: false, text: `${shortDuration(left)} left`, tone: "soft", extended: true } : hidden;
    return { visible: true, closed: false, text: `Extended window · ${shortDuration(left)} left`, tone: "soft", extended: true };
  }
  const left = Date.parse(window.standardClosesAt ?? "") - now;
  if (!Number.isFinite(left)) return hidden;
  const tone: ReplyWindowTone = left < HOUR ? "danger" : left <= 6 * HOUR ? "strong" : "muted";
  if (variant === "row") return left > 6 * HOUR ? hidden : { visible: true, closed: false, text: `${shortDuration(left)} left`, tone, extended: false };
  return { visible: true, closed: false, text: `Reply window · ${shortDuration(left)} left`, tone, extended: false };
}

export function pluralize(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}
