import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DraftCheckpoint } from "../evals/draft-checkpoint";

describe("local synthetic draft checkpoint", () => {
  it("resumes valid drafts and rejects stale profiles, models, prompts, or empty content", () => {
    const dir = mkdtempSync(join(tmpdir(), "dealdock-draft-test-"));
    const path = join(dir, "progress.json");
    try {
      const first = new DraftCheckpoint(path, "fixture-v1", 2, "groq:example", "prompt-v1");
      first.save(0, { body: "A fictional reply", modelVersion: "groq:example", promptVersion: "prompt-v1" });
      first.save(1, { body: "A second reply", modelVersion: "groq:example", promptVersion: "prompt-v1" });
      expect(new DraftCheckpoint(path, "fixture-v1", 2, "groq:example", "prompt-v1").get(1)?.body).toBe("A second reply");
      expect(() => new DraftCheckpoint(path, "fixture-v2", 2, "groq:example", "prompt-v1")).toThrow("does not match");
      expect(() => new DraftCheckpoint(path, "fixture-v1", 2, "groq:other", "prompt-v1")).toThrow("different model or prompt");
      expect(() => first.save(0, { body: " ", modelVersion: "groq:example", promptVersion: "prompt-v1" })).toThrow();
      expect(() => first.save(2, { body: "reply", modelVersion: "groq:example", promptVersion: "prompt-v1" })).toThrow("case index");
    } finally { unlinkSync(path); rmdirSync(dir); }
  });
});
