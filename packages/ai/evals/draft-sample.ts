import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPipeline, HEURISTIC_MODEL_VERSION } from "../src/index";
import type { CreatorContext } from "../src/types";
import { GOLDEN_SET } from "./golden-set";

/**
 * Generates the 50-draft blind-review sample (M2 exit criterion: founding team
 * scores each draft "would send as-is / minor edits / rewrite"; ≥70% must land
 * in the first two buckets). Output is shuffle-ordered and unlabeled so the
 * reviewer can't pattern-match on message type.
 */

const CREATOR: CreatorContext = {
  businessSummary:
    "Fitness coach selling a 12-week transformation program, 1-on-1 coaching, and a creator course.",
  currencyCode: "INR",
  typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 },
  typicalCoachingMinor: { min: 2_500_000, max: 8_000_000 },
  typicalCourseMinor: { min: 800_000, max: 1_500_000 },
  styleCard: {
    greeting: "Hey hey!",
    tone: "warm, direct, high-energy",
    signoff: "– D",
    codeSwitching: "light Hinglish when the other side uses it",
  },
  correctionExamples: [],
};

const HIGH_INTENT = ["brand_deal", "coaching_lead", "course_inquiry", "other_commerce"];

/** Deterministic shuffle (mulberry32) so re-runs produce the same order. */
function shuffled<T>(arr: T[], seed = 42): T[] {
  const a = [...arr];
  let s = seed;
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function main() {
  const pipeline = createPipeline();
  const isRealModel = Boolean(process.env.ANTHROPIC_API_KEY);
  const cases = shuffled(GOLDEN_SET.filter((c) => HIGH_INTENT.includes(c.label))).slice(0, 50);

  const lines: string[] = [
    "# Draft blind-review sample",
    "",
    `Generated: ${new Date().toISOString().slice(0, 10)} · pipeline: ${isRealModel ? "Claude" : HEURISTIC_MODEL_VERSION}`,
    "",
    "Score each draft: **A** = would send as-is · **B** = minor edits · **C** = rewrite.",
    "M2 gate: ≥70% A+B (PRD §7.4 voice fidelity). Don't peek at each other's scores.",
    "",
    "| # | Score (A/B/C) | Notes |",
    "|---|---|---|",
    ...cases.map((_, i) => `| ${i + 1} |  |  |`),
    "",
    "---",
    "",
  ];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const d = await pipeline.draft({
      kind: "reply",
      classificationLabel: c.label,
      threadHistory: [{ direction: "inbound", text: c.text }],
      creator: CREATOR,
    });
    lines.push(`## ${i + 1}`);
    lines.push("");
    lines.push(`**Them (@${c.handle}):** ${c.text}`);
    lines.push("");
    lines.push(`**Draft:**`);
    lines.push("");
    lines.push(d.body.split("\n").map((l) => `> ${l}`).join("\n"));
    lines.push("");
  }

  const outPath = join(__dirname, "..", "..", "..", "docs", "draft-review-sample.md");
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${cases.length} drafts → docs/draft-review-sample.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
