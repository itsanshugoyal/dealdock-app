import { describe, expect, it } from "vitest";
import { describeEdit, selectExemplars, selectLessons, type ExemplarCandidate, type LessonCandidate } from "../src/style-retrieval";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 864e5);

let seq = 0;
function candidate(over: Partial<ExemplarCandidate> = {}): ExemplarCandidate {
  seq++;
  return {
    messageId: `m${seq}`,
    threadId: `t${seq}`,
    text: `Reply number ${seq} with some words`,
    inboundText: "What are your rates for a reel?",
    label: "brand_deal",
    draftKind: null,
    origin: "native",
    editRatio: null,
    sentAt: daysAgo(1),
    ...over,
  };
}

const query = { inboundText: "What are your rates for a reel?", scope: "brand_deal" as const, now: NOW };

describe("selectExemplars", () => {
  it("ranks the same label above other commerce above everything else at equal similarity", () => {
    const brand = candidate({ text: "Hey hey! Send the brief and I'll quote" });
    const coaching = candidate({ label: "coaching_lead", text: "My coaching starts at the next batch" });
    const fan = candidate({ label: "fan", text: "Thank you so so much for the love" });
    expect(selectExemplars(query, [fan, coaching, brand], 1)).toEqual([brand]);
    expect(selectExemplars(query, [fan, coaching], 1)).toEqual([coaching]);
  });

  it("prefers replies in the inbound's language when similarity is equal", () => {
    const english = candidate({ inboundText: null, text: "Sure, send me the details and the budget" });
    const hinglish = candidate({ inboundText: null, text: "Haan ji, details aur budget bhej do yaar" });
    const hinglishQuery = { ...query, inboundText: "Reel ka rate kya hai bhai?" };
    expect(selectExemplars(hinglishQuery, [english, hinglish], 1)).toEqual([hinglish]);
  });

  it("never picks near-duplicates twice: a diverse lower scorer beats them (MMR)", () => {
    const dups = [1, 2, 3].map((i) => candidate({ text: `Hey! DM me your rates and the brief please ${i}` }));
    const diverse = candidate({ text: "Love this, what deliverables are you thinking?", inboundText: "Do you do reels for brands" });
    const picked = selectExemplars(query, [...dups, diverse], 3);
    expect(picked).toContain(diverse);
    expect(picked.filter((p) => dups.includes(p))).toHaveLength(1);
  });

  it("caps untouched DealDock sends at half and keeps at least one native reply", () => {
    const untouched = [
      "Sure, sending the media kit now",
      "Rates depend on deliverables, share the brief",
      "Happy to collab, what's the timeline",
      "Let me check my calendar and revert",
    ].map((text) => candidate({ origin: "dealdock", editRatio: 0, text }));
    const native = candidate({ inboundText: "something unrelated about shoes", text: "yo send the deets" });
    const picked = selectExemplars(query, [...untouched, native], 4);
    expect(picked.filter((p) => p.origin === "dealdock" && p.editRatio === 0).length).toBeLessThanOrEqual(2);
    expect(picked).toContain(native);
  });

  it("orders least → most relevant, skips this thread, automation and personal chats, and handles an empty pool", () => {
    const best = candidate({ text: "Best match reply text here" });
    const weaker = candidate({ inboundText: "Do you do collabs?", text: "Weaker match reply text" });
    const sameThread = candidate({ threadId: "current", text: "From this very thread" });
    const automation = candidate({ origin: "automation", text: "Auto reply: thanks!" });
    const personal = candidate({ label: "personal", text: "Haha see you at dinner" });
    const picked = selectExemplars({ ...query, excludeThreadId: "current" }, [best, weaker, sameThread, automation, personal], 4);
    expect(picked.at(-1)).toBe(best);
    expect(picked).not.toContain(sameThread);
    expect(picked).not.toContain(automation);
    expect(picked).not.toContain(personal);
    expect(selectExemplars(query, [], 4)).toEqual([]);
  });
});

describe("edit lessons", () => {
  function lesson(over: Partial<LessonCandidate> = {}): LessonCandidate {
    seq++;
    return {
      draftId: `d${seq}`,
      threadId: `lt${seq}`,
      scope: "brand_deal",
      inboundText: "What are your rates for a reel?",
      before: "Thanks for reaching out! Send the brief.",
      after: "Hey hey! Send the brief.",
      editRatio: 0.3,
      sentAt: daysAgo(3),
      ...over,
    };
  }

  it("describes the largest non-fact change in one line", () => {
    expect(describeEdit("Thanks for reaching out! Send the brief.", "Hey hey! Send the brief.")).toBe("you changed “Thanks for reaching out!” → “Hey hey!”");
    expect(describeEdit("The fee is ₹20k.", "The fee is ₹25k.")).toBeNull();
  });

  it("returns the top 2 similar, recent, real-but-not-rewrite edits, same scope first", () => {
    const same = lesson();
    const otherScope = lesson({ scope: "coaching_lead" });
    const old = lesson({ sentAt: daysAgo(130) });
    const rewrite = lesson({ editRatio: 0.9 });
    const tiny = lesson({ editRatio: 0.01 });
    const unrelated = lesson({ inboundText: "Happy birthday!!" });
    const out = selectLessons(query, [otherScope, old, rewrite, tiny, unrelated, same]);
    expect(out.map((l) => l.draftId)).toEqual([same.draftId, otherScope.draftId]);
    expect(out[0]!.text).toBe("On a similar brand message you changed “Thanks for reaching out!” → “Hey hey!”");
  });
});
