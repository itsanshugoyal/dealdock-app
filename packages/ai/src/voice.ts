import Anthropic from "@anthropic-ai/sdk";
import { PROMPT_VERSION } from "./prompts";
import { HEURISTIC_MODEL_VERSION } from "./heuristic-pipeline";

/**
 * Voice modeling v1 (PRD §6.4): consented sent-DM samples → style card.
 * The card is JSON, human-readable, and editable by us during pilot support.
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

export async function extractStyleCard(samples: string[]): Promise<StyleCardResult> {
  if (!process.env.ANTHROPIC_API_KEY) return heuristicStyleCard(samples);

  const client = new Anthropic();
  const model = process.env.DRAFT_MODEL ?? "claude-sonnet-5";
  const response = await client.messages.create({
    model,
    max_tokens: 500,
    temperature: 0,
    system:
      "You analyze a creator's sent Instagram DMs and extract their writing style. Describe how they ACTUALLY write, not how they should. Always call record_style_card exactly once.",
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
