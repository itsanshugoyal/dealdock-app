import { describe, expect, it, vi } from "vitest";
import { GroqPipeline } from "../src/groq-pipeline";
import { GroqRateLimitError, strictSchema } from "../src/groq-client";
import type { CreatorContext } from "../src/types";

const creator: CreatorContext = { businessSummary: "Fitness coach", currencyCode: "INR", typicalBrandDealMinor: { min: 100_000, max: 200_000 }, typicalCoachingMinor: null, typicalCourseMinor: null, styleCard: null, correctionExamples: [] };
const reply = (content: unknown, finish = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(content) } }] }), { status: 200 });
describe("Groq pipeline", () => {
  it("clamps untrusted currency amounts, stamps provider and uses strict JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ label: "brand_deal", confidence: 2, language: "hinglish", value_min_major: -5, value_max_major: 999_999_999, rationale: "Paid brief" }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    const result = await pipeline.classify({ messageText: "Paid collab?", senderHandle: "example", creator });
    expect(result.confidence).toBe(1);
    expect(result.valueRange).toEqual({ minMinor: 0, maxMinor: 20_000_000 });
    expect(result.modelVersion).toBe("groq:openai/gpt-oss-120b");
    expect(result.promptVersion).toContain("groq");
    const request = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.response_format.json_schema.schema.additionalProperties).toBe(false);
  });
  it("preserves approval and ignored-handle guards before contacting the provider", async () => {
    const fetchImpl = vi.fn();
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    await expect(pipeline.classify({ messageText: "Hi", senderHandle: "ignored", creator, isIgnoredHandle: true })).rejects.toThrow("ignored");
    await expect(pipeline.draft({ kind: "reply", classificationLabel: "fan", threadHistory: [], creator, voiceConsent: false })).rejects.toThrow("consent");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not attach value estimates to non-commerce messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ label: "fan", confidence: 0.9, language: "en", value_min_major: 1000, value_max_major: 2000, rationale: "Compliment" }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    expect((await pipeline.classify({ messageText: "Great content", senderHandle: "example", creator })).valueRange).toBeNull();
  });
  it("returns a draft for review with its provenance", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ drafts: ["Hey! Could you share a little more?"], missingFacts: ["the brief"] }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    const result = await pipeline.draft({ kind: "reply", classificationLabel: "brand_deal", threadHistory: [], creator, voiceConsent: true });
    expect(result.body).toContain("Could you share");
    expect(result.modelVersion).toBe("groq:openai/gpt-oss-120b");
    expect(result.context?.missingFacts).toEqual(["the brief"]);
  });
  it("passes an unrounded saved offer price to the provider", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ drafts: ["The course is ₹5,999."], missingFacts: [] }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    const pricedCreator: CreatorContext = { ...creator, offers: [{ id: "course", name: "Recorded course", dealType: "course", priceMinMinor: 599_900, priceMaxMinor: 599_900, details: null, link: null, availability: null }] };
    await pipeline.draft({ kind: "reply", classificationLabel: "course_inquiry", threadHistory: [{ direction: "inbound", text: "What is the course price?" }], creator: pricedCreator });
    const request = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(request.messages[0].content).toContain("Recorded course (course): ₹5,999");
    expect(request.messages[0].content).not.toContain("Recorded course (course): ₹6K");
  });
  it("rejects malformed, incomplete and provider-error responses without exposing bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply({ drafts: [], missingFacts: [] })).mockResolvedValueOnce(reply({}, "length")).mockResolvedValueOnce(new Response("sensitive provider details", { status: 429 }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    const input = { kind: "reply" as const, classificationLabel: "fan", threadHistory: [], creator };
    await expect(pipeline.draft(input)).rejects.toThrow();
    await expect(pipeline.draft(input)).rejects.toThrow("incomplete");
    await expect(pipeline.draft(input)).rejects.toThrow("HTTP 429");
  });
  it("makes optional nested schema properties nullable and required", () => {
    const converted = strictSchema({ type: "object", properties: { text: { type: "string" }, optional: { type: "string" } }, required: ["text"] });
    expect(converted.required).toEqual(["text", "optional"]);
    expect(converted.properties).toMatchObject({ optional: { anyOf: [{ type: "string" }, { type: "null" }] } });
  });
  it("exposes only a bounded retry delay for the evaluation runner", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("provider details", { status: 429, headers: { "retry-after": "2" } }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    try {
      await pipeline.classify({ messageText: "Hi", senderHandle: "example", creator });
      throw new Error("Expected a rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(GroqRateLimitError);
      expect((error as GroqRateLimitError).retryAfterMs).toBe(2000);
      expect((error as Error).message).not.toContain("provider details");
    }
  });
  it("retries transient Groq JSON generation failures without weakening the schema", async () => {
    const failure = () => new Response(JSON.stringify({ error: { code: "json_validate_failed", failed_generation: "private message" } }), { status: 400 });
    const fetchImpl = vi.fn().mockResolvedValueOnce(failure()).mockResolvedValueOnce(failure()).mockResolvedValueOnce(reply({
      label: "fan", confidence: 0.9, language: "en", value_min_major: null, value_max_major: null, rationale: "Compliment",
    }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    expect((await pipeline.classify({ messageText: "Great content", senderHandle: "example", creator })).label).toBe("fan");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, request] of fetchImpl.mock.calls) {
      expect(JSON.parse(request.body as string).response_format.json_schema.strict).toBe(true);
    }
  });
  it("suggests a deal with strict JSON, falling back to the heuristic for invalid fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({
      title: "Diwali launch", dealType: "brand", amount_major: 45_000, payment_due_date: "2026-11-30",
      deliverables: [{ label: "1 reel", due_date: "2026-11-06" }, { label: "2 stories", due_date: "2026-11-15" }],
      usage: "Paid ads, 3 months", exclusivity: null, revisionsIncluded: -1, advancePercent: 50, paymentDays: 30, notes: null,
    }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    const result = await pipeline.suggestDeal({
      threadHistory: [
        { direction: "outbound", text: "My rate for 1 reel + 2 stories is ₹50,000, with 2 revisions." },
        { direction: "inbound", text: "Done, let's proceed." },
      ],
      creator, now: new Date("2026-11-04T06:30:00Z"), timezone: "Asia/Kolkata",
    });
    expect(result).toMatchObject({ title: "Diwali launch", dealType: "brand", dueAt: "2026-11-30T18:29:59.000Z", modelVersion: "groq:openai/gpt-oss-120b" });
    // ₹45,000 is named nowhere in the thread (an estimate or midpoint), so the agreed quote stands.
    expect(result.amountMinor).toBe(5_000_000);
    expect(result.terms).toMatchObject({ usage: "Paid ads, 3 months", advancePercent: 50, paymentDays: 30, revisionsIncluded: 2 });
    expect(result.terms.deliverables.map((d) => d.dueAt)).toEqual(["2026-11-06T18:29:59.000Z", "2026-11-15T18:29:59.000Z"]);
    expect(result.missing).toEqual([]);
    const request = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(request.temperature).toBe(0);
    expect(request.response_format.json_schema).toMatchObject({ name: "record_deal", strict: true });
    expect(request.response_format.json_schema.schema.properties.deliverables.items.additionalProperties).toBe(false);
    expect(request.messages[1].content).toContain("Today: Wednesday, 2026-11-04 (Asia/Kolkata)");
    expect(request.messages[0].content).not.toContain("Always answer by calling record_deal");
  });
  it("surfaces provider rate limits on deal suggestions instead of guessing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("provider details", { status: 429, headers: { "retry-after": "3" } }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    await expect(pipeline.suggestDeal({ threadHistory: [], creator, now: new Date() })).rejects.toBeInstanceOf(GroqRateLimitError);
  });
  it("retries a payment reminder that states the wrong amount, once", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({ drafts: ["Hey! Just a nudge on the ₹50,000 for the reel."], missingFacts: [] }))
      .mockResolvedValueOnce(reply({ drafts: ["Hey! Just a nudge on the ₹52,500 for the reel, due 20 Oct."], missingFacts: [] }));
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl });
    const deal = {
      id: "deal-1", threadId: "t1", igAccountId: "ig1", counterpartyHandle: "glowco", counterpartyName: null, channel: "instagram" as const,
      title: "1 reel", dealType: "brand" as const, amountMinor: 5_250_000, currencyCode: "INR", stage: "invoiced" as const,
      terms: { deliverables: [], usage: null, exclusivity: null, revisionsIncluded: null, advancePercent: null, paymentDays: null, notes: null },
      agreedAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-20T18:29:59.000Z", invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null,
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    };
    const result = await pipeline.draft({ kind: "reply", classificationLabel: "brand_deal", threadHistory: [], creator, purpose: "payment_reminder", deal, now: new Date("2026-10-30T00:00:00Z"), timezone: "Asia/Kolkata" });
    expect(result.body).toContain("₹52,500");
    expect(result.lintViolations).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(retry.messages[1].content).toContain("State money exactly as the deal has it: ₹52,500, and no other amount");
    expect(retry.messages[1].content).toContain("Tone: firm but polite");
  });
  it("bounds JSON-generation retries and does not retry or expose other provider errors", async () => {
    const failure = () => new Response(JSON.stringify({ error: { code: "json_validate_failed", failed_generation: "private message" } }), { status: 400 });
    const repeated = vi.fn().mockImplementation(async () => failure());
    const pipeline = new GroqPipeline({ apiKey: "test", fetchImpl: repeated });
    await expect(pipeline.classify({ messageText: "Hi", senderHandle: "example", creator })).rejects.toThrow("HTTP 400");
    expect(repeated).toHaveBeenCalledTimes(3);
    const other = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "invalid_request", message: "private message" } }), { status: 400 }));
    const otherPipeline = new GroqPipeline({ apiKey: "test", fetchImpl: other });
    await expect(otherPipeline.classify({ messageText: "Hi", senderHandle: "example", creator })).rejects.toThrow("HTTP 400");
    expect(other).toHaveBeenCalledTimes(1);
  });
});
