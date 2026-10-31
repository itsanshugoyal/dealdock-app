import { HIGH_INTENT_LABELS, type ClassificationLabel, type MessageOrigin, type VoiceRuleScope } from "@dealdock/core";
import { draftScope } from "./style-learning";
import {
  cleanSpan,
  emojiCount,
  isContentSpan,
  jaccard,
  languageOf,
  trigramSet,
  trigramSimilarity,
  wordCount,
  wordDiff,
} from "./style-text";

/**
 * Per-draft retrieval (research 04 §4.4): the creator's own past replies to
 * similar inbound DMs (exemplars) and 1–2 lessons from their past edits.
 * Lexical trigram similarity, scored in-process over a few hundred rows.
 * shortcut: in-process scoring of the newest ~200 rows; move to pg_trgm when an
 * account passes ~5k outbound messages, embeddings only if the eval demands it.
 */

export interface ExemplarCandidate {
  messageId: string;
  threadId: string;
  text: string;
  /** The inbound message this replied to. */
  inboundText: string | null;
  label: ClassificationLabel | null;
  draftKind: "reply" | "nudge" | null;
  origin: MessageOrigin;
  /** DealDock sends only (0 = sent untouched). */
  editRatio: number | null;
  sentAt: Date;
}

export interface RetrievalQuery {
  /** The latest inbound message (text or transcript). */
  inboundText: string;
  scope: VoiceRuleScope;
  now: Date;
  /** The conversation being drafted — already in the prompt, so never an exemplar. */
  excludeThreadId?: string;
}

const COMMERCE = new Set<string>(HIGH_INTENT_LABELS);

function labelAffinity(a: VoiceRuleScope, b: VoiceRuleScope): number {
  if (a === b) return 1;
  return COMMERCE.has(a) && COMMERCE.has(b) ? 0.5 : 0.2;
}

/** Native and human-rewritten replies anchor the voice; untouched DealDock sends count least (research §4.4). */
function sourceWeight(c: ExemplarCandidate): number {
  if (c.origin === "native") return 1;
  const ratio = c.editRatio ?? 0;
  return ratio >= 0.5 ? 0.95 : ratio > 0 ? 0.85 : 0.6;
}

function untouchedDealDock(c: ExemplarCandidate): boolean {
  return c.origin === "dealdock" && (c.editRatio ?? 0) <= 0;
}

/**
 * Up to k exemplars: score = (0.45·same label + 0.35·similarity of their past
 * inbound to this inbound + 0.2·same language) × source weight × recency; the
 * top 40 go through MMR (λ 0.7) so near-duplicates are never picked twice; at
 * most ⌊k/2⌋ untouched DealDock sends and at least one native reply when one
 * exists. Returned least → most relevant (closest to the task).
 */
export function selectExemplars(query: RetrievalQuery, pool: readonly ExemplarCandidate[], k = 4): ExemplarCandidate[] {
  const language = languageOf(query.inboundText);
  const inbound = trigramSet(query.inboundText);
  const scored = pool
    .filter((c) => {
      const text = c.text.trim();
      if (c.origin === "automation" || c.label === "personal" || c.label === "spam") return false;
      if (query.excludeThreadId && c.threadId === query.excludeThreadId) return false;
      if (text.length > 600 || /^https?:\/\/\S+$/i.test(text)) return false;
      return wordCount(text) >= 2 || emojiCount(text) > 0;
    })
    .map((c) => {
      const similarity = c.inboundText ? jaccard(inbound, trigramSet(c.inboundText)) : 0;
      const sameLanguage = languageOf(c.inboundText ?? c.text) === language ? 1 : 0.6;
      const ageDays = Math.max(0, (query.now.getTime() - c.sentAt.getTime()) / 864e5);
      const recency = 0.6 + 0.4 * Math.pow(0.5, ageDays / 120);
      const affinity = labelAffinity(draftScope({ kind: c.draftKind, label: c.label }), query.scope);
      return { c, grams: trigramSet(c.text), score: (0.45 * affinity + 0.35 * similarity + 0.2 * sameLanguage) * sourceWeight(c) * recency };
    })
    .sort((a, b) => b.score - a.score || b.c.sentAt.getTime() - a.c.sentAt.getTime())
    .slice(0, 40);
  if (scored.length === 0) return [];

  const want = scored.filter((s) => s.score > 0.2).length < 2 ? Math.min(k, 3) : k;
  const maxUntouched = Math.floor(want / 2);
  const picked: typeof scored = [];
  const remaining = [...scored];
  while (picked.length < want && remaining.length > 0) {
    let best = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    remaining.forEach((s, i) => {
      if (untouchedDealDock(s.c) && picked.filter((p) => untouchedDealDock(p.c)).length >= maxUntouched) return;
      const redundancy = picked.length ? Math.max(...picked.map((p) => jaccard(s.grams, p.grams))) : 0;
      if (redundancy >= 0.8) return; // near-duplicate of a pick
      const value = 0.7 * s.score - 0.3 * redundancy;
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    });
    if (best === -1) break;
    picked.push(remaining.splice(best, 1)[0]!);
  }

  // Keep the creator's real voice as the anchor: at least one native reply if any scored.
  if (picked.length > 0 && !picked.some((p) => p.c.origin === "native")) {
    const native = remaining.find((s) => s.c.origin === "native" && picked.every((p) => jaccard(s.grams, p.grams) < 0.8));
    if (native) picked[picked.length - 1] = native;
  }
  return picked
    .sort((a, b) => a.score - b.score)
    .map((p) => p.c);
}

export interface LessonCandidate {
  draftId: string;
  threadId: string;
  scope: VoiceRuleScope;
  inboundText: string | null;
  /** The draft the creator saw. */
  before: string;
  /** What they actually sent. */
  after: string;
  editRatio: number;
  sentAt: Date;
}

export interface EditLesson {
  draftId: string;
  text: string;
}

const SCOPE_WORDS: Partial<Record<VoiceRuleScope, string>> = {
  brand_deal: "brand",
  coaching_lead: "coaching",
  course_inquiry: "course",
  other_commerce: "paid-work",
  nudge: "follow-up",
};

/** The largest stylistic change in an edit, as one line ("you changed “…” → “…”"). */
export function describeEdit(before: string, after: string): string | null {
  const hunk = wordDiff(before, after)
    .filter((h) => !isContentSpan(`${h.deleted} ${h.inserted}`))
    .sort((a, b) => b.deleted.length + b.inserted.length - (a.deleted.length + a.inserted.length))[0];
  if (!hunk) return null;
  const removed = cleanSpan(hunk.deleted);
  const added = cleanSpan(hunk.inserted);
  if (removed && added) return `you changed “${removed}” → “${added}”`;
  if (added) return `you added “${added}”`;
  return removed ? `you cut “${removed}”` : null;
}

/**
 * CIPHER-style lessons: past sends whose edit was real but not a rewrite
 * (0.05 ≤ edit ratio ≤ 0.8, last 120 days), scored by how similar their
 * inbound was to this one (×0.5 for another scope). Top 2 with score ≥ 0.15.
 */
export function selectLessons(query: RetrievalQuery, pool: readonly LessonCandidate[], max = 2): EditLesson[] {
  return pool
    .filter(
      (c) =>
        c.editRatio >= 0.05 &&
        c.editRatio <= 0.8 &&
        query.now.getTime() - c.sentAt.getTime() <= 120 * 864e5 &&
        c.threadId !== query.excludeThreadId
    )
    .map((c) => ({ c, score: trigramSimilarity(query.inboundText, c.inboundText ?? "") * (c.scope === query.scope ? 1 : 0.5) }))
    .filter((s) => s.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .flatMap(({ c }) => {
      const change = describeEdit(c.before, c.after);
      return change ? [{ draftId: c.draftId, text: `On a similar ${SCOPE_WORDS[c.scope] ?? ""} message ${change}`.replace(/\s+/g, " ") }] : [];
    })
    .slice(0, max);
}
