import { describe, expect, it } from "vitest";
import {
  canReplyPrivately,
  COMMENT_REPLY_WINDOW_MS,
  commentReplyBy,
  matchCommentKeyword,
  normalizeCommentKeywords,
} from "../src/comment-leads";

describe("comment keyword matching", () => {
  it("matches a whole word in any case, with punctuation around it", () => {
    for (const comment of ["PRICE", "price?", "Price please!!", "what's the price.", "#price", "(price)", "@diya.moves price"]) {
      expect(matchCommentKeyword(comment, ["PRICE"]), comment).toBe("PRICE");
    }
  });

  it("never matches inside a longer word", () => {
    for (const comment of ["prices", "priceless", "overpriced", "price2", "price_list", "spriced"]) {
      expect(matchCommentKeyword(comment, ["PRICE"]), comment).toBeNull();
    }
  });

  it("matches a phrase across any spacing, and not a partial phrase", () => {
    expect(matchCommentKeyword("How   much\nfor the plan?", ["how much"])).toBe("how much");
    expect(matchCommentKeyword("how is it so much", ["how much"])).toBeNull();
  });

  it("reads Hinglish, Devanagari and emoji comments", () => {
    expect(matchCommentKeyword("Bhai price kya hai??", ["PRICE"])).toBe("PRICE");
    expect(matchCommentKeyword("PRICE batao 🙏🔥", ["price"])).toBe("price");
    expect(matchCommentKeyword("🔥PRICE🔥", ["price"])).toBe("price");
    expect(matchCommentKeyword("दाम बताओ", ["दाम"])).toBe("दाम");
    // A vowel sign continues the word: "दामों" is not "दाम".
    expect(matchCommentKeyword("दामों में फर्क", ["दाम"])).toBeNull();
    expect(matchCommentKeyword("LINK 👇👇", ["link"])).toBe("link");
    expect(matchCommentKeyword("💰💰", ["💰"])).toBe("💰");
  });

  it("returns the creator's first keyword that matches, keeping how they wrote it", () => {
    expect(matchCommentKeyword("link and price pls", ["PRICE", "Link"])).toBe("PRICE");
    expect(matchCommentKeyword("send the link", ["PRICE", "Link"])).toBe("Link");
    expect(matchCommentKeyword("nice reel", ["PRICE", "Link"])).toBeNull();
    expect(matchCommentKeyword("price", [])).toBeNull();
  });

  it("treats keyword characters literally", () => {
    expect(matchCommentKeyword("c++ course?", ["C++"])).toBe("C++");
    expect(matchCommentKeyword("cx course?", ["c.x"])).toBeNull();
    expect(matchCommentKeyword("ＰＲＩＣＥ", ["price"])).toBe("price");
  });
});

describe("comment keywords as stored", () => {
  it("trims, single-spaces and drops blanks and repeats in any case", () => {
    expect(normalizeCommentKeywords(["  PRICE ", "price", "", "  ", "how   much", "Link"])).toEqual({ ok: true, keywords: ["PRICE", "how much", "Link"] });
  });

  it("refuses more than 10, longer than 30 characters, or no letter, digit or emoji", () => {
    expect(normalizeCommentKeywords(Array.from({ length: 11 }, (_, i) => `word${i}`))).toEqual({ ok: false, error: "too_many_keywords" });
    expect(normalizeCommentKeywords(Array.from({ length: 10 }, (_, i) => `word${i}`))).toMatchObject({ ok: true });
    expect(normalizeCommentKeywords(["x".repeat(31)])).toEqual({ ok: false, error: "keyword_too_long" });
    expect(normalizeCommentKeywords(["x".repeat(30)])).toMatchObject({ ok: true });
    expect(normalizeCommentKeywords(["दाम".repeat(10)])).toMatchObject({ ok: true });
    expect(normalizeCommentKeywords(["?!"])).toEqual({ ok: false, error: "keyword_needs_a_word" });
    expect(normalizeCommentKeywords(["💰"])).toEqual({ ok: true, keywords: ["💰"] });
  });
});

describe("the 7-day private reply window", () => {
  const commentedAt = new Date("2026-11-01T10:00:00Z");

  it("closes exactly 7 days after the comment", () => {
    expect(commentReplyBy(commentedAt).toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(canReplyPrivately(commentedAt, commentedAt.getTime() + COMMENT_REPLY_WINDOW_MS - 1)).toBe(true);
    expect(canReplyPrivately(commentedAt, commentedAt.getTime() + COMMENT_REPLY_WINDOW_MS)).toBe(false);
    expect(canReplyPrivately(commentedAt.toISOString(), new Date("2026-11-20T00:00:00Z"))).toBe(false);
  });
});
