import { describe, expect, it } from "vitest";
import {
  buildClassifySystem,
  buildDraftPrompt,
  missingOfferFacts,
  offerDealTypeFor,
  parseDraftToolInput,
  promptRules,
  PROMPT_VERSION,
} from "../src/prompts";
import type { CreatorContext, DraftInput, VoiceRuleContext } from "../src/types";

const creator: CreatorContext = {
  businessSummary: "Fitness coach selling a 12-week program",
  currencyCode: "INR",
  locale: "en-IN",
  typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 },
  typicalCoachingMinor: null,
  typicalCourseMinor: null,
  styleCard: { greeting: "Hey hey!", tone: "warm, direct", signoff: "– R", avoidPhrases: ["thanks for reaching out", "—", "feel free to"] },
  correctionExamples: [],
  offers: [
    { id: "o1", name: "12-week coaching", dealType: "coaching", priceMinMinor: 2_500_000, priceMaxMinor: 8_000_000, link: null, details: null, availability: "Next batch 1 Dec" },
  ],
  voiceRules: [
    { id: "r1", key: "greeting:heyy", text: "Open with “Heyy”", scope: "all", status: "active", evidence: 4 },
    { id: "r2", key: "avoid:circling back", text: "Don't say “circling back”", scope: "nudge", status: "pinned", evidence: 1 },
  ],
  measured: [
    { scope: "all", samples: 40, avgWords: 22, medianWords: 20, emojiRate: 0.4, hinglishIndex: 0.3, topOpeners: ["Heyy"], topSignoffs: [] },
    { scope: "brand_deal", samples: 12, avgWords: 26, medianWords: 24, emojiRate: 0.1, hinglishIndex: 0.1, topOpeners: ["Hi team"], topSignoffs: [] },
  ],
};

function input(over: Partial<DraftInput> = {}): DraftInput {
  return {
    kind: "reply",
    classificationLabel: "brand_deal",
    threadHistory: [{ direction: "inbound", text: "Hi! Paid collab for 2 reels? What are your rates?" }],
    creator,
    ...over,
  };
}

describe("draft prompt v2", () => {
  it("bumps the prompt version", () => {
    expect(PROMPT_VERSION).toBe("2.0.1-voice");
  });

  it("orders static → voice → examples → lessons → thread → task", () => {
    const prompt = buildDraftPrompt(
      input({
        exemplars: [{ messageId: "e1", text: "Heyy! Send the brief", inboundText: "Collab?", label: "brand_deal" }],
        lessons: ["On a similar brand message you changed “Thanks” → “Heyy”"],
      })
    );
    expect(prompt.system[0]).toContain("write_reply");
    const voice = prompt.system[1];
    const order = ["<creator>", "<offers>", "<voice_profile>", "<voice_rules>", "<avoid_generic>"].map((tag) => voice.indexOf(tag));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    const user = ["<examples>", "<edit_lessons>", "<thread>", "<task>"].map((tag) => prompt.user.indexOf(tag));
    expect(user).toEqual([...user].sort((a, b) => a - b));
    expect(prompt.user.trimEnd().endsWith("</task>")).toBe(true);
  });

  it("keeps the creator-voice block byte-identical across drafts (cache stability)", () => {
    const a = buildDraftPrompt(input());
    const b = buildDraftPrompt(
      input({
        kind: "nudge",
        classificationLabel: "coaching_lead",
        threadHistory: [{ direction: "inbound", text: "Something completely different" }],
        exemplars: [{ messageId: "e9", text: "An exemplar that must stay out of system", inboundText: null, label: null }],
        chips: ["shorter"],
      })
    );
    expect(b.system).toEqual(a.system);
    expect(a.system.join("\n")).not.toContain("Paid collab");
    expect(b.system.join("\n")).not.toContain("An exemplar that must stay out of system");
  });

  it("formats offers with the core money formatter and admits missing prices", () => {
    expect(buildDraftPrompt(input()).system[1]).toContain("- 12-week coaching (coaching): ₹25K–₹80K · availability: Next batch 1 Dec");
    expect(buildDraftPrompt(input({ creator: { ...creator, offers: [] } })).system[1]).toContain("None listed. Never quote a price");
  });

  it("shows typical ranges the same way in the classifier and voice blocks", () => {
    const classify = buildClassifySystem(creator);
    expect(classify).toContain("Typical brand deal: ₹1.5L–₹4L");
    expect(classify).toContain("Typical coaching package: not provided");
    const voice = buildDraftPrompt(input()).system[1];
    expect(voice).toContain("Typical brand deal: ₹1.5L–₹4L");
    expect(voice).toContain("Typical course: not provided");
  });

  it("reads a malformed stored range or an unknown currency as not provided instead of throwing", () => {
    const fractional = { ...creator, typicalBrandDealMinor: { min: 1_500.5, max: 4_000 } };
    const negative = { ...creator, typicalBrandDealMinor: { min: -100, max: 4_000 } };
    for (const bad of [fractional, negative, { ...creator, currencyCode: "XYZ" }]) {
      expect(buildClassifySystem(bad)).toContain("Typical brand deal: not provided");
      expect(buildDraftPrompt(input({ creator: bad })).system[1]).toContain("Typical brand deal: not provided");
    }
  });

  it("lists pinned rules first, de-duplicates by key (the 'all' rule covers it) and caps at 12", () => {
    const many: VoiceRuleContext[] = Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`,
      key: `prefer:phrase ${i}`,
      text: `Use “phrase ${i}”`,
      scope: "brand_deal",
      status: "active",
      evidence: i,
    }));
    const rules = promptRules([
      ...many,
      { id: "p", key: "emoji:none", text: "Skip emojis", scope: "coaching_lead", status: "pinned", evidence: 0 },
      { id: "dup-all", key: "prefer:phrase 19", text: "Use “phrase 19”", scope: "all", status: "active", evidence: 50 },
    ]);
    expect(rules).toHaveLength(12);
    expect(rules[0]!.id).toBe("p");
    expect(rules.filter((r) => r.key === "prefer:phrase 19").map((r) => r.scope)).toEqual(["all"]);
  });

  it("avoids only stock phrases the creator doesn't use, and lints against avoid rules in scope", () => {
    const prompt = buildDraftPrompt(input({ kind: "nudge" }));
    expect(prompt.system[1]).toContain("“thanks for reaching out”");
    expect(prompt.system[1]).not.toContain("“kindly”");
    expect(prompt.lint.avoidPhrases).toEqual(expect.arrayContaining(["circling back", "thanks for reaching out", "—"]));
    expect(buildDraftPrompt(input()).lint.avoidPhrases).not.toContain("circling back");
  });

  it("renders chips and the creator's note in the task, with variants", () => {
    const prompt = buildDraftPrompt(input({ chips: ["shorter", "add_emoji"], instruction: "mention I'm free next week", variants: 3 }));
    const task = prompt.user.slice(prompt.user.indexOf("<task>"));
    expect(task).toContain("Make it noticeably shorter");
    expect(task).toContain(`Creator's note: "mention I'm free next week"`);
    expect(task).toContain("Write 3 clearly different versions");
    expect(prompt.variants).toBe(3);
  });

  it("targets length from overrides, rules, measured habits and chips", () => {
    expect(buildDraftPrompt(input()).targetWords).toBe(24);
    expect(buildDraftPrompt(input({ chips: ["shorter"] })).targetWords).toBe(14);
    expect(buildDraftPrompt(input({ creator: { ...creator, styleOverrides: { sentenceLength: "long" } } })).targetWords).toBe(70);
    const withRule = { ...creator, voiceRules: [{ id: "l", key: "length:very_short", text: "x", scope: "brand_deal" as const, status: "active" as const, evidence: 3 }] };
    expect(buildDraftPrompt(input({ creator: withRule })).targetWords).toBe(8);
  });

  it("uses a neutral structure when the label is unknown, never a silent brand deal", () => {
    for (const classificationLabel of [null, "", "not_a_label"]) {
      const prompt = buildDraftPrompt(input({ classificationLabel }));
      expect(prompt.user).toContain("if what they want is unclear, ask one short question");
      expect(prompt.user).not.toContain("brand deal");
      expect(prompt.scope).toBe("all");
    }
    expect(buildDraftPrompt(input({ classificationLabel: "fan" })).scope).toBe("fan");
  });

  it("matches language and uses voice-note transcripts in the thread", () => {
    const prompt = buildDraftPrompt(
      input({ threadHistory: [{ direction: "inbound", text: "", contentType: "audio", transcript: "bhai reel ka kitna charge karte ho?" }] })
    );
    expect(prompt.user).toContain("THEM (voice note): bhai reel ka kitna charge karte ho?");
    expect(prompt.language).toBe("hinglish");
    expect(prompt.user).toContain("reply in Hinglish");
  });

  it("drops the oldest thread messages first to fit the budget", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ direction: "inbound" as const, text: `${i}:${"x".repeat(495)}` }));
    const prompt = buildDraftPrompt(input({ threadHistory: history }));
    expect(prompt.user).not.toContain("THEM: 0:");
    expect(prompt.user).toContain("THEM: 11:");
  });

  it("summarises what the draft was built from", () => {
    const prompt = buildDraftPrompt(input({ exemplars: [{ messageId: "e1", text: "Heyy!", inboundText: null, label: null }], lessons: ["l1"] }));
    expect(prompt.context).toEqual({
      rules: [
        { id: "r2", text: "Don't say “circling back”" },
        { id: "r1", text: "Open with “Heyy”" },
      ],
      exemplars: [{ messageId: "e1", text: "Heyy!", inboundText: null }],
      offers: [{ id: "o1", name: "12-week coaching" }],
      lessons: ["l1"],
      missingFacts: [],
    });
  });
});

describe("tool parsing and missing facts", () => {
  it("trims, de-duplicates and caps drafts; rejects an empty answer", () => {
    expect(parseDraftToolInput({ drafts: [" a ", "a", "b", "c", "d"], missingFacts: ["your rate", "your rate"] }, 3)).toEqual({
      drafts: ["a", "b", "c"],
      missingFacts: ["your rate"],
    });
    expect(() => parseDraftToolInput({ drafts: ["  "] }, 1)).toThrow("empty model response");
  });

  it("names facts a reply type needs that the offers don't cover", () => {
    expect(missingOfferFacts("coaching_lead", [], false)).toEqual(["your coaching price"]);
    expect(missingOfferFacts("coaching_lead", creator.offers!, false)).toEqual([]);
    expect(missingOfferFacts("brand_deal", [], true)).toEqual(["your brand collaboration rate"]);
    expect(missingOfferFacts("brand_deal", [], false)).toEqual([]);
  });

  it("matches commerce scopes to the offer deal type that answers them", () => {
    expect(offerDealTypeFor("brand_deal")).toBe("brand");
    expect(offerDealTypeFor("coaching_lead")).toBe("coaching");
    expect(offerDealTypeFor("course_inquiry")).toBe("course");
    expect(offerDealTypeFor("other_commerce")).toBe("other");
    for (const scope of ["all", "nudge", "fan", "uncertain"] as const) expect(offerDealTypeFor(scope)).toBeNull();
  });
});
