import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointFingerprint, EvalCheckpoint } from "../evals/checkpoint";

const result = { label: "fan" as const, confidence: 0.9, language: "en" as const, valueRange: null, rationale: "Praise", modelVersion: "groq:test-model", promptVersion: "test-prompt" };

describe("local evaluation checkpoint", () => {
  it("resumes exact scored cases and rejects changes in model, prompt, source or dataset fingerprint", () => {
    const dir = mkdtempSync(join(tmpdir(), "dealdock-eval-test-"));
    const path = join(dir, "progress.json");
    try {
      const fingerprint = checkpointFingerprint({ model: "test-model", prompt: "v1", source: "a", cases: ["one", "two"] });
      const first = new EvalCheckpoint(path, fingerprint, 2, "groq:test-model", "test-prompt");
      first.save(0, result);
      first.save(1, { ...result, confidence: 0.7 });
      const resumed = new EvalCheckpoint(path, fingerprint, 2, "groq:test-model", "test-prompt");
      expect(resumed.get(0)).toEqual(result);
      expect(resumed.get(1)?.confidence).toBe(0.7);
      expect(() => new EvalCheckpoint(path, checkpointFingerprint({ model: "other" }), 2, "groq:test-model", "test-prompt")).toThrow("does not match");
      expect(() => new EvalCheckpoint(path, fingerprint, 2, "groq:other", "test-prompt")).toThrow("different model or prompt");
      expect(() => resumed.save(2, result)).toThrow("case index");
      const stored = JSON.parse(readFileSync(path, "utf8"));
      stored.results["0"].confidence = 2;
      writeFileSync(path, JSON.stringify(stored));
      expect(() => new EvalCheckpoint(path, fingerprint, 2, "groq:test-model", "test-prompt")).toThrow();
    } finally {
      unlinkSync(path);
      rmdirSync(dir);
    }
  });
});
