/**
 * Text features shared by voice learning, exemplar retrieval and draft lint
 * (docs/research/04-writing-style-learning.md §4.0). Pure: no Node APIs, no
 * I/O. Only the API and worker use them; the web never imports @dealdock/ai.
 */

const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_GLOBAL = /\p{Extended_Pictographic}/gu;
const DEVANAGARI = /[ऀ-ॿ]/;

/** Lowercased word and emoji tokens. Devanagari matras stay attached to their letters. */
export function tokenize(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}']*|\p{Extended_Pictographic}/gu) ?? [];
}

export function words(text: string): string[] {
  return tokenize(text).filter((token) => !EMOJI.test(token));
}

export function wordCount(text: string): number {
  return words(text).length;
}

export function emojiCount(text: string): number {
  return text.match(EMOJI_GLOBAL)?.length ?? 0;
}

export function hasDevanagari(text: string): boolean {
  return DEVANAGARI.test(text);
}

/**
 * Romanized Hindi function/content words. English-colliding tokens ("to",
 * "me", "he", "main", "is", "the", "do", "hi", "par", "mat", "ya", "log",
 * "tab", "jab") are deliberately absent so English text never reads as mixed.
 */
const HINGLISH = new Set(
  (
    "hai hain tha thi ho hoga hogi hoon hun hu kya kyu kyun kyon kaise kaisa kaisi kab kahan kaha kaun kitna kitne kitni " +
    "nahi nahin nhi na haan han ji acha accha achha theek thik bilkul zaroor jarur pakka sahi ekdum bahut bohot bhot thoda " +
    "zyada jyada abhi kal aaj parso jaldi baad pehle phir fir toh bhi sirf bas ki ka ke ko se mein mai mera meri mere mujhe " +
    "hum humein hume hamara aap aapka aapki aapke tum tumhara tumhe apna apni apne uska uski unka unki iska iski yaar yar " +
    "bhai bhaiya didi dost kar karo karna karenge karunga karungi karte karti kiya kiye raha rahi rahe rha rhi wala wali " +
    "wale chahiye chahte chahti chahta sakte sakti sakta milte milenge mil bata batao bataiye batana dijiye dena dekh dekho " +
    "dekhte dekhenge bolo bol bolna samajh samjha pata lagta lagega chalo chal jao aao aaja aana jana hona matlab waise " +
    "vaise aisa aise kuch kuchh sab sabko koi kyunki lekin aur agar jo woh wo yeh shukriya dhanyavaad dhanyawad namaste " +
    "arre arey mast badhiya badiya zabardast pyaar pyar khush paisa paise baat kaam din raat subah shaam hafte mahine saal " +
    "ghar bhejo bhej bhejna bhejenge dunga dungi denge lenge lena lo pucho poocho gaya gayi gaye diya liya hogaya kariye " +
    "karein rakho rakh chahenge doon"
  ).split(" ")
);

function languageCounts(text: string): { hi: number; en: number } {
  let hi = 0;
  let en = 0;
  for (const word of words(text)) {
    if (DEVANAGARI.test(word) || HINGLISH.has(word)) hi++;
    else if (/^[a-z']+$/.test(word)) en++;
  }
  return { hi, en };
}

/** Gambäck & Das Code-Mixing Index: 0 = one language, 0.5 = evenly mixed. Fewer than 3 tagged words → 0. */
export function codeMixingIndex(text: string): number {
  const { hi, en } = languageCounts(text);
  const n = hi + en;
  return n < 3 ? 0 : 1 - Math.max(hi, en) / n;
}

/**
 * Share of Hindi words (romanized or Devanagari) — the creator-facing
 * "Hinglish index" (MeasuredStyle.hinglishIndex). Unlike CMI it is monotonic
 * in "more Hindi", so it also gives an edit shift its direction.
 */
export function hindiShare(text: string): number {
  const { hi, en } = languageCounts(text);
  const n = hi + en;
  return n < 3 ? 0 : hi / n;
}

export type TextLanguage = "en" | "hinglish" | "hi";

export function languageOf(text: string): TextLanguage {
  const all = words(text);
  const devanagari = all.filter((word) => DEVANAGARI.test(word)).length;
  if (all.length > 0 && devanagari / all.length >= 0.5) return "hi";
  return hindiShare(text) >= 0.2 ? "hinglish" : "en";
}

const CLAUSE_END = /[,!?.;:\n—–]|\s-\s/;
const GREETING_WORD = /^(hi+|hey+|hello+|helo+|hiya|heya|yo+|namaste|namaskar|hola|dear|gm|sup)$/;

function bare(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

/**
 * The opener of a message: leading greeting words ("Heyy", "Hey hey!",
 * "Hi team"), otherwise a first clause of at most 4 words that ends in
 * punctuation ("Thanks for reaching out!"). A trailing "!" is kept because it
 * is part of how the creator sounds; "," and "." are not.
 */
export function greetingOf(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "";
  const tokens = line.split(/\s+/);
  const picked: string[] = [];
  for (const raw of tokens) {
    if (picked.length >= 2) break;
    const word = bare(raw);
    if (picked.length === 0 ? GREETING_WORD.test(word) : GREETING_WORD.test(word) || (/[,!]$/.test(raw) && /^\p{L}+$/u.test(word))) {
      picked.push(raw);
      if (/[,!?.;:]$/.test(raw)) break;
      continue;
    }
    break;
  }
  if (picked.length > 0) {
    const joined = picked.join(" ");
    const exclaim = /!+$/.exec(joined)?.[0] ?? "";
    return `${joined.replace(/[,!?.;:]+$/, "")}${exclaim}`;
  }
  const end = CLAUSE_END.exec(line);
  if (!end || end.index === 0) return "";
  const span = line.slice(0, end.index).trim();
  const n = wordCount(span);
  if (n < 1 || n > 4) return "";
  return end[0] === "!" ? `${span}!` : span;
}

/**
 * The sign-off: the last line of a multi-line message when it is at most 3
 * words (or only emoji) and the lines before it carry the body (≥ 4 words).
 * A single-line message has no sign-off.
 */
export function signoffOf(text: string): string {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return "";
  const last = lines[lines.length - 1]!;
  if (wordCount(lines.slice(0, -1).join(" ")) < 4) return "";
  const n = wordCount(last);
  return n <= 3 && (n > 0 || emojiCount(last) > 0) ? last : "";
}

/** Generic assistant phrasing that makes a DM read as AI-written (research 04 §4.0). */
export const AI_TELLS: readonly string[] = [
  "thanks for reaching out",
  "i hope this message finds you well",
  "i'd be happy to",
  "feel free to",
  "looking forward to hearing from you",
  "don't hesitate to",
  "absolutely!",
  "great question",
  "—",
  "i appreciate you",
  "rest assured",
  "kindly",
];

/**
 * Comparable form: lowercase, emoji and punctuation removed, letter runs ≥ 3
 * collapsed to 2 ("pleaseee" → "pleasee"), single spaces. Also the
 * normalization behind rule keys such as "avoid:thanks for reaching out".
 */
export function normalizeForSim(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(EMOJI_GLOBAL, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole-word, case/punctuation-insensitive phrase match; punctuation-only phrases ("—") match literally. */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = normalizeForSim(phrase);
  if (!needle) return phrase.trim().length > 0 && text.includes(phrase.trim());
  return ` ${normalizeForSim(text)} `.includes(` ${needle} `);
}

export function aiTellScore(text: string): number {
  return AI_TELLS.filter((tell) => containsPhrase(text, tell)).length;
}

const CONTENT =
  /\d|[₹$£€]|\brs\.?(?=\s|\d|$)|\b(inr|usd|gbp|eur|aed|lakh|lakhs|lac|crore|crores)\b|https?:|www\.|@\w|\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b(january|february|march|april|june|july|august|september|october|november|december)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|yesterday)\b/i;

/** Prices, dates, links and handles are facts, never style evidence. */
export function isContentSpan(span: string): boolean {
  return CONTENT.test(span);
}

const STOPWORDS = new Set(
  "a an the and or but so to of in on at for with is are was were be been it its this that these those i you we they he she me my your our us them just very really also too as if then than do does did have has had will would can could".split(
    " "
  )
);

export function isStopwordsOnly(span: string): boolean {
  const all = words(span);
  return all.length === 0 || all.every((word) => STOPWORDS.has(word));
}

/** Character-trigram set over the comparable form (precompute for repeated comparisons). */
export function trigramSet(text: string): Set<string> {
  const normalized = normalizeForSim(text);
  const out = new Set<string>();
  if (!normalized) return out;
  const chars = Array.from(` ${normalized} `);
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Lexical similarity 0..1 (symmetric; 1 for identical text, 0 when either side is empty). */
export function trigramSimilarity(a: string, b: string): number {
  return jaccard(trigramSet(a), trigramSet(b));
}

export interface DiffHunk {
  /** Original-text words removed (punctuation kept). */
  deleted: string;
  /** Original-text words added. */
  inserted: string;
}

/**
 * Word-level LCS diff grouped into change hunks. Words compare on their
 * normalized form, so punctuation-only changes produce no hunk. O(n·m) on
 * tokens; DMs are short, and anything absurdly long is one full-rewrite hunk.
 */
export function wordDiff(before: string, after: string): DiffHunk[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  if (a.length * b.length > 250_000) return [{ deleted: a.join(" "), inserted: b.join(" ") }];
  const key = (token: string) => normalizeForSim(token) || token;
  const ka = a.map(key);
  const kb = b.map(key);
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        ka[i] === kb[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const hunks: DiffHunk[] = [];
  let deleted: string[] = [];
  let inserted: string[] = [];
  const flush = () => {
    if (deleted.length || inserted.length) hunks.push({ deleted: deleted.join(" "), inserted: inserted.join(" ") });
    deleted = [];
    inserted = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) {
      flush();
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      deleted.push(a[i++]!);
    } else {
      inserted.push(b[j++]!);
    }
  }
  deleted.push(...a.slice(i));
  inserted.push(...b.slice(j));
  flush();
  return hunks;
}

/** Strip clause punctuation from a span's edges for display ("Thanks for reaching out —" → "Thanks for reaching out"). */
export function cleanSpan(span: string, max = 80): string {
  const trimmed = span.replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/g, "");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}
