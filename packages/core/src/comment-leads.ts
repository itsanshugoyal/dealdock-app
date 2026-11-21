/**
 * Comment leads: someone comments one of the creator's keywords ("PRICE") on
 * their post, and DealDock drafts the one private reply Instagram allows.
 * A person approves and sends every reply; nothing here sends.
 */

/** Instagram takes one private reply per comment, within 7 days of the comment. */
export const COMMENT_REPLY_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAX_COMMENT_KEYWORDS = 10;
export const MAX_COMMENT_KEYWORD_LENGTH = 30;

/** When the private reply window closes. */
export function commentReplyBy(commentedAt: Date | string | number): Date {
  return new Date(new Date(commentedAt).getTime() + COMMENT_REPLY_WINDOW_MS);
}

/** True while Instagram still takes a private reply to a comment made at `commentedAt`. */
export function canReplyPrivately(commentedAt: Date | string | number, now: Date | number = Date.now()): boolean {
  return commentReplyBy(commentedAt).getTime() > new Date(now).getTime();
}

/** Compatibility form, trimmed, single-spaced: how a keyword is stored and compared. */
function tidy(keyword: string): string {
  return keyword.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export type CommentKeywordsError = "too_many_keywords" | "keyword_too_long" | "keyword_needs_a_word";
export type CommentKeywordsResult = { ok: true; keywords: string[] } | { ok: false; error: CommentKeywordsError };

/**
 * Keywords as stored: trimmed, blanks and repeats (in any case) dropped, at
 * most 10 of 1–30 characters, each with a letter, digit or emoji.
 */
export function normalizeCommentKeywords(input: readonly string[]): CommentKeywordsResult {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const keyword = tidy(raw);
    if (!keyword) continue;
    if ([...keyword].length > MAX_COMMENT_KEYWORD_LENGTH) return { ok: false, error: "keyword_too_long" };
    if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(keyword)) return { ok: false, error: "keyword_needs_a_word" };
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
  }
  return keywords.length > MAX_COMMENT_KEYWORDS ? { ok: false, error: "too_many_keywords" } : { ok: true, keywords };
}

/** Letters (with their combining marks, as in Devanagari), digits and "_" join a word; anything else ends it. */
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}_]";

/**
 * The first of the creator's keywords that the comment contains as a whole
 * word or phrase, in any case ("price?" and "#PRICE" match PRICE; "prices"
 * does not). Null when none does.
 */
export function matchCommentKeyword(text: string, keywords: readonly string[]): string | null {
  const comment = text.normalize("NFKC");
  for (const keyword of keywords) {
    const words = tidy(keyword).split(" ").filter(Boolean);
    if (!words.length) continue;
    const phrase = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    if (new RegExp(`(?<!${WORD_CHAR})${phrase}(?!${WORD_CHAR})`, "iu").test(comment)) return keyword;
  }
  return null;
}
