import type { ClassificationLabel } from "@dealdock/core";

/** Every golden example remains in the denominator, including abstentions. */
export function exactLabelAccuracy(rows: readonly { c: { label: ClassificationLabel }; predicted: ClassificationLabel }[]) {
  return rows.length === 0 ? 0 : rows.filter(row => row.predicted === row.c.label).length / rows.length;
}
