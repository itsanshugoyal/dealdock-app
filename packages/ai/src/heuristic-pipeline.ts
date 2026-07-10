import {
  ClassificationResult,
  HIGH_INTENT_LABELS,
  type ClassificationLabel,
  type MessageLanguage,
} from "@dealdock/core";
import type { AiPipeline, ClassifyInput, DraftInput, DraftResult } from "./types";
import { PROMPT_VERSION } from "./prompts";

export const HEURISTIC_MODEL_VERSION = "heuristic-fallback-1";

/**
 * Deterministic keyword pipeline used when ANTHROPIC_API_KEY is absent
 * (local dev, CI, demos) and in unit tests. Honest about what it is:
 * every row it writes is stamped `heuristic-fallback-1` so no heuristic
 * output ever pollutes real accuracy metrics.
 */
export class HeuristicPipeline implements AiPipeline {
  async classify(input: ClassifyInput): Promise<ClassificationResult> {
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

  async draft(input: DraftInput): Promise<DraftResult> {
    const greeting =
      (input.creator.styleCard?.["greeting"] as string | undefined) ?? "Hey!";
    const signoff = (input.creator.styleCard?.["signoff"] as string | undefined) ?? "";

    const bodies: Record<string, string> = {
      brand_deal: `${greeting} Thanks for reaching out — this sounds interesting. Could you share the brief with deliverables, timeline, and budget range? I'll take a look and get back to you quickly.`,
      coaching_lead: `${greeting} Love that you're serious about this. My program is built exactly for where you are — happy to share how it works and what it costs. Want me to send the details?`,
      course_inquiry: `${greeting} Yes — enrollment details coming right up. Tell me which batch works for you and I'll share the payment options.`,
      other_commerce: `${greeting} Sounds like a great fit. Could you share the date, audience size, and session length? I'll send over my terms.`,
      nudge: `${greeting} Just circling back on this — still keen to make it work if you are. Any update on your side?`,
    };

    const key = input.kind === "nudge" ? "nudge" : input.classificationLabel;
    const body = `${bodies[key] ?? bodies.brand_deal}${signoff ? `\n${signoff}` : ""}`;

    return { body, modelVersion: HEURISTIC_MODEL_VERSION, promptVersion: PROMPT_VERSION };
  }
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
