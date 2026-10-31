import {
  ClassificationResult,
  CURRENCY_CODES,
  HIGH_INTENT_LABELS,
  type ClassificationLabel,
  type CurrencyCode,
  type MessageLanguage,
} from "@dealdock/core";
import type { AiPipeline, ClassifyInput, DraftInput, DraftResult } from "./types";
import {
  buildDraftPrompt,
  mergedStyleCard,
  missingOfferFacts,
  offerDealTypeFor,
  offerPrice,
  PROMPT_VERSION,
  usualHindiShare,
} from "./prompts";
import { lintDraft, quotedValue, ruleFamily } from "./style-learning";
import { emojiCount, greetingOf, wordCount } from "./style-text";

export const HEURISTIC_MODEL_VERSION = "heuristic-fallback-1";

/**
 * Deterministic keyword pipeline used when ANTHROPIC_API_KEY is absent
 * (local dev, CI, demos) and in unit tests. Honest about what it is:
 * every row it writes is stamped `heuristic-fallback-1` so no heuristic
 * output ever pollutes real accuracy metrics.
 */
export class HeuristicPipeline implements AiPipeline {
  async classify(input: ClassifyInput): Promise<ClassificationResult> {
    if (input.isIgnoredHandle) throw new Error("classification is blocked for an ignored handle");
    const text = input.messageText.toLowerCase();
    const { label, confidence, rationale } = matchLabel(text, input.senderHandle);
    const language = detectLanguage(input.messageText);

    const isCommerce = (HIGH_INTENT_LABELS as readonly string[]).includes(label);
    const range = isCommerce ? valueRangeFor(label, input) : null;

    return ClassificationResult.parse({
      label,
      confidence,
      language,
      valueRange: range,
      rationale,
      modelVersion: HEURISTIC_MODEL_VERSION,
      promptVersion: PROMPT_VERSION,
    });
  }

  /**
   * Deterministic mirror of the v2 prompt so demo/local mode exercises the
   * learning loop: the same targets and "Why this draft" context, the
   * creator's rules first (greeting, sign-off, emoji, language, casing,
   * avoid-phrases, length), then Voice Studio edits, the closest exemplar's
   * opener and the card; chips steer it; no stock AI phrasing.
   */
  async draft(input: DraftInput): Promise<DraftResult> {
    if (input.isIgnoredHandle) throw new Error("drafting is blocked for an ignored handle");
    if (input.voiceConsent === false) {
      throw new Error("drafting is blocked because voice-model consent is disabled");
    }
    const prompt = buildDraftPrompt(input);
    const chips = new Set(input.chips ?? []);
    const creator = input.creator;
    const rules = (creator.voiceRules ?? []).filter((r) => r.scope === prompt.scope || r.scope === "all");
    const has = (key: string) => rules.some((r) => r.key === key);
    const ruleFor = (family: string) =>
      rules.filter((r) => ruleFamily(r.key) === family).sort((a, b) => (a.scope === "all" ? 1 : 0) - (b.scope === "all" ? 1 : 0))[0];
    const card = mergedStyleCard(creator);
    const measured = creator.measured?.find((m) => m.scope === prompt.scope) ?? creator.measured?.find((m) => m.scope === "all");

    const hinglish =
      chips.has("more_hinglish") ||
      (!chips.has("more_english") &&
        !has("language:english") &&
        (has("language:hinglish") || (prompt.language !== "en" && (usualHindiShare(creator, prompt.scope) >= 0.15 || !measured))));

    const greetingRule = ruleFor("greeting");
    const exemplar = input.exemplars?.[input.exemplars.length - 1];
    let greeting: string;
    if (chips.has("more_formal")) greeting = "Hello,";
    else if (greetingRule) greeting = greetingRule.key === "greeting:none" ? "" : (quotedValue(greetingRule.text) ?? "");
    else greeting = creator.styleOverrides?.greeting || (exemplar ? greetingOf(exemplar.text) : "") || card.greeting || measured?.topOpeners[0] || "Hey!";

    const signoffRule = ruleFor("signoff");
    const signoff = signoffRule
      ? signoffRule.key === "signoff:none"
        ? ""
        : (quotedValue(signoffRule.text) ?? "")
      : creator.styleOverrides?.signoff ?? card.signoff ?? measured?.topSignoffs[0] ?? "";

    const structure = prompt.scope === "nudge" ? "nudge" : (TEMPLATES.en[prompt.scope] ? prompt.scope : "neutral");
    const missingFacts = missingOfferFacts(prompt.scope, creator.offers ?? [], chips.has("quote_rate"));
    const compose = (useHinglish: boolean, shorter: boolean) => {
      const language = useHinglish ? "hi" : "en";
      let body = chips.has("decline_politely") ? DECLINE[language] : TEMPLATES[language][structure]!;
      if (chips.has("warmer")) body = `${useHinglish ? "Aww, love this!" : "Love this!"} ${body}`;
      if (chips.has("quote_rate")) {
        const dealType = offerDealTypeFor(prompt.scope);
        const offer = (creator.offers ?? []).find((o) => o.dealType === dealType && offerPrice(o, money(creator)));
        body += offer ? ` My rate for ${offer.name} is ${offerPrice(offer, money(creator))}.` : ` ${BUDGET[language]}`;
      } else if (chips.has("ask_budget") && !/budget/i.test(body)) {
        body += ` ${BUDGET[language]}`;
      }
      if (chips.has("longer")) body += ` ${CALL[language]}`;
      const limit = shorter || chips.has("shorter") ? Math.min(prompt.targetWords, Math.round(wordCount(body) * 0.6)) : prompt.targetWords;
      body = fitWords(body, limit);
      let text = `${greeting ? `${greeting} ` : ""}${body}${signoff ? `\n${signoff}` : ""}`;
      for (const phrase of prompt.lint.avoidPhrases) text = removePhrase(text, phrase);
      if (chips.has("no_emoji") || chips.has("more_formal") || (has("emoji:none") && !chips.has("add_emoji"))) {
        text = text.replace(/\p{Extended_Pictographic}️?/gu, "").replace(/[ \t]{2,}/g, " ").trim();
      } else if ((chips.has("add_emoji") || has("emoji:light") || has("emoji:heavy")) && emojiCount(text) === 0) {
        text = signoff ? text.replace(/\n(?=[^\n]*$)/, " 🙌\n") : `${text} 🙌`;
      }
      if (chips.has("more_casual") || has("casing:lowercase")) text = text.charAt(0).toLowerCase() + text.slice(1);
      return text.trim();
    };

    const body = compose(hinglish, false);
    const alternatives =
      prompt.variants > 1 ? [...new Set([body, compose(hinglish, true), compose(!hinglish, false)])].slice(0, prompt.variants) : [];
    return {
      body,
      alternatives,
      context: { ...prompt.context, missingFacts },
      lintViolations: lintDraft(body, prompt.lint),
      modelVersion: HEURISTIC_MODEL_VERSION,
      promptVersion: PROMPT_VERSION,
    };
  }
}

const TEMPLATES: Record<"en" | "hi", Record<string, string>> = {
  en: {
    brand_deal: "This sounds interesting. Could you share the brief with deliverables, timeline and budget range? I'll take a look and get back to you quickly.",
    coaching_lead: "Love that you're serious about this. My program is built exactly for where you are. Happy to share how it works and what it costs. Want me to send the details?",
    course_inquiry: "Yes! Enrollment details coming right up. Tell me which batch works for you and I'll share the payment options.",
    other_commerce: "Sounds like a great fit. Could you share the date, audience size and session length? I'll send over my terms.",
    fan: "Thank you so much, this genuinely made my day!",
    personal: "Got it! Let's catch up soon.",
    nudge: "Just circling back on this. Still keen to make it work if you are. Any update on your side?",
    neutral: "Thanks for the message! What did you have in mind?",
  },
  hi: {
    brand_deal: "Sounds interesting! Brief share kar do, deliverables, timeline aur budget range ke saath. Dekh ke jaldi reply karte hain.",
    coaching_lead: "Love that you're serious about this! Mera program bilkul aapke level ke liye bana hai. Details aur price bhej doon?",
    course_inquiry: "Haan ji! Enrollment details abhi bhejte hain. Kaunsa batch suit karega, batao, phir payment options share karte hain.",
    other_commerce: "Sounds like a great fit! Date, audience size aur session length share kar do, phir terms bhejte hain.",
    fan: "Thank you so much, dil khush ho gaya!",
    personal: "Haan haan, done! Jaldi milte hain.",
    nudge: "Bas check kar rahe the, is pe koi update? Still keen to make it work!",
    neutral: "Thanks for the message! Aap kya plan kar rahe ho, batao?",
  },
};
const DECLINE = {
  en: "Thank you for thinking of me! I'll have to pass on this one for now, but I'd love to stay in touch for future work.",
  hi: "Thank you for thinking of me! Abhi ke liye pass karna padega, but future mein zaroor connect karte hain.",
};
const BUDGET = { en: "What budget do you have in mind?", hi: "Budget kya socha hai?" };
const CALL = { en: "Happy to hop on a quick call if that's easier.", hi: "Chaho toh ek quick call bhi kar sakte hain." };

function money(creator: DraftInput["creator"]) {
  const currency = creator.currencyCode as CurrencyCode;
  return (CURRENCY_CODES as readonly string[]).includes(currency) ? { currency, locale: creator.locale } : null;
}

/** Keep whole sentences while they fit the word budget (always at least the first). */
function fitWords(text: string, limit: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const sentence of sentences) {
    if (out && wordCount(out + sentence) > limit) break;
    out += sentence;
  }
  return out.trim();
}

function removePhrase(text: string, phrase: string): string {
  if (phrase.trim() === "—") return text.replace(/\s*—\s*/g, ", ");
  const parts = phrase.split(/\s+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return text;
  return text
    .replace(new RegExp(`(^|[^\\p{L}])${parts.join("[\\s'’,.!?-]+")}(?![\\p{L}])[\\s,.!?]*`, "giu"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function matchLabel(
  text: string,
  handle: string
): { label: ClassificationLabel; confidence: number; rationale: string } {
  if (/(guaranteed|10x (your )?follow|buy .*follow|registration to claim|paid promotion packages|free audit)/.test(text)) {
    return { label: "spam", confidence: 0.95, rationale: "Follower-scheme language — classic spam pattern." };
  }
  if (/(collab|campaign|partnership|sponsor|ambassad|brand|deliverable|paid collaboration|media kit|commercials|retainer)/.test(text)) {
    return { label: "brand_deal", confidence: 0.88, rationale: "Mentions paid collaboration/campaign terms." };
  }
  if (/(coaching|1-on-1|one.on.one|mentorship|transformation program|personal coach|12.week|program ke)/.test(text)) {
    return { label: "coaching_lead", confidence: 0.86, rationale: "Asks about coaching/program with buying intent." };
  }
  if (/(course|cohort|enroll|curriculum|batch|waitlist|emi)/.test(text)) {
    return { label: "course_inquiry", confidence: 0.85, rationale: "Asks about course enrollment/pricing." };
  }
  if (/(workshop|consult|speaker|speaking|summit|license|licensing|session for our)/.test(text)) {
    return { label: "other_commerce", confidence: 0.82, rationale: "Paid workshop/consulting/speaking request." };
  }
  if (/(ghar|mummy|birthday|call kar|bhaiya .*aa rahe)/.test(text)) {
    return { label: "personal", confidence: 0.75, rationale: "Personal/family context, no commercial intent." };
  }
  if (/(love your|legend|inspire|respect|goosebumps|🔥|❤️|aapki wajah se|best .* creator)/.test(text)) {
    return { label: "fan", confidence: 0.84, rationale: "Appreciation message, no commercial intent." };
  }
  return {
    label: "uncertain",
    confidence: 0.4,
    rationale: `No clear commercial or fan signal from @${handle} — needs your judgement.`,
  };
}

function detectLanguage(text: string): MessageLanguage {
  const hinglish =
    /\b(bhai|bhaiya|didi|yaar|hai|hain|kya|kab|nahi|karo|ke|ka|ki|mein|aap|aapki|mujhe|maine|bata|dijiye|abhi|wala|saath|hoon)\b/i.test(
      text
    );
  const devanagari = /[ऀ-ॿ]/.test(text);
  if (devanagari && hinglish) return "mixed";
  if (devanagari) return "hi";
  if (hinglish) return "hinglish";
  return "en";
}

function valueRangeFor(label: ClassificationLabel, input: ClassifyInput) {
  const c = input.creator;
  const base =
    label === "brand_deal"
      ? c.typicalBrandDealMinor
      : label === "coaching_lead"
        ? c.typicalCoachingMinor
        : label === "course_inquiry"
          ? c.typicalCourseMinor
          : (c.typicalBrandDealMinor ?? c.typicalCoachingMinor);
  if (!base) return null;
  return { minMinor: base.min, maxMinor: base.max };
}
