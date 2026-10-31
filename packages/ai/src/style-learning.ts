import { editRatio as draftEditRatio } from "@dealdock/core";
import type {
  ClassificationLabel,
  DraftChip,
  LearnedSignal,
  MeasuredStyle,
  MessageOrigin,
  SeatRole,
  VoiceRuleScope,
  VoiceRuleSource,
  VoiceRuleStatus,
} from "@dealdock/core";
import {
  AI_TELLS,
  aiTellScore,
  cleanSpan,
  codeMixingIndex,
  containsPhrase,
  emojiCount,
  greetingOf,
  hasDevanagari,
  hindiShare,
  isContentSpan,
  isStopwordsOnly,
  normalizeForSim,
  signoffOf,
  wordCount,
  wordDiff,
} from "./style-text";

/**
 * Writing-style learning (F2, docs/research/04-writing-style-learning.md).
 * Pure functions only: persistence lives in @dealdock/db (repos take the
 * planned rule rows), scheduling in the worker, prompts in prompts.ts.
 *
 * The loop: provenance-filtered samples → measured style + seed rules;
 * every human edit → deterministic signals → decayed evidence on VoiceRule
 * rows → deterministic promotion. Claude only ever proposes candidates.
 */

// ── Corpus & sample selection (§4.1) ───────────────────────────────────────

/** One outbound text message from the account, joined with what it answered. */
export interface CorpusMessage {
  messageId: string;
  threadId: string;
  text: string;
  sentAt: Date;
  /** Provenance. A linked DealDock draft always means "dealdock", whatever the echo said. */
  origin: MessageOrigin;
  /** Label the reply was written for: draft label → replied-to classification → thread label. */
  label: ClassificationLabel | null;
  draftKind: "reply" | "nudge" | null;
  /** DealDock sends only: share of the draft the human changed (0 = sent untouched). */
  editRatio: number | null;
  /** DealDock sends only: role of the seat that approved the send. */
  seatRole: SeatRole | null;
  /** The inbound message this replied to (text, or a voice note's transcript). */
  inboundText: string | null;
}

export type SampleExclusion =
  | "excluded_by_you"
  | "too_short"
  | "link_only"
  | "personal"
  | "automation"
  | "unedited_draft"
  | "duplicate"
  | "ai_sounding";

export interface VoiceSample extends CorpusMessage {
  scope: VoiceRuleScope;
  /** 0-1 influence on the measured style and extraction. */
  weight: number;
  /** Same text sent in ≥ 3 threads (saved reply / template). */
  template: boolean;
  /** One-word or emoji-only replies: emoji stats only, never exemplars or extraction. */
  statsOnly: boolean;
}

export const MIN_VOICE_SAMPLES = 3;

export function draftScope(input: { kind: "reply" | "nudge" | null | undefined; label: ClassificationLabel | null | undefined }): VoiceRuleScope {
  return input.kind === "nudge" ? "nudge" : (input.label ?? "all");
}

/**
 * Provenance weight (research §4.1): typed natively 1.0; a heavily rewritten
 * DealDock draft 0.9; a lightly edited one 0.5; an untouched one 0 (never learn
 * from our own output). Sends approved by an assistant/manager count half.
 */
export function provenanceWeight(message: Pick<CorpusMessage, "origin" | "editRatio" | "seatRole">): number {
  if (message.origin === "automation") return 0;
  let weight = 1;
  if (message.origin === "dealdock") {
    const ratio = message.editRatio ?? 0;
    if (ratio <= 0) return 0;
    weight = ratio >= 0.5 ? 0.9 : 0.5;
  }
  return message.seatRole && message.seatRole !== "creator" ? weight * 0.5 : weight;
}

/**
 * Filter the corpus down to genuine evidence of how the creator texts:
 * drops user-excluded, empty/one-word, link-only, personal/spam-thread,
 * automation and untouched-DealDock messages; keeps one copy of repeated
 * texts (a template sent to ≥ 3 threads weighs 0.3×); drops AI-sounding
 * messages (≥ 2 stock phrases) unless that is simply how most of them read.
 */
export function selectVoiceSamples(
  rows: readonly CorpusMessage[],
  excludedIds: Iterable<string> = []
): { samples: VoiceSample[]; excluded: Partial<Record<SampleExclusion, number>> } {
  const excludedSet = new Set(excludedIds);
  const excluded: Partial<Record<SampleExclusion, number>> = {};
  const skip = (reason: SampleExclusion, count = 1) => {
    excluded[reason] = (excluded[reason] ?? 0) + count;
  };
  const byText = new Map<string, { sample: VoiceSample; threads: Set<string> }>();
  const kept: VoiceSample[] = [];
  for (const row of [...rows].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())) {
    const text = row.text.trim();
    if (excludedSet.has(row.messageId)) {
      skip("excluded_by_you");
      continue;
    }
    const n = wordCount(text);
    if (n < 2 && emojiCount(text) === 0) {
      skip("too_short");
      continue;
    }
    if (/^https?:\/\/\S+$/i.test(text)) {
      skip("link_only");
      continue;
    }
    // Friends & family never reach a model as style evidence.
    if (row.label === "personal" || row.label === "spam") {
      skip("personal");
      continue;
    }
    if (row.origin === "automation") {
      skip("automation");
      continue;
    }
    const weight = provenanceWeight(row);
    if (weight === 0) {
      skip("unedited_draft");
      continue;
    }
    const norm = normalizeForSim(text) || text;
    const seen = byText.get(norm);
    if (seen) {
      seen.threads.add(row.threadId);
      skip("duplicate");
      continue;
    }
    const sample: VoiceSample = { ...row, text, scope: draftScope({ kind: row.draftKind, label: row.label }), weight, template: false, statsOnly: n < 2 };
    byText.set(norm, { sample, threads: new Set([row.threadId]) });
    kept.push(sample);
  }
  for (const { sample, threads } of byText.values()) {
    if (threads.size >= 3) {
      sample.template = true;
      sample.weight = round(sample.weight * 0.3);
    }
  }
  const aiSounding = kept.filter((sample) => aiTellScore(sample.text) >= 2);
  if (kept.length > 0 && aiSounding.length > 0 && aiSounding.length / kept.length <= 0.5) {
    skip("ai_sounding", aiSounding.length);
    return { samples: kept.filter((sample) => !aiSounding.includes(sample)), excluded };
  }
  return { samples: kept, excluded };
}

// ── Measured style (§4.1 measureStyle) ─────────────────────────────────────

/** MeasuredStyle plus the extra habits the prompt and seed rules use. */
export interface MeasuredScopeStyle extends MeasuredStyle {
  medianWords: number;
  /** Gambäck & Das Code-Mixing Index (0 = monolingual, 0.5 = evenly mixed). */
  cmi: number;
  devanagariRate: number;
  lowercaseStartRate: number;
  exclaimRate: number;
  openers: Array<{ text: string; share: number }>;
  signoffs: Array<{ text: string; share: number }>;
}

const SCOPE_ORDER: VoiceRuleScope[] = [
  "all",
  "brand_deal",
  "coaching_lead",
  "course_inquiry",
  "other_commerce",
  "nudge",
  "fan",
  "uncertain",
  "personal",
  "spam",
];

export function scopeRank(scope: VoiceRuleScope): number {
  const index = SCOPE_ORDER.indexOf(scope);
  return index === -1 ? SCOPE_ORDER.length : index;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function weightedMean(samples: readonly VoiceSample[], value: (sample: VoiceSample) => number): number {
  let total = 0;
  let weights = 0;
  for (const sample of samples) {
    total += value(sample) * sample.weight;
    weights += sample.weight;
  }
  return weights > 0 ? total / weights : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function topShares(samples: readonly VoiceSample[], extract: (text: string) => string): Array<{ text: string; share: number }> {
  const totals = new Map<string, { text: string; weight: number }>();
  let all = 0;
  for (const sample of samples) {
    all += sample.weight;
    const value = extract(sample.text);
    const key = normalizeForSim(value);
    if (!key) continue;
    const entry = totals.get(key) ?? { text: value, weight: 0 };
    entry.weight += sample.weight;
    totals.set(key, entry);
  }
  return [...totals.values()]
    .sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text))
    .slice(0, 3)
    .map((entry) => ({ text: entry.text, share: round(all > 0 ? entry.weight / all : 0) }));
}

function startsLowercase(text: string): boolean | null {
  const first = /\p{L}/u.exec(text)?.[0];
  if (!first || !/[a-zA-Z]/.test(first)) return null;
  return first === first.toLowerCase();
}

function measureGroup(scope: VoiceRuleScope, group: readonly VoiceSample[], textual: readonly VoiceSample[]): MeasuredScopeStyle {
  const lettered = textual.filter((sample) => startsLowercase(sample.text) !== null);
  const openers = topShares(textual, greetingOf);
  const signoffs = topShares(textual, signoffOf);
  return {
    scope,
    samples: textual.length,
    avgWords: round(weightedMean(textual, (s) => wordCount(s.text)), 1),
    medianWords: median(textual.map((s) => wordCount(s.text))),
    emojiRate: round(weightedMean(group, (s) => emojiCount(s.text))),
    hinglishIndex: round(weightedMean(textual, (s) => hindiShare(s.text))),
    cmi: round(weightedMean(textual, (s) => codeMixingIndex(s.text))),
    devanagariRate: round(weightedMean(textual, (s) => (hasDevanagari(s.text) ? 1 : 0))),
    lowercaseStartRate: round(weightedMean(lettered, (s) => (startsLowercase(s.text) ? 1 : 0))),
    exclaimRate: round(weightedMean(textual, (s) => (s.text.match(/!/g)?.length ?? 0))),
    openers,
    signoffs,
    topOpeners: openers.map((o) => o.text),
    topSignoffs: signoffs.map((s) => s.text),
  };
}

/** Weighted habits per scope: "all" from 3 samples, a specific scope from 5 (research §4.1). */
export function measureStyle(samples: readonly VoiceSample[]): MeasuredScopeStyle[] {
  const groups = new Map<VoiceRuleScope, VoiceSample[]>([["all", [...samples]]]);
  for (const sample of samples) {
    if (sample.scope === "all") continue;
    groups.set(sample.scope, [...(groups.get(sample.scope) ?? []), sample]);
  }
  const out: MeasuredScopeStyle[] = [];
  for (const scope of [...groups.keys()].sort((a, b) => scopeRank(a) - scopeRank(b) || a.localeCompare(b))) {
    const group = groups.get(scope)!;
    const textual = group.filter((sample) => !sample.statsOnly);
    if (textual.length < (scope === "all" ? MIN_VOICE_SAMPLES : 5)) continue;
    out.push(measureGroup(scope, group, textual));
  }
  return out;
}

/**
 * Up to 40 samples for the descriptive (Claude) card: native or heavily
 * rewritten only, ≤ 10 per commerce scope, ≤ 5 nudges, ≤ 5 other, newest
 * first, each truncated to 400 chars.
 */
export function extractionSample(samples: readonly VoiceSample[], limit = 40): string[] {
  const candidates = samples
    .filter((s) => !s.statsOnly && (s.origin === "native" || (s.editRatio ?? 0) >= 0.5))
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const quota = (scope: VoiceRuleScope) =>
    scope === "brand_deal" || scope === "coaching_lead" || scope === "course_inquiry" || scope === "other_commerce" ? 10 : 5;
  const used = new Map<string, number>();
  const picked: VoiceSample[] = [];
  for (const sample of candidates) {
    const bucket = quota(sample.scope) === 10 ? sample.scope : sample.scope === "nudge" ? "nudge" : "other";
    if ((used.get(bucket) ?? 0) >= quota(sample.scope)) continue;
    used.set(bucket, (used.get(bucket) ?? 0) + 1);
    picked.push(sample);
  }
  for (const sample of candidates) {
    if (picked.length >= limit) break;
    if (!picked.includes(sample)) picked.push(sample);
  }
  return picked.slice(0, limit).map((s) => s.text.slice(0, 400));
}

/** Stock AI phrases the creator does not genuinely use (native frequency < 2%) — the prompt's avoid list. */
export function genericAvoidList(samples: readonly VoiceSample[]): string[] {
  const native = samples.filter((s) => s.origin === "native" && !s.statsOnly);
  return AI_TELLS.filter((tell) => {
    if (native.length === 0) return true;
    return native.filter((s) => containsPhrase(s.text, tell)).length / native.length < 0.02;
  });
}

// ── Rule catalog ───────────────────────────────────────────────────────────

export const LENGTH_BUCKETS = [
  { key: "length:very_short", max: 12, target: 8, text: "Keep it to one quick line (under ~12 words)" },
  { key: "length:short", max: 30, target: 20, text: "Keep it short: about 15–30 words" },
  { key: "length:medium", max: 60, target: 45, text: "Keep it medium: about 30–60 words" },
  { key: "length:long", max: Number.POSITIVE_INFINITY, target: 80, text: "Write fuller replies (60+ words) when it helps" },
] as const;

export function lengthBucket(words: number): (typeof LENGTH_BUCKETS)[number] {
  return LENGTH_BUCKETS.find((bucket) => words <= bucket.max) ?? LENGTH_BUCKETS[3];
}

function emojiKey(count: number): "emoji:none" | "emoji:light" | "emoji:heavy" {
  return count === 0 ? "emoji:none" : count <= 2 ? "emoji:light" : "emoji:heavy";
}

/** Creator-facing text for every fixed rule key (keys with a value render from it). */
export const RULE_TEXT: Readonly<Record<string, string>> = {
  "greeting:none": "Skip the greeting and get straight to the point",
  "signoff:none": "Don't add a sign-off",
  "emoji:none": "Skip emojis",
  "emoji:light": "Use an emoji or two",
  "emoji:heavy": "Use emojis freely",
  "language:hinglish": "Mix in Hindi (Hinglish)",
  "language:english": "Reply in English",
  "script:devanagari": "Write Hindi words in Devanagari",
  "script:roman": "Write Hindi in Roman letters, not Devanagari",
  "casing:lowercase": "Start messages in lowercase",
  "casing:capitalized": "Start messages with a capital letter",
  "exclaim:more": "Use exclamation marks freely",
  "exclaim:fewer": "Go easy on exclamation marks",
  "tone:warm": "Keep it warm and personal",
  "tone:formal": "Keep a polished, slightly formal tone",
  "tone:casual": "Keep it casual, like a quick text",
  "posture:ask-budget": "Ask about their budget early",
  "posture:quote-rate": "Share your rate up front when you have one",
  ...Object.fromEntries(LENGTH_BUCKETS.map((bucket) => [bucket.key, bucket.text])),
};

/** Families where only one habit can be active per scope (highest evidence wins). */
const EXCLUSIVE_FAMILIES = new Set(["greeting", "signoff", "length", "emoji", "language", "script", "casing", "exclaim"]);

export function ruleFamily(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}

function ruleValue(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? "" : key.slice(colon + 1);
}

/** Keys that cannot both describe the creator: another greeting, avoid vs prefer the same phrase, formal vs casual. */
export function rulesConflict(a: string, b: string): boolean {
  if (a === b) return false;
  const fa = ruleFamily(a);
  const fb = ruleFamily(b);
  if (fa === fb && EXCLUSIVE_FAMILIES.has(fa)) return true;
  const value = ruleValue(a);
  if (value && value === ruleValue(b) && ((fa === "avoid" && fb === "prefer") || (fa === "prefer" && fb === "avoid"))) return true;
  return (a === "tone:formal" && b === "tone:casual") || (a === "tone:casual" && b === "tone:formal");
}

/** The quoted value inside a rule text ("Open with “Heyy”" → "Heyy"). */
export function quotedValue(text: string): string | null {
  return /[“"]([^”"]+)[”"]/.exec(text)?.[1] ?? null;
}

// ── Edit analysis (§4.2 deterministic detector) ────────────────────────────

export interface StyleSignal {
  /** Rule key, e.g. "greeting:hey hey", "avoid:thanks for reaching out", "length:short". */
  key: string;
  /** Imperative rule text for Voice Studio and the prompt. */
  text: string;
  /** Creator-facing observation for the after-send hint ("You open with “Heyy”"). */
  summary: string;
  /** Evidence weight: 1 for a clear edit, 0.3 for "kept the length". */
  weight: number;
  /** Clear enough to offer back to the creator after the send. */
  strong: boolean;
  before: string;
  after: string;
}

export interface EditAnalysis {
  /** accepted = sent untouched; fact_edit = only prices/dates/links/handles changed (never style). */
  kind: "accepted" | "fact_edit" | "style";
  editRatio: number;
  signals: StyleSignal[];
}

function signal(key: string, summary: string, before: string, after: string, strong: boolean, weight = 1, text?: string): StyleSignal {
  return { key, text: text ?? RULE_TEXT[key] ?? key, summary, weight, strong, before: cleanSpan(before, 100), after: cleanSpan(after, 100) };
}

function overlaps(a: string, b: string): boolean {
  return Boolean(a && b) && (a.includes(b) || b.includes(a));
}

/**
 * Deterministic edit signals between the draft the creator saw and what they
 * sent: opener/sign-off swaps, removed 2–8-word phrases and added recurring
 * phrases (never prices, dates, links or handles), length beyond 0.75×/1.33×,
 * emoji added/removed, a Hinglish shift ≥ 0.15, Devanagari appearing or
 * disappearing, capitalisation and exclamation habits. An edit that only
 * touches facts is a fact fix, not style. `measuredRatio` is the Draft's
 * stored editRatio (core editRatio, measured at send); passing it skips a
 * second Levenshtein, and a missing one (legacy rows) is measured here.
 */
export function analyzeEdit(draft: string, finalText: string, measuredRatio?: number | null): EditAnalysis {
  if (draft.trim() === finalText.trim()) return { kind: "accepted", editRatio: 0, signals: [] };
  const ratio = round(typeof measuredRatio === "number" && Number.isFinite(measuredRatio) ? measuredRatio : draftEditRatio(draft, finalText), 4);
  const hunks = wordDiff(draft, finalText);
  const changedSpans = hunks.flatMap((h) => [h.deleted, h.inserted]).filter(Boolean);
  if (changedSpans.length > 0 && changedSpans.every(isContentSpan)) return { kind: "fact_edit", editRatio: ratio, signals: [] };

  const signals: StyleSignal[] = [];
  const fullRewrite = ratio > 0.8;

  const g0 = greetingOf(draft);
  const g1 = greetingOf(finalText);
  const ng0 = normalizeForSim(g0);
  const ng1 = normalizeForSim(g1);
  if (ng0 !== ng1) {
    if (ng1) signals.push(signal(`greeting:${ng1}`, `You open with “${g1}”`, g0, g1, true, 1, `Open with “${g1}”`));
    else if (ng0) signals.push(signal("greeting:none", "You skip the greeting", g0, "", true));
  }
  const s0 = signoffOf(draft);
  const s1 = signoffOf(finalText);
  const ns0 = normalizeForSim(s0);
  const ns1 = normalizeForSim(s1);
  if (ns0 !== ns1 && (s0 || s1)) {
    if (s1) signals.push(signal(`signoff:${ns1 || s1}`, `You sign off with “${s1}”`, s0, s1, true, 1, `Sign off with “${s1}”`));
    else signals.push(signal("signoff:none", "You don't add a sign-off", s0, "", true));
  }

  if (!fullRewrite) {
    for (const hunk of hunks) {
      const removed = hunk.deleted.trim();
      const added = hunk.inserted.trim();
      const nr = normalizeForSim(removed);
      const na = normalizeForSim(added);
      let replaced = false;
      if (removed) {
        const n = wordCount(removed);
        if (n >= 2 && n <= 8 && !isContentSpan(removed) && !isStopwordsOnly(removed) && !overlaps(nr, ng0) && !overlaps(nr, ns0)) {
          const replacement = added && !isContentSpan(added) && wordCount(added) <= 8 && !overlaps(na, ng1) && !overlaps(na, ns1) ? cleanSpan(added) : "";
          replaced = Boolean(replacement);
          signals.push(
            signal(
              `avoid:${nr}`,
              replacement ? `You say “${replacement}” instead of “${cleanSpan(removed)}”` : `You cut “${cleanSpan(removed)}”`,
              removed,
              replacement,
              n >= 3 || replaced,
              1,
              replacement ? `Say “${replacement}” instead of “${cleanSpan(removed)}”` : `Don't say “${cleanSpan(removed)}”`
            )
          );
        }
      }
      if (added && !replaced) {
        const n = wordCount(added);
        if (n >= 1 && n <= 6 && !isContentSpan(added) && !isStopwordsOnly(added) && !overlaps(na, ng1) && !overlaps(na, ns1)) {
          signals.push(signal(`prefer:${na}`, `You add “${cleanSpan(added)}”`, removed, added, false, 1, `Use phrases like “${cleanSpan(added)}”`));
        }
      }
    }
  }

  const w0 = wordCount(draft);
  const w1 = wordCount(finalText);
  const lengthRatio = w1 / Math.max(1, w0);
  const bucket = lengthBucket(w1);
  if (lengthRatio < 0.75 || lengthRatio > 1.33) {
    signals.push(
      signal(
        bucket.key,
        lengthRatio < 1 ? `You keep it short (about ${w1} words)` : `You write a bit more (about ${w1} words)`,
        `${w0} words`,
        `${w1} words`,
        lengthRatio < 0.6 || lengthRatio > 1.66
      )
    );
  } else {
    signals.push(signal(bucket.key, `Your length was about right (${w1} words)`, `${w0} words`, `${w1} words`, false, 0.3));
  }

  const e0 = emojiCount(draft);
  const e1 = emojiCount(finalText);
  if (e0 !== e1) {
    const key = emojiKey(e1);
    signals.push(
      signal(key, e1 === 0 ? "You skip emojis" : e1 > e0 ? "You add emojis" : "You keep emojis light", `${e0} emoji`, `${e1} emoji`, e0 === 0 || e1 === 0)
    );
  }

  const shift = hindiShare(finalText) - hindiShare(draft);
  if (Math.abs(shift) >= 0.15) {
    signals.push(
      shift > 0
        ? signal("language:hinglish", "You mix in Hindi", "", "", true)
        : signal("language:english", "You keep it in English", "", "", true)
    );
  }
  if (hasDevanagari(finalText) !== hasDevanagari(draft)) {
    signals.push(
      hasDevanagari(finalText)
        ? signal("script:devanagari", "You write Hindi in Devanagari", "", "", true)
        : signal("script:roman", "You write Hindi in Roman letters", "", "", true)
    );
  }
  const c0 = startsLowercase(draft);
  const c1 = startsLowercase(finalText);
  if (c0 !== null && c1 !== null && c0 !== c1) {
    signals.push(c1 ? signal("casing:lowercase", "You start in lowercase", "", "", false) : signal("casing:capitalized", "You start with a capital letter", "", "", false));
  }
  const x0 = draft.match(/!/g)?.length ?? 0;
  const x1 = finalText.match(/!/g)?.length ?? 0;
  if (Math.abs(x1 - x0) >= 2) {
    signals.push(x1 > x0 ? signal("exclaim:more", "You use more exclamation marks", "", "", false) : signal("exclaim:fewer", "You go easy on exclamation marks", "", "", false));
  }
  return { kind: "style", editRatio: ratio, signals };
}

const HINT_PRIORITY = ["greeting", "signoff", "avoid", "language", "script", "emoji", "length"];

/**
 * The after-send hint ("Noted: you open with “Heyy”. Keep it?"): at most two
 * strong, clear observations from this one edit. The key matches the rule
 * the learner would build, so "Keep it" is POST /voice/rules with it.
 */
export function summarizeLearnedSignals(originalDraft: string, finalText: string): LearnedSignal[] {
  const analysis = analyzeEdit(originalDraft, finalText);
  if (analysis.kind !== "style") return [];
  const picked: LearnedSignal[] = [];
  const families = new Set<string>();
  const strong = analysis.signals
    .filter((s) => s.strong && s.weight >= 1 && HINT_PRIORITY.includes(ruleFamily(s.key)))
    .sort((a, b) => HINT_PRIORITY.indexOf(ruleFamily(a.key)) - HINT_PRIORITY.indexOf(ruleFamily(b.key)));
  for (const s of strong) {
    if (picked.length === 2) break;
    if (families.has(ruleFamily(s.key))) continue;
    families.add(ruleFamily(s.key));
    picked.push({ key: s.key, text: s.summary, scope: "all" });
  }
  return picked;
}

// ── Rule evidence, decay, promotion (§4.3) ─────────────────────────────────

export const RULE_HALF_LIFE_DAYS = 45;
const MAX_RULE_REFS = 20;
const MAX_RULES_PER_ACCOUNT = 200;

/** Exponential decay with a 45-day half-life from the last evidence. */
export function decayEvidence(value: number, lastAt: Date | null, now: Date): number {
  if (!lastAt || value === 0) return value;
  const days = Math.max(0, (now.getTime() - lastAt.getTime()) / 864e5);
  return value * Math.pow(0.5, days / RULE_HALF_LIFE_DAYS);
}

/** A before → after snippet, plus the draft/thread it came from (distinct-draft and -thread counting). */
export interface RuleExample {
  before: string;
  after: string;
  draftId?: string | null;
  threadId?: string | null;
}

/** A VoiceRule row as the pure learner sees it (schema.prisma VoiceRule). */
export interface VoiceRuleState {
  id?: string;
  key: string;
  text: string;
  scope: VoiceRuleScope;
  status: VoiceRuleStatus;
  source: VoiceRuleSource;
  evidence: number;
  against: number;
  distinctDrafts: number;
  distinctThreads: number;
  creatorEvidence: number;
  /** Newest first, ≤ 20 supporting refs; entries with text are the UI's examples. */
  examples: RuleExample[];
  lastEvidenceAt: Date | null;
  createdAt?: Date;
}

export interface RuleEvidence {
  key: string;
  text: string;
  scope: VoiceRuleScope;
  polarity: 1 | -1;
  weight: number;
  source: Exclude<VoiceRuleSource, "user">;
  draftId?: string | null;
  threadId?: string | null;
  /** Approving seat's role. Assistant/manager evidence counts half and can never activate a rule alone. */
  seatRole?: SeatRole | null;
  example?: { before: string; after: string };
}

export function applyRuleEvidence(rule: VoiceRuleState, ev: RuleEvidence, now: Date): VoiceRuleState {
  if (rule.status === "muted") return rule; // "Not me" is suppression, never resurrection
  const fromCreator = !ev.seatRole || ev.seatRole === "creator";
  const weight = ev.weight * (fromCreator ? 1 : 0.5);
  const support = ev.polarity > 0;
  const newDraft = support && Boolean(ev.draftId) && !rule.examples.some((e) => e.draftId === ev.draftId);
  const newThread = support && Boolean(ev.threadId) && !rule.examples.some((e) => e.threadId === ev.threadId);
  const examples =
    support && (ev.draftId || ev.example)
      ? [
          { before: cleanSpan(ev.example?.before ?? "", 120), after: cleanSpan(ev.example?.after ?? "", 120), draftId: ev.draftId ?? null, threadId: ev.threadId ?? null },
          ...rule.examples,
        ].slice(0, MAX_RULE_REFS)
      : rule.examples;
  const userOwned = rule.source === "user" || rule.status === "pinned";
  return {
    ...rule,
    text: support && !userOwned && ev.text ? ev.text : rule.text,
    evidence: round(decayEvidence(rule.evidence, rule.lastEvidenceAt, now) + (support ? weight : 0), 4),
    against: round(decayEvidence(rule.against, rule.lastEvidenceAt, now) + (support ? 0 : weight), 4),
    creatorEvidence: round(decayEvidence(rule.creatorEvidence, rule.lastEvidenceAt, now) + (support && fromCreator ? weight : 0), 4),
    distinctDrafts: rule.distinctDrafts + (newDraft ? 1 : 0),
    distinctThreads: rule.distinctThreads + (newThread ? 1 : 0),
    examples,
    lastEvidenceAt: now,
  };
}

/**
 * Deterministic promotion (research §4.3): a candidate activates with decayed
 * evidence ≥ 3 from ≥ 3 drafts (2 for chip feedback) in ≥ 2 threads, ≤ 25%
 * contradiction and some creator-seat evidence; an active rule fades back to
 * candidate below 1.5 evidence or when contradicted (≥ 2, > 40%). Pinned,
 * muted and user-authored rules never change by themselves.
 */
export function nextRuleStatus(rule: VoiceRuleState, now: Date): VoiceRuleStatus {
  if (rule.status === "pinned" || rule.status === "muted" || rule.source === "user") return rule.status;
  const support = decayEvidence(rule.evidence, rule.lastEvidenceAt, now);
  const against = decayEvidence(rule.against, rule.lastEvidenceAt, now);
  const contradiction = against / Math.max(1e-9, support + against);
  if (rule.status === "candidate") {
    const minDrafts = rule.source === "feedback" ? 2 : 3;
    const creatorBacked = decayEvidence(rule.creatorEvidence, rule.lastEvidenceAt, now) > 0;
    return support >= 3 && rule.distinctDrafts >= minDrafts && rule.distinctThreads >= 2 && contradiction <= 0.25 && creatorBacked
      ? "active"
      : "candidate";
  }
  return support < 1.5 || (against >= 2 && contradiction > 0.4) ? "candidate" : "active";
}

/** Did the sent text follow (1), break (-1) or not exercise (0) a rule? Used for rules that shaped the draft. */
export function checkRuleAgainstText(key: string, text: string): 1 | -1 | 0 {
  const value = ruleValue(key);
  switch (ruleFamily(key)) {
    case "avoid":
      return containsPhrase(text, value) ? -1 : 1;
    case "prefer":
      return containsPhrase(text, value) ? 1 : 0;
    case "greeting": {
      const greeting = normalizeForSim(greetingOf(text));
      if (value === "none") return greeting ? -1 : 1;
      return greeting === value ? 1 : greeting ? -1 : 0;
    }
    case "signoff": {
      const signoff = normalizeForSim(signoffOf(text)) || signoffOf(text);
      if (value === "none") return signoff ? -1 : 1;
      return signoff === value ? 1 : signoff ? -1 : 0;
    }
    case "length": {
      const index = LENGTH_BUCKETS.findIndex((b) => b.key === key);
      if (index === -1) return 0;
      const actual = LENGTH_BUCKETS.indexOf(lengthBucket(wordCount(text)));
      return actual === index ? 1 : Math.abs(actual - index) >= 2 ? -1 : 0;
    }
    case "emoji":
      return emojiKey(emojiCount(text)) === key ? 1 : -1;
    case "language": {
      if (wordCount(text) < 5) return 0;
      const share = hindiShare(text);
      if (value === "hinglish") return share >= 0.1 ? 1 : -1;
      return share < 0.1 ? 1 : -1;
    }
    case "script":
      if (hindiShare(text) === 0) return 0;
      return hasDevanagari(text) === (value === "devanagari") ? 1 : -1;
    case "casing": {
      const lower = startsLowercase(text);
      return lower === null ? 0 : lower === (value === "lowercase") ? 1 : -1;
    }
    case "exclaim": {
      const count = text.match(/!/g)?.length ?? 0;
      return value === "more" ? (count >= 2 ? 1 : count === 0 ? -1 : 0) : count <= 1 ? 1 : count >= 3 ? -1 : 0;
    }
    default:
      return 0;
  }
}

function slot(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

function newRuleState(input: { key: string; text: string; scope: VoiceRuleScope; source: VoiceRuleSource }): VoiceRuleState {
  return {
    key: input.key,
    text: input.text,
    scope: input.scope,
    status: "candidate",
    source: input.source,
    evidence: 0,
    against: 0,
    distinctDrafts: 0,
    distinctThreads: 0,
    creatorEvidence: 0,
    examples: [],
    lastEvidenceAt: null,
  };
}

export interface RulePlan {
  /** Rows to write (new rows have no id). */
  upserts: VoiceRuleState[];
  /** Ids of stale candidates to delete. */
  deletes: string[];
  /** Rules that became active in this plan ("DealDock noticed…"). */
  promoted: VoiceRuleState[];
}

export interface RulePlanContext {
  /** Rules that shaped the draft (generationContext) and the text actually sent. */
  appliedRuleIds?: readonly string[];
  finalText?: string;
  draftId?: string | null;
  threadId?: string | null;
  seatRole?: SeatRole | null;
}

/**
 * Apply one batch of evidence to the account's rules. Support for a habit
 * also reinforces its "all"-scope row and contradicts its alternatives (once
 * per draft); rules that shaped the draft are checked against what was sent
 * (kept → +0.3, broken → contradiction). Then the bookkeeping: ≥ 2 active
 * scopes generalise to "all", one active habit per exclusive family and scope
 * (pinned/user rules win), avoid-vs-prefer keeps the newer, stale candidates
 * are pruned.
 */
export function planRuleUpdates(
  existing: readonly VoiceRuleState[],
  evidence: readonly RuleEvidence[],
  now: Date,
  context: RulePlanContext = {}
): RulePlan {
  const rules = new Map(existing.map((rule) => [slot(rule.scope, rule.key), rule] as const));
  const statusBefore = new Map([...rules].map(([k, rule]) => [k, rule.status] as const));
  const changed = new Set<string>();
  const supported = new Set<string>();
  const contradicted = new Set<string>();
  const apply = (target: string, ev: RuleEvidence) => {
    const rule = rules.get(target);
    if (!rule || rule.status === "muted") return;
    rules.set(target, applyRuleEvidence(rule, ev, now));
    changed.add(target);
    if (ev.polarity > 0) supported.add(target);
  };

  for (const ev of evidence) {
    const target = slot(ev.scope, ev.key);
    if (!rules.has(target)) {
      if (ev.polarity < 0) continue; // a contradiction never creates a rule
      rules.set(target, newRuleState(ev));
    }
    apply(target, ev);
    if (ev.polarity < 0) continue;
    const broad = slot("all", ev.key);
    if (ev.scope !== "all" && rules.has(broad)) apply(broad, ev);
    for (const [k, rule] of [...rules]) {
      if ((rule.scope !== ev.scope && rule.scope !== "all") || !rulesConflict(rule.key, ev.key)) continue;
      const once = `${ev.draftId ?? ""}\u0000${k}`;
      if (contradicted.has(once)) continue;
      contradicted.add(once);
      apply(k, { ...ev, key: rule.key, text: rule.text, scope: rule.scope, polarity: -1, example: undefined });
    }
  }

  if (context.finalText !== undefined && context.appliedRuleIds?.length) {
    const assessed = new Set(changed);
    for (const id of context.appliedRuleIds) {
      const entry = [...rules].find(([, rule]) => rule.id === id);
      if (!entry || assessed.has(entry[0])) continue;
      const verdict = checkRuleAgainstText(entry[1].key, context.finalText);
      if (verdict === 0) continue;
      apply(entry[0], {
        key: entry[1].key,
        text: entry[1].text,
        scope: entry[1].scope,
        polarity: verdict,
        weight: verdict > 0 ? 0.3 : 1,
        source: "edits",
        draftId: context.draftId,
        threadId: context.threadId,
        seatRole: context.seatRole,
      });
    }
  }

  for (const k of changed) {
    const rule = rules.get(k)!;
    rules.set(k, { ...rule, status: nextRuleStatus(rule, now) });
  }
  return finishPlan(rules, changed, statusBefore, now, supported);
}

/** Rule seeds measured from the creator's own messages (cold start, research §4.1). */
export interface RuleSeed {
  key: string;
  text: string;
  scope: VoiceRuleScope;
  evidence: number;
  distinctDrafts: number;
  distinctThreads: number;
}

/**
 * Day-one rules: a greeting used in ≥ 40% of ≥ 8 messages (evidence 3×share),
 * a sign-off used in ≥ 30%, the typical length (evidence 3), emoji habits and a
 * Hinglish mix ≥ 15%. With fewer than 10 samples every seed but length is
 * capped at evidence 2, so it stays a candidate until an edit confirms it.
 */
export function seedRulesFromMeasured(measured: readonly MeasuredScopeStyle[], samples: readonly VoiceSample[]): RuleSeed[] {
  const textual = samples.filter((s) => !s.statsOnly);
  const cap = (value: number) => round(textual.length < 10 ? Math.min(2, value) : value, 4);
  const threads = (group: readonly VoiceSample[]) => new Set(group.map((s) => s.threadId)).size;
  const seeds: RuleSeed[] = [];
  for (const m of measured) {
    const group = textual.filter((s) => m.scope === "all" || s.scope === m.scope);
    const base = { scope: m.scope, distinctDrafts: group.length, distinctThreads: threads(group) };
    const opener = m.openers[0];
    if (opener && opener.share >= 0.4 && m.samples >= 8) {
      const key = normalizeForSim(opener.text);
      const support = group.filter((s) => normalizeForSim(greetingOf(s.text)) === key);
      seeds.push({ key: `greeting:${key}`, text: `Open with “${opener.text}”`, scope: m.scope, evidence: cap(3 * opener.share), distinctDrafts: support.length, distinctThreads: threads(support) });
    }
    const signoff = m.signoffs[0];
    if (signoff && signoff.share >= 0.3) {
      const key = normalizeForSim(signoff.text) || signoff.text;
      const support = group.filter((s) => (normalizeForSim(signoffOf(s.text)) || signoffOf(s.text)) === key);
      seeds.push({ key: `signoff:${key}`, text: `Sign off with “${signoff.text}”`, scope: m.scope, evidence: cap(3 * signoff.share), distinctDrafts: support.length, distinctThreads: threads(support) });
    }
    const bucket = lengthBucket(m.medianWords);
    seeds.push({ key: bucket.key, text: bucket.text, ...base, evidence: 3 });
    if (m.emojiRate < 0.1) seeds.push({ key: "emoji:none", text: RULE_TEXT["emoji:none"]!, ...base, evidence: cap(3) });
    else if (m.emojiRate > 0.8) seeds.push({ key: "emoji:light", text: RULE_TEXT["emoji:light"]!, ...base, evidence: cap(3) });
    if (m.hinglishIndex >= 0.15) seeds.push({ key: "language:hinglish", text: RULE_TEXT["language:hinglish"]!, ...base, evidence: cap(3) });
  }
  return seeds;
}

/** Re-measure "samples"-source rules; rules learned from edits, pinned, muted or user-authored are left alone. */
export function planSeedRules(existing: readonly VoiceRuleState[], seeds: readonly RuleSeed[], now: Date): RulePlan {
  const rules = new Map(existing.map((rule) => [slot(rule.scope, rule.key), rule] as const));
  const statusBefore = new Map([...rules].map(([k, rule]) => [k, rule.status] as const));
  const changed = new Set<string>();
  for (const seed of seeds) {
    const k = slot(seed.scope, seed.key);
    const current = rules.get(k);
    if (current && (current.source !== "samples" || current.status === "pinned" || current.status === "muted")) continue;
    const next: VoiceRuleState = {
      ...(current ?? newRuleState({ ...seed, source: "samples" })),
      text: seed.text,
      evidence: seed.evidence,
      against: current ? round(decayEvidence(current.against, current.lastEvidenceAt, now), 4) : 0,
      creatorEvidence: seed.evidence,
      distinctDrafts: seed.distinctDrafts,
      distinctThreads: seed.distinctThreads,
      lastEvidenceAt: now,
    };
    rules.set(k, { ...next, status: nextRuleStatus(next, now) });
    changed.add(k);
  }
  return finishPlan(rules, changed, statusBefore, now, new Set(changed));
}

function finishPlan(
  rules: Map<string, VoiceRuleState>,
  changed: Set<string>,
  statusBefore: Map<string, VoiceRuleStatus>,
  now: Date,
  supportedNow: ReadonlySet<string>
): RulePlan {
  const set = (k: string, rule: VoiceRuleState) => {
    rules.set(k, rule);
    changed.add(k);
  };
  const live = (rule: VoiceRuleState) => decayEvidence(rule.evidence, rule.lastEvidenceAt, now);
  const owned = (rule: VoiceRuleState) => rule.status === "pinned" || (rule.source === "user" && rule.status === "active");
  const auto = (rule: VoiceRuleState) => rule.status === "active" && rule.source !== "user";

  // 1. A learned habit active in ≥ 2 specific scopes applies everywhere ("all").
  //    Rules the creator wrote per scope stay exactly as they wrote them.
  const scopesByKey = new Map<string, VoiceRuleState[]>();
  for (const rule of rules.values()) {
    if (rule.scope === "all" || rule.source === "user" || (rule.status !== "active" && rule.status !== "pinned")) continue;
    scopesByKey.set(rule.key, [...(scopesByKey.get(rule.key) ?? []), rule]);
  }
  for (const [key, group] of scopesByKey) {
    if (group.length < 2) continue;
    const k = slot("all", key);
    const current = rules.get(k);
    if (current && current.status !== "candidate") continue;
    const first = group[0]!;
    const base = current ?? newRuleState({ key, text: first.text, scope: "all", source: first.source });
    set(k, {
      ...base,
      status: "active",
      evidence: round(Math.max(live(base), group.reduce((sum, r) => sum + live(r), 0)), 4),
      creatorEvidence: round(group.reduce((sum, r) => sum + decayEvidence(r.creatorEvidence, r.lastEvidenceAt, now), 0), 4),
      against: round(decayEvidence(base.against, base.lastEvidenceAt, now), 4),
      distinctDrafts: Math.max(base.distinctDrafts, group.reduce((sum, r) => sum + r.distinctDrafts, 0)),
      distinctThreads: Math.max(base.distinctThreads, group.reduce((sum, r) => sum + r.distinctThreads, 0)),
      examples: base.examples.length ? base.examples : group.flatMap((r) => r.examples).slice(0, MAX_RULE_REFS),
      lastEvidenceAt: now,
    });
  }

  // 2. One active habit per exclusive family and scope; a pinned or user rule always wins.
  const families = new Map<string, VoiceRuleState[]>();
  for (const rule of rules.values()) {
    const family = ruleFamily(rule.key);
    if (!EXCLUSIVE_FAMILIES.has(family) || !(owned(rule) || auto(rule))) continue;
    families.set(slot(rule.scope, family), [...(families.get(slot(rule.scope, family)) ?? []), rule]);
  }
  for (const group of families.values()) {
    const automatic = group.filter(auto).sort((a, b) => live(b) - live(a) || (b.lastEvidenceAt?.getTime() ?? 0) - (a.lastEvidenceAt?.getTime() ?? 0));
    const keep = group.some(owned) ? 0 : 1;
    for (const rule of automatic.slice(keep)) set(slot(rule.scope, rule.key), { ...rule, status: "candidate" });
  }

  // 3. Opposite habits (avoid X vs prefer X, formal vs casual): the newer support wins.
  for (const k of [...rules.keys()]) {
    const rule = rules.get(k)!;
    if (!auto(rule) || EXCLUSIVE_FAMILIES.has(ruleFamily(rule.key))) continue;
    for (const [otherSlot, other] of rules) {
      if (otherSlot === k || other.scope !== rule.scope || !auto(other) || !rulesConflict(rule.key, other.key)) continue;
      const fresh = supportedNow.has(k) !== supportedNow.has(otherSlot) ? (supportedNow.has(k) ? k : otherSlot) : null;
      const loser = fresh ? (fresh === k ? otherSlot : k) : (rule.lastEvidenceAt?.getTime() ?? 0) < (other.lastEvidenceAt?.getTime() ?? 0) ? k : otherSlot;
      set(loser, { ...rules.get(loser)!, status: "candidate" });
      break;
    }
  }

  // 4. Housekeeping: drop faded candidates older than 60 days; ≤ 200 rows per account.
  const deletes: string[] = [];
  const drop = (rule: VoiceRuleState) => {
    const k = slot(rule.scope, rule.key);
    rules.delete(k);
    changed.delete(k);
    if (rule.id) deletes.push(rule.id);
  };
  const prunable = (rule: VoiceRuleState) => rule.status === "candidate" && rule.source !== "user";
  for (const rule of [...rules.values()]) {
    if (prunable(rule) && live(rule) < 0.5 && rule.createdAt && now.getTime() - rule.createdAt.getTime() > 60 * 864e5) drop(rule);
  }
  if (rules.size > MAX_RULES_PER_ACCOUNT) {
    const weakest = [...rules.values()].filter(prunable).sort((a, b) => live(a) - live(b));
    for (const rule of weakest.slice(0, rules.size - MAX_RULES_PER_ACCOUNT)) drop(rule);
  }

  const upserts = [...changed].map((k) => rules.get(k)).filter((rule): rule is VoiceRuleState => Boolean(rule));
  return {
    upserts,
    deletes,
    promoted: upserts.filter((rule) => rule.status === "active" && statusBefore.get(slot(rule.scope, rule.key)) !== "active"),
  };
}

/** Evidence from one analysed send (scope = "nudge" for nudges, else the label the draft was written for). */
export function editEvidence(
  analysis: EditAnalysis,
  context: { scope: VoiceRuleScope; draftId: string; threadId: string; seatRole: SeatRole | null }
): RuleEvidence[] {
  if (analysis.kind !== "style") return [];
  return analysis.signals.map((s) => ({
    key: s.key,
    text: s.text,
    scope: context.scope,
    polarity: 1,
    weight: s.weight,
    source: "edits",
    draftId: context.draftId,
    threadId: context.threadId,
    seatRole: context.seatRole,
    example: { before: s.before, after: s.after },
  }));
}

// ── Steering chips & instructions (§4.6) ───────────────────────────────────

/** Typed as Record<DraftChip, …> so a chip added to the API contract fails to compile until it has an instruction. */
export const CHIP_INSTRUCTIONS: Readonly<Record<DraftChip, string>> = {
  shorter: "Make it noticeably shorter (about 60% of the usual length).",
  longer: "Make it a bit longer and more complete (about 1.5× the usual length).",
  warmer: "Make it warmer and more personal.",
  more_formal: "Make it a little more formal and polished, still in their voice.",
  more_casual: "Make it more casual, like a quick text.",
  more_hinglish: "Mix in more Hindi (Hinglish), the way they do.",
  more_english: "Write it in English only.",
  add_emoji: "Add an emoji or two where it feels natural.",
  no_emoji: "Don't use any emojis.",
  ask_budget: "Ask about their budget.",
  quote_rate: "Quote the creator's rate from their offers; if no rate is listed, ask about their budget instead of inventing one.",
  decline_politely: "Politely decline, keeping the door open for future work.",
  wrong_facts: "Do not state any price, date or availability that isn't in the thread or the creator's offers and business context.",
};

/** Every steering chip, for request validation: core's list, which a compile-time check keeps equal to DraftChip (the keys of CHIP_INSTRUCTIONS). */
export { DRAFT_CHIPS } from "@dealdock/core";

/** Chips + free text → the steering line of the task (chips first, the creator's note last). */
export function steeringText(chips: readonly DraftChip[] = [], instruction?: string | null): string {
  const parts = [...new Set(chips)].map((chip) => CHIP_INSTRUCTIONS[chip]);
  const note = instruction?.trim();
  if (note) parts.push(`Creator's note: "${note.slice(0, 200)}"`);
  return parts.join(" ");
}

/**
 * Chip feedback as rule evidence (weight 1.5, source "feedback"). Situational
 * chips (decline_politely) and wrong_facts — a quality signal, never style —
 * produce none.
 */
export function chipEvidence(
  chips: readonly DraftChip[],
  context: { scope: VoiceRuleScope; draftBody: string; draftId: string; threadId: string; seatRole: SeatRole | null }
): RuleEvidence[] {
  const words = wordCount(context.draftBody);
  const keyFor = (chip: DraftChip): string | null => {
    switch (chip) {
      case "shorter":
        return lengthBucket(Math.max(1, Math.round(words * 0.6))).key;
      case "longer":
        return lengthBucket(Math.round(words * 1.5)).key;
      case "warmer":
        return "tone:warm";
      case "more_formal":
        return "tone:formal";
      case "more_casual":
        return "tone:casual";
      case "more_hinglish":
        return "language:hinglish";
      case "more_english":
        return "language:english";
      case "add_emoji":
        return "emoji:light";
      case "no_emoji":
        return "emoji:none";
      case "ask_budget":
        return "posture:ask-budget";
      case "quote_rate":
        return "posture:quote-rate";
      default:
        return null;
    }
  };
  return [...new Set(chips)].flatMap((chip) => {
    const key = keyFor(chip);
    if (!key) return [];
    return [{ key, text: RULE_TEXT[key] ?? key, scope: context.scope, polarity: 1 as const, weight: 1.5, source: "feedback" as const, draftId: context.draftId, threadId: context.threadId, seatRole: context.seatRole }];
  });
}

// ── Post-generation rule check (§4.5 rule-lint) ────────────────────────────

export interface LintOptions {
  /** Phrases the draft must not contain: avoid rules + the generic AI-phrase list. */
  avoidPhrases: readonly string[];
  /** Target length; a draft over 1.6× is too long. */
  targetWords: number | null;
}

export function lintDraft(text: string, options: LintOptions): string[] {
  const violations: string[] = [];
  for (const phrase of options.avoidPhrases) {
    if (!containsPhrase(text, phrase)) continue;
    violations.push(phrase.trim() === "—" ? "Don't use em dashes (—)" : `Don't say “${phrase}”`);
  }
  if (/\[[^\]\n]{1,40}\]/.test(text)) violations.push("Remove placeholders like [price]; ask or say you'll confirm instead");
  if (options.targetWords && wordCount(text) > Math.ceil(options.targetWords * 1.6)) {
    violations.push(`Too long: keep it to about ${options.targetWords} words`);
  }
  return violations;
}

export function lintRetryInstruction(violations: readonly string[]): string {
  return `<fix>Rewrite every version so it follows these: ${violations.join("; ")}.</fix>`;
}

// ── Refresh (extraction) plan ──────────────────────────────────────────────

export interface VoiceRefreshPlan {
  samples: VoiceSample[];
  excluded: Partial<Record<SampleExclusion, number>>;
  /** Samples that count toward "not enough samples" (MIN_VOICE_SAMPLES). */
  eligibleCount: number;
  measured: MeasuredScopeStyle[];
  /** ≤ 40 texts for the descriptive (Claude) card. */
  extractionTexts: string[];
  sampleIds: string[];
  avoidPhrases: string[];
  seeds: RuleSeed[];
}

export function planVoiceRefresh(rows: readonly CorpusMessage[], excludedIds: Iterable<string> = []): VoiceRefreshPlan {
  const { samples, excluded } = selectVoiceSamples(rows, excludedIds);
  const textual = samples.filter((s) => !s.statsOnly);
  const measured = measureStyle(samples);
  return {
    samples,
    excluded,
    eligibleCount: textual.length,
    measured,
    extractionTexts: extractionSample(samples),
    sampleIds: textual.map((s) => s.messageId),
    avoidPhrases: genericAvoidList(samples),
    seeds: seedRulesFromMeasured(measured, samples),
  };
}

const CARD_KEYS = ["greeting", "tone", "sentenceLength", "signoff", "emojiUsage", "codeSwitching", "characteristicPhrases"] as const;

/** StyleCard v2 JSON: the descriptive keys + measured habits + the avoid list (backward compatible with v1 readers). */
export function composeStyleCard(extracted: Record<string, unknown>, plan: VoiceRefreshPlan, now: Date): Record<string, unknown> {
  const card: Record<string, unknown> = {};
  for (const key of CARD_KEYS) if (extracted[key] !== undefined) card[key] = extracted[key];
  return {
    ...card,
    avoidPhrases: plan.avoidPhrases,
    v: 2,
    measured: plan.measured,
    sampleCount: plan.eligibleCount,
    excludedCounts: plan.excluded,
    computedAt: now.toISOString(),
  };
}
