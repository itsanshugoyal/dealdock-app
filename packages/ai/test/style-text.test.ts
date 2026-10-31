import { describe, expect, it } from "vitest";
import {
  aiTellScore,
  codeMixingIndex,
  containsPhrase,
  emojiCount,
  greetingOf,
  hindiShare,
  isContentSpan,
  languageOf,
  normalizeForSim,
  signoffOf,
  tokenize,
  trigramSimilarity,
  wordCount,
  wordDiff,
} from "../src/style-text";

describe("tokenize / words", () => {
  it("keeps Devanagari words with matras intact and splits emoji as their own tokens", () => {
    expect(tokenize("नमस्ते जी")).toEqual(["नमस्ते", "जी"]);
    expect(tokenize("Love it 🔥🔥")).toEqual(["love", "it", "🔥", "🔥"]);
    expect(wordCount("Love it 🔥🔥")).toBe(2);
    expect(emojiCount("❤️ love it 🔥")).toBe(2);
  });

  it("never counts an emoji variation selector as a word", () => {
    expect(wordCount("❤️")).toBe(0);
  });
});

describe("code mixing", () => {
  it("is 0 for monolingual English and romanized Hindi, mixed in between", () => {
    expect(codeMixingIndex("Please share the brief with your budget")).toBe(0);
    expect(codeMixingIndex("haan bhai kya hai yaar")).toBe(0);
    const cmi = codeMixingIndex("haan bhai rates bhej do, will check");
    expect(cmi).toBeGreaterThan(0.3);
    expect(cmi).toBeLessThan(0.6);
  });

  it("is 0 below 3 classified words, and never reads 'to'/'me' as Hindi", () => {
    expect(codeMixingIndex("haan ok")).toBe(0);
    expect(hindiShare("send it to me now please")).toBe(0);
  });

  it("hindiShare is monotonic in Hindi words and detects language", () => {
    expect(hindiShare("haan bhai kya scene hai")).toBeGreaterThan(hindiShare("haan bhai rates bhej do, will check"));
    expect(languageOf("Kya rate hai aapka?")).toBe("hinglish");
    expect(languageOf("What is your rate?")).toBe("en");
    expect(languageOf("आपका रेट क्या है")).toBe("hi");
  });
});

describe("greetingOf / signoffOf", () => {
  it("finds openers", () => {
    expect(greetingOf("Hey hey! Loved this")).toBe("Hey hey!");
    expect(greetingOf("Heyy loved your reel")).toBe("Heyy");
    expect(greetingOf("Hi team, thanks for the brief")).toBe("Hi team");
    expect(greetingOf("Thanks for reaching out! We'd love to")).toBe("Thanks for reaching out!");
  });

  it("returns nothing for a long first clause", () => {
    expect(greetingOf("I would really love to collaborate with your brand on this.")).toBe("");
  });

  it("finds a sign-off only on a short last line after a real body", () => {
    expect(signoffOf("Hey!\nSure thing, send the brief over\n– R")).toBe("– R");
    expect(signoffOf("Hey hey! Loved this")).toBe("");
    expect(signoffOf("Hey hey!\nSend me the brief")).toBe("");
  });
});

describe("content spans and phrases", () => {
  it("treats prices, dates, links and handles as facts", () => {
    for (const span of ["₹25,000", "12 Nov", "https://example.com/kit", "@brand", "Rs 500", "next Friday", "2 lakh"]) {
      expect(isContentSpan(span), span).toBe(true);
    }
    expect(isContentSpan("thanks so much")).toBe(false);
    expect(isContentSpan("our marketing team")).toBe(false);
  });

  it("matches phrases on whole words, case and punctuation insensitive", () => {
    expect(containsPhrase("Thanks for reaching out!!", "thanks for reaching out")).toBe(true);
    expect(containsPhrase("I'd be happy to help", "i'd be happy to")).toBe(true);
    expect(containsPhrase("kindness matters", "kindly")).toBe(false);
    expect(containsPhrase("Sure — sending now", "—")).toBe(true);
    expect(aiTellScore("Thanks for reaching out! Feel free to DM. Kindly share")).toBe(3);
  });
});

describe("trigram similarity", () => {
  it("is symmetric, 1 for identical text and 0 for empty", () => {
    const a = "what are your rates for a reel";
    const b = "rates for 2 reels?";
    expect(trigramSimilarity(a, b)).toBeCloseTo(trigramSimilarity(b, a));
    expect(trigramSimilarity(a, a)).toBe(1);
    expect(trigramSimilarity("", a)).toBe(0);
  });

  it("collapses letter runs so 'pleaseee' ≈ 'pleasee'", () => {
    expect(normalizeForSim("Pleaseee!!")).toBe("pleasee");
    expect(trigramSimilarity("pleaseee", "pleasee")).toBe(1);
  });
});

describe("wordDiff", () => {
  it("groups word changes into hunks and ignores punctuation-only changes", () => {
    expect(wordDiff("Thanks for reaching out! Send the brief.", "Hey hey! Send the brief.")).toEqual([
      { deleted: "Thanks for reaching out!", inserted: "Hey hey!" },
    ]);
    expect(wordDiff("Send the brief", "Send the brief!")).toEqual([]);
  });
});
