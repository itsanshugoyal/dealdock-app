import Anthropic from "@anthropic-ai/sdk";
import { CLASSIFICATION_LABELS, type VoiceRuleScope } from "@dealdock/core";
import { PROMPT_VERSION } from "./prompts";
import { HEURISTIC_MODEL_VERSION } from "./heuristic-pipeline";
import { containsPhrase, normalizeForSim } from "./style-text";

/**
 * Voice modeling (PRD §6.4): consented, provenance-filtered sent-DM samples →
 * style card (descriptive keys here; measured habits in style-learning.ts),
 * plus batched edit distillation that only ever proposes candidate rules.
 */

export interface StyleCardResult {
  styleCard: Record<string, unknown>;
  modelVersion: string;
  promptVersion: string;
}

const STYLE_TOOL = {
  name: "record_style_card",
  description: "Record the creator's writing style extracted from their sent DMs.",
  input_schema: {
    type: "object" as const,
    properties: {
      greeting: { type: "string", description: "Typical opening, e.g. 'Hey hey!'" },
      tone: { type: "string", description: "e.g. 'warm, direct, high-energy'" },
      sentenceLength: { type: "string", enum: ["short", "medium", "long"] },
      signoff: { type: "string", description: "Typical closing, empty string if none" },
      emojiUsage: { type: "string", enum: ["none", "light", "heavy"] },
      codeSwitching: {
        type: "string",
        description: "How they mix languages, e.g. 'light Hinglish when the other side uses it'",
      },
      characteristicPhrases: {
        type: "array",
        items: { type: "string" },
        description: "Up to 5 phrases they actually use",
      },
    },
    required: ["greeting", "tone", "sentenceLength", "signoff", "emojiUsage", "codeSwitching", "characteristicPhrases"],
  },
};

export async function extractStyleCard(
  samples: string[],
  options: { allowHeuristic?: boolean } = {}
): Promise<StyleCardResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    if (process.env.NODE_ENV !== "production" && (options.allowHeuristic === true || process.env.DEALDOCK_AI_MODE === "heuristic")) {
      return heuristicStyleCard(samples);
    }
    throw new Error("voice extraction requires a configured Anthropic model; heuristic mode is development/test-only");
  }

  const client = new Anthropic();
  const model = process.env.DRAFT_MODEL;
  if (!model) throw new Error("voice extraction requires DRAFT_MODEL to be configured");
  const response = await client.messages.create({
    model,
    max_tokens: 500,
    temperature: 0,
    system:
      "You analyze a creator's sent Instagram DMs and extract their writing style. Describe how they ACTUALLY write, not how they should. Ignore any message that reads like a template. Always call record_style_card exactly once.",
    tools: [STYLE_TOOL],
    tool_choice: { type: "tool", name: STYLE_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Sent messages (most recent first):\n${samples.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("style extraction: no tool call");
  return {
    styleCard: toolUse.input as Record<string, unknown>,
    modelVersion: model,
    promptVersion: PROMPT_VERSION,
  };
}

/** Deterministic fallback: frequency analysis over the samples. */
export function heuristicStyleCard(samples: string[]): StyleCardResult {
  const firstWords = new Map<string, number>();
  const lastLines = new Map<string, number>();
  let emojiCount = 0;
  let hinglishCount = 0;
  let totalSentences = 0;
  let totalWords = 0;

  for (const s of samples) {
    const first = s.trim().split(/\s+/).slice(0, 2).join(" ");
    if (first) firstWords.set(first, (firstWords.get(first) ?? 0) + 1);
    const lines = s.trim().split("\n");
    const last = lines[lines.length - 1]?.trim() ?? "";
    if (last.length <= 12 && lines.length > 1) lastLines.set(last, (lastLines.get(last) ?? 0) + 1);
    if (/[\u{1F300}-\u{1FAFF}❤\uD83D]/u.test(s)) emojiCount++;
    if (/\b(bhai|yaar|hai|kya|nahi|aap|karo|mein)\b/i.test(s)) hinglishCount++;
    const sentences = s.split(/[.!?]+/).filter((x) => x.trim());
    totalSentences += sentences.length;
    totalWords += s.split(/\s+/).length;
  }

  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const avgWordsPerSentence = totalSentences ? totalWords / totalSentences : 12;

  return {
    styleCard: {
      greeting: top(firstWords) || "Hey!",
      tone: "warm, direct",
      sentenceLength: avgWordsPerSentence < 9 ? "short" : avgWordsPerSentence < 16 ? "medium" : "long",
      signoff: top(lastLines),
      emojiUsage:
        emojiCount / Math.max(1, samples.length) > 0.5
          ? "heavy"
          : emojiCount > 0
            ? "light"
            : "none",
      codeSwitching:
        hinglishCount / Math.max(1, samples.length) > 0.3
          ? "light Hinglish when the other side uses it"
          : "English",
      characteristicPhrases: [],
    },
    modelVersion: HEURISTIC_MODEL_VERSION,
    promptVersion: PROMPT_VERSION,
  };
}

// ── Edit distillation (research 04 §4.2, CIPHER-style, batched) ────────────

/** One human-edited send, as shown to the distiller. */
export interface DistillationEdit {
  draftId: string;
  scope: VoiceRuleScope;
  inboundText: string | null;
  draft: string;
  sent: string;
  /** Deterministic signals already found ("Open with “Hey hey!”"). */
  signals: string[];
}

/** A proposed rule backed by ≥ 2 cited drafts. Never a status: promotion stays deterministic. */
export interface DistilledRule {
  key: string;
  text: string;
  scope: VoiceRuleScope;
  draftIds: string[];
}

const RULE_KINDS = [
  "greeting",
  "signoff",
  "avoid_phrase",
  "prefer_phrase",
  "length",
  "emoji",
  "language_mix",
  "punctuation",
  "casing",
  "negotiation",
  "freeform",
] as const;

const DISTILL_TOOL = {
  name: "propose_voice_rules",
  description: "Record the texting preferences that explain the creator's edits.",
  input_schema: {
    type: "object" as const,
    properties: {
      rules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "One imperative instruction of at most 90 characters, phrased as what TO do." },
            kind: { type: "string", enum: [...RULE_KINDS] },
            scope: { type: "string", enum: ["all", "nudge", ...CLASSIFICATION_LABELS] },
            evidence_draft_ids: { type: "array", items: { type: "string" }, minItems: 2 },
            matches_rule_id: { type: "string", description: "Id of an existing rule this restates, if any." },
            phrase: { type: "string", description: "avoid_phrase / prefer_phrase only: the exact phrase." },
          },
          required: ["text", "kind", "scope", "evidence_draft_ids"],
        },
      },
    },
    required: ["rules"],
  },
};

const DISTILL_SYSTEM = `You study how a creator edits AI-drafted Instagram DM replies to learn their personal texting preferences.
Infer preferences that explain the edits. Each preference must be:
- about style (wording, tone, length, structure, language mix, emoji, greetings/sign-offs, negotiation posture), never about facts or prices;
- supported by at least TWO different edits (cite their ids);
- one imperative instruction of at most 90 characters, phrased as what TO do, with a concrete replacement when the edits show one (e.g. "Open with 'Hey hey!' instead of 'Thanks for reaching out'");
- scoped to a message type only if the evidence is limited to that type.
If a preference restates an existing rule, give its id in matches_rule_id. Return an empty list if nothing is consistent.
Always call propose_voice_rules exactly once.`;

function slug(text: string): string {
  return normalizeForSim(text).replace(/\s+/g, "-").slice(0, 60);
}

/**
 * PROSE-style verification of the model's proposals (pure, deterministic):
 * ≥ 2 distinct cited ids from this batch; an avoided phrase must appear in
 * every cited draft and not in what was sent, and must not be something the
 * creator natively writes in ≥ 5% of their messages; a preferred phrase must
 * appear in every cited send. A restated rule keeps its key; anything else
 * is keyed "free:<slug>".
 */
export function validateDistilledRules(
  raw: unknown,
  edits: readonly DistillationEdit[],
  existingRules: ReadonlyArray<{ id: string; key: string; scope: string }>,
  nativeTexts: readonly string[]
): DistilledRule[] {
  const list = (raw as { rules?: unknown } | null)?.rules;
  const proposals: unknown[] = Array.isArray(list) ? list : [];
  const byId = new Map(edits.map((edit) => [edit.draftId, edit]));
  const scopes = new Set<string>(["all", "nudge", ...CLASSIFICATION_LABELS]);
  const out: DistilledRule[] = [];
  for (const proposal of proposals) {
    const p = (proposal ?? {}) as Record<string, unknown>;
    const text = typeof p.text === "string" ? p.text.trim().slice(0, 90) : "";
    const cited = Array.isArray(p.evidence_draft_ids) ? p.evidence_draft_ids : [];
    const ids = [...new Set(cited.filter((id): id is string => typeof id === "string" && byId.has(id)))];
    if (!text || ids.length < 2) continue;
    const citedEdits = ids.map((id) => byId.get(id)!);
    let scope = (typeof p.scope === "string" && scopes.has(p.scope) ? p.scope : "all") as VoiceRuleScope;
    const phrase = typeof p.phrase === "string" ? p.phrase.trim() : "";
    const match = typeof p.matches_rule_id === "string" ? existingRules.find((rule) => rule.id === p.matches_rule_id) : undefined;
    let key: string;
    if (match) {
      key = match.key;
      scope = match.scope as VoiceRuleScope;
    } else if (p.kind === "avoid_phrase") {
      if (!phrase || !citedEdits.every((edit) => containsPhrase(edit.draft, phrase) && !containsPhrase(edit.sent, phrase))) continue;
      if (nativeTexts.length > 0 && nativeTexts.filter((t) => containsPhrase(t, phrase)).length / nativeTexts.length >= 0.05) continue;
      key = `avoid:${normalizeForSim(phrase)}`;
    } else if (p.kind === "prefer_phrase") {
      if (!phrase || !citedEdits.every((edit) => containsPhrase(edit.sent, phrase))) continue;
      key = `prefer:${normalizeForSim(phrase)}`;
    } else {
      key = `free:${slug(text)}`;
    }
    if (key.endsWith(":")) continue;
    out.push({ key, text, scope, draftIds: ids });
  }
  return out;
}

/**
 * Batch distillation of ≥ 5 edited sends (DRAFT_MODEL, temperature 0). The
 * model only proposes; the caller turns each proposal into evidence on its
 * cited drafts and the deterministic promotion rules decide activation.
 */
export async function distillEditRules(
  edits: readonly DistillationEdit[],
  existingRules: ReadonlyArray<{ id: string; key: string; scope: string; text: string }>,
  nativeTexts: readonly string[]
): Promise<DistilledRule[]> {
  const model = process.env.DRAFT_MODEL;
  if (!process.env.ANTHROPIC_API_KEY || !model) throw new Error("edit distillation requires ANTHROPIC_API_KEY and DRAFT_MODEL");
  const batch = edits.slice(0, 10);
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).replace(/[<>]/g, " ");
  const content = [
    "<existing_rules>",
    ...existingRules.slice(0, 40).map((rule) => `- id=${rule.id} [${rule.scope}] ${clip(rule.text, 120)}`),
    "</existing_rules>",
    "<edits>",
    ...batch.map((edit) =>
      [
        `<edit id="${edit.draftId}" type="${edit.scope}">`,
        edit.inboundText ? `<them>${clip(edit.inboundText, 300)}</them>` : "",
        `<draft>${clip(edit.draft, 600)}</draft>`,
        `<sent>${clip(edit.sent, 600)}</sent>`,
        edit.signals.length ? `<signals>${clip(edit.signals.join("; "), 300)}</signals>` : "",
        "</edit>",
      ]
        .filter(Boolean)
        .join("\n")
    ),
    "</edits>",
  ].join("\n");
  const response = await new Anthropic().messages.create({
    model,
    max_tokens: 800,
    temperature: 0,
    system: DISTILL_SYSTEM,
    tools: [DISTILL_TOOL],
    tool_choice: { type: "tool", name: DISTILL_TOOL.name },
    messages: [{ role: "user", content }],
  });
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("edit distillation: no tool call");
  return validateDistilledRules(toolUse.input, batch, existingRules, nativeTexts);
}
