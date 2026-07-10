import { describe, expect, it } from "vitest";
import { CLASSIFICATION_LABELS } from "@dealdock/core";
import { CORPUS, generateCorpus } from "../src/mock/corpus";

describe("fixture corpus", () => {
  it("meets the M0 size target (≥200 labelled messages)", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(200);
  });

  it("covers all 8 classification labels", () => {
    const labels = new Set(CORPUS.map((m) => m.expectedLabel));
    for (const label of CLASSIFICATION_LABELS) {
      expect(labels, `missing label: ${label}`).toContain(label);
    }
  });

  it("is Hinglish-weighted (PRD P0 bar) — ≥40% messages contain Devanagari-adjacent Hinglish markers", () => {
    const hinglishMarkers =
      /\b(bhai|bhaiya|didi|yaar|hai|hain|kya|kab|nahi|karo|kar|ke|ka|ki|mein|aap|aapki|aapke|mujhe|maine|karni|bata|dijiye|abhi|wala|saath|hoon|jaanna|bachi|karenge)\b/i;
    const hinglishCount = CORPUS.filter((m) => hinglishMarkers.test(m.text)).length;
    expect(hinglishCount / CORPUS.length).toBeGreaterThanOrEqual(0.4);
  });

  it("is deterministic", () => {
    expect(generateCorpus()).toEqual(generateCorpus());
  });

  it("spreads messages across ~30 days for Leak Scan realism", () => {
    const ages = CORPUS.map((m) => m.minutesAgo);
    expect(Math.max(...ages)).toBeGreaterThan(60 * 24 * 20); // >20 days
    expect(Math.min(...ages)).toBeLessThan(60 * 24); // <1 day
  });
});
