import type { DraftContextSummary } from "@dealdock/core";
import { selectExemplars, selectLessons, type ExemplarCandidate, type LessonCandidate, type RetrievalQuery } from "./style-retrieval";
import type { DraftExemplar, DraftResult } from "./types";

/**
 * What every drafting caller (the API's draft route and voice preview, the
 * worker's drafting consumer) does around AiPipeline.draft: retrieval in,
 * the stored "Why this draft" record out. Pure: the pools come from
 * @dealdock/db getDraftVoiceContext, and the record goes to createDraft.
 */

/** Retrieval pools for one draft: exemplar candidates and lesson candidates. */
export interface VoiceContextPools {
  exemplarPool: readonly ExemplarCandidate[];
  lessonPool: readonly LessonCandidate[];
}

/** The creator's closest past replies and edit lessons, shaped as DraftInput takes them. */
export function retrieveVoiceContext(query: RetrievalQuery, pools: VoiceContextPools): { exemplars: DraftExemplar[]; lessons: string[] } {
  return {
    exemplars: selectExemplars(query, pools.exemplarPool).map((e) => ({ messageId: e.messageId, text: e.text, inboundText: e.inboundText, label: e.label })),
    lessons: selectLessons(query, pools.lessonPool).map((l) => l.text),
  };
}

/**
 * Draft.generationContext as stored: the summary plus the prompt version and
 * the lint violations left after the retry. The summary is copied through a
 * mapped type because an interface is not assignable to the JSON record
 * createDraft takes.
 */
export type DraftGenerationContext = { [K in keyof DraftContextSummary]: DraftContextSummary[K] } & {
  promptVersion: string;
  lintViolations: string[];
};

/** The generationContext to store with a draft; null when the pipeline reported no context. */
export function generationContextOf(result: Pick<DraftResult, "context" | "promptVersion" | "lintViolations">): DraftGenerationContext | null {
  return result.context ? { ...result.context, promptVersion: result.promptVersion, lintViolations: result.lintViolations ?? [] } : null;
}
