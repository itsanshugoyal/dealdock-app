import {
  CLASSIFICATION_LABELS,
  REVIEW_CONFIDENCE_THRESHOLD,
  type ClassificationLabel,
} from "@dealdock/core";
import { createPipeline, HEURISTIC_MODEL_VERSION } from "../src/index";
import type { CreatorContext } from "../src/types";
import { GOLDEN_SET, type EvalCase } from "./golden-set";
import { exactLabelAccuracy } from "./scoring";

/**
 * Eval harness (PLAN.md M2). Scores the active pipeline against the golden set:
 *   - distinct Brand / Coaching / Course / Fan / Spam accuracy (PRD §7.4)
 *   - exact-label accuracy + confusion matrix
 *   - Hinglish vs English slices (parity within 3 points — PRD §7.4)
 *   - value calibration: commerce estimates overlap the creator's typical range
 *   - ROUTING INVARIANT: every prediction below 0.80 confidence must route to
 *     review — checked here AND enforced in the worker; belt and braces.
 *
 * Gates (exit non-zero) when running the REAL configured model:
 *   each core class ≥ 0.85, abstention coverage ≥ 0.95, Hinglish gap ≤ 0.03.
 * The heuristic fallback is reported but never gated — it exists to keep dev
 * moving, not to pass quality bars (its rows are version-stamped).
 */

const EVAL_CREATOR: CreatorContext = {
  businessSummary:
    "Fitness coach selling a 12-week transformation program, 1-on-1 coaching, and a creator course.",
  currencyCode: "INR",
  typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 },
  typicalCoachingMinor: { min: 2_500_000, max: 8_000_000 },
  typicalCourseMinor: { min: 800_000, max: 1_500_000 },
  styleCard: null,
  correctionExamples: [],
};

const GATED_LABELS: readonly ClassificationLabel[] = [
  "brand_deal", "coaching_lead", "course_inquiry", "fan", "spam",
];

interface CaseResult {
  c: EvalCase;
  predicted: ClassificationLabel;
  confidence: number;
  routedTo: "inbox" | "review_queue";
  valueOk: boolean | null;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const isRealModel = Boolean(
    process.env.ANTHROPIC_API_KEY && process.env.CLASSIFY_MODEL && process.env.DRAFT_MODEL
  );
  const pipeline = createPipeline({ allowHeuristic: !isRealModel });
  const concurrency = isRealModel ? 8 : 64;

  console.log(
    `\nDealDock eval · ${GOLDEN_SET.length} cases · pipeline: ${isRealModel ? "Claude" : HEURISTIC_MODEL_VERSION}\n`
  );

  const results: CaseResult[] = [];
  let inFlight: Promise<void>[] = [];
  for (const c of GOLDEN_SET) {
    const p = (async () => {
      const r = await pipeline.classify({
        messageText: c.text,
        senderHandle: c.handle,
        creator: EVAL_CREATOR,
      });
      const anchor =
        c.valueAnchor === "brand"
          ? EVAL_CREATOR.typicalBrandDealMinor
          : c.valueAnchor === "coaching"
            ? EVAL_CREATOR.typicalCoachingMinor
            : c.valueAnchor === "course"
              ? EVAL_CREATOR.typicalCourseMinor
              : null;
      // Calibration: predicted range must overlap the anchor range (loose ±50%).
      const valueOk =
        anchor === null
          ? null
          : r.valueRange !== null &&
            r.valueRange.maxMinor >= anchor.min * 0.5 &&
            r.valueRange.minMinor <= anchor.max * 1.5;
      results.push({
        c,
        predicted: r.label,
        confidence: r.confidence,
        routedTo: r.label !== "uncertain" && r.confidence >= REVIEW_CONFIDENCE_THRESHOLD ? "inbox" : "review_queue",
        valueOk,
      });
    })();
    inFlight.push(p);
    if (inFlight.length >= concurrency) {
      await Promise.all(inFlight);
      inFlight = [];
    }
  }
  await Promise.all(inFlight);

  // ── Scores ────────────────────────────────────────────────────────────────
  const scored = results.filter((r) => r.routedTo === "inbox");
  const labelAccuracy = (label: ClassificationLabel, rs = results) => {
    const examples = rs.filter((r) => r.c.label === label);
    return examples.length === 0 ? 0 : examples.filter((r) => r.predicted === label).length / examples.length;
  };

  // Inbox precision is a separate diagnostic, never the headline accuracy.
  // Otherwise a model can improve its apparent accuracy simply by abstaining.
  const decisive = scored.filter((r) => r.c.label !== "uncertain");
  const uncertainTruth = results.filter((r) => r.c.label === "uncertain");
  const uncertainRoutedRight =
    uncertainTruth.length === 0
      ? 1
      : uncertainTruth.filter(
          (r) => r.routedTo === "review_queue" || r.predicted === "uncertain"
        ).length / uncertainTruth.length;

  const gated = results.filter((r) => GATED_LABELS.includes(r.c.label));
  const gatedAccuracy = exactLabelAccuracy;
  const parityCases = results.filter((r) => r.c.label !== "uncertain");
  const hinglish = parityCases.filter((r) => r.c.language !== "en");
  const english = parityCases.filter((r) => r.c.language === "en");
  const hard = gated.filter((r) => r.c.hard);
  const valueCases = results.filter((r) => r.valueOk !== null);
  const valueOkRate =
    valueCases.length === 0 ? 1 : valueCases.filter((r) => r.valueOk).length / valueCases.length;

  // Routing invariant — no prediction below threshold may sit in the inbox.
  const invariantViolations = results.filter(
    (r) => r.confidence < REVIEW_CONFIDENCE_THRESHOLD && r.routedTo === "inbox"
  );

  const reviewRate = results.filter((r) => r.routedTo === "review_queue").length / results.length;
  const abstentionCoverage =
    uncertainTruth.length === 0 ? 1 : uncertainTruth.filter((r) => r.routedTo === "review_queue").length / uncertainTruth.length;

  console.log("Distinct class accuracy (all cases, including abstentions):");
  for (const label of GATED_LABELS) console.log(`  ${label}: ${pct(labelAccuracy(label))}`);
  console.log(`Exact-label accuracy (all ${results.length} examples):       ${pct(exactLabelAccuracy(results))}`);
  console.log(`Inbox precision (confident non-uncertain only):  ${pct(exactLabelAccuracy(decisive))}`);
  console.log(`  Hinglish slice: ${pct(gatedAccuracy(hinglish))} (${hinglish.length})   English slice: ${pct(gatedAccuracy(english))} (${english.length})`);
  console.log(`  Hard cases:     ${pct(gatedAccuracy(hard))} (${hard.length})`);
  console.log(`Uncertain-truth handled correctly:               ${pct(uncertainRoutedRight)}`);
  console.log(`Abstention coverage (uncertain -> review):       ${pct(abstentionCoverage)}`);
  console.log(`Value calibration (overlaps creator range):      ${pct(valueOkRate)} (${valueCases.length})`);
  console.log(`Routed to review overall:                        ${pct(reviewRate)}`);
  console.log(`Routing invariant violations:                    ${invariantViolations.length}`);

  // ── Confusion matrix (truth rows × predicted cols) ───────────────────────
  console.log("\nConfusion (rows=truth, cols=predicted):");
  const short = (l: string) => l.slice(0, 6).padStart(7);
  console.log("       " + CLASSIFICATION_LABELS.map(short).join(""));
  for (const t of CLASSIFICATION_LABELS) {
    const row = CLASSIFICATION_LABELS.map(
      (p) => results.filter((r) => r.c.label === t && r.predicted === p).length
    );
    console.log(short(t) + row.map((n) => String(n).padStart(7)).join(""));
  }

  // Worst misses for debugging
  const misses = gated.filter((r) => r.predicted !== r.c.label).slice(0, 8);
  if (misses.length) {
    console.log("\nSample distinct-class misses:");
    for (const m of misses) {
      console.log(`  [${m.c.label} → ${m.predicted}] @${m.c.handle}: "${m.c.text.slice(0, 70)}..."`);
    }
  }

  // ── Gates ─────────────────────────────────────────────────────────────────
  const failures: string[] = [];
  if (invariantViolations.length > 0) {
    failures.push(`routing invariant violated ${invariantViolations.length}×`);
  }
  if (isRealModel) {
    if (exactLabelAccuracy(results) < 0.85) failures.push(`top-level accuracy ${pct(exactLabelAccuracy(results))} < 85% (M2 gate)`);
    const gap = Math.abs(gatedAccuracy(hinglish) - gatedAccuracy(english));
    for (const label of GATED_LABELS) {
      const score = labelAccuracy(label);
      if (score < 0.85) failures.push(`${label} accuracy ${pct(score)} < 85% (M2 gate)`);
    }
    if (abstentionCoverage < 0.95) failures.push(`abstention coverage ${pct(abstentionCoverage)} < 95%`);
    if (gap > 0.03) failures.push(`language parity gap ${pct(gap)} > 3 points (PRD §7.4)`);
    if (valueOkRate < 0.8) failures.push(`value calibration ${pct(valueOkRate)} < 80%`);
  } else {
    console.log(
      "\n(heuristic fallback: numbers reported for reference, quality gates apply to the real model only)"
    );
  }

  if (failures.length) {
    console.error(`\nEVAL FAILED:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(isRealModel ? "\nREAL MODEL QUALITY GATE PASSED" : "\nHEURISTIC HARNESS PASSED — real-model quality gate NOT RUN");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
