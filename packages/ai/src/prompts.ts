import {
  ClassificationLabel,
  CURRENCY_CODES,
  dealTypeForLabel,
  formatMoneyCompact,
  formatMoneyRange,
  MinorUnits,
  type CurrencyCode,
  type DraftContextSummary,
  type MoneyContext,
  type StyleCard,
  type VoiceRuleScope,
} from "@dealdock/core";
import type { CreatorContext, DraftInput, DraftThreadMessage, MeasuredStyleInput, OfferContext, VoiceRuleContext } from "./types";
import { AI_TELLS, languageOf, type TextLanguage } from "./style-text";
import { draftScope, LENGTH_BUCKETS, ruleFamily, scopeRank, steeringText, type LintOptions } from "./style-learning";

/**
 * Prompt builders. PROMPT_VERSION stamps every Classification/Draft row so
 * accuracy metrics are computed per version (ARCHITECTURE.md §5.2) — bump it
 * on ANY change to this file; CI runs evals on prompt changes (M2).
 */
export const PROMPT_VERSION = "2.0.1-voice";

export const CLASSIFY_TOOL = {
  name: "classify_message",
  description: "Record the classification of an Instagram DM received by a creator.",
  input_schema: {
    type: "object" as const,
    properties: {
      label: {
        type: "string",
        enum: [
          "brand_deal",
          "coaching_lead",
          "course_inquiry",
          "other_commerce",
          "fan",
          "spam",
          "personal",
          "uncertain",
        ],
        description: "The single best classification for this message.",
      },
      confidence: {
        type: "number",
        description: "0-1. Below 0.8 routes to human review — be honest, not optimistic.",
      },
      language: {
        type: "string",
        enum: ["en", "hi", "hinglish", "mixed"],
      },
      value_min_major: {
        type: ["number", "null"],
        description:
          "For commerce labels only: conservative low estimate of deal value in the creator's currency (major units). Null for fan/spam/personal/uncertain.",
      },
      value_max_major: {
        type: ["number", "null"],
        description: "For commerce labels only: optimistic high estimate. Null otherwise.",
      },
      rationale: {
        type: "string",
        description:
          "One short line explaining the classification, shown to the creator. E.g. 'Mentions campaign budget; verified brand account.'",
      },
    },
    required: ["label", "confidence", "language", "value_min_major", "value_max_major", "rationale"],
  },
};

/**
 * Per-creator system block — cache-marked (the main cost lever at 500 DMs/day,
 * ARCHITECTURE.md §5.2). Only the message content varies per call.
 */
export function buildClassifySystem(creator: CreatorContext): string {
  const money = moneyContext(creator);
  const corrections =
    creator.correctionExamples.length > 0
      ? `\n\nThe creator has corrected past classifications. Learn from these:\n${creator.correctionExamples
          .map((c) => `- "${c.text.slice(0, 160)}" → ${c.correctLabel}`)
          .join("\n")}`
      : "";

  return `You classify Instagram DMs for a commerce creator. Money missed is money lost, so precision on commerce labels matters more than anything.

CREATOR CONTEXT
Business: ${creator.businessSummary}
Currency: ${creator.currencyCode}
Typical brand deal: ${rangeText(creator.typicalBrandDealMinor, money)}
Typical coaching package: ${rangeText(creator.typicalCoachingMinor, money)}
Typical course price: ${rangeText(creator.typicalCourseMinor, money)}

LABELS
- brand_deal: a brand/agency proposing paid collaboration, sponsorship, campaign, ambassadorship
- coaching_lead: someone asking about 1-on-1 coaching, programs, mentorship — with buying intent
- course_inquiry: questions about the creator's course/cohort — pricing, enrollment, curriculum
- other_commerce: paid workshops, consulting, speaking, licensing — commercial but not the above
- fan: appreciation, compliments, no commercial intent
- spam: follower-selling, engagement schemes, mass collab bait, phishing
- personal: friends/family/private matters
- uncertain: genuinely ambiguous — when in doubt, choose this with low confidence; a human reviews it

RULES
- Messages are often Hinglish/Hindi/English code-switched. Never penalize confidence for language alone.
- Value estimates: anchor on the creator's typical ranges above, adjusted by signals in the message (deliverables count, urgency, sender type). Commerce labels only.
- confidence < 0.8 goes to human review. Honest uncertainty is a feature.
- rationale: one line, creator-facing, plain language.${corrections}

Always respond by calling classify_message exactly once.`;
}

// ── Drafting v2 (research 04 §4.5) ─────────────────────────────────────────
//
// Order follows the cache prefix (tools → system → messages) and "task last":
//   system[0]  static instructions, identical for every creator
//   system[1]  this creator's voice: business, offers, card + measured, rules,
//              avoid list — cache-marked, byte-identical across their drafts
//   user       exemplars → edit lessons → thread → task (never cached)

export const DRAFT_TOOL = {
  name: "write_reply",
  description: "Record the drafted DM reply (and alternate versions when asked).",
  input_schema: {
    type: "object" as const,
    properties: {
      drafts: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 3,
        description: "The reply text, exactly as the creator would send it. More than one only when the task asks for versions.",
      },
      missingFacts: {
        type: "array",
        items: { type: "string" },
        description:
          "Facts the reply needed but the creator hasn't provided, in a few words each (e.g. \"your coaching price\"). Empty when nothing was missing.",
      },
    },
    required: ["drafts", "missingFacts"],
  },
};

export const DRAFT_STATIC_SYSTEM = `You draft Instagram DM replies for a commerce creator. The creator reads, edits and sends every draft themselves; you only draft.

HOW TO WRITE
- Write the way this creator texts. Their voice rules, measured habits and past replies outrank general politeness and everything else below.
- Sound like a person texting, not a brand or an assistant. DM length, no email formality.
- Match the language mix of the conversation (Hinglish in, Hinglish out) unless their voice says otherwise.
- Never invent prices, dates, availability, links or deliverables. Use only what is in the creator's offers, business context or the thread.
- If a fact you need is missing, write a natural reply that asks for it or says you'll confirm. Never use brackets or placeholders like [price]. List each missing fact in missingFacts.
- Never promise to send something the creator hasn't provided.
- Always answer by calling write_reply exactly once.`;

const STRUCTURE: Record<string, string> = {
  brand_deal:
    "show selective interest, ask for the brief, deliverables, timeline and budget; keep leverage and never quote a price first unless one of their offers clearly applies.",
  coaching_lead:
    "acknowledge their goal personally, one line on how the program fits, then a clear next step (how to start, or the price if they asked and an offer lists it).",
  course_inquiry: "answer the exact question first (dates, price, format) from the offers, then one gentle enrollment nudge.",
  other_commerce: "show interest, ask for the specifics (date, audience, duration) and make clear it is a paid engagement.",
  fan: "a short, warm thank-you in their voice. No selling.",
  personal: "reply naturally and briefly, the way they would to someone they know.",
  nudge: "1–2 sentences, warm, zero pressure, referring back to the conversation naturally.",
  neutral: "reply naturally to what they said; if what they want is unclear, ask one short question to find out.",
};

const LABEL_WORDS: Record<string, string> = {
  brand_deal: "brand deal",
  coaching_lead: "coaching lead",
  course_inquiry: "course question",
  other_commerce: "paid work request",
  fan: "fan message",
  personal: "personal message",
  spam: "unclear message",
  uncertain: "unclear message",
};

const SENTENCE_LENGTH_WORDS: Record<StyleCard["sentenceLength"], number> = { short: 20, medium: 40, long: 70 };
const MAX_PROMPT_RULES = 12;
const MAX_PROMPT_OFFERS = 12;
const THREAD_MESSAGES = 12;
const THREAD_CHAR_BUDGET = 4_800; // ≈ 1,200 tokens at 4 chars/token

export interface DraftPrompt {
  /** [static, creator voice]; only the second carries cache_control. */
  system: [string, string];
  user: string;
  scope: VoiceRuleScope;
  targetWords: number;
  language: TextLanguage;
  variants: number;
  /** Post-generation rule check inputs (avoid rules + generic AI phrases, length). */
  lint: LintOptions;
  /** What the prompt was built from; missingFacts is filled in from the model's answer. */
  context: DraftContextSummary;
}

/** Strip tag-like brackets so DM text can never close the prompt's XML sections. */
function quoteDm(text: string, max: number): string {
  const clean = text.replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›")).trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function messageText(message: DraftThreadMessage): string {
  if (message.contentType === "audio") return message.transcript?.trim() || "(voice note, not transcribed)";
  return message.text.trim() || message.transcript?.trim() || "(attachment)";
}

function moneyContext(creator: CreatorContext): MoneyContext | null {
  const currency = creator.currencyCode as CurrencyCode;
  return (CURRENCY_CODES as readonly string[]).includes(currency) ? { currency, locale: creator.locale } : null;
}

export function offerPrice(offer: Pick<OfferContext, "priceMinMinor" | "priceMaxMinor">, money: MoneyContext | null): string | null {
  if (!money) return null;
  const { priceMinMinor: min, priceMaxMinor: max } = offer;
  if (min !== null && max !== null) return min === max ? formatMoneyCompact(min, money) : formatMoneyRange(min, max, money);
  if (min !== null) return `from ${formatMoneyCompact(min, money)}`;
  if (max !== null) return `up to ${formatMoneyCompact(max, money)}`;
  return null;
}

/** Extracted card with the creator's hand edits on top. */
export function mergedStyleCard(creator: CreatorContext): Partial<StyleCard> {
  return { ...((creator.styleCard ?? {}) as Partial<StyleCard>), ...(creator.styleOverrides ?? {}) };
}

/** ≤ 12 rules for the cached block: pinned, then the creator's own, then by evidence. An "all" rule covers the same key elsewhere. */
export function promptRules(rules: readonly VoiceRuleContext[]): VoiceRuleContext[] {
  const broad = new Set(rules.filter((r) => r.scope === "all").map((r) => r.key));
  const rank = (r: VoiceRuleContext) => (r.status === "pinned" ? 0 : r.source === "user" ? 1 : 2);
  return rules
    .filter((r) => r.scope === "all" || !broad.has(r.key))
    .sort((a, b) => rank(a) - rank(b) || b.evidence - a.evidence || scopeRank(a.scope) - scopeRank(b.scope) || a.key.localeCompare(b.key))
    .slice(0, MAX_PROMPT_RULES);
}

/** Built-in AI tells minus those the creator genuinely uses (card) or asks for (prefer rules), or that they toggled off. */
export function genericAvoidPhrases(creator: CreatorContext): string[] {
  const card = mergedStyleCard(creator);
  const preferred = new Set((creator.voiceRules ?? []).filter((r) => ruleFamily(r.key) === "prefer").map((r) => r.key.slice("prefer:".length)));
  const list = Array.isArray(card.avoidPhrases) ? card.avoidPhrases.filter((p): p is string => typeof p === "string") : [...AI_TELLS];
  return list.filter((phrase) => !preferred.has(phrase.toLowerCase()));
}

function measuredLine(m: MeasuredStyleInput): string {
  const parts = [`~${Math.round(m.avgWords)} words`, `${m.emojiRate} emoji per message`];
  if (m.hinglishIndex >= 0.05) parts.push(`~${Math.round(m.hinglishIndex * 100)}% Hindi words`);
  if ((m.devanagariRate ?? 0) >= 0.2) parts.push("often writes Hindi in Devanagari");
  if ((m.lowercaseStartRate ?? 0) >= 0.6) parts.push("usually starts in lowercase");
  if (m.topOpeners[0]) parts.push(`often opens “${m.topOpeners[0]}”`);
  if (m.topSignoffs[0]) parts.push(`signs off “${m.topSignoffs[0]}”`);
  return `- ${m.scope}: ${parts.join(", ")}`;
}

/** The per-creator system block. Depends only on the creator, never on this thread (cache stability). */
export function buildVoiceSystem(creator: CreatorContext): string {
  const money = moneyContext(creator);
  const offers = (creator.offers ?? []).slice(0, MAX_PROMPT_OFFERS);
  const offerLines = offers.map((o) => {
    const facts = [offerPrice(o, money), o.availability && `availability: ${o.availability}`, o.link && `link: ${o.link}`, o.details && `details: ${o.details}`];
    return `- ${o.name} (${o.dealType})${facts.some(Boolean) ? `: ${facts.filter(Boolean).join(" · ")}` : ""}`;
  });
  const card = mergedStyleCard(creator);
  const cardLines = [
    card.greeting && `Opens with: ${card.greeting}`,
    card.tone && `Tone: ${card.tone}`,
    card.sentenceLength && `Reply length: ${card.sentenceLength}`,
    card.signoff && `Signs off: ${card.signoff}`,
    card.emojiUsage && `Emoji: ${card.emojiUsage}`,
    card.codeSwitching && `Language: ${card.codeSwitching}`,
    Array.isArray(card.characteristicPhrases) && card.characteristicPhrases.length > 0 &&
      `Phrases they use: ${card.characteristicPhrases.slice(0, 5).map((p) => `“${p}”`).join(", ")}`,
  ].filter(Boolean);
  const measured = [...(creator.measured ?? [])].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope)).slice(0, 6);
  const rules = promptRules(creator.voiceRules ?? []);
  const avoid = genericAvoidPhrases(creator);

  return [
    "<creator>",
    `Business: ${creator.businessSummary}`,
    `Currency: ${creator.currencyCode}`,
    `Typical brand deal: ${rangeText(creator.typicalBrandDealMinor, money)}`,
    `Typical coaching: ${rangeText(creator.typicalCoachingMinor, money)}`,
    `Typical course: ${rangeText(creator.typicalCourseMinor, money)}`,
    "</creator>",
    "<offers>",
    ...(offerLines.length ? offerLines : ["None listed. Never quote a price: ask about their budget or say you'll confirm."]),
    "</offers>",
    "<voice_profile>",
    ...(cardLines.length ? cardLines : ["No style card yet: write warm, concise and casual; light Hinglish only if they write Hinglish."]),
    ...(measured.length ? ["Measured from their own messages:", ...measured.map(measuredLine)] : []),
    "</voice_profile>",
    "<voice_rules>",
    ...(rules.length ? rules.map((r) => `- [${r.scope}] ${r.text}${r.status === "pinned" ? " (pinned)" : ""}`) : ["None yet."]),
    "</voice_rules>",
    "<avoid_generic>",
    avoid.length
      ? `Skip stock assistant phrasing such as ${avoid.map((p) => (p === "—" ? "em dashes (—)" : `“${p}”`)).join(", ")}; use their own openers and wording instead.`
      : "None.",
    "</avoid_generic>",
  ].join("\n");
}

function scopeRules(creator: CreatorContext, scope: VoiceRuleScope): VoiceRuleContext[] {
  return (creator.voiceRules ?? []).filter((r) => r.scope === scope || r.scope === "all");
}

/** Overrides → length rule (specific scope first) → measured median → a sensible default; chips scale it. */
export function draftTargetWords(input: DraftInput, scope: VoiceRuleScope): number {
  const card = mergedStyleCard(input.creator);
  const lengthRule = scopeRules(input.creator, scope)
    .filter((r) => ruleFamily(r.key) === "length")
    .sort((a, b) => (a.scope === "all" ? 1 : 0) - (b.scope === "all" ? 1 : 0))[0];
  const measured = input.creator.measured?.find((m) => m.scope === scope) ?? input.creator.measured?.find((m) => m.scope === "all");
  const override = input.creator.styleOverrides?.sentenceLength;
  let target =
    (override && SENTENCE_LENGTH_WORDS[override]) ||
    LENGTH_BUCKETS.find((b) => b.key === lengthRule?.key)?.target ||
    Math.round(measured?.medianWords ?? measured?.avgWords ?? 0) ||
    (card.sentenceLength && SENTENCE_LENGTH_WORDS[card.sentenceLength]) ||
    (scope === "nudge" ? 20 : 40);
  const chips = new Set(input.chips ?? []);
  if (chips.has("shorter")) target = Math.max(5, Math.round(target * 0.6));
  if (chips.has("longer")) target = Math.round(target * 1.5);
  return Math.max(5, target);
}

function languageLine(input: DraftInput, scope: VoiceRuleScope, language: TextLanguage): string {
  const measured = input.creator.measured?.find((m) => m.scope === scope) ?? input.creator.measured?.find((m) => m.scope === "all");
  const usual = measured && measured.hinglishIndex >= 0.05 ? Math.round(measured.hinglishIndex * 100) : null;
  const preference = mergedStyleCard(input.creator).codeSwitching;
  const base =
    language === "hinglish"
      ? `The latest message is Hinglish: reply in Hinglish${usual ? ` (they usually use about ${usual}% Hindi words)` : ""}.`
      : language === "hi"
        ? "The latest message is in Hindi: reply in Hindi or Hinglish, the way they usually do."
        : usual && usual >= 15
          ? `The latest message is in English. They often mix in Hindi (about ${usual}% of words); keep that only if it feels natural.`
          : "Reply in English.";
  return preference ? `${base} Their language preference: ${preference}.` : base;
}

/** Assemble the full v2 draft prompt. Pure: the heuristic pipeline uses it too, for the same targets and context. */
export function buildDraftPrompt(input: DraftInput): DraftPrompt {
  const creator = input.creator;
  const label = ClassificationLabel.safeParse(input.classificationLabel).data ?? null;
  const scope = draftScope({ kind: input.kind, label });
  const variants = Math.min(3, Math.max(1, Math.round(input.variants ?? 1)));
  const latestInbound = [...input.threadHistory].reverse().find((m) => m.direction === "inbound");
  const inboundText = latestInbound ? messageText(latestInbound) : "";
  const language = languageOf(inboundText);
  const targetWords = draftTargetWords(input, scope);
  const exemplars = (input.exemplars ?? []).slice(-5);
  const lessons = (input.lessons ?? []).slice(0, 2);
  const rules = promptRules(creator.voiceRules ?? []);
  const offers = (creator.offers ?? []).slice(0, MAX_PROMPT_OFFERS);

  const thread = input.threadHistory
    .slice(-THREAD_MESSAGES)
    .map((m) => `${m.direction === "inbound" ? "THEM" : "CREATOR"}${m.contentType === "audio" ? " (voice note)" : ""}: ${quoteDm(messageText(m), 500)}`);
  while (thread.length > 1 && thread.join("\n").length > THREAD_CHAR_BUDGET) thread.shift(); // drop oldest first

  const steering = steeringText(input.chips ?? [], input.instruction);
  const structureKey = scope === "nudge" ? "nudge" : label && STRUCTURE[label] ? label : "neutral";
  const task = [
    "<task>",
    scope === "nudge"
      ? "Draft a short follow-up nudge: they have gone quiet since the creator's last message."
      : `Draft the creator's reply to the latest message from THEM${label ? ` (type: ${LABEL_WORDS[label] ?? label})` : ""}.`,
    `Structure: ${STRUCTURE[structureKey]}`,
    `Length: about ${targetWords} words.`,
    `Language: ${languageLine(input, scope, language)}`,
    `Apply the [${scope}]${scope === "all" ? "" : " and [all]"} voice rules.`,
    ...(steering ? [`Steering for this draft: ${steering}`] : []),
    variants > 1
      ? `Write ${variants} clearly different versions in drafts, the one closest to their usual voice first.`
      : "Write exactly one version in drafts.",
    "</task>",
  ].join("\n");

  const user = [
    exemplars.length
      ? [
          "<examples>",
          ...exemplars.map((e) =>
            [
              `<example type="${e.label ?? "reply"}">`,
              ...(e.inboundText ? [`<them>${quoteDm(e.inboundText, 200)}</them>`] : []),
              `<creator>${quoteDm(e.text, 400)}</creator>`,
              "</example>",
            ].join("\n")
          ),
          "</examples>",
        ].join("\n")
      : "",
    lessons.length ? ["<edit_lessons>", ...lessons.map((l) => `- ${l}`), "</edit_lessons>"].join("\n") : "",
    ["<thread>", ...(thread.length ? thread : ["(no messages yet)"]), "</thread>"].join("\n"),
    task,
  ]
    .filter(Boolean)
    .join("\n\n");

  const avoidRules = scopeRules(creator, scope)
    .filter((r) => ruleFamily(r.key) === "avoid")
    .map((r) => r.key.slice("avoid:".length));

  return {
    system: [DRAFT_STATIC_SYSTEM, buildVoiceSystem(creator)],
    user,
    scope,
    targetWords,
    language,
    variants,
    lint: { avoidPhrases: [...new Set([...avoidRules, ...genericAvoidPhrases(creator)])], targetWords },
    context: {
      rules: rules.map((r) => ({ id: r.id, text: r.text })),
      exemplars: exemplars.map((e) => ({ messageId: e.messageId, text: e.text, inboundText: e.inboundText })),
      offers: offers.map((o) => ({ id: o.id, name: o.name })),
      lessons,
      missingFacts: [],
    },
  };
}

/** Validate the model's write_reply call: trimmed, distinct, ≤ variants drafts; ≤ 3 short missing facts. */
export function parseDraftToolInput(raw: unknown, variants: number): { drafts: string[]; missingFacts: string[] } {
  const input = (raw ?? {}) as { drafts?: unknown; missingFacts?: unknown };
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const drafts = [...new Set(strings(input.drafts).map((d) => d.trim()).filter(Boolean))].slice(0, variants);
  if (drafts.length === 0) throw new Error("drafting: empty model response");
  const missingFacts = [...new Set(strings(input.missingFacts).map((f) => f.trim().slice(0, 120)).filter(Boolean))].slice(0, 3);
  return { drafts, missingFacts };
}

/** Missing facts the reply type needs and the offers don't cover (deterministic; the heuristic pipeline's answer). */
export function missingOfferFacts(scope: VoiceRuleScope, offers: readonly OfferContext[], quoteRequested: boolean): string[] {
  const priced = (dealType: OfferContext["dealType"]) =>
    offers.some((o) => o.dealType === dealType && (o.priceMinMinor !== null || o.priceMaxMinor !== null));
  if (scope === "coaching_lead" && !priced("coaching")) return ["your coaching price"];
  if (scope === "course_inquiry" && !offers.some((o) => o.dealType === "course" && (o.availability || o.priceMinMinor !== null || o.priceMaxMinor !== null))) {
    return ["your course price and next batch dates"];
  }
  if (quoteRequested && scope === "brand_deal" && !priced("brand")) return ["your brand collaboration rate"];
  return [];
}

/** Which deal type an offer must have to answer a reply of this scope. */
export function offerDealTypeFor(scope: VoiceRuleScope): OfferContext["dealType"] | null {
  return dealTypeForLabel(scope);
}

/** The creator's measured Hindi-word share for a scope (falls back to "all"; 0 when unmeasured). */
export function usualHindiShare(creator: CreatorContext, scope: VoiceRuleScope): number {
  const measured = creator.measured?.find((m) => m.scope === scope) ?? creator.measured?.find((m) => m.scope === "all");
  return measured?.hinglishIndex ?? 0;
}

/**
 * A typical-price range as both system blocks show it: the core money
 * formatter in the creator's locale, like offer prices. The ranges come from
 * free-form onboarding JSON, so anything that isn't whole minor units reads as
 * "not provided" instead of throwing inside classification.
 */
function rangeText(range: { min: number; max: number } | null, money: MoneyContext | null): string {
  if (!range || !money || !MinorUnits.safeParse(range.min).success || !MinorUnits.safeParse(range.max).success) return "not provided";
  return formatMoneyRange(range.min, range.max, money);
}
