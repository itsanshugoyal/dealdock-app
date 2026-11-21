import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configuredModelProvider, createPipeline, GroqRateLimitError, HEURISTIC_MODEL_VERSION, PROMPT_VERSION } from "../src/index";
import { groqModel } from "../src/provider";
import type { CreatorContext, DraftExemplar } from "../src/types";
import { checkpointFingerprint } from "./checkpoint";
import { DraftCheckpoint, type DraftRecord } from "./draft-checkpoint";
import { GOLDEN_SET } from "./golden-set";

/** Synthetic, model-blind 50-draft review sample. Human A/B/C scoring remains required. */
const base: CreatorContext = {
  businessSummary: "Fitness coach selling a 12-week transformation program, 1-on-1 coaching, and a creator course.",
  currencyCode: "INR",
  typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 },
  typicalCoachingMinor: { min: 2_500_000, max: 8_000_000 },
  typicalCourseMinor: { min: 800_000, max: 1_500_000 },
  styleCard: null,
  correctionExamples: [],
};
const profiles: Array<{ id: string; description: string; examples: DraftExemplar[]; creator: CreatorContext }> = [
  {
    id: "A",
    description: "Warm, direct, high-energy; opens 'Hey hey!' and signs '– D'. Light Hinglish if the other person uses it. No offer prices, dates, or links are supplied.",
    examples: [{ messageId: "a1", inboundText: "How does coaching work?", text: "Hey hey! Tell me what you want help with and I'll explain the options. – D", label: "coaching_lead" }],
    creator: { ...base, styleCard: { greeting: "Hey hey!", tone: "warm, direct, high-energy", signoff: "– D", codeSwitching: "light Hinglish when the other side uses it" }, offers: [] },
  },
  {
    id: "B",
    description: "Measured, concise English; opens 'Hello,' and avoids exclamation marks and emoji. Coaching costs ₹18,000 with weekly check-ins. The recorded course costs ₹5,999. No dates or links are supplied.",
    examples: [{ messageId: "b1", inboundText: "Can you tell me more?", text: "Hello, happy to explain. Which part would you like to know about?", label: null }],
    creator: { ...base, styleCard: { greeting: "Hello,", tone: "measured, concise and professional", emojiUsage: "none", codeSwitching: "English only" },
      offers: [
        { id: "b-coach", name: "One-to-one coaching", dealType: "coaching", priceMinMinor: 1_800_000, priceMaxMinor: 1_800_000, details: "Weekly check-ins", availability: null, link: null },
        { id: "b-course", name: "Recorded creator course", dealType: "course", priceMinMinor: 599_900, priceMaxMinor: 599_900, details: "Recorded lessons", availability: null, link: null },
      ] },
  },
  {
    id: "C",
    description: "Relaxed, short texts, often starts 'heyy'; naturally mixes Hindi and English when appropriate, with no sign-off. Coaching is ₹32,000. The course costs ₹8,999 and its next batch starts 15 January 2027. No links are supplied.",
    examples: [{ messageId: "c1", inboundText: "Can I get details?", text: "heyy haan, kya jaan-na hai? happy to help", label: null }],
    creator: { ...base, styleCard: { greeting: "heyy", tone: "casual, short and friendly", sentenceLength: "short", emojiUsage: "none", codeSwitching: "English and light Hinglish" },
      offers: [
        { id: "c-coach", name: "Personal coaching", dealType: "coaching", priceMinMinor: 3_200_000, priceMaxMinor: 3_200_000, details: null, availability: null, link: null },
        { id: "c-course", name: "Creator course", dealType: "course", priceMinMinor: 899_900, priceMaxMinor: 899_900, details: null, availability: "Next batch starts 15 January 2027", link: null },
      ] },
  },
];
const HIGH_INTENT = ["brand_deal", "coaching_lead", "course_inquiry", "other_commerce"];

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
  const provider = configuredModelProvider();
  const seen = new Set<string>();
  const unique = GOLDEN_SET.filter((c) => {
    const key = `${c.label}:${c.handle}`;
    if (!HIGH_INTENT.includes(c.label) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const cases = shuffled(unique).slice(0, 50);
  if (cases.length !== 50) throw new Error("Blind review requires 50 distinct synthetic cases.");
  const outPath = process.env.DEALDOCK_DRAFT_SAMPLE_OUT ? resolve(process.env.DEALDOCK_DRAFT_SAMPLE_OUT) : join(__dirname, "..", "..", "..", "docs", "draft-review-sample.md");
  const metadataPath = `${outPath}.metadata.json`;
  if ((existsSync(outPath) || existsSync(metadataPath)) && process.env.DEALDOCK_DRAFT_SAMPLE_ALLOW_OVERWRITE !== "1") {
    throw new Error("Draft sample output already exists. Choose a new DEALDOCK_DRAFT_SAMPLE_OUT or explicitly allow overwriting it.");
  }
  const checkpointPath = process.env.DEALDOCK_DRAFT_CHECKPOINT?.trim();
  if (checkpointPath && (provider !== "groq" || process.env.CI)) throw new Error("Draft checkpoints are only available for local Groq sample generation, not CI.");
  const model = provider === "groq" ? groqModel("draft") : "";
  const sourceDirectories = [join(__dirname, "..", "src"), join(__dirname, "..", "..", "core", "src")];
  const checkpoint = checkpointPath ? new DraftCheckpoint(
    resolve(checkpointPath),
    checkpointFingerprint({ model, profiles, cases, promptVersion: PROMPT_VERSION, script: readFileSync(__filename, "utf8"),
      source: sourceDirectories.flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".ts")).sort().map((name) => readFileSync(join(dir, name), "utf8"))) }),
    cases.length, `groq:${model}`, `${PROMPT_VERSION}-groq1`,
  ) : null;
  if (checkpoint) console.log("Local synthetic draft checkpoint enabled.");

  const lines: string[] = [
    "# Blind draft-review sample", "",
    "Score independently: **A** = would send as-is · **B** = minor edits · **C** = rewrite. The M2 gate is at least 70% A+B.",
    "All creators and messages are fictional. The model identity is in a separate metadata file; avoid opening it before scoring.",
    "Evaluate whether each reply answers the message, matches that creator's voice, and avoids unsupported prices, dates and promises.", "",
    "## Fictional creator profiles", "",
    ...profiles.flatMap((p) => [`**Creator ${p.id}:** ${p.description}`, `Style example: “${p.examples[0]!.text}”`, ""]),
    "| # | Score (A/B/C) | Notes |", "|---|---|---|", ...cases.map((_, i) => `| ${i + 1} |  |  |`), "", "---", "",
  ];
  let version: { modelVersion: string; promptVersion: string } | undefined;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const profile = profiles[i % profiles.length]!;
    let d: DraftRecord | undefined = checkpoint?.get(i);
    let retries = 0;
    while (!d) {
      try {
        const generated = await pipeline.draft({ kind: "reply", classificationLabel: c.label, threadHistory: [{ direction: "inbound", text: c.text }], creator: profile.creator, exemplars: profile.examples, voiceConsent: true });
        d = { body: generated.body, modelVersion: generated.modelVersion, promptVersion: generated.promptVersion };
        checkpoint?.save(i, d);
      } catch (error) {
        if (!(error instanceof GroqRateLimitError) || error.retryAfterMs === null || error.retryAfterMs > 60_000 || retries >= 3) throw error;
        retries++;
        console.log(`Groq rate limit: retrying this draft in ${Math.ceil(error.retryAfterMs / 1000)}s (${retries}/3).`);
        const delayMs = Math.max(error.retryAfterMs, 1_000);
        await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
      }
    }
    if (!version) version = { modelVersion: d.modelVersion, promptVersion: d.promptVersion };
    else if (version.modelVersion !== d.modelVersion || version.promptVersion !== d.promptVersion) throw new Error("Draft sample contains mixed model or prompt versions.");
    lines.push(`## ${i + 1} · Creator ${profile.id}`, "", `**Them (@${c.handle}):** ${c.text}`, "", "**Draft:**", "", d.body.split("\n").map((l) => `> ${l}`).join("\n"), "");
    if ((i + 1) % 10 === 0) console.log(`Generated or restored ${i + 1}/${cases.length} drafts.`);
  }
  const content = lines.join("\n");
  const metadata = { generatedAt: new Date().toISOString(), modelVersion: version?.modelVersion ?? provider ?? HEURISTIC_MODEL_VERSION,
    promptVersion: version?.promptVersion ?? PROMPT_VERSION, cases: cases.length, fictionalCreators: profiles.length,
    unscoredSampleSha256: createHash("sha256").update(content).digest("hex") };
  writeFileSync(outPath, content, "utf8");
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  console.log(`Wrote ${cases.length} unscored drafts → ${outPath}; model metadata → ${metadataPath}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
