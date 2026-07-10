/**
 * @dealdock/ai — the Claude pipeline (ARCHITECTURE.md §5).
 * Classify+value in ONE Haiku structured call; Sonnet drafting with per-creator
 * style cards; prompt caching on the creator system block; every result stamped
 * with model+prompt versions. Returns results; the worker persists them —
 * no DB access here.
 */

export * from "./types";
export { PROMPT_VERSION } from "./prompts";
export { ClaudePipeline } from "./claude-pipeline";
export { HeuristicPipeline, HEURISTIC_MODEL_VERSION } from "./heuristic-pipeline";
export { extractStyleCard, heuristicStyleCard, type StyleCardResult } from "./voice";

import { ClaudePipeline } from "./claude-pipeline";
import { HeuristicPipeline } from "./heuristic-pipeline";
import type { AiPipeline } from "./types";

/**
 * Factory: Claude when a key is configured, deterministic heuristic otherwise
 * (local dev / CI / demos). Heuristic rows are version-stamped so they never
 * pollute real accuracy metrics.
 */
export function createPipeline(): AiPipeline {
  return process.env.ANTHROPIC_API_KEY ? new ClaudePipeline() : new HeuristicPipeline();
}
