/**
 * Levenshtein edit distance — the voice-fidelity metric (PRD §7.4):
 * a draft counts as "sent with minor edits" when the final text changed
 * by <20% of the draft's characters.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Edit ratio relative to the draft length (0 = untouched, 1 = fully rewritten). */
export function editRatio(draft: string, finalText: string): number {
  if (draft.length === 0) return finalText.length === 0 ? 0 : 1;
  return Math.min(1, editDistance(draft, finalText) / draft.length);
}

/** PRD §7.4: "no edit or minor edit" = <20% character change. */
export const MINOR_EDIT_THRESHOLD = 0.2;
