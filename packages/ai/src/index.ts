/**
 * @dealdock/ai — the Claude pipeline (ARCHITECTURE.md §5).
 * Classify+value in ONE Haiku structured call; Sonnet drafting with per-creator
 * style cards; prompt caching on the creator system block; every result stamped
 * with model+prompt versions. Returns results; the worker persists them —
 * no DB access here.
 */

export * from "./types";
export { PROMPT_VERSION, buildDraftPrompt, type DraftPrompt } from "./prompts";
export { ClaudePipeline } from "./claude-pipeline";
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

import { ClaudePipeline } from "./claude-pipeline";
import { HeuristicPipeline } from "./heuristic-pipeline";
import type { AiPipeline } from "./types";

/**
 * Production may never silently substitute a keyword classifier for the
 * configured model. The fallback is intentionally opt-in for tests and local
 * visual demos, and every fallback result remains version-stamped.
 */
export function createPipeline(options: { allowHeuristic?: boolean } = {}): AiPipeline {
  if (process.env.ANTHROPIC_API_KEY) return new ClaudePipeline();

  const explicitlyAllowed =
    process.env.NODE_ENV !== "production" &&
    (options.allowHeuristic === true || process.env.DEALDOCK_AI_MODE === "heuristic");
  if (explicitlyAllowed) return new HeuristicPipeline();

  throw new Error(
    "AI model is not configured. Set ANTHROPIC_API_KEY and explicit model names; " +
      "heuristic mode is development/test-only (DEALDOCK_AI_MODE=heuristic)."
  );
}
