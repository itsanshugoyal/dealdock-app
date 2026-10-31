import Anthropic from "@anthropic-ai/sdk";
import { ClassificationResult, HIGH_INTENT_LABELS, MINOR_PER_MAJOR } from "@dealdock/core";
import type { AiPipeline, ClassifyInput, DraftInput, DraftResult } from "./types";
import { buildClassifySystem, buildDraftPrompt, CLASSIFY_TOOL, DRAFT_TOOL, parseDraftToolInput, PROMPT_VERSION } from "./prompts";
import { lintDraft, lintRetryInstruction } from "./style-learning";

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
    this.classifyModel = opts?.classifyModel ?? process.env.CLASSIFY_MODEL ?? "";
    this.draftModel = opts?.draftModel ?? process.env.DRAFT_MODEL ?? "";
    if (!this.classifyModel || !this.draftModel) {
      throw new Error(
        "ClaudePipeline requires CLASSIFY_MODEL and DRAFT_MODEL. Model versions must be configured rather than assumed."
      );
    }
  }

  async classify(input: ClassifyInput): Promise<ClassificationResult> {
    if (input.isIgnoredHandle) {
      throw new Error("classification is blocked for an ignored handle");
    }
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

    // The model's numeric output is untrusted: clamp before it reaches the DB
    // or the high-value push threshold. A negative estimate would otherwise
    // throw in zod (MinorUnits is non-negative), and a hallucinated/unit-
    // confused figure (rupees read as crores) would corrupt revenue metrics
    // and fire false high-value alerts.
    const confidence = Number.isFinite(Number(raw.confidence))
      ? Math.max(0, Math.min(1, Number(raw.confidence)))
      : 0;

    return ClassificationResult.parse({
      label,
      confidence,
      language: raw.language,
      valueRange: this.clampValueRange(
        isCommerce,
        raw.value_min_major as number | null,
        raw.value_max_major as number | null,
        input
      ),
      rationale: String(raw.rationale ?? ""),
      modelVersion: this.classifyModel,
      promptVersion: PROMPT_VERSION,
    });
  }

  /** Clamp untrusted model value estimates to [0, 100× the creator's top typical deal]. */
  private clampValueRange(
    isCommerce: boolean,
    minMajor: number | null,
    maxMajor: number | null,
    input: ClassifyInput
  ): { minMinor: number; maxMinor: number } | null {
    if (!isCommerce || minMajor == null || maxMajor == null) return null;
    if (!Number.isFinite(minMajor) || !Number.isFinite(maxMajor)) return null;

    const typicalMax = Math.max(
      input.creator.typicalBrandDealMinor?.max ?? 0,
      input.creator.typicalCoachingMinor?.max ?? 0,
      input.creator.typicalCourseMinor?.max ?? 0
    );
    // 100× the creator's biggest typical deal, or a ₹10Cr / $1.2M-scale hard
    // ceiling (minor units) when there's no onboarding context to anchor on.
    const ceiling = typicalMax > 0 ? typicalMax * 100 : 100_00_00_000_00;

    const lo = Math.min(minMajor, maxMajor);
    const hi = Math.max(minMajor, maxMajor);
    return {
      minMinor: Math.min(Math.max(0, Math.round(lo * MINOR_PER_MAJOR)), ceiling),
      maxMinor: Math.min(Math.max(0, Math.round(hi * MINOR_PER_MAJOR)), ceiling),
    };
  }

  /**
   * Draft v2 (research 04 §4.5): static + cache-marked creator-voice system
   * blocks, exemplars/lessons/thread/task in the user turn, one write_reply
   * tool call (drafts + missingFacts). A draft that breaks an avoid rule, the
   * generic-phrase list or the length target is retried once with the
   * violations; whatever remains is reported, never blocking.
   */
  async draft(input: DraftInput): Promise<DraftResult> {
    assertDraftAllowed(input);
    const prompt = buildDraftPrompt(input);
    const generate = async (fix?: string) => {
      const response = await this.client.messages.create({
        model: this.draftModel,
        max_tokens: prompt.variants > 1 ? 1_200 : 600,
        temperature: 0.4,
        system: [
          { type: "text", text: prompt.system[0] },
          { type: "text", text: prompt.system[1], cache_control: { type: "ephemeral" } },
        ],
        tools: [DRAFT_TOOL],
        tool_choice: { type: "tool", name: DRAFT_TOOL.name },
        messages: [{ role: "user", content: fix ? `${prompt.user}\n\n${fix}` : prompt.user }],
      });
      const toolUse = response.content.find((b) => b.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") throw new Error("drafting: model did not call the tool");
      return parseDraftToolInput(toolUse.input, prompt.variants);
    };

    let result = await generate();
    let violations = lintDraft(result.drafts[0]!, prompt.lint);
    if (violations.length > 0) {
      const retry = await generate(lintRetryInstruction(violations));
      const retryViolations = lintDraft(retry.drafts[0]!, prompt.lint);
      if (retryViolations.length <= violations.length) {
        result = retry;
        violations = retryViolations;
      }
    }

    return {
      body: result.drafts[0]!,
      alternatives: prompt.variants > 1 ? result.drafts : [],
      context: { ...prompt.context, missingFacts: result.missingFacts },
      lintViolations: violations,
      modelVersion: this.draftModel,
      promptVersion: PROMPT_VERSION,
    };
  }
}

function assertDraftAllowed(input: DraftInput): void {
  if (input.isIgnoredHandle) {
    throw new Error("drafting is blocked for an ignored handle");
  }
  if (input.voiceConsent === false) {
    throw new Error("drafting is blocked because voice-model consent is disabled");
  }
}
