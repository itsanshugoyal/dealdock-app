import type { CreatorContext } from "./types";

/**
 * Prompt builders. PROMPT_VERSION stamps every Classification/Draft row so
 * accuracy metrics are computed per version (ARCHITECTURE.md §5.2) — bump it
 * on ANY change to this file; CI runs evals on prompt changes (M2).
 */
export const PROMPT_VERSION = "1.0.0-m1";

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
Typical brand deal: ${rangeText(creator.typicalBrandDealMinor, creator.currencyCode)}
Typical coaching package: ${rangeText(creator.typicalCoachingMinor, creator.currencyCode)}
Typical course price: ${rangeText(creator.typicalCourseMinor, creator.currencyCode)}

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

export function buildDraftSystem(creator: CreatorContext): string {
  const style = creator.styleCard
    ? `\nVOICE STYLE CARD (match this exactly):\n${JSON.stringify(creator.styleCard, null, 2)}`
    : "\nNo voice profile yet — write warm, concise, professional; light Hinglish only if the inbound message uses it.";

  return `You draft DM replies for a commerce creator. The creator reviews and sends every draft — you draft, they decide.

CREATOR CONTEXT
Business: ${creator.businessSummary}
Currency: ${creator.currencyCode}
${style}

REPLY STRUCTURE BY TYPE
- brand_deal: thank them, show selective interest, ask for brief/budget/timeline, keep leverage. Never quote a price first unless the creator's rate context clearly applies.
- coaching_lead: acknowledge their goal personally, one-line program fit, clear next step (how to start / what it costs if asked directly).
- course_inquiry: answer the exact question first (cohort dates, price, format), then one enrollment nudge.
- other_commerce: express interest, ask for scope specifics (date, audience, duration), signal paid engagement.
- follow-up nudge: 1-2 sentences, warm, zero pressure, reference the prior thread naturally.

RULES
- Match the inbound message's language mix (Hinglish in → Hinglish out).
- Length: 2-5 sentences. DMs, not emails.
- Never invent prices, dates, or availability not present in creator context.
- No emojis unless the style card shows the creator uses them.
- Output ONLY the reply text. No preamble, no quotes, no explanations.`;
}

function rangeText(
  range: { min: number; max: number } | null,
  currency: string
): string {
  if (!range) return "not provided";
  return `${currency} ${Math.round(range.min / 100).toLocaleString()}–${Math.round(range.max / 100).toLocaleString()}`;
}
