import type { DealDto } from "@dealdock/core";
import { describe, expect, it, vi } from "vitest";
import { GroqPipeline } from "../src/groq-pipeline";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import { buildDraftPrompt, classifyUserText, creatorFirstName, DRAFT_STATIC_SYSTEM, DRAFT_STATIC_SYSTEM_EMAIL } from "../src/prompts";
import { lintDraft } from "../src/style-learning";
import type { CreatorContext, DraftInput } from "../src/types";

const creator: CreatorContext = {
  businessSummary: "I'm Riya, a skincare creator in Mumbai",
  currencyCode: "INR",
  locale: "en-IN",
  typicalBrandDealMinor: null,
  typicalCoachingMinor: null,
  typicalCourseMinor: null,
  styleCard: { greeting: "Hey hey!", signoff: "– R" },
  correctionExamples: [],
  voiceRules: [{ id: "e", key: "emoji:light", text: "Use an emoji now and then", scope: "all", status: "active", evidence: 2 }],
};
const anonymous: CreatorContext = { ...creator, businessSummary: "Skincare creator in Mumbai" };
const fromPriya = { direction: "inbound" as const, text: "Hi Riya,\n\nWe'd love a paid collab for our Diwali launch: 1 reel and 2 stories.\n\nThanks,\nPriya\nGlow Co" };
const input = (over: Partial<DraftInput> = {}): DraftInput => ({
  kind: "reply", classificationLabel: "brand_deal", threadHistory: [fromPriya], creator, channel: "email", subject: "Paid collab: Diwali launch", ...over,
});
const draft = (over: Partial<DraftInput> = {}) => new HeuristicPipeline().draft(input(over));
const deal: DealDto = {
  id: "deal-1", threadId: "t1", igAccountId: "ig1", counterpartyHandle: "priya@glowco.com", counterpartyName: "Priya Sharma", channel: "email",
  title: "1 reel + 2 stories", dealType: "brand", amountMinor: 5_250_000, currencyCode: "INR", stage: "invoiced",
  terms: { deliverables: [], usage: null, exclusivity: null, revisionsIncluded: null, advancePercent: null, paymentDays: 30, notes: null },
  agreedAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-20T18:29:59.000Z", invoicedAt: null, paidAt: null, receivedMinor: null, tdsMinor: null,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
};

describe("email classification", () => {
  const email = { messageText: "Hi, sharing the details below.", senderHandle: "priya@glowco.com", creator, channel: "email" as const, subject: "Paid collab: 1 reel, budget ₹50k" };

  it("reads the subject along with the message, and only for email", async () => {
    const pipeline = new HeuristicPipeline();
    expect((await pipeline.classify(email)).label).toBe("brand_deal");
    expect((await pipeline.classify({ ...email, channel: undefined })).label).toBe("uncertain");
    expect((await pipeline.classify({ ...email, subject: "Quick question" })).rationale).toContain("from priya@glowco.com —");
  });

  it("tells the model it is an email and gives the subject; DMs are unchanged", async () => {
    expect(classifyUserText(email)).toBe("This is an email, not an Instagram DM.\nFrom: priya@glowco.com\nSubject: Paid collab: 1 reel, budget ₹50k\nMessage:\nHi, sharing the details below.");
    expect(classifyUserText({ ...email, channel: "instagram" })).toBe("Sender: @priya@glowco.com\nMessage:\nHi, sharing the details below.");
    const reply = { label: "brand_deal", confidence: 0.9, language: "en", value_min_major: null, value_max_major: null, rationale: "Paid collab" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }] }), { status: 200 }));
    await new GroqPipeline({ apiKey: "test", fetchImpl }).classify(email);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages[1].content).toContain("Subject: Paid collab: 1 reel, budget ₹50k");
  });
});

describe("email draft prompts", () => {
  it("swaps the static block for the email one, keeps the cached voice block, and leaves DMs alone", () => {
    const email = buildDraftPrompt(input());
    const dm = buildDraftPrompt(input({ channel: undefined, subject: undefined }));
    expect(email.system[0]).toBe(DRAFT_STATIC_SYSTEM_EMAIL);
    expect(email.system[1]).toBe(dm.system[1]);
    expect(dm.system[0]).toBe(DRAFT_STATIC_SYSTEM);
    expect(dm.user).not.toContain("Format:");
    expect(dm.user).not.toContain("Subject:");
    expect([dm.email, dm.lint.email]).toEqual([null, undefined]);
    expect(email.lint.email).toBe(true);
    expect(email.targetWords).toBeGreaterThanOrEqual(60);
  });

  it("gives the model the subject for context and the names it may use", () => {
    const { user, email } = buildDraftPrompt(input());
    expect(user).toContain("<thread>\nSubject: Paid collab: Diwali launch\nTHEM: Hi Riya,");
    expect(user).toContain("Format: an email, not a DM. Greet Priya, write short paragraphs, and sign off as Riya. Never write a subject line.");
    expect(email).toEqual({ theirName: "Priya", creatorName: "Riya" });
    const unknown = buildDraftPrompt(input({ creator: anonymous, threadHistory: [{ direction: "inbound", text: "Paid collab?" }] })).user;
    expect(unknown).toContain("Greet them by name if the thread shows it, otherwise without a name");
    expect(unknown).toContain("sign off without inventing a name");
  });

  it("writes recaps and reminders as emails when the deal came by email", () => {
    const prompt = buildDraftPrompt(input({ channel: undefined, purpose: "payment_reminder", deal, threadHistory: [], now: new Date("2026-10-30T00:00:00Z") }));
    expect(prompt.system[0]).toBe(DRAFT_STATIC_SYSTEM_EMAIL);
    expect(prompt.user).toContain("Greet Priya Sharma");
    expect(prompt.user).toContain("Tone: firm but polite");
  });

  it("finds the creator's first name only where they gave it", () => {
    expect(creatorFirstName(creator)).toBe("Riya");
    expect(creatorFirstName({ ...anonymous, styleCard: { signoff: "Cheers, Ananya ✨" } })).toBe("Ananya");
    expect(creatorFirstName({ ...anonymous, businessSummary: "Hi, my name is Kabir and I coach runners" })).toBe("Kabir");
    for (const businessSummary of ["Fitness Coach, Mumbai", "I'm Mumbai-based", "Skincare creator"]) {
      expect(creatorFirstName({ ...anonymous, businessSummary })).toBeNull();
    }
  });
});

describe("heuristic email drafts", () => {
  it("greets them by name, writes short paragraphs and signs off with the creator's name", async () => {
    const { body, lintViolations } = await draft();
    expect(body).toBe(
      "Hey Priya,\n\nThis sounds interesting. Could you share the brief with deliverables, timeline and budget range?\n\n" +
        "I'll take a look and get back to you quickly.\n\nThanks,\nRiya",
    );
    expect(lintViolations).toEqual([]);
  });

  it("never invents a name, adds emoji only when asked, and never writes a subject line", async () => {
    const anon = (await draft({ creator: anonymous, threadHistory: [{ direction: "inbound", text: "Paid collab?" }] })).body;
    expect(anon.startsWith("Hey,\n\n")).toBe(true);
    expect(anon.endsWith("\n\n– R")).toBe(true);
    expect(anon).not.toContain("Riya");
    const withEmoji = (await draft({ chips: ["add_emoji"] })).body;
    expect(withEmoji).toContain("quickly. 🙌\n\nThanks,\nRiya");
    for (const body of [anon, withEmoji, (await draft({ kind: "nudge" })).body]) expect(body).not.toMatch(/subject:/i);
  });

  it("lays out recaps and payment reminders as emails, with the exact amount", async () => {
    const recap = (await draft({ purpose: "recap", deal, now: new Date("2026-10-02T00:00:00Z") })).body;
    expect(recap.startsWith("Hey Priya,\n\nQuick recap so we're on the same page: 1 reel + 2 stories, for ₹52,500.")).toBe(true);
    expect(recap.endsWith("Can you confirm this works for you?\n\nThanks,\nRiya")).toBe(true);
    const reminder = await draft({ purpose: "payment_reminder", deal, threadHistory: [], now: new Date("2026-11-20T00:00:00Z") });
    expect(reminder.body.startsWith("Hey Priya Sharma,\n\nChecking in again on the ₹52,500")).toBe(true);
    expect(reminder.lintViolations).toEqual([]);
  });
});

describe("email lint", () => {
  const lint = (text: string, email?: boolean) => lintDraft(text, { avoidPhrases: [], targetWords: null, email });

  it("flags a subject line and emoji spam in emails only", () => {
    expect(lint("Subject: Collab\n\nHi Priya,\n\nSounds good.", true)).toEqual(["Don't write a subject line; the email already has one"]);
    expect(lint("Hi Priya! 🙌🔥✨ Sounds good.", true)).toEqual(["Keep emoji out of the email (one at most)"]);
    expect(lint("Hi Priya! 🙌 Sounds good.", true)).toEqual([]);
    expect(lint("Subject: hi 🙌🔥", false)).toEqual([]);
  });
});
