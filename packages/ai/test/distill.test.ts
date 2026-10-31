import { describe, expect, it } from "vitest";
import { validateDistilledRules, type DistillationEdit } from "../src/voice";

const edits: DistillationEdit[] = [
  { draftId: "d1", scope: "brand_deal", inboundText: null, draft: "Thanks for reaching out! Send the brief.", sent: "Hey hey! Send the brief.", signals: [] },
  { draftId: "d2", scope: "brand_deal", inboundText: null, draft: "Thanks for reaching out! Rates?", sent: "Heyy! Rates?", signals: [] },
  { draftId: "d3", scope: "coaching_lead", inboundText: null, draft: "Happy to help. No worries at all!", sent: "No worries at all, let's do it!", signals: [] },
];

describe("distillation validation (no network)", () => {
  it("keeps a proposal backed by two cited drafts in this batch", () => {
    const out = validateDistilledRules(
      { rules: [{ text: "Open with 'Hey hey!' instead of 'Thanks for reaching out'", kind: "avoid_phrase", scope: "brand_deal", phrase: "thanks for reaching out", evidence_draft_ids: ["d1", "d2"] }] },
      edits,
      [],
      []
    );
    expect(out).toEqual([
      { key: "avoid:thanks for reaching out", text: "Open with 'Hey hey!' instead of 'Thanks for reaching out'", scope: "brand_deal", draftIds: ["d1", "d2"] },
    ]);
    expect(out[0]).not.toHaveProperty("status");
  });

  it("drops proposals with < 2 valid ids, unknown ids, or phrases absent from the cited texts", () => {
    const out = validateDistilledRules(
      {
        rules: [
          { text: "One edit only", kind: "freeform", scope: "all", evidence_draft_ids: ["d1"] },
          { text: "Unknown ids", kind: "freeform", scope: "all", evidence_draft_ids: ["d1", "nope"] },
          { text: "Avoid a phrase never drafted", kind: "avoid_phrase", scope: "all", phrase: "kind regards", evidence_draft_ids: ["d1", "d2"] },
          { text: "Prefer a phrase never sent", kind: "prefer_phrase", scope: "all", phrase: "cheers", evidence_draft_ids: ["d1", "d2"] },
        ],
      },
      edits,
      [],
      []
    );
    expect(out).toEqual([]);
  });

  it("rejects an avoided phrase the creator natively uses in ≥ 5% of messages", () => {
    const native = Array.from({ length: 10 }, (_, i) => (i === 0 ? "Thanks for reaching out, appreciate it" : `message ${i}`));
    const out = validateDistilledRules(
      { rules: [{ text: "Skip it", kind: "avoid_phrase", scope: "all", phrase: "thanks for reaching out", evidence_draft_ids: ["d1", "d2"] }] },
      edits,
      [],
      native
    );
    expect(out).toEqual([]);
  });

  it("reuses an existing rule's key and scope, and slugs freeform rules", () => {
    const out = validateDistilledRules(
      {
        rules: [
          { text: "Open warmly", kind: "greeting", scope: "all", matches_rule_id: "r1", evidence_draft_ids: ["d1", "d2"] },
          { text: "Agree enthusiastically before details", kind: "negotiation", scope: "bogus", evidence_draft_ids: ["d2", "d3"] },
        ],
      },
      edits,
      [{ id: "r1", key: "greeting:hey hey", scope: "brand_deal" }],
      []
    );
    expect(out).toEqual([
      { key: "greeting:hey hey", text: "Open warmly", scope: "brand_deal", draftIds: ["d1", "d2"] },
      { key: "free:agree-enthusiastically-before-details", text: "Agree enthusiastically before details", scope: "all", draftIds: ["d2", "d3"] },
    ]);
  });
});
