import {
  DealTermsSchema,
  detectDealSignal,
  MINOR_PER_MAJOR,
  normalizeDealTerms,
  type DealDeliverable,
  type DealSuggestion,
  type DealTerms,
  type DealType,
} from "@dealdock/core";
import { z } from "zod";
import { messageText, timeZoneOr } from "./prompts";
import { languageOf, moneyAmounts } from "./style-text";
import type { DealSuggestionInput } from "./types";

/**
 * Deal suggestion: the terms a conversation agreed, for the creator to check
 * before saving. This deterministic reader is the demo/dev answer and every
 * model answer's per-field fallback. It never guesses: an amount needs an
 * agreement, a date needs words that name one, and whatever stays unsettled
 * is listed in `missing`. Relative dates count from the day their message was
 * sent ("by Friday" written last Wednesday), or from `now` when that's unknown.
 */

const DAY_MS = 86_400_000;
/** Unicode-aware word edges (\b is ASCII-only). */
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
/** Clauses: sentence ends, line breaks and list commas, but not the comma in "50,000" or the dot in "Rs. 500". */
const SENTENCE = /(?<=[!?;]|(?<!\b(?:rs|dhs))\.)\s+|\n+|,(?!\d)/i;

// ── Dates: org calendar days held as UTC midnights; endOfDayIso makes the instant ──

/** Wall-clock time in `timeZone` at instant `at`, written as if it were UTC. */
function wallClock(at: number, timeZone: string): number {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(fields.find((field) => field.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** The org's calendar day of an instant. */
function localDay(at: number, timeZone: string): number {
  const wall = wallClock(at, timeZone);
  return wall - (wall % DAY_MS);
}

/** The last second of that calendar day in the org's zone: "by Friday" includes all of Friday. */
export function endOfDayIso(day: number, timeZone: string): string {
  const wall = day + DAY_MS - 1000;
  const offset = (at: number) => wallClock(at, timeZone) - Math.floor(at / 1000) * 1000;
  let at = wall - offset(wall);
  at = wall - offset(at); // a second pass settles days whose offset changes (DST)
  return new Date(at).toISOString();
}

/** A real calendar date (month 0-11), or null for "31 Feb". */
function calendarDay(year: number, month: number, day: number): number | null {
  const at = Date.UTC(year, month, day);
  const date = new Date(at);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? at : null;
}

const parts = (day: number) => {
  const date = new Date(day);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), date: date.getUTCDate(), weekday: date.getUTCDay() };
};

/** A day and month with no year: this year, unless that is two months gone (then next year). */
function dayMonth(today: number, month: number, day: number, year?: string): number | null {
  if (year) return calendarDay(year.length === 2 ? 2000 + Number(year) : Number(year), month, day);
  const thisYear = calendarDay(parts(today).year, month, day);
  return thisYear !== null && thisYear < today - 60 * DAY_MS ? calendarDay(parts(today).year + 1, month, day) : thisYear;
}

/** "Friday": the next one after today. "Next Friday": the one in next week (weeks start Monday). */
function weekday(today: number, target: number, nextWeek: boolean): number {
  const now = parts(today).weekday;
  if (!nextWeek) return today + ((target - now + 7) % 7 || 7) * DAY_MS;
  const nextMonday = today + ((1 - now + 7) % 7 || 7) * DAY_MS;
  return nextMonday + ((target + 6) % 7) * DAY_MS;
}

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIndex = (name: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(name.slice(0, 3).toLowerCase());
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const OFFSETS: Record<string, number> = { today: 0, tonight: 0, aaj: 0, tomorrow: 1, tmrw: 1, tmr: 1, kal: 1 };

type DateHit = { index: number; end: number; day: number; relative: boolean };
type DatePattern = { pattern: RegExp; resolve: (m: RegExpMatchArray, today: number, monthFirst: boolean) => number | null; relative?: boolean };

const DATE_PATTERNS: DatePattern[] = [
  { pattern: /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, resolve: (m) => calendarDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])) },
  { pattern: new RegExp(`${B}(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH}\\.?(?:,?\\s*(\\d{4}))?${E}`, "giu"), resolve: (m, today) => dayMonth(today, monthIndex(m[2]!), Number(m[1]), m[3]) },
  { pattern: new RegExp(`${B}${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?${E}`, "giu"), resolve: (m, today) => dayMonth(today, monthIndex(m[1]!), Number(m[2]), m[3]) },
  // Numeric dates only after a word that introduces one: "24/7" is not a date.
  {
    pattern: new RegExp(`(?<=${B}(?:by|on|till|until|before|due|date|dated)\\s+)(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{4}|\\d{2}))?${E}`, "giu"),
    resolve: (m, today, monthFirst) => dayMonth(today, Number(monthFirst ? m[1] : m[2]) - 1, Number(monthFirst ? m[2] : m[1]), m[3]),
  },
  {
    pattern: new RegExp(`${B}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)${E}`, "giu"),
    resolve: (m, today) => {
      const { year, month, date } = parts(today);
      const next = month + (Number(m[1]) < date ? 1 : 0);
      return calendarDay(year + Math.floor(next / 12), next % 12, Number(m[1]));
    },
  },
  { pattern: new RegExp(`${B}(day after tomorrow|parso|parson|today|tonight|aaj|tomorrow|tmrw|tmr|kal)${E}`, "giu"), resolve: (m, today) => today + (OFFSETS[m[1]!.toLowerCase()] ?? 2) * DAY_MS },
  { pattern: new RegExp(`${B}(?:(this|next|coming|agle|is)\\s+)?(${WEEKDAYS.join("|")})${E}`, "giu"), resolve: (m, today) => weekday(today, WEEKDAYS.indexOf(m[2]!.toLowerCase()), /^(?:next|agle)$/i.test(m[1] ?? "")) },
  // Weeks end on Sunday, months on their last day.
  { pattern: new RegExp(`${B}(this week|is (?:hafte|week)|end of (?:the |this )?week|next week|agle (?:hafte|week))${E}`, "giu"), resolve: (m, today) => today + ((7 - parts(today).weekday) % 7 + (/next|agle/i.test(m[1]!) ? 7 : 0)) * DAY_MS },
  { pattern: new RegExp(`${B}(end of (?:the |this )?month|month[- ]end|mahine ke (?:end|aakhir)|next month|agle mahine)${E}`, "giu"), resolve: (m, today) => Date.UTC(parts(today).year, parts(today).month + (/next|agle/i.test(m[1]!) ? 2 : 1), 0) },
  { pattern: new RegExp(`${B}(?:in|within)\\s+(\\d{1,3})\\s+(days?|weeks?)${E}`, "giu"), resolve: (m, today) => today + Number(m[1]) * (/^w/i.test(m[2]!) ? 7 : 1) * DAY_MS, relative: true },
  { pattern: new RegExp(`${B}(\\d{1,3})\\s*(?:din|dino|dinon)\\s*(?:mein|me|main|mai|ke andar)${E}`, "giu"), resolve: (m, today) => today + Number(m[1]) * DAY_MS, relative: true },
];

/** Every date named in `text`, in order; where two readings overlap ("15th Nov" vs "15th") the longer wins. */
function findDates(text: string, today: number, monthFirst: boolean): DateHit[] {
  const hits: DateHit[] = [];
  for (const { pattern, resolve, relative } of DATE_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const day = resolve(m, today, monthFirst);
      if (day !== null) hits.push({ index: m.index!, end: m.index! + m[0].length, day, relative: relative === true });
    }
  }
  hits.sort((a, b) => a.index - b.index || b.end - a.end);
  const kept: DateHit[] = [];
  for (const hit of hits) if (hit.index >= (kept[kept.length - 1]?.end ?? 0)) kept.push(hit);
  return kept;
}

// ── Deliverables ───────────────────────────────────────────────────────────

const NOUNS: Record<string, string> = {
  reel: "reels?", story: "stor(?:y|ies)", carousel: "carousels?", post: "posts?", video: "videos?",
  live: "lives?", tweet: "tweets?", blog: "blogs?", session: "sessions?", integration: "integrations?",
};
const NOUN = Object.values(NOUNS).join("|");
const kindOf = (noun: string) => Object.keys(NOUNS).find((kind) => new RegExp(`^(?:${NOUNS[kind]})$`, "i").test(noun)) ?? noun.toLowerCase();
const KIND_MENTION = new RegExp(`${B}(${NOUN})${E}`, "giu");
const kindsIn = (text: string) => [...text.matchAll(KIND_MENTION)].map((m) => kindOf(m[1]!));

const COUNTS: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, ek: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
/** Also English words ("do stories?"), so they count only in a Hinglish message. */
const HINGLISH_COUNTS: Record<string, number> = { do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5 };
const ADJECTIVE = "(?:dedicated|instagram|insta|ig|youtube|yt|static|feed|grid|collab|sponsored|branded|long|unboxing|review|tiktok|linkedin|coaching)\\s+";
const COUNTED = new RegExp(
  `${B}(?:(\\d{1,2})\\s*(?:x\\s*)?|(${[...Object.keys(COUNTS), ...Object.keys(HINGLISH_COUNTS)].join("|")})\\s+)((?:${ADJECTIVE}){0,2}(?:${NOUN}))${E}` +
    `(?!\\s+(?:call|chat|meeting|draft|idea|link)s?${E})`,
  "giu",
);

type Counted = { kind: string; label: string; strong: boolean };

/** "1 reel + 2 stories", "ek reel aur do stories" → labelled items; "a" / "an" counts are weak. */
function deliverablesIn(text: string): Counted[] {
  const hinglish = languageOf(text) !== "en";
  const found = new Map<string, Counted>();
  for (const m of text.matchAll(COUNTED)) {
    const word = m[2]?.toLowerCase() ?? "";
    const count = m[1] ? Number(m[1]) : (COUNTS[word] ?? (hinglish ? HINGLISH_COUNTS[word] : undefined));
    if (!count) continue;
    const what = m[3]!.replace(/\s+/g, " ");
    const label = `${count} ${what}`;
    if (!found.has(label.toLowerCase())) found.set(label.toLowerCase(), { kind: kindOf(what.split(" ").pop()!), label, strong: word !== "a" && word !== "an" });
  }
  return [...found.values()];
}

/** The newest list of deliverables; a list with real counts beats a later passing "a story". */
function pickDeliverables(texts: readonly string[]): Counted[] {
  let picked: Counted[] = [];
  for (const text of texts) {
    const items = deliverablesIn(text);
    if (items.some((item) => item.strong) || (items.length > 0 && !picked.some((item) => item.strong))) picked = items;
  }
  return picked;
}

const PAYMENT_WORD = new RegExp(
  `${B}(?:pay(?:ment|ments|out)?|invoice[ds]?|fees?|amount|transfer|paisa|paise|net\\s?-?\\d+)${E}` +
    // "paid collab", "paid reel": the adjective, not a payment.
    `|${B}paid${E}(?!\\s+(?:collab|colab|partnership|promo\\w*|post|campaign|content|deal|ads?|feature|stor(?:y|ies)|reels?|videos?|work|gig)${E})`,
  "iu",
);
const CONTENT_WORD = new RegExp(`${B}(?:content|deliverables?|everything|live|publish(?:ed)?|post(?:ed|ing)?|upload(?:ed)?)${E}`, "iu");

/**
 * Dates to deliverables, newest message last so it wins. Within a clause,
 * each date covers what was named since the previous date ("reel by Friday
 * and stories next week"); a date named before its deliverable takes the rest
 * of the clause ("by Friday for the reel"); a date about content in general
 * fills undated deliverables. A payment clause's date is the payment due date.
 */
function assignDates(
  messages: ReadonlyArray<{ text: string; today: number }>,
  items: Array<{ kind: string; day: number | null }>,
  monthFirst: boolean,
): number | null {
  let paymentDay: number | null = null;
  for (const { text, today } of messages) {
    for (const clause of text.toLowerCase().split(SENTENCE)) {
      const hits = findDates(clause, today, monthFirst);
      let from = 0;
      for (const [i, hit] of hits.entries()) {
        const segment = clause.slice(from, hit.end);
        const rest = i === hits.length - 1 ? clause.slice(hit.end) : "";
        from = hit.end;
        if (PAYMENT_WORD.test(segment)) {
          // "within 30 days" of payment is payment terms (paymentDays), not a date.
          if (!hit.relative) paymentDay = hit.day;
          continue;
        }
        let kinds = kindsIn(segment);
        if (kinds.length === 0 && !PAYMENT_WORD.test(rest)) kinds = kindsIn(rest);
        let targets = items.filter((item) => kinds.includes(item.kind));
        if (targets.length === 0 && (kinds.length > 0 || CONTENT_WORD.test(segment + rest))) targets = items.filter((item) => item.day === null);
        for (const item of targets) item.day = hit.day;
      }
    }
  }
  return paymentDay;
}

// ── Terms ──────────────────────────────────────────────────────────────────

/** The newest clause that states the term wins; a question settles nothing. */
function latest<T>(texts: readonly string[], read: (clause: string) => T | null): T | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    for (const clause of texts[i]!.toLowerCase().split(SENTENCE)) {
      if (clause.includes("?")) continue;
      const value = read(clause);
      if (value !== null) return value;
    }
  }
  return null;
}

function advanceIn(s: string): number | null {
  const m =
    /(\d{1,3})\s?(?:%|percent|per cent)\s*(?:of the (?:fee|amount|payment)\s*)?(?:as\s+|in\s+)?(?:advance|upfront|up[- ]front|pehle)/.exec(s) ??
    /(?:advance|upfront|up[- ]front)\s*(?:of|:|-|payment of|payment)?\s*(\d{1,3})\s?(?:%|percent)/.exec(s);
  if (m) return Number(m[1]) <= 100 ? Number(m[1]) : null;
  if (/half\s+(?:(?:the\s+)?(?:fee|amount|payment)\s+)?(?:in\s+)?(?:advance|upfront)|(?:aadha|adha)\s+(?:payment\s+)?advance|50[-/]50/.test(s)) return 50;
  if (/(?:full|100%)\s+(?:payment\s+)?(?:in\s+)?advance/.test(s)) return 100;
  return new RegExp(`${B}no advance${E}`, "u").test(s) ? 0 : null;
}

const NET_DAYS = new RegExp(`${B}net\\s?-?(\\d{1,3})${E}`, "u");
const PAY_WITHIN = new RegExp(
  `${B}(?:within|in|after)\\s+(\\d{1,3})\\s*(?:working\\s+|business\\s+)?(?:days?|din)${E}|${B}(\\d{1,3})\\s*(?:days?|din|dino|dinon)\\s*(?:mein|me|main|mai|ke andar|of|after|from|post)${E}`,
  "u",
);

/** "net 30", "payment within 30 days", "payment 30 din mein". */
function paymentDaysIn(s: string): number | null {
  const m = NET_DAYS.exec(s) ?? (PAYMENT_WORD.test(s) ? PAY_WITHIN.exec(s) : null);
  const days = m ? Number(m[1] ?? m[2]) : NaN;
  return days >= 0 && days <= 365 ? days : null;
}

const REVISIONS = new RegExp(
  `${B}(\\d{1,2}|${[...Object.keys(COUNTS), ...Object.keys(HINGLISH_COUNTS)].join("|")})\\s+(?:rounds?\\s+of\\s+(?:revisions?|edits?|changes|feedback)|revisions?|edits?)${E}`,
  "u",
);

function revisionsIn(s: string): number | null {
  if (new RegExp(`${B}no\\s+(?:revisions?|edits?|changes)${E}`, "u").test(s)) return 0;
  const m = REVISIONS.exec(s) ?? new RegExp(`${B}(?:revisions?|edits?)\\s*(?:included\\s*)?[:-]?\\s*(\\d{1,2})${E}`, "u").exec(s);
  if (!m) return null;
  const word = m[1]!;
  const count = /^\d+$/.test(word) ? Number(word) : (COUNTS[word] ?? (languageOf(s) !== "en" ? HINGLISH_COUNTS[word] : undefined));
  return count !== undefined && count <= 20 ? count : null;
}

const DURATION = new RegExp(`${B}(\\d{1,3})\\s*(days?|din|weeks?|hafte|months?|mahina|mahine|years?|saal)${E}`, "gu");
/** By first letter, so Hindi units read in English: din → day, hafte → week, mahine → month, saal → year. */
const UNIT: Record<string, string> = { d: "day", w: "week", h: "week", m: "month", y: "year", s: "year" };

/** The duration written nearest the keyword at `at` ("3 months usage, 30 days exclusivity"). */
function durationNear(s: string, at: number): string | null {
  let best: { text: string; distance: number } | null = null;
  for (const m of s.matchAll(DURATION)) {
    const start = m.index!;
    const distance = start >= at ? start - at : Math.max(0, at - start - m[0].length);
    const n = Number(m[1]);
    if (!best || distance < best.distance) best = { text: `${n} ${UNIT[m[2]![0]!]}${n === 1 ? "" : "s"}`, distance };
  }
  return best?.text ?? null;
}

const USAGE_WORD = new RegExp(`${B}(?:usage|rights|organic|paid ads?|whitelist\\w*|boost\\w*|spark ads?|perpetu\\w*)${E}`, "u");

/** "Organic only", "Paid ads, 3 months", "Usage rights, 6 months"; a bare "usage" settles nothing. */
function usageIn(s: string): string | null {
  const word = USAGE_WORD.exec(s);
  if (!word) return null;
  const paid = /paid (?:ads?|media|usage|promotion|social)|(?<![\p{L}])ads? usage|boost|spark ads?|whitelist|dark posts?/u.test(s);
  const organic = /(?<![\p{L}])organic/u.test(s);
  const kind = organic ? (paid ? "Organic and paid ads" : "Organic only") : paid ? "Paid ads" : "Usage rights";
  const span = /perpetu|forever|lifetime/.test(s) ? "perpetual" : durationNear(s, word.index);
  if (kind === "Usage rights" && !span) return null;
  return span ? `${kind}, ${span}` : kind;
}

// ── When usage rights and exclusivity end ─────────────────────────────────────

const EXCLUSIVITY_WORD = new RegExp(`${B}(?:exclusiv\\w*|no (?:other|competing|competitor))`, "u");
/** Words before a date that make it the end of a term ("till 3 March"); "by" stays a due date. */
const UNTIL_BEFORE = /(?:till|until|untill|through|thru|ending|ends?(?: on)?|expir(?:es|ing|y)?(?: on)?|valid (?:till|until)|upto|up to)\s*$/u;
/** Words before a date that start a term ("from 1 Dec"), so a duration can count from it. */
const FROM_BEFORE = /(?:from|starting(?: on| from)?|starts?(?: on)?|beginning|effective|w\.?e\.?f\.?)\s*$/u;
/** Whole sentences, so a duration and its start date stay together ("3 months, from 1 Dec"). */
const SENTENCES = /(?<=[!?;]|(?<!\b(?:rs|dhs))\.)\s+|\n+/i;

/** A calendar day plus a whole number of days, weeks, months or years (31 Jan + 1 month is 28 or 29 Feb). */
function addSpan(day: number, n: number, unit: string): number {
  if (unit === "day" || unit === "week") return day + n * (unit === "week" ? 7 : 1) * DAY_MS;
  const { year, month, date } = parts(day);
  const months = month + n * (unit === "year" ? 12 : 1);
  return Date.UTC(year, months, Math.min(date, new Date(Date.UTC(year, months + 1, 0)).getUTCDate()));
}

/**
 * When a term ends, newest statement first: a date written as its end in a
 * sentence about it ("usage till 3 March"), or a stated duration counted from
 * a stated start ("3 months from 1 Dec"). Never guessed: a duration with no
 * start date gives null.
 */
function endOf(messages: ReadonlyArray<{ text: string; today: number }>, keyword: RegExp, monthFirst: boolean): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const { text, today } = messages[i]!;
    for (const sentence of text.toLowerCase().split(SENTENCES)) {
      const word = sentence.includes("?") ? null : keyword.exec(sentence);
      if (!word) continue;
      const hits = findDates(sentence, today, monthFirst).filter((hit) => !hit.relative);
      const before = (hit: DateHit) => sentence.slice(Math.max(0, hit.index - 24), hit.index);
      const nearest = (list: DateHit[]) => list.sort((a, b) => Math.abs(a.index - word.index) - Math.abs(b.index - word.index))[0];
      const until = nearest(hits.filter((hit) => UNTIL_BEFORE.test(before(hit))));
      if (until) return until.day;
      const from = nearest(hits.filter((hit) => FROM_BEFORE.test(before(hit))));
      const span = from ? /^(\d+) (day|week|month|year)s?$/.exec(durationNear(sentence, word.index) ?? "") : null;
      if (from && span) return addSpan(from.day, Number(span[1]), span[2]!);
    }
  }
  return null;
}

/** "No other skincare brands, 30 days", "Exclusivity, 1 month", or "None" when they said so. */
function exclusivityIn(s: string): string | null {
  if (new RegExp(`${B}(?:no exclusivity|non[- ]exclusive)${E}`, "u").test(s)) return "None";
  const category = new RegExp(`${B}no (?:other|competing|competitor)\\s+((?:[\\p{L}-]+\\s+){0,2}?)brands?${E}`, "u").exec(s);
  const keyword = category ?? new RegExp(`${B}exclusiv\\w*`, "u").exec(s);
  if (!keyword) return null;
  const span = durationNear(s, keyword.index);
  const what = category ? `No other ${category[1]}brands`.replace(/\s+/g, " ") : "Exclusivity";
  return span ? `${what}, ${span}` : what;
}

// ── Amount ─────────────────────────────────────────────────────────────────

/** Acceptances core's close-out detector leaves out because alone they don't mean money moved or a deal closed. */
const ACCEPT = new RegExp(`${B}(?:sounds good|works for (?:us|me)|that works|agreed|approved|go ahead|chalega|done deal)${E}|^\\W*(?:(?:ok|okay|haan|yes)\\W+)?done\\W*$`, "u");
const NOT_YET = new RegExp(`\\?|${B}(?:not|no|nahi|nahin|nhi|yet|pending|let me|check|discuss|think|get back|revert)${E}`, "u");
// Whole sentences, not comma clauses: "Sounds good, let me check with the team" is not a yes.
const agrees = (text: string) =>
  detectDealSignal(text) !== null || text.toLowerCase().split(/(?<=[.!?])\s+|\n+/).some((s) => ACCEPT.test(s.trim()) && !NOT_YET.test(s));

/** Money-looking text, including what core won't read as an amount (ranges, "50k followers"). */
const MONEY_HINT = /[₹$£€]\s?\d|\b(?:rs|inr|usd|gbp|eur|aed|dhs)\.?\s?\d|\d\s?(?:k|l|lakhs?|lacs?|cr|crores?|hazaa?r)(?![a-z])|\d\s?\/-/i;
const AMOUNT_LOOKBACK = 6;

/**
 * The fee on the table when the conversation last agreed: named in the
 * agreeing message, or in the latest message before it that talks money. A
 * range, another currency or two candidate fees is no agreement, and a
 * different figure raised afterwards reopens it.
 */
function agreedAmount(texts: readonly string[], currencyCode: string, advancePercent: number | null): number | null {
  let at = texts.length - 1;
  while (at >= 0 && !agrees(texts[at]!)) at--;
  if (at < 0) return null;
  const advanceOf = (fee: number) => (advancePercent ? Math.round((fee * advancePercent) / 100) : null);
  for (let i = at; i >= Math.max(0, at - AMOUNT_LOOKBACK); i--) {
    if (!MONEY_HINT.test(texts[i]!)) continue;
    const named = [...new Set(moneyAmounts(texts[i]!, currencyCode))];
    const fees = named.filter((minor) => !named.some((fee) => fee !== minor && advanceOf(fee) === minor));
    if (fees.length !== 1) return null;
    const fee = fees[0]!;
    const reopened = texts.slice(at + 1).some((text) => moneyAmounts(text, currencyCode).some((minor) => minor !== fee && minor !== advanceOf(fee)));
    return reopened ? null : fee;
  }
  return null;
}

// ── Suggestion ─────────────────────────────────────────────────────────────

function titleOf(items: readonly Counted[]): string | null {
  if (items.length === 0) return null;
  const all = items.map((item) => item.label).join(" + ");
  return all.length <= 80 ? all : `${items[0]!.label} + ${items.length - 1} more`;
}

function dealTypeOf(text: string, items: readonly Counted[]): DealType | null {
  if (items.some((item) => item.kind !== "session") || /collab|campaign|sponsor|ambassador|brand/.test(text)) return "brand";
  if (/coaching|mentorship|1:1|one[- ]on[- ]one|1-on-1/.test(text)) return "coaching";
  if (/course|cohort|batch|enrol/.test(text)) return "course";
  if (/workshop|consult|speaking|keynote|licens|session/.test(text)) return "other";
  return null;
}

/** What the conversation left unsettled, in plain words and a fixed order. */
export function dealMissing(s: Pick<DealSuggestion, "amountMinor" | "dealType" | "dueAt" | "terms">): string[] {
  const { deliverables, paymentDays, usage } = s.terms;
  return [
    s.amountMinor === null && "fee",
    deliverables.length === 0 && "deliverables",
    (deliverables.length === 0 || deliverables.some((d) => !d.dueAt)) && "due dates",
    paymentDays === null && s.dueAt === null && "payment terms",
    usage === null && s.dealType !== "coaching" && s.dealType !== "course" && "usage rights",
  ].filter((item): item is string => typeof item === "string");
}

/** The heuristic reading of a conversation's deal (English and Hinglish). */
export function suggestDealHeuristically(input: DealSuggestionInput, modelVersion: string): DealSuggestion {
  const timeZone = timeZoneOr(input.timezone);
  const monthFirst = (input.creator.locale ?? (input.creator.currencyCode === "USD" ? "en-US" : "")).toLowerCase() === "en-us";
  const messages = input.threadHistory.map((m) => {
    const sent = m.sentAt ? Date.parse(m.sentAt) : NaN;
    return { text: messageText(m), today: localDay(Number.isFinite(sent) ? sent : input.now.getTime(), timeZone) };
  });
  const texts = messages.map((m) => m.text);
  const counted = pickDeliverables(texts);
  const items = counted.map((item) => ({ ...item, day: null as number | null }));
  const paymentDay = assignDates(messages, items, monthFirst);
  const advancePercent = latest(texts, advanceIn);
  const endIso = (day: number | null) => (day === null ? null : endOfDayIso(day, timeZone));
  const terms: DealTerms = {
    deliverables: items.map((item, i) => ({ id: `d${i + 1}`, label: item.label, dueAt: item.day === null ? null : endOfDayIso(item.day, timeZone), done: false })),
    usage: latest(texts, usageIn),
    usageEndsAt: endIso(endOf(messages, USAGE_WORD, monthFirst)),
    exclusivity: latest(texts, exclusivityIn),
    exclusivityEndsAt: endIso(endOf(messages, EXCLUSIVITY_WORD, monthFirst)),
    revisionsIncluded: latest(texts, revisionsIn),
    advancePercent,
    paymentDays: latest(texts, paymentDaysIn),
    notes: null,
    disclosure: [],
  };
  const suggestion = {
    title: titleOf(counted),
    dealType: dealTypeOf(texts.join("\n").toLowerCase(), counted),
    amountMinor: agreedAmount(texts, input.creator.currencyCode, advancePercent),
    dueAt: paymentDay === null ? null : endOfDayIso(paymentDay, timeZone),
    terms,
  };
  return { ...suggestion, missing: dealMissing(suggestion), modelVersion };
}

const MODEL_TITLE = z.string().trim().min(1).max(80).nullable();
const MODEL_DEAL_TYPE = z.enum(["brand", "coaching", "course", "other"]).nullable();
const MODEL_DELIVERABLES = z.array(z.object({ label: z.string(), due_date: z.unknown() }));
const MODEL_TERMS = ["usage", "exclusivity", "revisionsIncluded", "advancePercent", "paymentDays", "notes"] as const;

/**
 * A model's record_deal answer, field by field: a field that fails validation
 * keeps the heuristic's value, an amount counts only if the conversation names
 * it in the org currency, and `missing` is recomputed from the result.
 */
export function mergeDealSuggestion(raw: unknown, fallback: DealSuggestion, input: DealSuggestionInput, modelVersion: string): DealSuggestion {
  const model = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const timeZone = timeZoneOr(input.timezone);
  // null is the model saying "not stated"; undefined means its answer was invalid.
  const isoDate = (value: unknown): string | null | undefined => {
    if (value === null) return null;
    const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    const day = m ? calendarDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    return day === null ? undefined : endOfDayIso(day, timeZone);
  };

  const patch: Partial<DealTerms> = {};
  for (const key of MODEL_TERMS) {
    if (DealTermsSchema.shape[key].safeParse(model[key]).success) Object.assign(patch, { [key]: model[key] });
  }
  // End dates come as calendar days; null is "not stated", an invalid one keeps the heuristic reading.
  for (const [key, field] of [["usageEndsAt", "usage_end_date"], ["exclusivityEndsAt", "exclusivity_end_date"]] as const) {
    const ends = isoDate(model[field]);
    if (ends !== undefined) patch[key] = ends;
  }
  const items = MODEL_DELIVERABLES.safeParse(model.deliverables);
  if (items.success) {
    const deliverables = items.data.map((item, i) => ({ id: `d${i + 1}`, label: item.label.trim(), dueAt: isoDate(item.due_date), done: false }));
    if (deliverables.every((d) => d.dueAt !== undefined) && DealTermsSchema.shape.deliverables.safeParse(deliverables).success) {
      patch.deliverables = deliverables as DealDeliverable[];
    }
  }

  const named = new Set(input.threadHistory.flatMap((m) => moneyAmounts(messageText(m), input.creator.currencyCode)));
  const major = model.amount_major;
  const minor = typeof major === "number" && Number.isFinite(major) ? Math.round(major * MINOR_PER_MAJOR) : NaN;
  const title = MODEL_TITLE.safeParse(model.title);
  const dealType = MODEL_DEAL_TYPE.safeParse(model.dealType);
  const dueAt = isoDate(model.payment_due_date);
  const suggestion = {
    title: title.success ? title.data : fallback.title,
    dealType: dealType.success ? dealType.data : fallback.dealType,
    amountMinor: major === null ? null : named.has(minor) ? minor : fallback.amountMinor,
    dueAt: dueAt === undefined ? fallback.dueAt : dueAt,
    terms: normalizeDealTerms(patch, fallback.terms),
  };
  return { ...suggestion, missing: dealMissing(suggestion), modelVersion };
}
