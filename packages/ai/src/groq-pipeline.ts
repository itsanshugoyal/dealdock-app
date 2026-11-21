import { ClassificationResult, HIGH_INTENT_LABELS, MINOR_PER_MAJOR, type DealSuggestion } from "@dealdock/core";
import { z } from "zod";
import { mergeDealSuggestion, suggestDealHeuristically } from "./deal-suggestion";
import { CHAT_VENDORS, groqStructured } from "./groq-client";
import { HEURISTIC_MODEL_VERSION } from "./heuristic-pipeline";
import { chatModel, type ChatVendor } from "./provider";
import { buildClassifySystem, buildDealPrompt, buildDraftPrompt, CLASSIFY_TOOL, classifyUserText, DEAL_TOOL, DRAFT_TOOL, mergeMissingFacts, parseDraftToolInput, PROMPT_VERSION } from "./prompts";
import { lintDraft, lintRetryInstruction } from "./style-learning";
import type { AiPipeline, ClassifyInput, DealSuggestionInput, DraftInput, DraftResult } from "./types";

const rawClassification = z.object({
  label: z.string(), confidence: z.number().finite(), language: z.string(),
  value_min_major: z.number().finite().nullable(), value_max_major: z.number().finite().nullable(), rationale: z.string(),
});
const rawDraft = z.object({ drafts: z.array(z.string()).min(1).max(3), missingFacts: z.array(z.string()) });
/** Groq, or OpenAI with vendor "openai": both speak chat completions with strict JSON schemas. */
export class GroqPipeline implements AiPipeline {
  private classifyModel: string;
  private draftModel: string;
  private apiKey?: string;
  private fetchImpl?: typeof fetch;
  private vendor: ChatVendor;
  private version: string;
  constructor(options: { apiKey?: string; classifyModel?: string; draftModel?: string; fetchImpl?: typeof fetch; vendor?: ChatVendor } = {}) {
    this.vendor = options.vendor ?? "groq";
    const { keyEnv, label } = CHAT_VENDORS[this.vendor];
    this.apiKey = options.apiKey ?? process.env[keyEnv];
    if (!this.apiKey) throw new Error(`${label} pipeline requires ${keyEnv}`);
    this.classifyModel = options.classifyModel ?? chatModel(this.vendor, "classify");
    this.draftModel = options.draftModel ?? chatModel(this.vendor, "draft");
    this.fetchImpl = options.fetchImpl;
    this.version = `${PROMPT_VERSION}-${this.vendor}1`;
  }
  async classify(input: ClassifyInput): Promise<ClassificationResult> {
    if (input.isIgnoredHandle) throw new Error("classification is blocked for an ignored handle");
    const raw = rawClassification.parse(await groqStructured({
      model: this.classifyModel, name: CLASSIFY_TOOL.name, schema: CLASSIFY_TOOL.input_schema,
      system: buildClassifySystem(input.creator).replace("Always respond by calling classify_message exactly once.", ""),
      user: classifyUserText(input),
      maxTokens: 2048, temperature: 0, apiKey: this.apiKey, fetchImpl: this.fetchImpl, vendor: this.vendor,
    }));
    const isCommerce = (HIGH_INTENT_LABELS as readonly string[]).includes(raw.label);
    let valueRange: { minMinor: number; maxMinor: number } | null = null;
    if (isCommerce && raw.value_min_major !== null && raw.value_max_major !== null) {
      const typicalMax = Math.max(input.creator.typicalBrandDealMinor?.max ?? 0, input.creator.typicalCoachingMinor?.max ?? 0, input.creator.typicalCourseMinor?.max ?? 0);
      const ceiling = typicalMax > 0 ? typicalMax * 100 : 100_00_00_000_00;
      const minor = (amount: number) => Math.min(Math.max(0, Math.round(amount * MINOR_PER_MAJOR)), ceiling);
      valueRange = { minMinor: minor(Math.min(raw.value_min_major, raw.value_max_major)), maxMinor: minor(Math.max(raw.value_min_major, raw.value_max_major)) };
    }
    return ClassificationResult.parse({ label: raw.label, confidence: Math.max(0, Math.min(1, raw.confidence)), language: raw.language, valueRange, rationale: raw.rationale, modelVersion: `${this.vendor}:${this.classifyModel}`, promptVersion: this.version });
  }
  async draft(input: DraftInput): Promise<DraftResult> {
    if (input.isIgnoredHandle) throw new Error("drafting is blocked for an ignored handle");
    if (input.voiceConsent === false) throw new Error("drafting is blocked because voice-model consent is disabled");
    const prompt = buildDraftPrompt(input);
    const generate = async (fix?: string) => {
      const system = prompt.system.join("\n\n").replace("Always answer by calling write_reply exactly once.", "");
      const raw = rawDraft.parse(await groqStructured({ model: this.draftModel, name: DRAFT_TOOL.name, schema: DRAFT_TOOL.input_schema, system,
        user: fix ? `${prompt.user}\n\n${fix}` : prompt.user, maxTokens: 3072, temperature: 0.4, apiKey: this.apiKey, fetchImpl: this.fetchImpl, vendor: this.vendor }));
      return parseDraftToolInput(raw, prompt.variants);
    };
    let result = await generate();
    let violations = lintDraft(result.drafts[0]!, prompt.lint);
    if (violations.length > 0) {
      const retry = await generate(lintRetryInstruction(violations));
      const retryViolations = lintDraft(retry.drafts[0]!, prompt.lint);
      if (retryViolations.length <= violations.length) { result = retry; violations = retryViolations; }
    }
    return { body: result.drafts[0]!, alternatives: prompt.variants > 1 ? result.drafts : [], context: { ...prompt.context, missingFacts: mergeMissingFacts(prompt.context.missingFacts, result.missingFacts) }, lintViolations: violations, modelVersion: `${this.vendor}:${this.draftModel}`, promptVersion: this.version };
  }
  /** Extraction at temperature 0 on the classify model; invalid fields fall back to the heuristic reading. */
  async suggestDeal(input: DealSuggestionInput): Promise<DealSuggestion> {
    const fallback = suggestDealHeuristically(input, HEURISTIC_MODEL_VERSION);
    const prompt = buildDealPrompt(input);
    const raw = await groqStructured({ model: this.classifyModel, name: DEAL_TOOL.name, schema: DEAL_TOOL.input_schema,
      system: prompt.system.replace("Always answer by calling record_deal exactly once.", ""), user: prompt.user,
      maxTokens: 3072, temperature: 0, apiKey: this.apiKey, fetchImpl: this.fetchImpl, vendor: this.vendor });
    return mergeDealSuggestion(raw, fallback, input, `${this.vendor}:${this.classifyModel}`);
  }
}
