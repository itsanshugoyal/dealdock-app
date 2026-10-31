import type { ClassificationLabel } from "./index";
import type { DealSignal, DealType } from "./api-types";
import { dealTypeForLabel } from "./catalog";
import { MINOR_PER_MAJOR } from "./money";

/**
 * Close-out detection (F6): notice a counterparty's "payment done" / "let's
 * proceed" so the thread can offer "Looks like this closed — record ₹X?".
 * Pure and deliberately conservative: a missed signal costs the creator one
 * manual tap, a false one nags them, so negation, questions, conditionals and
 * future tense all veto a match. Nothing here records revenue — a human does.
 */

export interface DealSignalMatch {
  /** The matched wording, normalized (lower-case, single spaces). */
  phrase: string;
}

const WORD = "\\p{L}\\p{M}\\p{N}_";

/** Unicode-aware whole-phrase matcher (\b is ASCII-only and breaks Devanagari). */
function phrase(source: string): RegExp {
  // NFC: Devanagari nukta letters (ढ़, फ़) decompose, so patterns must match normalized input.
  return new RegExp(`(?<![${WORD}])(?:${source.normalize("NFC")})(?![${WORD}])`, "u");
}

const PAY_SUBJECT =
  "payment|paymnt|pymt|money|amount|fees?|advance|funds|balance|transfer|transaction|upi|gpay|google pay|paytm|phone ?pe|neft|imps|rtgs|bank transfer|wire(?: transfer)?";
const PAY_VERB =
  "done|made|sent|completed?|successful|successfully done|received|processed|cleared|credited|transferred|deposited|wired";
/** "paid collab", "a paid one", "paid basis": the adjective, not a payment. */
const PAID_NOT_A_PAYMENT =
  "collab|colab|partner|promo|post|campaign|content|ads?\\b|advert|media|deal|opportunit|gig|work|job|project|shout|feature|stor|reel|sponsor|version|plan|subscri|member|tier|influencer|creator|user|account|app\\b|tool|course|program|session|consult|call|service|event|ticket|option|offer|package|search|traffic|marketing|placement|mention|review|trip|leave|intern|role|position|one\\b|basis|barter|engagement|association|activit|assignment|requirement|brief|integration|budget";
/** "confirmed dates", "our confirmed budget": describing the brief, not agreeing to it. */
const CONFIRMED_NOT_AGREEMENT =
  "budget|dates?\\b|list|timeline|deliverable|brief|details|creators|influencers|names|availability";
const HINGLISH_SUBJECT = "payment|pyment|paymnt|paise|paisa|pese|pesa|amount|fees?|money|advance|rupaye|rupees|token|upi|gpay|paytm|phone ?pe";
const HINGLISH_DONE =
  "(?:kar|kr|bhej|transfer kar|transfer kr|daal|dal|de|jama kar|jama kr) ?(?:diya|diye|dia|di|diyaa)|ho ?(?:gaya|gayi|gya|gyi|gaye|gye)|hogaya|hogya";

/** Ordered most-specific first; the first unvetoed match wins. */
const SIGNALS: RegExp[] = [
  // English payment confirmations.
  phrase(`(?:${PAY_SUBJECT})(?: (?:is|has been|was|got|have been))? (?:${PAY_VERB})`),
  phrase(`(?:made|done|completed|sent|cleared|processed|transferred)(?: the| your| ur| my)? (?:payment|transfer|upi)`),
  phrase(`(?:sent|transferred|wired|deposited|credited)(?: you| u)?(?: the| your| ur)? (?:money|amount|payment|fees?|advance|funds|balance|dues)`),
  phrase(`(?:sent|transferred|deposited|credited)(?: it)? (?:to|in|into) (?:your|ur) (?:account|a\\/c|acc|upi|bank|gpay|paytm)`),
  // "sent you ₹50k" / "transferred 25k" — a bare "sent 2 reels" is not money.
  phrase(
    `(?:sent|transferred|wired|deposited)(?: you| u)?(?= (?:₹|rs\\b|inr\\b|\\$|£|€|aed\\b)| \\d[\\d,.]*\\s?(?:k|l|lakh|lakhs|cr|rs|inr|rupees|\\/-)(?![\\p{L}]))`
  ),
  phrase(`done (?:via|through|thru|on|by|using) (?:upi|gpay|google pay|paytm|phone ?pe|neft|imps|rtgs|bank transfer|card|net ?banking)`),
  phrase(`(?<!(?:get|gets|getting|got|be|being|a|an) )paid(?! (?:${PAID_NOT_A_PAYMENT}))`),
  phrase(`transferred(?=[^\\p{L}\\p{N}]*$)`),
  // Paperwork that only exists once a deal is agreed.
  phrase(`(?:invoice|bill)(?: (?:is|has been|was|got))? (?:raised|approved|cleared|paid|processed|generated|settled)`),
  phrase(`(?:raised|approved|cleared|processed|settled)(?: the| your| ur)? (?:invoice|bill)`),
  phrase(`(?:po|purchase order)(?: (?:is|has been|was|got))? (?:issued|raised|released|sent|shared|generated|approved|signed)`),
  phrase(`(?:issued|raised|released|sent|shared|signed)(?: the| a| your| ur)? (?:po|purchase order)`),
  phrase(`(?:contract|agreement|mou)(?: (?:is|has been|was|got))? (?:signed|executed|finali[sz]ed|confirmed|done)`),
  phrase(`signed(?: the| your| ur)? (?:contract|agreement|mou)`),
  // Agreement.
  phrase(`let'?s (?:proceed|go ahead|lock (?:it|this|that)(?: in)?|close (?:it|this)|do (?:it|this)|move ahead|move forward|get started|finali[sz]e)|let us proceed`),
  phrase(`(?:please|pls|plz|kindly|you can|we can) (?:proceed|go ahead)`),
  phrase(`lock(?:ed)? it in|consider it (?:done|locked|confirmed)|it'?s a deal|done deal|we have a deal|we'?ve got a deal|(?:we'?re )?good to go`),
  phrase(`deal (?:done|locked|sealed|closed|confirmed|final|finali[sz]ed|fixed|pakka|hai)`),
  phrase(`(?:i|we) confirm|confirmed(?! (?:${CONFIRMED_NOT_AGREEMENT}))`),
  phrase(`(?:bought|purchased)(?: your| ur| the)? (?:course|program(?:me)?|package|plan|ebook|e-book|guide|preset|template|coaching|session|membership|slot)`),
  phrase(`(?:enrolled|joined|registered)(?: in| into| for)? (?:your|ur|the) (?:course|program(?:me)?|coaching|batch|cohort|membership|workshop|masterclass)`),
  // Hinglish.
  phrase(`(?:${HINGLISH_SUBJECT})(?: [\\p{L}\\p{N}']+){0,2}? (?:${HINGLISH_DONE})`),
  phrase(`transfer (?:kar|kr) ?(?:diya|diye|dia|di)`),
  phrase(`(?:proceed|lock|final|fix|book) (?:karte|krte) (?:hain|hai|h|he)|(?:proceed|lock|final|fix|book) (?:kar do|kr do|karo|kro|kar dijiye|kr dijiye)`),
  phrase(`(?:final|fix|fixed|lock|locked|confirm|confirmed|done|set) (?:hai|h|he|ho gaya|ho gya|hogaya)`),
  phrase(`pakka|pukka|pakki`),
  // Hindi (Devanagari).
  phrase(
    `(?:भुगतान|पेमेंट|पेमेन्ट|पैसे|पैसा|रकम|राशि|अमाउंट|फीस|एडवांस)(?: [\\p{L}\\p{M}\\p{N}]+){0,2}? (?:हो ?गया|हो ?गई|हो ?गयी|कर ?दिया|कर ?दिए|कर ?दिये|कर ?दी|भेज ?दिया|भेज ?दिए|भेज ?दिये|भेज ?दी|ट्रांसफर ?कर ?दिया|ट्रांसफर ?कर ?दिए|डाल ?दिया|डाल ?दिए|जमा ?कर ?दिया)`
  ),
  phrase(`(?:डील|सौदा|बात) (?:पक्की|पक्का|फाइनल|फ़ाइनल|लॉक|डन|कन्फर्म|तय)`),
  phrase(`पक्का|पक्की|कन्फर्म(?:्ड)?|आगे बढ़(?:ते|ें|िए)`),
];

/** A bare "Deal!" / "ok deal 🤝" as the whole sentence (not "brand deal", "what's the deal"). */
const BARE_DEAL = /^(?:(?:ok|okay|okk|cool|sure|perfect|fine|alright|haan|han|yes|yeah|yep|done)[^\p{L}\p{N}]+)?deal[^\p{L}\p{N}]*$/u;

const NEGATION = new Set([
  "not", "no", "never", "nope", "yet", "pending", "almost", "nearly",
  "haven't", "havent", "hasn't", "hasnt", "didn't", "didnt", "isn't", "isnt", "wasn't", "wasnt",
  "won't", "wont", "can't", "cant", "cannot", "don't", "dont", "doesn't", "doesnt", "aren't", "arent",
  "nahi", "nahin", "nhi", "nai", "mat", "नहीं", "नही", "मत",
]);
/** Future, conditional or hypothetical framing: "once paid", "will be done", "agar payment ho gaya". */
const HYPOTHETICAL = new Set([
  "will", "i'll", "we'll", "you'll", "he'll", "she'll", "they'll", "it'll", "shall", "would", "gonna",
  "once", "if", "when", "after", "before", "until", "unless", "within", "tomorrow", "soon", "later",
  "agar", "jab", "jaise", "hoga", "hogi", "honge", "karunga", "karungi", "karenge", "krunga", "dunga", "dungi", "denge",
  "अगर", "जब", "बाद", "होगा", "होगी", "करूंगा", "करूँगा", "करेंगे", "दूंगा", "दूँगा", "भेजूंगा", "भेजेंगे",
]);
const QUESTION_WORD = new Set([
  "kya", "kyaa", "kab", "kitna", "kitne", "kaise", "kyun", "kyu", "kahan", "batao", "btao", "bolo",
  "क्या", "कब", "कितना", "कैसे", "क्यों",
]);
const QUESTION_START =
  /^(?:(?:did|do|does|have|has|is|are|was|were|will|would|can|could|should|shall)\s+(?:you|u|we|i|it|the|they|he|she|this|that|ur|your|my|our)|when|why|how|what|where|which)(?![\p{L}\p{N}])/u;
/** "No worries, payment done" — these "no"s are not negations. */
const BENIGN_NO = /(?<![\p{L}\p{N}])no (?:worries|worry|problem|problems|prob|probs|issue|issues|stress|tension)(?![\p{L}\p{N}])/gu;

function normalize(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u{200B}-\u{200D}\u{FEFF}]/gu, "")
    .replace(/[\u{2018}\u{2019}\u{02BC}]/gu, "'")
    .replace(/[ \t\f\v\u{00A0}]+/gu, " ")
    .trim();
}

function tokens(text: string): string[] {
  return text.split(/[^\p{L}\p{M}\p{N}']+/u).filter(Boolean);
}

function vetoed(segment: string, start: number, end: number): boolean {
  if (segment.slice(start).includes("?")) return true;
  const trimmed = segment.trim();
  if (QUESTION_START.test(trimmed)) return true;
  const all = tokens(segment);
  if (all.some((t) => QUESTION_WORD.has(t))) return true;
  const before = tokens(segment.slice(0, start)).slice(-4);
  const after = tokens(segment.slice(end)).slice(0, 2);
  if (before.some((t) => NEGATION.has(t) || HYPOTHETICAL.has(t))) return true;
  if (/(?<![\p{L}\p{N}])(?:going to|about to|to be|yet to)\s*$/u.test(segment.slice(0, start))) return true;
  return after.some((t) => NEGATION.has(t) || HYPOTHETICAL.has(t));
}

/**
 * Does this message read like the counterparty confirming the deal? English,
 * Hinglish and Devanagari Hindi. Returns the wording that matched, or null.
 */
export function detectDealSignal(text: string): DealSignalMatch | null {
  if (!text) return null;
  const normalized = normalize(text).replace(BENIGN_NO, " ");
  // Clauses end at sentence punctuation or a line break; a "?" stays with its clause.
  const segments = normalized.split(/(?<=[!?।])|(?<=\.)(?=\s|$)|\n+/u).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    if (BARE_DEAL.test(segment)) return { phrase: "deal" };
    for (const pattern of SIGNALS) {
      const match = pattern.exec(segment);
      if (!match) continue;
      if (vetoed(segment, match.index, match.index + match[0].length)) continue;
      return { phrase: match[0].trim() };
    }
  }
  return null;
}

// ── Amount extraction ─────────────────────────────────────────────────────

type Marker = "INR" | "USD" | "GBP" | "EUR" | "AED" | "ORG";

const MARKERS: Array<[RegExp, Marker]> = [
  [/^(?:₹|rs\.?|inr|rupees?|rupaye|rupay)$/u, "INR"],
  [/^(?:\$|us\$|usd|dollars?|bucks)$/u, "USD"],
  [/^(?:£|gbp|pounds?|quid)$/u, "GBP"],
  [/^(?:€|eur|euros?)$/u, "EUR"],
  [/^(?:aed|dhs?\.?|dirhams?)$/u, "AED"],
  // Indian price notation "50,000/-": currency-marked, denomination = the org's.
  [/^\/-$/u, "ORG"],
];

const MAGNITUDE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  l: 1e5, lk: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7,
  m: 1e6, mn: 1e6, million: 1e6,
};

const AMOUNT = new RegExp(
  "(?<![\\p{L}\\p{N}.,])" +
    "(?:(?<pre>₹|rs\\.?|inr|us\\$|usd|\\$|£|gbp|€|eur|aed|dhs?\\.?)\\s?)?" +
    "(?<num>\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)*)" +
    "(?:\\s?(?<mag>k|thousand|lakhs|lakh|lacs|lac|lk|l|crores|crore|cr|million|mn|m)(?![\\p{L}]))?" +
    "(?<post>\\s?(?:\\/-|₹|rs\\.?|inr|rupees?|rupaye|rupay|usd|dollars?|bucks|\\$|gbp|pounds?|quid|£|eur|euros?|€|aed|dhs?|dirhams?)(?![\\p{L}]))?",
  "gu",
);
const COUNT_NOUN =
  /^\s*(?:followers?|subs|subscribers?|views?|likes?|reach|impressions?|people|members?|students?|users?|downloads?|comments?|shares?|saves?|plays?|streams?|fans?|audience|accounts?|creators?|influencers?|posts?|reels?|stories|videos?|days?|weeks?|months?|years?|hours?|hrs?|mins?|minutes?|km|kg|steps|calories)(?![\p{L}])/u;
const RANGE_AFTER = /^\s?(?:-|–|—|to)\s?(?:₹|rs\.?|\$|£|€)?\s?\d/u;
const RANGE_BEFORE = /\d\s?(?:k|l|lakh|cr)?\s?(?:-|–|—|to)\s?(?:₹|rs\.?|\$|£|€)?\s?$/u;

function markerOf(token: string | undefined): Marker | null {
  if (!token) return null;
  const t = token.trim();
  for (const [re, marker] of MARKERS) if (re.test(t)) return marker;
  return null;
}

/**
 * The first money amount in `text` denominated in the org currency, as
 * integer minor units: "₹1,20,000", "Rs. 50000/-", "1.2L", "1.5 cr", "2k",
 * "$500". A bare number needs a currency or magnitude ("50000" alone could be
 * anything); amounts in another currency, ranges ("30-50k") and counts
 * ("50k followers") are skipped — never converted or guessed.
 */
export function extractAmountMinor(text: string, currencyCode: string): number | null {
  if (!text) return null;
  const normalized = normalize(text);
  for (const match of normalized.matchAll(AMOUNT)) {
    const { pre, num, mag, post } = match.groups ?? {};
    if (!num) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const marker = markerOf(pre) ?? markerOf(post);
    // "m" is minutes as often as millions: only trust it next to a currency.
    if (mag === "m" && !marker) continue;
    if (!marker && !mag) continue;
    if (marker && marker !== "ORG" && marker !== currencyCode) continue;
    if (!marker && COUNT_NOUN.test(normalized.slice(end))) continue;
    if (RANGE_AFTER.test(normalized.slice(end)) || RANGE_BEFORE.test(normalized.slice(0, start))) continue;

    let digits = num.replaceAll(",", "");
    // "€1.500" / "1.234.567": a dot followed by exactly three digits is grouping, not decimals.
    if (!mag && /^\d{1,3}(?:\.\d{3})+$/.test(digits)) digits = digits.replaceAll(".", "");
    if ((digits.match(/\./g) ?? []).length > 1) continue;
    const major = Number(digits) * (mag ? MAGNITUDE[mag] ?? 1 : 1);
    const minor = Math.round(major * MINOR_PER_MAJOR);
    if (Number.isSafeInteger(minor) && minor > 0) return minor;
  }
  return null;
}

export interface SignalMessage {
  id: string;
  direction: string;
  /** Message text, or the voice-note transcript. */
  text: string;
  sentAt: Date | string;
}

/** Recent messages scanned for a confirmation (inbox rows read the same window), and earlier ones searched for its amount. */
export const DEAL_SIGNAL_LOOKBACK = 8;
const AMOUNT_LOOKBACK = 6;

/**
 * The thread-level close-out suggestion: the newest recent inbound message
 * that reads like a confirmation, with the nearest amount mentioned in it or
 * the few messages before it (either side may have named the price). Null
 * when the thread is closed or a sale was already recorded at/after it.
 */
export function findDealSignal(input: {
  /** Chronological. */
  messages: SignalMessage[];
  state: string;
  label: string | null;
  currencyCode: string;
  /** closedAt of the thread's live ledger entries. */
  recordedAt: Array<Date | string>;
}): DealSignal | null {
  if (input.state === "closed") return null;
  const first = Math.max(0, input.messages.length - DEAL_SIGNAL_LOOKBACK);
  for (let i = input.messages.length - 1; i >= first; i--) {
    const message = input.messages[i]!;
    if (message.direction !== "inbound") continue;
    const match = detectDealSignal(message.text);
    if (!match) continue;
    const at = new Date(message.sentAt).getTime();
    if (input.recordedAt.some((recorded) => new Date(recorded).getTime() >= at)) return null;
    let suggestedAmountMinor: number | null = null;
    for (let j = i; j >= Math.max(0, i - AMOUNT_LOOKBACK) && suggestedAmountMinor === null; j--) {
      suggestedAmountMinor = extractAmountMinor(input.messages[j]!.text, input.currencyCode);
    }
    return { messageId: message.id, phrase: match.phrase, suggestedAmountMinor, suggestedDealType: inferDealType(input.label) };
  }
  return null;
}

/** The ledger deal type a commerce label implies, or null when it doesn't (dealTypeForLabel). */
export function inferDealType(label: ClassificationLabel | string | null | undefined): DealType | null {
  return dealTypeForLabel(label);
}
