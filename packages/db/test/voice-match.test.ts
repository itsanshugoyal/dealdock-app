import { describe, expect, it } from "vitest";
import { editDistance, editRatio } from "@dealdock/core";
import { isVoiceMatch, measureEdit, ratioFromDistance, sentEditRatio, sentEditRatios, voiceMatchPct } from "../src/voice-match";

const PAIRS: Array<[string, string]> = [
  ["", ""],
  ["", "Heyy!"],
  ["Hi", ""],
  ["Thanks for reaching out!", "Thanks for reaching out!"],
  ["Thanks for reaching out! Could you share the brief?", "Heyy! Could you share the brief?"],
  ["Rate card attached 🙏", "Rate card attached 🙏🙏"],
  ["Sure", "Sure, my rate for a reel is ₹50,000 plus GST — shall I send the media kit?"],
];

describe("voice match", () => {
  it("derives core editRatio from the edit distance alone", () => {
    for (const [draft, sent] of PAIRS) {
      expect(ratioFromDistance(editDistance(draft, sent), draft)).toBe(editRatio(draft, sent));
      expect(measureEdit(draft, sent)).toEqual({ editDistance: editDistance(draft, sent), editRatio: editRatio(draft, sent) });
    }
  });

  it("prefers the ratio stored at send, else derives it from a legacy edit distance", () => {
    expect(sentEditRatio({ body: "Hello there", editDistance: 9, editRatio: 0.1 })).toBe(0.1);
    expect(sentEditRatio({ body: "Hello there", editDistance: 2, editRatio: null })).toBeCloseTo(2 / 11);
    expect(sentEditRatio({ body: "", editDistance: 3, editRatio: null })).toBe(1);
    expect(sentEditRatio({ body: "Hello", editDistance: null, editRatio: null })).toBeNull();
    expect(sentEditRatios([
      { body: "Hello", editDistance: null, editRatio: null },
      { body: "Hello", editDistance: 0, editRatio: null },
    ])).toEqual([0]);
  });

  it("counts a send as in the creator's voice under a 20% change, as whole percents", () => {
    expect([0, 0.19, 0.2, 1].map(isVoiceMatch)).toEqual([true, true, false, false]);
    expect(voiceMatchPct([])).toBeNull();
    expect(voiceMatchPct([0, 0.1, 0.5])).toBe(67);
  });
});
