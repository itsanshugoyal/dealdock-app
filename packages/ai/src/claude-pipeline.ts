import Anthropic from "@anthropic-ai/sdk";
import { ClassificationResult, HIGH_INTENT_LABELS, MINOR_PER_MAJOR } from "@dealdock/core";
import type { AiPipeline, ClassifyInput, DraftInput, DraftResult } from "./types";
import { buildClassifySystem, buildDraftSystem, CLASSIFY_TOOL, PROMPT_VERSION } from "./prompts";

/**
 * Claude implementation (ADR-2): Haiku for volume classification+valuation in
 * ONE structured call (temperature 0); Sonnet for drafts. The per-creator
 * system block is cache-marked — only message content varies per call.
 */
export class ClaudePipeline implements AiPipeline {
  private client: Anthropic;
  private classifyModel: string;
  private draftModel: string;

  constructor(opts?: { apiKey?: string; classifyModel?: string; draftModel?: string }) {
    this.client = new Anthropic({ apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.classifyModel =
      opts?.classifyModel ?? process.env.CLASSIFY_MODEL ?? "claude-haiku-4-5-20251001";
    this.draftModel = opts?.draftModel ?? process.env.DRAFT_MODEL ?? "claude-sonnet-5";
  }

  async classify(input: ClassifyInput): Promise<ClassificationResult> {
    const response = await this.client.messages.create({
      model: this.classifyModel,
      max_tokens: 400,
      temperature: 0,
      system: [
        {
          type: "text",
          text: buildClassifySystem(input.creator),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
      messages: [
        {
          role: "user",
          content: `Sender: @${input.senderHandle}\nMessage:\n${input.messageText}`,
        },
      ],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("classification: model did not call the tool");
    }
    const raw = toolUse.input as Record<string, unknown>;

    const label = String(raw.label);
    const isCommerce = (HIGH_INTENT_LABELS as readonly string[]).includes(label);
    const minMajor = raw.value_min_major as number | null;
    const maxMajor = raw.value_max_major as number | null;

    return ClassificationResult.parse({
      label,
      confidence: Math.max(0, Math.min(1, Number(raw.confidence))),
      language: raw.language,
      valueRange:
        isCommerce && minMajor != null && maxMajor != null
          ? {
              minMinor: Math.round(minMajor * MINOR_PER_MAJOR),
              maxMinor: Math.round(Math.max(minMajor, maxMajor) * MINOR_PER_MAJOR),
            }
          : null,
      rationale: String(raw.rationale ?? ""),
      modelVersion: this.classifyModel,
      promptVersion: PROMPT_VERSION,
    });
  }

  async draft(input: DraftInput): Promise<DraftResult> {
    const history = input.threadHistory
      .slice(-12)
      .map((m) => `${m.direction === "inbound" ? "THEM" : "CREATOR"}: ${m.text}`)
      .join("\n");

    const task =
      input.kind === "nudge"
        ? "Draft a short follow-up nudge — the other side has gone quiet."
        : `Draft the creator's reply to the latest inbound message (type: ${input.classificationLabel}).`;

    const response = await this.client.messages.create({
      model: this.draftModel,
      max_tokens: 500,
      temperature: 0.4,
      system: [
        {
          type: "text",
          text: buildDraftSystem(input.creator),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: `${task}\n\nTHREAD:\n${history}` }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("drafting: empty model response");

    return { body: text, modelVersion: this.draftModel, promptVersion: PROMPT_VERSION };
  }
}
