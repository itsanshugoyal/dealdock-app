/**
 * @dealdock/ai — configured Groq or Claude pipeline (ARCHITECTURE.md §5).
 * Classification, drafting and style learning are version-stamped. The worker
 * persists results; this package does not access the database or send messages.
 */

export * from "./types";
export { PROMPT_VERSION, buildDraftPrompt, type DraftPrompt } from "./prompts";
export { ClaudePipeline } from "./claude-pipeline";
export { GroqPipeline } from "./groq-pipeline";
export { configuredFallbackProvider, configuredModelProvider, DEFAULT_GROQ_MODEL, DEFAULT_OPENAI_MODEL } from "./provider";
export { GroqRateLimitError } from "./groq-client";
export { HeuristicPipeline, HEURISTIC_MODEL_VERSION } from "./heuristic-pipeline";
export {
  distillEditRules,
  extractStyleCard,
  heuristicStyleCard,
  validateDistilledRules,
  type DistillationEdit,
  type DistilledRule,
  type StyleCardResult,
} from "./voice";
export * from "./style-learning";
export * from "./style-retrieval";
export * from "./style-text";
export * from "./draft-context";
export * from "./comment-reply";

import { ClaudePipeline } from "./claude-pipeline";
import { HeuristicPipeline } from "./heuristic-pipeline";
import { GroqPipeline } from "./groq-pipeline";
import { configuredFallbackProvider, configuredModelProvider, type ModelProvider } from "./provider";
import type { AiPipeline } from "./types";

function pipelineFor(provider: ModelProvider): AiPipeline {
  return provider === "anthropic" ? new ClaudePipeline() : new GroqPipeline({ vendor: provider });
}

/**
 * The fallback answers only when the primary call fails (outage, rate limit, bad output). Every result
 * carries its own model stamp, so which provider answered stays visible. If both fail, the primary's
 * error is the one reported.
 */
export function withFallback(primary: AiPipeline, fallback: AiPipeline): AiPipeline {
  const attempt = async <T>(run: (pipeline: AiPipeline) => Promise<T>): Promise<T> => {
    try {
      return await run(primary);
    } catch (error) {
      try { return await run(fallback); } catch { throw error; }
    }
  };
  return {
    classify: (input) => attempt((pipeline) => pipeline.classify(input)),
    draft: (input) => attempt((pipeline) => pipeline.draft(input)),
    suggestDeal: (input) => attempt((pipeline) => pipeline.suggestDeal(input)),
  };
}

/**
 * Production may never silently substitute a keyword classifier for the
 * configured model. The fallback is intentionally opt-in for tests and local
 * visual demos, and every fallback result remains version-stamped.
 */
export function createPipeline(options: { allowHeuristic?: boolean } = {}): AiPipeline {
  const provider = configuredModelProvider();
  if (provider) {
    const fallback = configuredFallbackProvider();
    const primary = pipelineFor(provider);
    return fallback && fallback !== provider ? withFallback(primary, pipelineFor(fallback)) : primary;
  }

  const explicitlyAllowed =
    process.env.NODE_ENV !== "production" &&
    (options.allowHeuristic === true || process.env.DEALDOCK_AI_MODE === "heuristic");
  if (explicitlyAllowed) return new HeuristicPipeline();

  throw new Error(
    "AI model is not configured. Set GROQ_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY and model names; " +
      "heuristic mode is development/test-only (DEALDOCK_AI_MODE=heuristic)."
  );
}
