import {
  addOnPrice, daysOverdue, defaultInvoiceDueAt, formatMoneyExact, invoiceProof, isStoryDeliverable, metricsLine, nextDeliverable,
  type DealDeliverable, type DealDto, type InvoiceDto, type InvoiceKind, type MoneyContext, type OfferDto,
} from "@dealdock/core";
import { atHandle, dayKey, formatDate, pluralize } from "./format";

/**
 * Deal words for the screens (no React): the stage chip, the next step in
 * plain words and the one action a deal card leads with. The money rules
 * themselves (owed, overdue, reminder tone) live in @dealdock/core.
 */

const DAY = 86_400_000;

export type DealTone = "neutral" | "waiting" | "money";

/** "Agreed", "Payment requested" ("Invoiced" with an invoice), "Overdue 6 days" (warning tone), "Paid" or "Cancelled". */
export function dealStage(deal: Pick<DealDto, "stage" | "dueAt" | "invoices">, now: number): { text: string; tone: DealTone } {
  const late = daysOverdue(deal, now);
  if (late > 0) return { text: `Overdue ${late} ${pluralize(late, "day")}`, tone: "waiting" };
  if (deal.stage === "invoiced") return { text: liveInvoices(deal).length ? "Invoiced" : "Payment requested", tone: "neutral" };
  if (deal.stage === "paid") return { text: "Paid", tone: "money" };
  if (deal.stage === "cancelled") return { text: "Cancelled", tone: "neutral" };
  return { text: "Agreed", tone: "neutral" };
}

/** A date as people say it next to "due": "today", "tomorrow", "Fri" within the week, else "12 Dec". */
export function dueWords(at: string | number, now: number, locale: string, timeZone: string): string {
  const days = Math.round((Date.parse(dayKey(at, timeZone)) - Date.parse(dayKey(now, timeZone))) / DAY);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return formatDate(at, locale, timeZone, { weekday: "short" });
  return formatDate(at, locale, timeZone, { day: "numeric", month: "short" });
}

/** "1 reel" reads "Reel" in a sentence; "2 stories" stays as it is. */
function deliverableName(label: string): string {
  const text = label.trim().replace(/^(?:1|one|a|an)\s+/i, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What happens next, in plain words: "Reel due Fri", "Payment due 12 Dec", "Overdue 6 days". */
export function dealNextStep(deal: DealDto, now: number, locale: string, timeZone: string): string {
  const late = daysOverdue(deal, now);
  if (late > 0) return `Overdue ${late} ${pluralize(late, "day")}`;
  const open = openInvoice(deal);
  if (open) return `Invoice due ${dueWords(open.dueAt, now, locale, timeZone)}`;
  // Paid invoices on a deal still open can only be its advance.
  if (liveInvoices(deal).length) return "Advance paid · balance to invoice";
  if (deal.stage === "agreed") {
    const next = nextDeliverable(deal.terms);
    if (next) return next.dueAt ? `${deliverableName(next.label)} due ${dueWords(next.dueAt, now, locale, timeZone)}` : `${deliverableName(next.label)} to deliver`;
    if (deal.terms.deliverables.length && !deal.dueAt) return "Delivered · ask for payment";
  }
  if (deal.dueAt) return `Payment due ${dueWords(deal.dueAt, now, locale, timeZone)}`;
  return deal.stage === "invoiced" ? "Payment requested" : "Agreed";
}

export type DealAction = "recap" | "request" | "remind" | "paid" | "invoice" | "send_invoice" | "invoice_paid" | "balance";

/**
 * The one next step a deal card leads with. `sentSince` says whether the
 * creator has written in the deal's conversation since a moment; a deal agreed
 * outside DealDock has no conversation (undefined), so it never leads with a
 * message. Overdue: Remind. An unpaid invoice: send it with a note, then Mark
 * invoice paid. An advance paid: Invoice the balance. Payment asked for without
 * an invoice: Mark paid. Agreed: a terms recap until the creator has written
 * since recording it, then Create invoice. With the Invoices feature off
 * (`invoices` false) no invoice step: Request payment, then Mark paid.
 */
export function dealPrimaryAction(deal: Pick<DealDto, "stage" | "dueAt" | "createdAt" | "invoices">, now: number, sentSince?: (at: string) => boolean, invoices = true): DealAction {
  if (sentSince && daysOverdue(deal, now) > 0) return "remind";
  const open = invoices ? openInvoice(deal) : null;
  if (open) return sentSince && !sentSince(open.issuedAt) ? "send_invoice" : "invoice_paid";
  if (invoices && liveInvoices(deal).length) return "balance";
  if (deal.stage === "invoiced") return "paid";
  return sentSince && !sentSince(deal.createdAt) ? "recap" : invoices ? "invoice" : "request";
}

/** Revenue's money action on an owed deal: its open invoice, the balance after an advance, or the deal itself (always, with Invoices off). */
export function owedAction(deal: Pick<DealDto, "invoices">, invoices = true): "invoice_paid" | "balance" | "paid" {
  if (!invoices) return "paid";
  if (openInvoice(deal)) return "invoice_paid";
  return liveInvoices(deal).length ? "balance" : "paid";
}

/* ── Invoices ──────────────────────────────────────────────────────────── */

/** Issued and paid invoices: a void one bills nothing. */
export function liveInvoices(deal: Pick<DealDto, "invoices">): InvoiceDto[] {
  return (deal.invoices ?? []).filter((invoice) => invoice.status !== "void");
}

/** The unpaid invoice the deal waits on: the one due first. */
export function openInvoice(deal: Pick<DealDto, "invoices">): InvoiceDto | null {
  return (deal.invoices ?? []).filter((invoice) => invoice.status === "issued").sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0] ?? null;
}

/** "Issued", "Overdue" (warning), "Paid" (money) or "Void". */
export function invoiceStatus(invoice: Pick<InvoiceDto, "status" | "dueAt">, now: number): { text: string; tone: DealTone } {
  if (invoice.status === "paid") return { text: "Paid", tone: "money" };
  if (invoice.status === "void") return { text: "Void", tone: "neutral" };
  return now > Date.parse(invoice.dueAt) ? { text: "Overdue", tone: "waiting" } : { text: "Issued", tone: "neutral" };
}

/**
 * The kinds a new invoice can be, the one to suggest first, by core's rules
 * (invoiceShareMinor): an advance (when agreed, below 100%) or the full fee
 * while nothing is invoiced; afterwards only the balance, while some is left.
 */
export function invoiceKinds(deal: Pick<DealDto, "amountMinor" | "terms" | "invoices">): InvoiceKind[] {
  const live = liveInvoices(deal);
  if (!live.length) {
    const advance = deal.terms.advancePercent;
    return advance && advance < 100 ? ["advance", "full"] : ["full"];
  }
  return deal.amountMinor - live.reduce((sum, invoice) => sum + invoice.subtotalMinor, 0) > 0 ? ["balance"] : [];
}

/**
 * When a new invoice is due unless the creator picks a day, as the API
 * decides it: a due date the deal took from an earlier invoice (its advance)
 * is that invoice's, so the balance counts its payment days from today.
 */
export function invoiceDueDefault(kind: InvoiceKind, deal: Pick<DealDto, "dueAt" | "terms" | "invoices">, now: number): string {
  const borrowed = liveInvoices(deal).some((invoice) => invoice.dueAt === deal.dueAt);
  return defaultInvoiceDueAt(kind, { dueAt: borrowed ? null : deal.dueAt, paymentDays: deal.terms.paymentDays }, new Date(now));
}

/* ── Who a deal is with ────────────────────────────────────────────────── */

/**
 * Who a deal is with, as the API prints it: a conversation's "@handle" (an
 * email address as it is); for a deal agreed outside DealDock, what was typed.
 */
export function dealWith(deal: Pick<DealDto, "counterpartyHandle" | "counterpartyName" | "threadId">): string {
  return deal.threadId ? atHandle(deal.counterpartyHandle) : deal.counterpartyName?.trim() || deal.counterpartyHandle;
}

/**
 * "Who it's with" for a deal agreed elsewhere, kept as typed. It is also the
 * name, unless it is a handle (with or without its @) or an email address.
 * Null when blank.
 */
export function counterpartyOf(text: string): { counterpartyHandle: string; counterpartyName: string | null } | null {
  const value = text.trim();
  if (!value) return null;
  const named = !/^@?[A-Za-z0-9._]{1,30}$/.test(value) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return { counterpartyHandle: value, counterpartyName: named ? value : null };
}

/** A payment's handle as people read it: only a conversation's handle takes an @, as in the API's CSV. */
export function whoFrom(handle: string, conversation: boolean): string {
  return conversation ? atHandle(handle) : handle;
}

/**
 * A date input's "YYYY-MM-DD" as the end of that day in the org's zone, so a
 * deal due on the 12th is not late until the 12th is over. Null for anything
 * that isn't a calendar date.
 */
export function endOfDayIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  if (!Number.isFinite(guess) || dayKey(guess, "UTC") !== value) return null;
  // The zone's offset at that moment: the same instant's wall clock in the zone, read back as UTC.
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(guess).map((part) => [part.type, part.value]));
  } catch {
    return new Date(guess).toISOString();
  }
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(guess - (wall - guess)).toISOString();
}

/* ── Usage rights and proof of results ─────────────────────────────────── */

/** The creator's usage price per month for a deal, as drafts read it: the first active brand offer of theirs (or shared) that sets one. */
export function usagePriceFor(deal: Pick<DealDto, "igAccountId">, offers: readonly OfferDto[]): number | null {
  const theirs = offers.filter((offer) => offer.active && (offer.igAccountId === null || offer.igAccountId === deal.igAccountId)).sort((a, b) => a.sortOrder - b.sortOrder);
  return addOnPrice(theirs, "usagePerMonthMinor");
}

/** "1 reel", "1 reel and 2 stories": what the rights or results cover, else the deal's title. */
export function contentOf(deal: Pick<DealDto, "title" | "terms">, items: ReadonlyArray<Pick<DealDeliverable, "label">> = deal.terms.deliverables): string {
  const labels = items.map((item) => item.label.trim()).filter(Boolean);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0] ?? deal.title;
}

/** Today: "@glowco's usage rights on 1 reel end 3 Mar" (or "ended" once the day has passed). */
export function usageReminderText(deal: DealDto, now: number, locale: string, timeZone: string): string {
  const ends = deal.terms.usageEndsAt!;
  const day = formatDate(ends, locale, timeZone, { day: "numeric", month: "short" });
  return `${dealWith(deal)}'s usage rights on ${contentOf(deal)} ${Date.parse(ends) < now ? "ended" : "end"} ${day}`;
}

/** Today: "Add results for 1 reel for @glowco"; stories first, since their results last a day. */
export function resultsReminderText(deal: DealDto, due: readonly DealDeliverable[]): string {
  const stories = due.filter((item) => isStoryDeliverable(item.label));
  return stories.length
    ? `Story results are easiest to grab now: ${contentOf(deal, stories)} for ${dealWith(deal)}`
    : `Add results for ${contentOf(deal, due)} for ${dealWith(deal)}`;
}

/**
 * A usage-rights note to copy, for a deal with no conversation in DealDock:
 * when the rights end, an extension at the creator's usage price per month
 * (or a question when none is set, never a guessed price), else a request to
 * stop using the content. No threats.
 */
export function usageNoteText(deal: DealDto, priceMinor: number | null, money: MoneyContext, locale: string, timeZone: string): string {
  const ends = deal.terms.usageEndsAt ? formatDate(deal.terms.usageEndsAt, locale, timeZone, { day: "numeric", month: "short" }) : null;
  return [
    `Hi! A quick heads-up: the usage rights for ${contentOf(deal)} end ${ends ? `on ${ends}` : "soon"}.`,
    priceMinor !== null
      ? `If you'd like to keep running it, I can extend them at ${formatMoneyExact(priceMinor, money)} per month.`
      : "If you'd like to keep running it, how long would you like to extend for? I'll confirm the price.",
    "Otherwise, please stop using the content after that date. Let me know which works!",
  ].join(" ");
}

/** "Copy results": a plain-text summary for Instagram or email, from what was posted and the numbers typed or fetched. */
export function resultsText(deal: DealDto, locale: string, timeZone: string): string {
  const proof = invoiceProof(deal.terms);
  const day = (at: string) => formatDate(at, locale, timeZone, { day: "numeric", month: "short" });
  const lines = [`Results for ${deal.title}`];
  for (const post of proof?.posts ?? []) {
    lines.push("", `${post.label}${post.postedAt ? `, posted ${day(post.postedAt)}` : ""}`, post.postUrl);
    if (post.metrics) lines.push(`${metricsLine(post.metrics, locale)}${post.metricsAt ? ` (as of ${day(post.metricsAt)})` : ""}`);
  }
  if (proof?.disclosure.length) lines.push("", `Disclosure: ${proof.disclosure.join("; ")}`);
  return lines.join("\n");
}
