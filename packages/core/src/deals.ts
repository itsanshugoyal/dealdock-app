import { z } from "zod";
import type { DealDeliverable, DealDto, DealStage, DealTerms, DeliverableMetrics, ExclusivityNote } from "./api-types";

/**
 * Deals: one agreement carried from the conversation to the money. Pure rules
 * shared by the API, the worker, the web app and the demo store, so "owed",
 * "overdue" and the reminder tone mean the same thing everywhere.
 */

export const DEAL_STAGES = ["agreed", "invoiced", "paid", "cancelled"] as const satisfies readonly DealStage[];
/** Stages where money is still owed. */
export const OPEN_DEAL_STAGES = ["agreed", "invoiced"] as const satisfies readonly DealStage[];

const DAY_MS = 86_400_000;

const When = z.string().datetime({ offset: true });
const Count = z.number().int().nonnegative().safe().nullable();

/** A post link: https only (it is shown to brands and printed on invoices), at most 500 characters. */
export const PostUrlSchema = z.string().trim().max(500).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Post links must be https URLs");

export const DeliverableMetricsSchema = z.object({ views: Count, reach: Count, likes: Count, comments: Count, shares: Count, saves: Count });

export const DealDeliverableSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  dueAt: When.nullable(),
  done: z.boolean(),
  // Optional, so deals saved before posts were tracked stay valid.
  postUrl: PostUrlSchema.nullable().optional(),
  postedAt: When.nullable().optional(),
  metrics: DeliverableMetricsSchema.nullable().optional(),
  metricsAt: When.nullable().optional(),
});

export const DealTermsSchema = z.object({
  deliverables: z.array(DealDeliverableSchema).max(20),
  usage: z.string().trim().max(200).nullable(),
  usageEndsAt: When.nullable(),
  exclusivity: z.string().trim().max(200).nullable(),
  exclusivityEndsAt: When.nullable(),
  revisionsIncluded: z.number().int().min(0).max(20).nullable(),
  advancePercent: z.number().int().min(0).max(100).nullable(),
  paymentDays: z.number().int().min(0).max(365).nullable(),
  notes: z.string().trim().max(500).nullable(),
  // Ids outside DISCLOSURE_ITEMS are dropped by normalizeDealTerms, so a renamed item never breaks a stored deal.
  disclosure: z.array(z.string().trim().min(1).max(40)).max(12),
});

/** Partial terms from a request; null clears a field. */
export const DealTermsPatchSchema = DealTermsSchema.partial();

export const EMPTY_DEAL_TERMS: DealTerms = Object.freeze({
  deliverables: [],
  usage: null,
  usageEndsAt: null,
  exclusivity: null,
  exclusivityEndsAt: null,
  revisionsIncluded: null,
  advancePercent: null,
  paymentDays: null,
  notes: null,
  disclosure: [],
}) as DealTerms;

/**
 * The disclosure checklist, after India's ASCI guidelines for influencer
 * advertising: a label upfront (not buried in hashtags or at the end), the
 * platform's own tag in addition to it, and in a video the disclosure in the
 * video itself. Plain words; the ids are what DealTerms.disclosure stores.
 */
export const DISCLOSURE_ITEMS = [
  { id: "paid_partnership", label: "“Paid partnership” label turned on" },
  { id: "label_upfront", label: "#ad or #collab at the start of the caption" },
  { id: "in_video", label: "Said or shown in the video itself" },
  { id: "brand_tagged", label: "Brand tagged" },
] as const;
export type DisclosureItemId = (typeof DISCLOSURE_ITEMS)[number]["id"];

export function isDisclosureItem(id: string): id is DisclosureItemId {
  return DISCLOSURE_ITEMS.some((item) => item.id === id);
}

/**
 * Complete terms from stored JSON or a partial request: missing keys become
 * empty, blank strings become null. Throws (zod) on invalid values, so bad
 * input is rejected at the boundary instead of stored.
 */
export function normalizeDealTerms(input: unknown, base: DealTerms = EMPTY_DEAL_TERMS): DealTerms {
  const patch = DealTermsPatchSchema.parse(input ?? {});
  const text = (value: string | null | undefined, fallback: string | null) =>
    value === undefined ? fallback : value === null || value.trim() === "" ? null : value.trim();
  // A base saved before a field existed lacks it: missing means empty.
  const keep = <T>(value: T | undefined, fallback: T | undefined, empty: T): T => (value === undefined ? (fallback ?? empty) : value);
  return {
    deliverables: patch.deliverables ?? base.deliverables,
    usage: text(patch.usage, base.usage),
    usageEndsAt: keep(patch.usageEndsAt, base.usageEndsAt, null),
    exclusivity: text(patch.exclusivity, base.exclusivity),
    exclusivityEndsAt: keep(patch.exclusivityEndsAt, base.exclusivityEndsAt, null),
    revisionsIncluded: patch.revisionsIncluded === undefined ? base.revisionsIncluded : patch.revisionsIncluded,
    advancePercent: patch.advancePercent === undefined ? base.advancePercent : patch.advancePercent,
    paymentDays: patch.paymentDays === undefined ? base.paymentDays : patch.paymentDays,
    notes: text(patch.notes, base.notes),
    disclosure: patch.disclosure === undefined ? (base.disclosure ?? []) : [...new Set(patch.disclosure)].filter(isDisclosureItem),
  };
}

function ms(at: Date | number | string): number {
  return typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : at.getTime();
}

export function isDealOpen(deal: Pick<DealDto, "stage">): boolean {
  return deal.stage === "agreed" || deal.stage === "invoiced";
}

/** Open, with a due date that has passed. */
export function isDealOverdue(deal: Pick<DealDto, "stage" | "dueAt">, now: Date | number): boolean {
  if (!isDealOpen(deal) || !deal.dueAt) return false;
  const due = ms(deal.dueAt);
  return Number.isFinite(due) && ms(now) > due;
}

/** Whole days past the due date; 0 when not overdue. */
export function daysOverdue(deal: Pick<DealDto, "stage" | "dueAt">, now: Date | number): number {
  if (!isDealOverdue(deal, now)) return 0;
  return Math.max(1, Math.floor((ms(now) - ms(deal.dueAt!)) / DAY_MS));
}

/** Payment due date from "net N days", counted from when payment was asked for (or agreed). */
export function dueFromPaymentDays(from: Date | string | number, paymentDays: number): string {
  return new Date(ms(from) + paymentDays * DAY_MS).toISOString();
}

/**
 * What a paid deal adds to Revenue: the gross the payer paid, including tax
 * they withheld for the creator. The API's paidMinor (the recorded payments,
 * net of invoiced GST/VAT) wins when present.
 */
export function dealRevenueMinor(deal: Pick<DealDto, "amountMinor" | "receivedMinor" | "tdsMinor" | "paidMinor">): number {
  if (deal.paidMinor !== undefined) return deal.paidMinor;
  if (deal.receivedMinor === null) return deal.amountMinor;
  return deal.receivedMinor + (deal.tdsMinor ?? 0);
}

/** Default "what arrived" when marking paid: the agreed amount less any TDS. Never negative. */
export function defaultReceivedMinor(amountMinor: number, tdsMinor?: number | null): number {
  return Math.max(0, amountMinor - (tdsMinor ?? 0));
}

/** The next deliverable not done yet: soonest due first, undated last. */
export function nextDeliverable(terms: Pick<DealTerms, "deliverables">): DealDeliverable | null {
  const open = terms.deliverables.filter((item) => !item.done);
  open.sort((a, b) => (a.dueAt ? ms(a.dueAt) : Infinity) - (b.dueAt ? ms(b.dueAt) : Infinity));
  return open[0] ?? null;
}

/** Deals by urgency: earliest due first (so the most overdue lead), undated last, newest agreed first among equals. */
export function byDealUrgency(a: Pick<DealDto, "dueAt" | "agreedAt">, b: Pick<DealDto, "dueAt" | "agreedAt">): number {
  const due = (deal: Pick<DealDto, "dueAt">) => (deal.dueAt ? ms(deal.dueAt) : Infinity);
  const [dueA, dueB] = [due(a), due(b)];
  return (dueA === dueB ? 0 : dueA - dueB) || ms(b.agreedAt) - ms(a.agreedAt);
}

/**
 * What the other side still owes on a deal: its unpaid invoices in full (tax included, as the
 * brand pays them), plus any part of the fee not invoiced yet. Before any invoice: the fee less
 * what was already paid. Void invoices don't count.
 */
export function dealOwedMinor(deal: Pick<DealDto, "amountMinor" | "paidMinor" | "invoices">): number {
  const invoices = (deal.invoices ?? []).filter((invoice) => invoice.status !== "void");
  if (invoices.length === 0) return Math.max(0, deal.amountMinor - (deal.paidMinor ?? 0));
  const unpaid = invoices.filter((invoice) => invoice.status === "issued").reduce((sum, invoice) => sum + invoice.totalMinor, 0);
  const invoiced = invoices.reduce((sum, invoice) => sum + invoice.subtotalMinor, 0);
  return unpaid + Math.max(0, deal.amountMinor - invoiced);
}

/** Today and Revenue totals over open deals, as dealOwedMinor counts them. One currency per org, so plain sums are safe. */
export function owedTotals(deals: ReadonlyArray<Pick<DealDto, "stage" | "dueAt" | "amountMinor" | "paidMinor" | "invoices">>, now: Date | number) {
  let owedMinor = 0, overdueMinor = 0, openCount = 0, overdueCount = 0;
  for (const deal of deals) {
    if (!isDealOpen(deal)) continue;
    const owed = dealOwedMinor(deal);
    openCount += 1;
    owedMinor += owed;
    if (isDealOverdue(deal, now)) { overdueCount += 1; overdueMinor += owed; }
  }
  return { owedMinor, overdueMinor, openCount, overdueCount };
}

/** How firm a payment reminder should be: gentle in the first week late, firm up to three weeks, then final. */
export function reminderTone(daysLate: number): "gentle" | "firm" | "final" {
  return daysLate <= 6 ? "gentle" : daysLate <= 20 ? "firm" : "final";
}

/* ── Usage rights and exclusivity ──────────────────────────────────────── */

/** The usage reminder shows from this many days before the rights end… */
export const USAGE_REMINDER_LEAD_DAYS = 14;
/** …until this many days after, unless the creator dealt with it first. */
export const USAGE_REMINDER_GRACE_DAYS = 7;

/** Today's usage-rights reminder: usageEndsAt is 14 days away to 7 days past, not handled yet, deal not cancelled. */
export function usageReminderDue(deal: Pick<DealDto, "stage" | "terms" | "usageHandledAt">, now: Date | number): boolean {
  const ends = deal.terms.usageEndsAt ? ms(deal.terms.usageEndsAt) : NaN;
  if (deal.stage === "cancelled" || deal.usageHandledAt || !Number.isFinite(ends)) return false;
  const at = ms(now);
  return at >= ends - USAGE_REMINDER_LEAD_DAYS * DAY_MS && at <= ends + USAGE_REMINDER_GRACE_DAYS * DAY_MS;
}

/** "No exclusivity" as the deal-suggestion reader records it. */
const NO_EXCLUSIVITY = /^(?:none|no|no exclusivity|non[- ]exclusive)$/i;

/** An exclusivity still running: agreed in words, with an end date still ahead, on a deal that isn't cancelled. */
export function isExclusivityActive(deal: Pick<DealDto, "stage" | "terms">, now: Date | number): boolean {
  const { exclusivity, exclusivityEndsAt } = deal.terms;
  if (deal.stage === "cancelled" || !exclusivity?.trim() || NO_EXCLUSIVITY.test(exclusivity.trim()) || !exclusivityEndsAt) return false;
  const ends = ms(exclusivityEndsAt);
  return Number.isFinite(ends) && ends > ms(now);
}

const handleKey = (handle: string) => handle.trim().replace(/^@/, "").toLowerCase();

/**
 * Exclusivities that a conversation with `counterpartyHandle` could break: the
 * active ones on the same creator account's other deals, never another
 * creator's (per-creator isolation) and never the same brand's own.
 */
export function exclusivitiesAgainst(
  deals: ReadonlyArray<Pick<DealDto, "id" | "threadId" | "igAccountId" | "counterpartyHandle" | "counterpartyName" | "stage" | "terms">>,
  conversation: { igAccountId: string; counterpartyHandle: string },
  now: Date | number,
): ExclusivityNote[] {
  return deals
    .filter((deal) => deal.igAccountId === conversation.igAccountId && handleKey(deal.counterpartyHandle) !== handleKey(conversation.counterpartyHandle) && isExclusivityActive(deal, now))
    .sort((a, b) => ms(a.terms.exclusivityEndsAt!) - ms(b.terms.exclusivityEndsAt!))
    .map((deal) => ({
      dealId: deal.id,
      threadId: deal.threadId,
      counterpartyHandle: deal.counterpartyHandle,
      counterpartyName: deal.counterpartyName,
      exclusivity: deal.terms.exclusivity!.trim(),
      endsAt: deal.terms.exclusivityEndsAt!,
    }));
}

/* ── Proof of results ──────────────────────────────────────────────────── */

/** Days after posting before a post's results are asked for; stories sooner, since their insights last only a day. */
export const RESULTS_AFTER_DAYS = 7;
export const STORY_RESULTS_AFTER_DAYS = 1;

/** "2 stories", "Story", "1 IG story": a story, whose results can't be fetched later. */
export function isStoryDeliverable(label: string): boolean {
  return /(?<![\p{L}])stor(?:y|ies)(?![\p{L}])/iu.test(label);
}

/** No number read yet (missing, or every metric null). */
export function hasNoMetrics(metrics: DeliverableMetrics | null | undefined): boolean {
  return !metrics || Object.values(metrics).every((value) => value === null);
}

/** Posted deliverables whose results are due: posted 7 or more days ago (a story 1), no results yet, deal not cancelled. */
export function resultsDue(deal: Pick<DealDto, "stage" | "terms">, now: Date | number): DealDeliverable[] {
  if (deal.stage === "cancelled") return [];
  return deal.terms.deliverables.filter((item) => {
    const posted = item.postedAt ? ms(item.postedAt) : NaN;
    const days = isStoryDeliverable(item.label) ? STORY_RESULTS_AFTER_DAYS : RESULTS_AFTER_DAYS;
    return Number.isFinite(posted) && hasNoMetrics(item.metrics) && ms(now) - posted >= days * DAY_MS;
  });
}

export const METRIC_KEYS = ["views", "reach", "likes", "comments", "shares", "saves"] as const satisfies ReadonlyArray<keyof DeliverableMetrics>;

/** What an invoice can show as proof: each posted deliverable (link, date, results) and the disclosure items ticked. Null when there's nothing to show. */
export function invoiceProof(terms: Pick<DealTerms, "deliverables" | "disclosure">) {
  const posts = terms.deliverables
    .filter((item): item is DealDeliverable & { postUrl: string } => Boolean(item.postUrl))
    .map((item) => ({ label: item.label, postUrl: item.postUrl, postedAt: item.postedAt ?? null, metrics: hasNoMetrics(item.metrics) ? null : item.metrics!, metricsAt: item.metricsAt ?? null }));
  const disclosure = DISCLOSURE_ITEMS.filter((item) => (terms.disclosure ?? []).includes(item.id)).map((item) => item.label);
  return posts.length || disclosure.length ? { posts, disclosure } : null;
}
export type InvoiceProof = NonNullable<ReturnType<typeof invoiceProof>>;

/** "12,400 views · 9,800 reach · 210 saves": the numbers read, in a fixed order; empty when none. */
export function metricsLine(metrics: DeliverableMetrics | null | undefined, locale = "en-IN"): string {
  if (!metrics) return "";
  const count = new Intl.NumberFormat(locale);
  return METRIC_KEYS.filter((key) => metrics[key] !== null).map((key) => `${count.format(metrics[key]!)} ${key}`).join(" · ");
}
