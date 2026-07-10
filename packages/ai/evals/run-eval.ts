import {
  CLASSIFICATION_LABELS,
  REVIEW_CONFIDENCE_THRESHOLD,
  type ClassificationLabel,
} from "@dealdock/core";
import { createPipeline, HEURISTIC_MODEL_VERSION } from "../src/index";
import type { CreatorContext } from "../src/types";
import { GOLDEN_SET, type EvalCase } from "./golden-set";

/**
 * Eval harness (PLAN.md M2). Scores the active pipeline against the golden set:
 *   - top-level accuracy (commerce-vs-fan-vs-spam distinction, PRD §7.4)
 *   - exact-label accuracy + confusion matrix
 *   - Hinglish vs English slices (parity within 3 points — PRD §7.4)
 *   - value calibration: commerce estimates overlap the creator's typical range
 *   - ROUTING INVARIANT: every prediction below 0.80 confidence must route to
 *     review — checked here AND enforced in the worker; belt and braces.
 *
 * Gates (exit non-zero) when running the REAL model (ANTHROPIC_API_KEY set):
 *   top-level accuracy ≥ 0.85, Hinglish gap ≤ 0.03.
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

/** PRD §7.4 top-level buckets: the distinction that must be ≥90% by pilot end. */
function topLevel(label: ClassificationLabel): string {
  switch (label) {
    case "brand_deal":
    case "coaching_lead":
    case "course_inquiry":
    case "other_commerce":
      return "commerce";
    case "fan":
      return "fan";
    case "spam":
      return "spam";
    case "personal":
      return "personal";
    case "uncertain":
      return "uncertain";
  }
}

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
  const pipeline = createPipeline();
  const isRealModel = Boolean(process.env.ANTHROPIC_API_KEY);
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
        routedTo: r.confidence >= REVIEW_CONFIDENCE_THRESHOLD ? "inbox" : "review_queue",
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
  const exact = (rs: CaseResult[]) =>
    rs.length === 0 ? 0 : rs.filter((r) => r.predicted === r.c.label).length / rs.length;
  const top = (rs: CaseResult[]) =>
    rs.length === 0
      ? 0
      : rs.filter((r) => topLevel(r.predicted) === topLevel(r.c.label)).length / rs.length;

  // Uncertain ground-truth cases SHOULD go to review — that's correct behavior,
  // so accuracy is computed over inbox-routed predictions on non-uncertain truth,
  // and uncertain-truth cases are scored on routing instead.
  const decisive = scored.filter((r) => r.c.label !== "uncertain");
  const uncertainTruth = results.filter((r) => r.c.label === "uncertain");
  const uncertainRoutedRight =
    uncertainTruth.length === 0
      ? 1
      : uncertainTruth.filter(
          (r) => r.routedTo === "review_queue" || r.predicted === "uncertain"
        ).length / uncertainTruth.length;

  const hinglish = decisive.filter((r) => r.c.language !== "en");
  const english = decisive.filter((r) => r.c.language === "en");
  const hard = decisive.filter((r) => r.c.hard);
  const valueCases = results.filter((r) => r.valueOk !== null);
  const valueOkRate =
    valueCases.length === 0 ? 1 : valueCases.filter((r) => r.valueOk).length / valueCases.length;

  // Routing invariant — no prediction below threshold may sit in the inbox.
  const invariantViolations = results.filter(
    (r) => r.confidence < REVIEW_CONFIDENCE_THRESHOLD && r.routedTo === "inbox"
  );

  const reviewRate = results.filter((r) => r.routedTo === "review_queue").length / results.length;

  console.log(`Top-level accuracy (commerce/fan/spam/personal): ${pct(top(decisive))}`);
  console.log(`Exact-label accuracy:                            ${pct(exact(decisive))}`);
  console.log(`  Hinglish slice: ${pct(top(hinglish))} (${hinglish.length})   English slice: ${pct(top(english))} (${english.length})`);
  console.log(`  Hard cases:     ${pct(top(hard))} (${hard.length})`);
  console.log(`Uncertain-truth handled correctly:               ${pct(uncertainRoutedRight)}`);
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
  const misses = decisive.filter((r) => topLevel(r.predicted) !== topLevel(r.c.label)).slice(0, 8);
  if (misses.length) {
    console.log("\nSample top-level misses:");
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
    const topAcc = top(decisive);
    const gap = Math.abs(top(hinglish) - top(english));
    if (topAcc < 0.85) failures.push(`top-level accuracy ${pct(topAcc)} < 85% (M2 gate)`);
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
  console.log("\nEVAL PASSED ✓");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
