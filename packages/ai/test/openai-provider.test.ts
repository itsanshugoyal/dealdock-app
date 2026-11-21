import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipeline, withFallback } from "../src/index";
import { GroqPipeline } from "../src/groq-pipeline";
import type { AiPipeline, CreatorContext } from "../src/types";

const creator: CreatorContext = { businessSummary: "Fitness coach", currencyCode: "INR", typicalBrandDealMinor: { min: 100_000, max: 200_000 }, typicalCoachingMinor: null, typicalCourseMinor: null, styleCard: null, correctionExamples: [] };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }), { status: 200 });
const classification = { label: "brand_deal", confidence: 0.9, language: "en", value_min_major: 500, value_max_major: 1000, rationale: "Paid brief" };

afterEach(() => vi.unstubAllEnvs());

describe("OpenAI provider", () => {
  it("calls OpenAI with a reasoning effort instead of a temperature, and stamps the model", async () => {
    vi.stubEnv("OPENAI_REASONING_EFFORT", "");
    const fetchImpl = vi.fn().mockResolvedValue(reply(classification));
    const result = await new GroqPipeline({ vendor: "openai", apiKey: "test", fetchImpl }).classify({ messageText: "Paid collab?", senderHandle: "brand", creator });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "high", response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_completion_tokens).toBeGreaterThan(2048);
    expect(result.modelVersion).toBe("openai:gpt-6-luna");
    expect(result.promptVersion).toMatch(/-openai1$/);
  });

  it("rejects an unknown reasoning effort before sending anything", async () => {
    vi.stubEnv("OPENAI_REASONING_EFFORT", "extreme");
    const fetchImpl = vi.fn();
    await expect(new GroqPipeline({ vendor: "openai", apiKey: "test", fetchImpl }).classify({ messageText: "Hi", senderHandle: "x", creator })).rejects.toThrow("OPENAI_REASONING_EFFORT");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is selected by AI_PROVIDER=openai and needs its key", () => {
    vi.stubEnv("AI_FALLBACK_PROVIDER", "");
    vi.stubEnv("AI_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", "test");
    expect(createPipeline().constructor.name).toBe("GroqPipeline");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => createPipeline()).toThrow("requires OPENAI_API_KEY");
  });

  it("wraps the primary only when a valid fallback provider is configured", () => {
    vi.stubEnv("AI_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", "test"); vi.stubEnv("GROQ_API_KEY", "test");
    vi.stubEnv("AI_FALLBACK_PROVIDER", "groq");
    expect(createPipeline().constructor.name).toBe("Object");
    vi.stubEnv("AI_FALLBACK_PROVIDER", "openai"); // same as the primary: no wrapper
    expect(createPipeline().constructor.name).toBe("GroqPipeline");
    vi.stubEnv("AI_FALLBACK_PROVIDER", "groq"); vi.stubEnv("GROQ_API_KEY", "");
    expect(() => createPipeline()).toThrow("AI_FALLBACK_PROVIDER=groq requires GROQ_API_KEY");
  });
});

describe("withFallback", () => {
  const stub = (classify: AiPipeline["classify"]): AiPipeline => ({ classify, draft: vi.fn(), suggestDeal: vi.fn() });
  const input = { messageText: "Paid collab?", senderHandle: "brand", creator };
  const answer = { label: "brand_deal" as const, confidence: 0.9, language: "en" as const, valueRange: null, rationale: "", modelVersion: "groq:x", promptVersion: "p" };

  it("asks the fallback only when the primary fails", async () => {
    const primary = stub(vi.fn().mockRejectedValue(new Error("OpenAI request failed (HTTP 503)")));
    const fallback = stub(vi.fn().mockResolvedValue(answer));
    expect(await withFallback(primary, fallback).classify(input)).toBe(answer);

    const healthy = stub(vi.fn().mockResolvedValue({ ...answer, modelVersion: "openai:gpt-6-luna" }));
    const unused = stub(vi.fn());
    expect((await withFallback(healthy, unused).classify(input)).modelVersion).toBe("openai:gpt-6-luna");
    expect(unused.classify).not.toHaveBeenCalled();
  });

  it("reports the primary error when both fail", async () => {
    const primary = stub(vi.fn().mockRejectedValue(new Error("primary down")));
    const fallback = stub(vi.fn().mockRejectedValue(new Error("fallback down")));
    await expect(withFallback(primary, fallback).classify(input)).rejects.toThrow("primary down");
  });
});
