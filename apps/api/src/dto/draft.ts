import { isDraftChip, type ClassificationLabel, type DraftContextSummary, type DraftDto, type DraftKind, type DraftPurpose, type DraftStatus } from "@dealdock/core";

export const DRAFT_PURPOSES = ["recap", "payment_reminder", "invoice", "usage_renewal", "renewal"] as const satisfies readonly DraftPurpose[];

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
  /** Draft.generationContext as stored; its `purpose` says what job the draft was written for. */
  generationContext: unknown;
  /** An invoice cover note's invoice (its PDF goes with the send). */
  invoiceId?: string | null;
}

/** The deal a purpose draft was written for, as the drafting route stored it. */
function dealIdOf(generationContext: unknown): string | null {
  const dealId = (generationContext as { dealId?: unknown } | null)?.dealId;
  return typeof dealId === "string" && dealId ? dealId : null;
}

function purposeOf(generationContext: unknown): DraftPurpose | null {
  const purpose = (generationContext as { purpose?: unknown } | null)?.purpose;
  return DRAFT_PURPOSES.find((known) => known === purpose) ?? null;
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
    purpose: purposeOf(draft.generationContext),
    dealId: dealIdOf(draft.generationContext),
    invoiceId: draft.invoiceId ?? null,
  };
}
