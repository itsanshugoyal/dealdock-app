import { describe, expect, it } from "vitest";
import { editRatio, type DraftChip } from "@dealdock/core";
import {
  analyzeEdit,
  applyRuleEvidence,
  checkRuleAgainstText,
  CHIP_INSTRUCTIONS,
  chipEvidence,
  composeStyleCard,
  decayEvidence,
  DRAFT_CHIPS,
  editEvidence,
  genericAvoidList,
  lintDraft,
  lintRetryInstruction,
  measureStyle,
  nextRuleStatus,
  planRuleUpdates,
  planSeedRules,
  planVoiceRefresh,
  provenanceWeight,
  RULE_HALF_LIFE_DAYS,
  seedRulesFromMeasured,
  selectVoiceSamples,
  steeringText,
  summarizeLearnedSignals,
  type CorpusMessage,
  type RuleEvidence,
  type VoiceRuleState,
} from "../src/style-learning";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 864e5);

let seq = 0;
function message(over: Partial<CorpusMessage> = {}): CorpusMessage {
  seq++;
  return {
    messageId: `m${seq}`,
    threadId: `t${seq}`,
    text: `Hey hey! Send me the brief and the budget please ${seq}`,
    sentAt: daysAgo(seq % 30),
    origin: "native",
    label: "brand_deal",
    draftKind: null,
    editRatio: null,
    seatRole: null,
    inboundText: "Hi, we'd love to collaborate on a reel",
    ...over,
  };
}

function rule(over: Partial<VoiceRuleState> = {}): VoiceRuleState {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    key: "greeting:hey hey",
    text: "Open with “Hey hey!”",
    scope: "brand_deal",
    status: "candidate",
    source: "edits",
    evidence: 0,
    against: 0,
    distinctDrafts: 0,
    distinctThreads: 0,
    creatorEvidence: 0,
    examples: [],
    lastEvidenceAt: null,
    createdAt: daysAgo(10),
    ...over,
  };
}

function support(key: string, i: number, over: Partial<RuleEvidence> = {}): RuleEvidence {
  return { key, text: key, scope: "brand_deal", polarity: 1, weight: 1, source: "edits", draftId: `d${i}`, threadId: `th${i}`, seatRole: "creator", ...over };
}

describe("sample selection", () => {
  it("drops excluded, link-only, personal/spam, automation and untouched DealDock messages", () => {
    const rows = [
      message({ messageId: "keep" }),
      message({ messageId: "mine-excluded" }),
      message({ text: "https://example.com/kit" }),
      message({ label: "personal" }),
      message({ label: "spam" }),
      message({ origin: "automation" }),
      message({ origin: "dealdock", editRatio: 0 }),
      message({ text: "ok" }),
    ];
    const { samples, excluded } = selectVoiceSamples(rows, ["mine-excluded"]);
    expect(samples.map((s) => s.messageId)).toEqual(["keep"]);
    expect(excluded).toEqual({ excluded_by_you: 1, link_only: 1, personal: 2, automation: 1, unedited_draft: 1, too_short: 1 });
  });

  it("keeps one copy of a repeated text and weighs a template sent to ≥ 3 threads at 0.3×", () => {
    const template = "Hey! DM me your brief and budget";
    const twice = "Sure, send it over when ready";
    const { samples, excluded } = selectVoiceSamples([
      message({ text: template, threadId: "a" }),
      message({ text: template, threadId: "b" }),
      message({ text: `${template}!`, threadId: "c" }),
      message({ text: twice, threadId: "a" }),
      message({ text: twice, threadId: "b" }),
    ]);
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.text.startsWith("Hey!"))).toMatchObject({ template: true, weight: 0.3 });
    expect(samples.find((s) => s.text === twice)).toMatchObject({ template: false, weight: 1 });
    expect(excluded.duplicate).toBe(3);
  });

  it("drops AI-sounding messages, but self-disables when that is most of the corpus", () => {
    const ai = "Thanks for reaching out! Feel free to send the brief over";
    const mostlyHuman = selectVoiceSamples([message({ text: ai }), message(), message(), message()]);
    expect(mostlyHuman.samples).toHaveLength(3);
    expect(mostlyHuman.excluded.ai_sounding).toBe(1);
    const mostlyAi = selectVoiceSamples([message({ text: `${ai} 1` }), message({ text: `${ai} 2` }), message({ text: `${ai} 3` }), message()]);
    expect(mostlyAi.samples).toHaveLength(4);
  });

  it("weights provenance: native 1, rewritten 0.9, lightly edited 0.5, untouched 0, other seats half", () => {
    expect(provenanceWeight({ origin: "native", editRatio: null, seatRole: null })).toBe(1);
    expect(provenanceWeight({ origin: "dealdock", editRatio: 0.6, seatRole: "creator" })).toBe(0.9);
    expect(provenanceWeight({ origin: "dealdock", editRatio: 0.2, seatRole: "creator" })).toBe(0.5);
    expect(provenanceWeight({ origin: "dealdock", editRatio: 0, seatRole: "creator" })).toBe(0);
    expect(provenanceWeight({ origin: "automation", editRatio: null, seatRole: null })).toBe(0);
    expect(provenanceWeight({ origin: "dealdock", editRatio: 0.6, seatRole: "assistant" })).toBe(0.45);
  });
});

describe("measured style and seed rules", () => {
  const brand = Array.from({ length: 8 }, (_, i) =>
    message({ text: i % 2 === 0 ? `Heyy! Love this, send the brief over ${i}` : `Sure, share the deliverables and timeline ${i}`, label: "brand_deal" })
  );
  const coaching = Array.from({ length: 4 }, (_, i) => message({ text: `Haan ji, program ke details bhejta hoon ${i}`, label: "coaching_lead" }));

  it("measures 'all' from 3 samples and a specific scope only from 5", () => {
    const { samples } = selectVoiceSamples([...brand, ...coaching]);
    const measured = measureStyle(samples);
    expect(measured.map((m) => m.scope)).toEqual(["all", "brand_deal"]);
    const all = measured[0]!;
    expect(all.samples).toBe(12);
    expect(all.hinglishIndex).toBeGreaterThan(0);
    expect(measured[1]!.topOpeners[0]).toBe("Heyy!");
    expect(measured[1]!.openers[0]!.share).toBe(0.5);
  });

  it("seeds a greeting only at ≥ 40% share of ≥ 8 messages, always a length rule, caps seeds under 10 samples", () => {
    const { samples } = selectVoiceSamples(brand);
    const seeds = seedRulesFromMeasured(measureStyle(samples), samples);
    const greeting = seeds.find((s) => s.key === "greeting:heyy" && s.scope === "brand_deal");
    expect(greeting).toMatchObject({ evidence: 1.5, distinctDrafts: 4 });
    expect(seeds.filter((s) => s.key.startsWith("length:"))).toHaveLength(2);
    expect(seeds.every((s) => s.key.startsWith("length:") || s.evidence <= 2)).toBe(true);
    const seven = selectVoiceSamples(brand.slice(0, 7)).samples;
    expect(seedRulesFromMeasured(measureStyle(seven), seven).some((s) => s.key.startsWith("greeting:"))).toBe(false);
  });

  it("keeps stock AI phrases the creator genuinely uses off the avoid list", () => {
    const native = Array.from({ length: 10 }, (_, i) => message({ text: i === 0 ? "Kindly share the brief over mail" : `Send the brief over ${i}` }));
    const avoid = genericAvoidList(selectVoiceSamples(native).samples);
    expect(avoid).not.toContain("kindly");
    expect(avoid).toContain("thanks for reaching out");
  });

  it("plans a refresh and composes a v2 card that keeps the v1 keys", () => {
    const plan = planVoiceRefresh([...brand, ...coaching]);
    expect(plan.eligibleCount).toBe(12);
    expect(plan.extractionTexts.length).toBeLessThanOrEqual(40);
    const card = composeStyleCard({ greeting: "Heyy!", tone: "warm", extra: "ignored" }, plan, NOW);
    expect(card).toMatchObject({ greeting: "Heyy!", tone: "warm", v: 2, sampleCount: 12, computedAt: NOW.toISOString() });
    expect(card).not.toHaveProperty("extra");
  });
});

describe("analyzeEdit", () => {
  const keys = (draft: string, final: string) => analyzeEdit(draft, final).signals.map((s) => s.key);

  it("reports an untouched send as accepted", () => {
    expect(analyzeEdit("Send the brief!", "Send the brief!")).toEqual({ kind: "accepted", editRatio: 0, signals: [] });
    expect(analyzeEdit("Send the brief!", "Send the brief! ", 0.0625)).toEqual({ kind: "accepted", editRatio: 0, signals: [] });
  });

  it("reuses the ratio measured at send, and measures it when the draft has none", () => {
    const draft = "Thanks for reaching out! Could you share the brief?";
    const sent = "Hey hey! Could you share the brief?";
    const measured = analyzeEdit(draft, sent);
    expect(analyzeEdit(draft, sent, editRatio(draft, sent))).toEqual(measured);
    expect(analyzeEdit(draft, sent, null)).toEqual(measured);
    expect(analyzeEdit(draft, sent, Number.NaN)).toEqual(measured);
    expect(analyzeEdit(draft, sent, 0.123456).editRatio).toBe(0.1235);
  });

  it("turns a greeting swap into one greeting signal, with no duplicate avoid for that span", () => {
    const k = keys("Thanks for reaching out! Could you share the brief?", "Hey hey! Could you share the brief?");
    expect(k).toContain("greeting:hey hey");
    expect(k.some((key) => key.startsWith("avoid:"))).toBe(false);
    expect(k.some((key) => key.startsWith("prefer:"))).toBe(false);
  });

  it("detects sign-offs added and removed", () => {
    const body = "Sounds great, send me the brief and timeline";
    expect(keys(body, `${body}\nCheers ✨`)).toEqual(expect.arrayContaining(["signoff:cheers", "emoji:light"]));
    expect(keys(`${body}\nCheers`, body)).toContain("signoff:none");
  });

  it("turns a removed 2–8 word phrase into avoid:<phrase> with the replacement at the same spot", () => {
    const analysis = analyzeEdit("Hey! Please feel free to send the brief over.", "Hey! Please just send the brief over.");
    const avoid = analysis.signals.find((s) => s.key === "avoid:feel free to");
    expect(avoid).toMatchObject({ text: "Say “just” instead of “feel free to”", after: "just" });
  });

  it("treats a price-only edit as a fact fix, never style", () => {
    expect(analyzeEdit("The fee is ₹20k for one reel.", "The fee is ₹25k for one reel.")).toMatchObject({ kind: "fact_edit", signals: [] });
    expect(summarizeLearnedSignals("The fee is ₹20k for one reel.", "The fee is ₹25k for one reel.")).toEqual([]);
  });

  it("separates a real length change from a kept length", () => {
    const sentence = "We would love to work on this campaign with your team soon. ";
    const sixty = sentence.repeat(5).trim(); // 60 words
    const thirty = `${sentence.repeat(2).trim()} Let us talk about it soon`; // 30 words
    const shorter = analyzeEdit(sixty, thirty).signals.find((s) => s.key.startsWith("length:"));
    expect(shorter).toMatchObject({ key: "length:short", weight: 1, strong: true });
    const kept = analyzeEdit(sixty, sixty.replace("soon.", "soon!")).signals;
    expect(kept.map((s) => [s.key, s.weight])).toEqual([["length:medium", 0.3]]);
    const nearly = analyzeEdit(sixty, `${sixty} Thanks`).signals.find((s) => s.key.startsWith("length:"));
    expect(nearly).toMatchObject({ weight: 0.3, strong: false });
  });

  it("detects emoji, Hinglish shifts, Devanagari and casing", () => {
    expect(keys("Sounds good, send the brief", "Sounds good, send the brief 🔥🔥")).toContain("emoji:light");
    expect(keys("Sure, please share the brief and budget", "Haan ji, brief aur budget share kar do")).toContain("language:hinglish");
    expect(keys("Thank you so much", "Thank you so much 🙏 धन्यवाद")).toContain("script:devanagari");
    expect(keys("Sure, send it over", "sure, send it over")).toContain("casing:lowercase");
  });

  it("keeps only global signals for a full rewrite", () => {
    const k = keys("Thanks for reaching out, we would love to hear more about the campaign.", "yo send deets 🙌");
    expect(k.some((key) => key.startsWith("avoid:") || key.startsWith("prefer:"))).toBe(false);
    expect(k).toContain("emoji:light");
  });
});

describe("summarizeLearnedSignals", () => {
  it("offers back at most two strong observations, keyed like the rules", () => {
    expect(summarizeLearnedSignals("Thanks for reaching out! Could you share the brief?", "Heyy! Could you share the brief? 🙌")).toEqual([
      { key: "greeting:heyy", text: "You open with “Heyy!”", scope: "all" },
      { key: "emoji:light", text: "You add emojis", scope: "all" },
    ]);
  });

  it("stays quiet for untouched sends and weak changes", () => {
    expect(summarizeLearnedSignals("Send the brief", "Send the brief")).toEqual([]);
    expect(summarizeLearnedSignals("Could you share the brief and timeline?", "Could you share the brief and the timeline?")).toEqual([]);
  });
});

describe("rule evidence, decay and promotion", () => {
  const ready = rule({ evidence: 3, distinctDrafts: 3, distinctThreads: 2, creatorEvidence: 3, lastEvidenceAt: NOW });

  it("halves evidence at exactly 45 days and decays monotonically", () => {
    expect(decayEvidence(4, daysAgo(RULE_HALF_LIFE_DAYS), NOW)).toBeCloseTo(2);
    expect(decayEvidence(4, daysAgo(10), NOW)).toBeGreaterThan(decayEvidence(4, daysAgo(20), NOW));
    expect(decayEvidence(4, null, NOW)).toBe(4);
  });

  it("promotes only when every condition holds", () => {
    expect(nextRuleStatus(ready, NOW)).toBe("active");
    expect(nextRuleStatus({ ...ready, evidence: 2.9 }, NOW)).toBe("candidate");
    expect(nextRuleStatus({ ...ready, distinctDrafts: 2 }, NOW)).toBe("candidate");
    expect(nextRuleStatus({ ...ready, distinctDrafts: 2, source: "feedback" }, NOW)).toBe("active");
    expect(nextRuleStatus({ ...ready, distinctThreads: 1 }, NOW)).toBe("candidate");
    expect(nextRuleStatus({ ...ready, against: 1.1 }, NOW)).toBe("candidate");
    expect(nextRuleStatus({ ...ready, creatorEvidence: 0 }, NOW)).toBe("candidate");
  });

  it("counts assistant/manager edits half and never activates on them alone", () => {
    let state = rule();
    for (let i = 0; i < 8; i++) state = applyRuleEvidence(state, support(state.key, i, { seatRole: "assistant" }), NOW);
    expect(state.evidence).toBe(4);
    expect(state.creatorEvidence).toBe(0);
    expect(nextRuleStatus(state, NOW)).toBe("candidate");
    state = applyRuleEvidence(state, support(state.key, 99), NOW);
    expect(nextRuleStatus(state, NOW)).toBe("active");
  });

  it("fades an active rule after 90 idle days or under sustained contradiction", () => {
    expect(nextRuleStatus({ ...ready, status: "active", evidence: 4, lastEvidenceAt: daysAgo(90) }, NOW)).toBe("candidate");
    expect(nextRuleStatus({ ...ready, status: "active", against: 2.5 }, NOW)).toBe("candidate");
    expect(nextRuleStatus({ ...ready, status: "active", against: 0.5 }, NOW)).toBe("active");
  });

  it("never changes pinned or user rules by itself, and muted rules ignore evidence", () => {
    expect(nextRuleStatus({ ...ready, status: "pinned", evidence: 0 }, NOW)).toBe("pinned");
    expect(nextRuleStatus({ ...ready, status: "active", source: "user", evidence: 0 }, NOW)).toBe("active");
    const muted = rule({ status: "muted" });
    expect(applyRuleEvidence(muted, support(muted.key, 1), NOW)).toBe(muted);
    const plan = planRuleUpdates([muted], [support(muted.key, 1)], NOW);
    expect(plan.upserts).toEqual([]);
  });

  it("counts distinct drafts and threads only once each", () => {
    let state = rule();
    state = applyRuleEvidence(state, support(state.key, 1), NOW);
    state = applyRuleEvidence(state, support(state.key, 1), NOW);
    state = applyRuleEvidence(state, support(state.key, 2, { threadId: "th1" }), NOW);
    expect(state).toMatchObject({ distinctDrafts: 2, distinctThreads: 1, evidence: 3 });
  });

  it("switches the greeting after enough new evidence, keeping one active greeting per scope", () => {
    let rules: VoiceRuleState[] = [rule({ key: "greeting:hi team", text: "Open with “Hi team”", status: "active", evidence: 3.5, distinctDrafts: 4, distinctThreads: 2, creatorEvidence: 3.5, lastEvidenceAt: NOW })];
    let promoted: string[] = [];
    for (let i = 0; i < 4; i++) {
      const plan = planRuleUpdates(rules, [support("greeting:hey hey", i)], NOW);
      const byKey = new Map(rules.map((r) => [`${r.scope}|${r.key}`, r]));
      for (const r of plan.upserts) byKey.set(`${r.scope}|${r.key}`, r);
      rules = [...byKey.values()];
      promoted = promoted.concat(plan.promoted.map((r) => r.key));
    }
    const active = rules.filter((r) => r.status === "active");
    expect(active.map((r) => r.key)).toEqual(["greeting:hey hey"]);
    expect(promoted).toContain("greeting:hey hey");
    expect(rules.find((r) => r.key === "greeting:hi team")).toMatchObject({ status: "candidate" });
  });

  it("lets a pinned greeting win over a learned one", () => {
    const pinned = rule({ key: "greeting:hi team", status: "pinned" });
    const learned = rule({ key: "greeting:hey hey", evidence: 2.5, distinctDrafts: 3, distinctThreads: 2, creatorEvidence: 2.5, lastEvidenceAt: NOW });
    const plan = planRuleUpdates([pinned, learned], [support("greeting:hey hey", 9)], NOW);
    expect(plan.upserts.find((r) => r.key === "greeting:hey hey")?.status).toBe("candidate");
    expect(plan.upserts.find((r) => r.key === "greeting:hi team")).toMatchObject({ status: "pinned", against: 1 });
  });

  it("cancels avoid:X against prefer:X, keeping the newer evidence", () => {
    const avoid = rule({ key: "avoid:no worries", status: "active", evidence: 4, distinctDrafts: 4, distinctThreads: 2, creatorEvidence: 4, lastEvidenceAt: daysAgo(5) });
    const prefer = rule({ key: "prefer:no worries", evidence: 2.5, distinctDrafts: 3, distinctThreads: 2, creatorEvidence: 2.5, lastEvidenceAt: daysAgo(1) });
    const plan = planRuleUpdates([avoid, prefer], [support("prefer:no worries", 7)], NOW);
    const out = new Map(plan.upserts.map((r) => [r.key, r.status]));
    expect(out.get("prefer:no worries")).toBe("active");
    expect(out.get("avoid:no worries")).toBe("candidate");
  });

  it("generalises a habit active in two scopes to an 'all' rule", () => {
    const brand = rule({ key: "emoji:none", text: "Skip emojis", status: "active", evidence: 3, distinctDrafts: 3, distinctThreads: 2, creatorEvidence: 3, lastEvidenceAt: NOW });
    const coaching = rule({ ...brand, id: "coach", scope: "coaching_lead", status: "candidate", evidence: 2.5 });
    const plan = planRuleUpdates([brand, coaching], [support("emoji:none", 50, { scope: "coaching_lead" })], NOW);
    expect(plan.upserts.find((r) => r.scope === "all")).toMatchObject({ key: "emoji:none", status: "active" });
  });

  it("checks rules that shaped the draft against what was sent", () => {
    const avoid = rule({ id: "avoid-1", key: "avoid:thanks for reaching out", status: "active", evidence: 4, distinctDrafts: 4, distinctThreads: 2, creatorEvidence: 4, lastEvidenceAt: NOW });
    const kept = planRuleUpdates([avoid], [], NOW, { appliedRuleIds: ["avoid-1"], finalText: "Hey! Send the brief", draftId: "d1", threadId: "t1" });
    expect(kept.upserts[0]!.evidence).toBeCloseTo(4.3);
    const broken = planRuleUpdates([avoid], [], NOW, { appliedRuleIds: ["avoid-1"], finalText: "Thanks for reaching out! Send the brief", draftId: "d1", threadId: "t1" });
    expect(broken.upserts[0]!.against).toBe(1);
    expect(checkRuleAgainstText("length:short", "one two three")).toBe(0);
    expect(checkRuleAgainstText("emoji:none", "hey 🔥")).toBe(-1);
  });

  it("never creates a rule from a contradiction and prunes faded old candidates", () => {
    expect(planRuleUpdates([], [{ ...support("greeting:yo", 1), polarity: -1 }], NOW).upserts).toEqual([]);
    const stale = rule({ id: "old", key: "prefer:lol", evidence: 0.6, lastEvidenceAt: daysAgo(100), createdAt: daysAgo(100) });
    const plan = planRuleUpdates([stale], [support("prefer:haha", 1)], NOW);
    expect(plan.deletes).toEqual(["old"]);
  });

  it("re-measures sample rules without touching rules learned from edits", () => {
    const learned = rule({ key: "length:short", source: "edits", evidence: 1 });
    const plan = planSeedRules([learned], [
      { key: "length:short", text: "x", scope: "brand_deal", evidence: 3, distinctDrafts: 10, distinctThreads: 4 },
      { key: "emoji:none", text: "Skip emojis", scope: "brand_deal", evidence: 3, distinctDrafts: 10, distinctThreads: 4 },
    ], NOW);
    expect(plan.upserts.map((r) => r.key)).toEqual(["emoji:none"]);
    expect(plan.upserts[0]).toMatchObject({ source: "samples", status: "active", creatorEvidence: 3 });
  });

  it("turns an analysed edit into scoped evidence for the edits source", () => {
    const evidence = editEvidence(analyzeEdit("Thanks for reaching out! Share the brief?", "Heyy! Share the brief?"), {
      scope: "nudge",
      draftId: "d1",
      threadId: "t1",
      seatRole: "creator",
    });
    expect(evidence.find((e) => e.key === "greeting:heyy")).toMatchObject({ scope: "nudge", source: "edits", polarity: 1, example: { before: "Thanks for reaching out!", after: "Heyy!" } });
  });
});

describe("chips", () => {
  it("has an instruction for every chip in the contract", () => {
    expect(DRAFT_CHIPS).toHaveLength(13);
    for (const chip of DRAFT_CHIPS) expect(CHIP_INSTRUCTIONS[chip].length).toBeGreaterThan(10);
    // Same chips, same order as when the list was derived from CHIP_INSTRUCTIONS.
    expect([...DRAFT_CHIPS]).toEqual(Object.keys(CHIP_INSTRUCTIONS));
  });

  it("renders chips first and the creator's note last", () => {
    expect(steeringText(["shorter", "add_emoji", "shorter"], "mention I'm free next week")).toBe(
      `${CHIP_INSTRUCTIONS.shorter} ${CHIP_INSTRUCTIONS.add_emoji} Creator's note: "mention I'm free next week"`
    );
    expect(steeringText([], "  ")).toBe("");
  });

  it("maps style chips to feedback evidence and skips situational/fact chips", () => {
    const draftBody = "word ".repeat(40).trim();
    const chips: DraftChip[] = ["shorter", "more_hinglish", "wrong_facts", "decline_politely"];
    const evidence = chipEvidence(chips, { scope: "brand_deal", draftBody, draftId: "d1", threadId: "t1", seatRole: "creator" });
    expect(evidence.map((e) => e.key)).toEqual(["length:short", "language:hinglish"]);
    expect(evidence.every((e) => e.weight === 1.5 && e.source === "feedback")).toBe(true);
  });
});

describe("lint", () => {
  it("flags avoid phrases case-insensitively, em dashes, placeholders and over-length", () => {
    const violations = lintDraft("THANKS for reaching out — your rate is [price]. " + "word ".repeat(40), {
      avoidPhrases: ["thanks for reaching out", "—"],
      targetWords: 20,
    });
    expect(violations).toEqual([
      "Don't say “thanks for reaching out”",
      "Don't use em dashes (—)",
      "Remove placeholders like [price]; ask or say you'll confirm instead",
      "Too long: keep it to about 20 words",
    ]);
    expect(lintRetryInstruction(violations)).toContain("Don't use em dashes (—)");
    expect(lintDraft("Hey! Send the brief", { avoidPhrases: ["feel free to"], targetWords: 20 })).toEqual([]);
  });
});
