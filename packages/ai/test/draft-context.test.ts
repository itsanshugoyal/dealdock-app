import { describe, expect, it } from "vitest";
import { generationContextOf, retrieveVoiceContext } from "../src/draft-context";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import { PROMPT_VERSION } from "../src/prompts";
import { selectExemplars, selectLessons, type ExemplarCandidate, type LessonCandidate } from "../src/style-retrieval";
import type { CreatorContext } from "../src/types";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 864e5);
const query = { inboundText: "What are your rates for a reel?", scope: "brand_deal" as const, now: NOW, excludeThreadId: "current" };

function exemplar(over: Partial<ExemplarCandidate> & Pick<ExemplarCandidate, "messageId" | "threadId" | "text">) {
  // Rows as @dealdock/db loads them: the candidate fields plus extras (seatRole) a prompt never needs.
  return { inboundText: null, label: "brand_deal" as const, draftKind: null, origin: "native" as const, editRatio: null, sentAt: daysAgo(2), seatRole: "creator" as const, ...over };
}

const exemplarPool = [
  exemplar({ messageId: "m1", threadId: "t1", text: "Hey hey! Send the brief and I'll quote", inboundText: "What are your rates for a reel?" }),
  exemplar({ messageId: "m2", threadId: "t2", text: "Thank you so so much for the love", inboundText: "Love your reels", label: "fan" }),
  exemplar({ messageId: "m3", threadId: "current", text: "From this very thread", inboundText: "What are your rates?" }),
];

const lessonPool: LessonCandidate[] = [
  {
    draftId: "d1",
    threadId: "lt1",
    scope: "brand_deal",
    inboundText: "What are your rates for a reel?",
    before: "Thanks for reaching out! Send the brief.",
    after: "Hey hey! Send the brief.",
    editRatio: 0.3,
    sentAt: daysAgo(3),
  },
];

describe("retrieveVoiceContext", () => {
  it("matches the inline selectExemplars/selectLessons mapping it replaces", () => {
    expect(retrieveVoiceContext(query, { exemplarPool, lessonPool })).toEqual({
      exemplars: selectExemplars(query, exemplarPool).map((e) => ({ messageId: e.messageId, text: e.text, inboundText: e.inboundText, label: e.label })),
      lessons: selectLessons(query, lessonPool).map((l) => l.text),
    });
  });

  it("returns exemplars least → most relevant with only the prompt's fields, and lesson lines", () => {
    const { exemplars, lessons } = retrieveVoiceContext(query, { exemplarPool, lessonPool });
    expect(exemplars.map((e) => e.messageId)).toEqual(["m2", "m1"]);
    expect(exemplars.at(-1)).toStrictEqual({
      messageId: "m1",
      text: "Hey hey! Send the brief and I'll quote",
      inboundText: "What are your rates for a reel?",
      label: "brand_deal",
    });
    expect(lessons).toEqual(["On a similar brand message you changed “Thanks for reaching out!” → “Hey hey!”"]);
  });

  it("returns nothing from empty pools (no consent, no history)", () => {
    expect(retrieveVoiceContext(query, { exemplarPool: [], lessonPool: [] })).toEqual({ exemplars: [], lessons: [] });
  });
});

describe("generationContextOf", () => {
  const context = { rules: [{ id: "r1", text: "Open with “Heyy”" }], exemplars: [], offers: [], lessons: [], missingFacts: ["your rate"] };

  it("stores the summary with the prompt version and the remaining lint violations", () => {
    expect(generationContextOf({ context, promptVersion: "p1", lintViolations: ["Don't say “kindly”"] })).toEqual({
      ...context,
      promptVersion: "p1",
      lintViolations: ["Don't say “kindly”"],
    });
    expect(generationContextOf({ context, promptVersion: "p1" })?.lintViolations).toEqual([]);
  });

  it("is null when the pipeline reported no context", () => {
    expect(generationContextOf({ promptVersion: "p1", lintViolations: [] })).toBeNull();
  });

  it("records what a real draft was built from (retrieval in, generationContext out)", async () => {
    const creator: CreatorContext = {
      businessSummary: "Fitness coach selling a 12-week program",
      currencyCode: "INR",
      locale: "en-IN",
      typicalBrandDealMinor: null,
      typicalCoachingMinor: null,
      typicalCourseMinor: null,
      styleCard: null,
      correctionExamples: [],
    };
    const result = await new HeuristicPipeline().draft({
      kind: "reply",
      classificationLabel: "brand_deal",
      threadHistory: [{ direction: "inbound", text: query.inboundText }],
      creator,
      ...retrieveVoiceContext(query, { exemplarPool, lessonPool }),
    });
    const stored = generationContextOf(result);
    expect(stored).toEqual({ ...result.context, promptVersion: PROMPT_VERSION, lintViolations: result.lintViolations });
    expect(stored?.exemplars.map((e) => e.messageId)).toEqual(["m2", "m1"]);
    expect(stored?.lessons).toHaveLength(1);
  });
});
