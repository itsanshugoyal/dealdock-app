import { editDistance, MINOR_EDIT_THRESHOLD } from "@dealdock/core";

/**
 * Voice match (PRD §7.4) for every read model — Voice Studio, Insights, the
 * weekly digest and the internal metrics — so one send is "in your voice"
 * everywhere or nowhere. The ratio is core editRatio; see sentEditRatio.
 */

/** The Draft columns a sent draft's edit ratio comes from. */
export interface SentEdit {
  body: string;
  editDistance: number | null;
  editRatio: number | null;
}

/**
 * core editRatio(body, finalText) from an edit distance already measured
 * between them, so a send needs one Levenshtein, not two. An empty draft
 * gives 0 or 1 exactly as editRatio does.
 */
export function ratioFromDistance(distance: number, draftBody: string): number {
  return Math.min(1, distance / Math.max(1, draftBody.length));
}

/** What a send stores: the edit distance and the edit ratio, from one Levenshtein. */
export function measureEdit(draftBody: string, finalText: string): { editDistance: number; editRatio: number } {
  const distance = editDistance(draftBody, finalText);
  return { editDistance: distance, editRatio: ratioFromDistance(distance, draftBody) };
}

/**
 * A sent draft's edit ratio: the one recorded at send, else (sends from
 * before the redesign stored only the distance) derived from the distance;
 * null when neither was recorded.
 */
export function sentEditRatio(draft: SentEdit): number | null {
  if (draft.editRatio !== null) return draft.editRatio;
  return draft.editDistance === null ? null : ratioFromDistance(draft.editDistance, draft.body);
}

/** A send is in the creator's voice when under 20% of the draft changed. */
export function isVoiceMatch(ratio: number): boolean {
  return ratio < MINOR_EDIT_THRESHOLD;
}

/** Whole-percent share of sends in the creator's voice; null with nothing to measure. */
export function voiceMatchPct(ratios: number[]): number | null {
  if (ratios.length === 0) return null;
  return Math.round((ratios.filter(isVoiceMatch).length / ratios.length) * 100);
}

/** The measurable edit ratios of these sends (unmeasured legacy rows are skipped). */
export function sentEditRatios(drafts: SentEdit[]): number[] {
  return drafts.flatMap((draft) => {
    const ratio = sentEditRatio(draft);
    return ratio === null ? [] : [ratio];
  });
}
