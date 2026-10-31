import { isDraftChip, type ClassificationLabel, type DraftContextSummary, type DraftDto, type DraftKind, type DraftStatus } from "@dealdock/core";

export interface DraftRecord {
  id: string;
  body: string;
  kind: DraftKind;
  status: DraftStatus;
  version: number;
  label: ClassificationLabel | null;
  instruction: string | null;
  chips: string[];
  alternatives: string[];
  chosenAlternative: number | null;
}

/** A live draft as the API shows it; `context` comes from resolveDraftContext. */
export function toDraftDto(draft: DraftRecord, context: DraftContextSummary | null): DraftDto {
  return {
    id: draft.id,
    body: draft.body,
    kind: draft.kind,
    status: draft.status,
    version: draft.version,
    label: draft.label,
    instruction: draft.instruction,
    // Stored as text[]; never forward a value the client's union doesn't know.
    chips: draft.chips.filter(isDraftChip),
    alternatives: draft.alternatives.slice(0, 3),
    chosenAlternative: draft.chosenAlternative,
    context,
  };
}
