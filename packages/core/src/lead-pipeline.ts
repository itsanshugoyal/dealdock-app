import type { ClassificationLabel } from "./index";
import type { LeadEventKind, LeadSourceProvider, LeadStage } from "./api-types";
import { CURRENCY_CODES, currencyExponent, formatMoneyExact, majorToMinor, type CurrencyCode } from "./money";

/**
 * The coach pipeline: a coaching or course conversation goes lead →
 * qualified → booked → paid. Booking and payment tools report back through a
 * webhook: a booking moves the stage to booked and a payment to paid, never
 * backwards. Pure rules shared by the API, the web app and the demo store.
 */

export const LEAD_STAGES = ["lead", "qualified", "booked", "paid"] as const satisfies readonly LeadStage[];
export const LEAD_SOURCE_PROVIDERS = ["calendly", "cal_com", "razorpay", "stripe", "other"] as const satisfies readonly LeadSourceProvider[];

export function isLeadStage(value: unknown): value is LeadStage {
  return (LEAD_STAGES as readonly unknown[]).includes(value);
}

/** Labels whose conversations are in the pipeline from the start. */
export function isPipelineLabel(label: ClassificationLabel | null | undefined): boolean {
  return label === "coaching_lead" || label === "course_inquiry";
}

/** Where a conversation stands: its stage, "lead" for a coaching or course one without one, else null (not in the pipeline). */
export function pipelineStage(thread: { topLabel: ClassificationLabel | null; leadStage?: LeadStage | null }): LeadStage | null {
  return thread.leadStage ?? (isPipelineLabel(thread.topLabel) ? "lead" : null);
}

/** What a booking or payment that reported back moves the stage to: only forward, so null when it is there or past it already. */
export function forwardStage(current: LeadStage | null, reported: LeadEventKind): LeadStage | null {
  const next: LeadStage = reported;
  return current !== null && LEAD_STAGES.indexOf(current) >= LEAD_STAGES.indexOf(next) ? null : next;
}

/** Per stage, how many conversations stand there. */
export function stageCounts(threads: ReadonlyArray<{ topLabel: ClassificationLabel | null; leadStage?: LeadStage | null }>): Record<LeadStage, number> {
  const counts: Record<LeadStage, number> = { lead: 0, qualified: 0, booked: 0, paid: 0 };
  for (const thread of threads) {
    const stage = pipelineStage(thread);
    if (stage) counts[stage] += 1;
  }
  return counts;
}

// ── References: a link in a draft carries its conversation ─────────────────

const REF_PREFIX = "dd_";

/** The reference a tagged link carries back: "dd_<threadId>". */
export function threadRef(threadId: string): string {
  return `${REF_PREFIX}${threadId}`;
}

/** The conversation id in a reference read back from a payload; null for anything else. */
export function threadIdFromRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  return /^dd_([A-Za-z0-9_-]{1,64})$/.exec(ref.trim())?.[1] ?? null;
}

/** The URL parameter each tool hands back in its payload. Razorpay links can't carry one, and "other" has no known links. */
const TAG_PARAMS: Partial<Record<LeadSourceProvider, { host: (host: string) => boolean; param: string }>> = {
  calendly: { host: (host) => host === "calendly.com" || host.endsWith(".calendly.com"), param: "utm_content" },
  // Written encoded, so the link stays one link when an app turns it into a tap target.
  cal_com: { host: (host) => host === "cal.com" || host.endsWith(".cal.com"), param: "metadata%5Bdd_ref%5D" },
  stripe: { host: (host) => host === "buy.stripe.com", param: "client_reference_id" },
};

// A web address, with or without its scheme; never the domain of an email address.
const URL_PATTERN = /(?<![\w@./-])(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?/gi;
const TRAILING = /[.,;:!?'"’”»…]+$/;

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/** One link with its reference added; the link exactly as it was when it isn't a connected tool's, or already has one of its own. */
function tagUrl(url: string, ref: string, providers: ReadonlySet<LeadSourceProvider>): string {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return url;
  }
  const tag = [...providers].map((provider) => TAG_PARAMS[provider]).find((item) => item?.host(host));
  if (!tag) return url;
  const hashAt = url.indexOf("#");
  const [base, hash] = hashAt < 0 ? [url, ""] : [url.slice(0, hashAt), url.slice(hashAt)];
  const queryAt = base.indexOf("?");
  const pairs = queryAt < 0 ? [] : base.slice(queryAt + 1).split("&");
  const wanted = decodeKey(tag.param);
  const index = pairs.findIndex((pair) => decodeKey(pair.split("=")[0] ?? "") === wanted);
  if (index >= 0) {
    // Someone else's value stays; an earlier conversation's reference (copied from an old reply) becomes this one's.
    const value = pairs[index]!.slice(pairs[index]!.indexOf("=") + 1);
    if (!pairs[index]!.includes("=") || !value.startsWith(REF_PREFIX) || value === ref) return url;
    pairs[index] = `${pairs[index]!.split("=")[0]}=${ref}`;
    return `${base.slice(0, queryAt)}?${pairs.join("&")}${hash}`;
  }
  const joiner = queryAt < 0 ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${joiner}${tag.param}=${ref}${hash}`;
}

/**
 * Adds the conversation's reference to every link in a draft that belongs to a
 * connected booking or payment tool, so a booking or payment through it finds
 * its way back. Links to other sites, to tools that aren't connected, and
 * links that already carry the parameter are left exactly as they were.
 */
export function tagLinks(text: string, ref: string, connectedProviders: Iterable<LeadSourceProvider>): string {
  const providers = new Set(connectedProviders);
  if (!threadIdFromRef(ref) || ![...providers].some((provider) => TAG_PARAMS[provider])) return text;
  return text.replace(URL_PATTERN, (match) => {
    let url = match;
    let tail = TRAILING.exec(url)?.[0] ?? "";
    url = url.slice(0, url.length - tail.length);
    // A closing bracket belongs to the sentence unless the link opened one.
    while (/[)\]]$/.test(url) && (url.match(/[([]/g) ?? []).length < (url.match(/[)\]]/g) ?? []).length) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    return `${tagUrl(url, ref, providers)}${tail}`;
  });
}

// ── Payloads: what each tool reports, as one shape ─────────────────────────

export interface ParsedLeadEvent {
  kind: LeadEventKind;
  /** The tool's id for the booking or payment: a redelivery carries the same one. */
  externalId: string;
  /** "dd_<threadId>" when the payload carries a tagged link's reference. */
  ref: string | null;
  amountMinor: number | null;
  /** Upper-case ISO 4217, present whenever amountMinor is. */
  currencyCode: string | null;
  payerName: string | null;
  occurredAt: string;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const text = (value: unknown, max = 200): string | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};
const name = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return trimmed ? trimmed.slice(0, 120) : null;
};
const currency = (value: unknown): string | null => (typeof value === "string" && /^[a-z]{3}$/i.test(value.trim()) ? value.trim().toUpperCase() : null);
/** An ISO date, or seconds since 1970 (Razorpay, Stripe); else `fallback`. */
function when(value: unknown, fallback: Date): string {
  const at = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : fallback.toISOString();
}
/** Minor units straight from a tool that reports them (paise, cents). */
const minor = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const ref = (value: unknown): string | null => (threadIdFromRef(value) ? (value as string).trim() : null);

function paid(event: Omit<ParsedLeadEvent, "kind">): ParsedLeadEvent[] {
  // A payment carries its currency (the database checks it too).
  return event.amountMinor !== null && event.currencyCode === null ? [] : [{ kind: "paid", ...event }];
}

/**
 * "Other": DealDock's own JSON, for Zapier, Make or the creator's tools.
 * {"event":"booked"|"paid","id":string,"ref"?:string,"amount"?:number,"currency"?:string,"name"?:string,"at"?:ISO}
 * `amount` is in major units ("4999" or 4999.5); the currency defaults to the org's.
 */
function parseOther(body: unknown, now: Date, orgCurrency: string): ParsedLeadEvent[] | null {
  const input = obj(body);
  const event = input.event;
  if (typeof event !== "string") return null;
  if (event !== "booked" && event !== "paid") return [];
  const externalId = text(input.id);
  if (!externalId) return null;
  const code = input.currency === undefined ? orgCurrency : currency(input.currency);
  const hasAmount = input.amount !== undefined && input.amount !== null;
  const amountMinor = event === "paid" && hasAmount && code ? majorToMinor(typeof input.amount === "number" || typeof input.amount === "string" ? input.amount : NaN, code) : null;
  if (event === "paid" && hasAmount && amountMinor === null) return null;
  const common = { externalId, ref: ref(input.ref), payerName: name(input.name), occurredAt: when(input.at, now) };
  return event === "booked"
    ? [{ kind: "booked", ...common, amountMinor: null, currencyCode: null }]
    : paid({ ...common, amountMinor, currencyCode: amountMinor === null ? null : code });
}

/** Calendly: a booking (invitee.created); the reference comes back as utm_content. */
function parseCalendly(body: unknown, now: Date): ParsedLeadEvent[] | null {
  const input = obj(body);
  if (input.event !== "invitee.created") return [];
  const payload = obj(input.payload);
  // shortcut: the invitee URI as the id is unconfirmed against a live sample; it is unique per booking either way.
  const externalId = text(payload.uri, 500);
  if (!externalId) return null;
  const full = [payload.first_name, payload.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ");
  return [{
    kind: "booked",
    externalId,
    ref: ref(obj(payload.tracking).utm_content),
    amountMinor: null,
    currencyCode: null,
    payerName: name(payload.name) ?? name(full),
    occurredAt: when(obj(payload.scheduled_event).start_time ?? input.created_at, now),
  }];
}

/** Cal.com: BOOKING_CREATED and BOOKING_PAID; the reference comes back in the booking's metadata. */
function parseCalCom(body: unknown, now: Date): ParsedLeadEvent[] | null {
  const input = obj(body);
  const trigger = input.triggerEvent;
  if (trigger !== "BOOKING_CREATED" && trigger !== "BOOKING_PAID") return [];
  const payload = obj(input.payload);
  const uid = text(payload.uid);
  if (!uid) return null;
  const attendee = obj(Array.isArray(payload.attendees) ? payload.attendees[0] : null);
  const common = {
    ref: ref(obj(payload.metadata).dd_ref),
    payerName: name(attendee.name) ?? name(obj(obj(payload.responses).name).value),
    occurredAt: when(input.createdAt, now),
  };
  if (trigger === "BOOKING_CREATED") return [{ kind: "booked", externalId: uid, amountMinor: null, currencyCode: null, ...common }];
  // shortcut: price is read as minor units (Cal.com's example shows 1000 for 10.00); confirm on a live payment.
  const amountMinor = minor(payload.price);
  return paid({ externalId: text(payload.paymentId) ?? `${uid}:paid`, amountMinor, currencyCode: amountMinor === null ? null : currency(payload.currency), ...common });
}

const RAZORPAY_PAID = new Set(["payment_link.paid", "payment.captured", "order.paid"]);

/** Razorpay: one payment, however many events report it (the payment id is the id). Its links can't carry a reference. */
function parseRazorpay(body: unknown, now: Date): ParsedLeadEvent[] | null {
  const input = obj(body);
  if (typeof input.event !== "string" || !RAZORPAY_PAID.has(input.event)) return [];
  const payload = obj(input.payload);
  const payment = obj(obj(payload.payment).entity);
  const externalId = text(payment.id);
  if (!externalId) return null;
  const amountMinor = minor(payment.amount);
  return paid({
    externalId,
    ref: null,
    amountMinor,
    currencyCode: amountMinor === null ? null : currency(payment.currency),
    // Payment Pages put the payer's details in the payment's notes (unconfirmed for every page setup).
    payerName: name(obj(obj(obj(payload.payment_link).entity).customer).name) ?? name(obj(payment.notes).name),
    occurredAt: when(payment.created_at ?? input.created_at, now),
  });
}

/** Stripe Payment Links: a paid checkout (now, or once a delayed method succeeds); the reference is client_reference_id. */
function parseStripe(body: unknown, now: Date): ParsedLeadEvent[] | null {
  const input = obj(body);
  const session = obj(obj(input.data).object);
  const completed = input.type === "checkout.session.completed" && session.payment_status === "paid";
  if (!completed && input.type !== "checkout.session.async_payment_succeeded") return [];
  const externalId = text(session.id);
  if (!externalId) return null;
  const amountMinor = minor(session.amount_total);
  return paid({
    externalId,
    ref: ref(session.client_reference_id),
    amountMinor,
    currencyCode: amountMinor === null ? null : currency(session.currency),
    payerName: name(obj(session.customer_details).name),
    occurredAt: when(input.created, now),
  });
}

/**
 * What a tool's webhook reported, in one shape. [] means nothing to record (an
 * event DealDock doesn't use: answer 200); null means the body isn't what this
 * tool sends (answer 400).
 */
export function parseLeadPayload(provider: LeadSourceProvider, body: unknown, ctx: { now: Date; orgCurrency: string }): ParsedLeadEvent[] | null {
  switch (provider) {
    case "other": return parseOther(body, ctx.now, ctx.orgCurrency);
    case "calendly": return parseCalendly(body, ctx.now);
    case "cal_com": return parseCalCom(body, ctx.now);
    case "razorpay": return parseRazorpay(body, ctx.now);
    case "stripe": return parseStripe(body, ctx.now);
  }
}

/** A reported amount in its own currency: the org formatter for the five DealDock currencies, Intl with the currency's precision otherwise. */
export function formatEventAmount(amountMinor: number, currencyCode: string, locale = "en-IN"): string {
  if ((CURRENCY_CODES as readonly string[]).includes(currencyCode)) return formatMoneyExact(amountMinor, { currency: currencyCode as CurrencyCode, locale });
  const exponent = currencyExponent(currencyCode);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode, minimumFractionDigits: amountMinor % 10 ** exponent === 0 ? 0 : exponent, maximumFractionDigits: exponent }).format(amountMinor / 10 ** exponent);
  } catch {
    return `${currencyCode} ${(amountMinor / 10 ** exponent).toFixed(exponent)}`;
  }
}

/** The tool's name as creators know it ("other" is Zapier, Make or their own tools). */
export const LEAD_PROVIDER_NAME: Record<LeadSourceProvider, string> = {
  calendly: "Calendly",
  cal_com: "Cal.com",
  razorpay: "Razorpay",
  stripe: "Stripe",
  other: "Other",
};
