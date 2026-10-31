import { describe, expect, it } from "vitest";
import { DRAFT_CHIPS, type DraftChip, type OfferDto, type ReplyWindow } from "@dealdock/core";
import {
  DRAFT_CHIP_TEXT,
  accountBigOneThreshold,
  bigOneThreshold,
  byValueDesc,
  chipText,
  compactCount,
  confidenceReason,
  confidenceWords,
  dayKey,
  dayLabel,
  dealTypeForLabel,
  displayName,
  followUpDue,
  formatDate,
  formatTime,
  isBigOne,
  isWaiting,
  middleTruncate,
  needsYou,
  replyWindowInfo,
  roleText,
  scopeText,
  shortDuration,
  textLang,
  tierText,
  toCheck,
  waitingLowMinor,
} from "../src/lib/format";
import type { DemoThread } from "../src/lib/types";

const HOUR = 3_600_000;
const window = (status: ReplyWindow["status"], closesInMs: number, extendedInMs = 0): ReplyWindow => ({
  status,
  lastInboundAt: null,
  standardClosesAt: new Date(1_000_000_000 + closesInMs).toISOString(),
  extendedClosesAt: new Date(1_000_000_000 + extendedInMs).toISOString(),
  humanAgentEnabled: status === "extended",
});
const NOW = 1_000_000_000;

describe("confidence words (never a percentage)", () => {
  it("uses the 0.80 / 0.55 thresholds", () => {
    expect(confidenceWords(0.8, "brand_deal")).toBe("Looks like a brand deal");
    expect(confidenceWords(0.79, "coaching_lead")).toBe("Probably a coaching enquiry");
    expect(confidenceWords(0.55, "other_commerce")).toBe("Probably another sale");
    expect(confidenceWords(0.54, "course_inquiry")).toBe("Not sure — maybe a course enquiry");
    expect(confidenceWords(0.2, "uncertain")).toBe("Not sure");
    expect(confidenceReason(null)).toBe("Why: based on the message text.");
  });
});

describe("big-one threshold", () => {
  const offer = (dealType: OfferDto["dealType"], priceMinMinor: number | null, active = true) => ({ dealType, priceMinMinor, active }) as OfferDto;
  it("is the lowest active brand price, else the per-currency default", () => {
    expect(bigOneThreshold("INR", [offer("brand", 90_000_00), offer("brand", 60_000_00), offer("brand", 10_000_00, false), offer("coaching", 1_000_00)])).toBe(60_000_00);
    expect(bigOneThreshold("INR", [])).toBe(1_00_000_00);
    expect(bigOneThreshold("USD")).toBe(1_000_00);
    expect(bigOneThreshold("GBP")).toBe(800_00);
    expect(bigOneThreshold("AED")).toBe(4_000_00);
  });

  it("per account, reads that account's and workspace-wide offers in the org currency, like the push", () => {
    const priced = (priceMinMinor: number, igAccountId: string | null, currencyCode: OfferDto["currencyCode"] = "INR") =>
      ({ ...offer("brand", priceMinMinor), igAccountId, currencyCode }) as OfferDto;
    const offers = [priced(80_000_00, "ig-1"), priced(30_000_00, "ig-2"), priced(50_000_00, null), priced(1_000_00, "ig-1", "USD")];
    expect(accountBigOneThreshold("INR", offers, "ig-1")).toBe(50_000_00);
    expect(accountBigOneThreshold("INR", offers, "ig-2")).toBe(30_000_00);
    expect(accountBigOneThreshold("INR", [priced(80_000_00, "ig-1")], "ig-3")).toBe(1_00_000_00);
    expect(accountBigOneThreshold("INR", offers, null)).toBe(50_000_00);
    expect(accountBigOneThreshold("USD", null, "ig-1")).toBe(1_000_00);
  });
});

describe("reply window clock copy", () => {
  it("hides on rows above 6 h, strengthens under 6 h, turns danger under 1 h", () => {
    expect(replyWindowInfo(window("open", 18 * HOUR), NOW, "row").visible).toBe(false);
    expect(replyWindowInfo(window("open", 18 * HOUR), NOW, "header")).toMatchObject({ visible: true, text: "Reply window · 18h left", tone: "muted" });
    expect(replyWindowInfo(window("open", 5 * HOUR), NOW, "row")).toMatchObject({ text: "5h left", tone: "strong" });
    expect(replyWindowInfo(window("open", 45 * 60_000), NOW, "row")).toMatchObject({ text: "45m left", tone: "danger" });
  });
  it("hands closed windows to Instagram and shows extended windows under a day on rows", () => {
    expect(replyWindowInfo(window("closed", -HOUR), NOW, "row")).toMatchObject({ closed: true, text: "Reply in Instagram" });
    expect(replyWindowInfo(window("closed", -HOUR), NOW, "header").text).toBe("Reply window closed");
    expect(replyWindowInfo(window("extended", -HOUR, 20 * HOUR), NOW, "row")).toMatchObject({ visible: true, text: "20h left" });
    expect(replyWindowInfo(window("extended", -HOUR, 4 * 24 * HOUR), NOW, "row").visible).toBe(false);
    expect(replyWindowInfo(window("extended", -HOUR, 4 * 24 * HOUR), NOW, "header")).toMatchObject({ text: "Extended window · 4d left", extended: true });
    expect(replyWindowInfo({ ...window("unknown", 0), standardClosesAt: null }, NOW, "header").visible).toBe(false);
  });
});

describe("small text helpers", () => {
  it("formats durations, truncates handles in the middle and tags Devanagari", () => {
    expect(shortDuration(30_000)).toBe("1m");
    expect(shortDuration(3 * HOUR + 5)).toBe("3h");
    expect(shortDuration(50 * HOUR)).toBe("2d");
    expect(middleTruncate("very.long.brand.handle.official", 15)).toBe("very.lo…fficial");
    expect(textLang("नमस्ते दीया जी")).toBe("hi");
    expect(textLang("Fees kya hai?")).toBeUndefined();
  });
});

describe("deal type for a recorded sale", () => {
  it("follows the commerce label and defaults to Other", () => {
    expect(dealTypeForLabel("brand_deal")).toBe("brand");
    expect(dealTypeForLabel("coaching_lead")).toBe("coaching");
    expect(dealTypeForLabel("course_inquiry")).toBe("course");
    expect(dealTypeForLabel("other_commerce")).toBe("other");
    expect(dealTypeForLabel("fan")).toBe("other");
    expect(dealTypeForLabel(null)).toBe("other");
  });
});

describe("conversation groups", () => {
  const row = (patch: Partial<DemoThread> = {}) => ({
    routedTo: "inbox", state: "open", unreplied: true, topLabel: "brand_deal", reviewed: false, nudgeDue: false,
    estValueMinMinor: null, estValueMaxMinor: null, lastMessageAt: 0, ...patch,
  }) as DemoThread;

  it("needs you: unreplied, open commerce in the inbox", () => {
    expect(needsYou(row())).toBe(true);
    expect(needsYou(row({ unreplied: false }))).toBe(false);
    expect(needsYou(row({ state: "waiting" }))).toBe(false);
    expect(needsYou(row({ topLabel: "fan" }))).toBe(false);
    expect(needsYou(row({ topLabel: null }))).toBe(false);
    expect(needsYou(row({ routedTo: "review_queue" }))).toBe(false);
  });

  it("separates review items, waiting conversations and due follow-ups", () => {
    expect(toCheck(row({ routedTo: "review_queue" }))).toBe(true);
    expect(toCheck(row({ routedTo: "review_queue", reviewed: true }))).toBe(false);
    expect(toCheck(row())).toBe(false);
    expect(isWaiting(row({ state: "waiting" }))).toBe(true);
    expect(isWaiting(row({ state: "waiting", routedTo: "review_queue" }))).toBe(false);
    expect(isWaiting(row())).toBe(false);
    expect(followUpDue(row({ state: "waiting", nudgeDue: true }))).toBe(true);
    expect(followUpDue(row({ state: "waiting" }))).toBe(false);
  });

  it("big ones are commerce at or above the threshold", () => {
    expect(isBigOne(row({ estValueMaxMinor: 60_000_00 }), 60_000_00)).toBe(true);
    expect(isBigOne(row({ estValueMaxMinor: 59_999_99 }), 60_000_00)).toBe(false);
    expect(isBigOne(row({ estValueMaxMinor: 90_000_00, topLabel: "uncertain" }), 60_000_00)).toBe(false);
    expect(isBigOne(row(), 60_000_00)).toBe(false);
  });

  it("orders by estimate, then by the latest message", () => {
    const threads = [
      row({ id: "small", estValueMaxMinor: 1_000_00, lastMessageAt: 5 }),
      row({ id: "none-old", lastMessageAt: 1 }),
      row({ id: "big", estValueMaxMinor: 9_000_00, lastMessageAt: 2 }),
      row({ id: "none-new", lastMessageAt: 9 }),
      row({ id: "small-new", estValueMaxMinor: 1_000_00, lastMessageAt: 7 }),
    ];
    expect([...threads].sort(byValueDesc).map((thread) => thread.id)).toEqual(["big", "small-new", "small", "none-new", "none-old"]);
  });

  it("totals the low end of what is waiting", () => {
    expect(waitingLowMinor([row({ estValueMinMinor: 20_000_00, estValueMaxMinor: 40_000_00 }), row({ estValueMaxMinor: 5_000_00 }), row()])).toBe(25_000_00);
    expect(waitingLowMinor([])).toBe(0);
  });

  it("names a sender by their trimmed name, else their handle", () => {
    expect(displayName({ name: "  Priya Shah " }, "priya")).toBe("Priya Shah");
    expect(displayName({ name: "   " }, "priya")).toBe("@priya");
    expect(displayName({ name: null }, "priya")).toBe("@priya");
    expect(displayName(null, "priya")).toBe("@priya");
  });
});

describe("words for enums", () => {
  it("names voice-rule scopes, roles and tiers", () => {
    expect(scopeText("all")).toBe("All replies");
    expect(scopeText("nudge")).toBe("Follow-ups");
    expect(scopeText("brand_deal")).toBe("Brand deals");
    expect(scopeText("uncertain")).toBe("Not sure");
    expect(roleText("creator")).toBe("Creator");
    expect(roleText("manager")).toBe("Manager");
    expect(tierText("studio")).toBe("Studio");
    expect(tierText("roster")).toBe("Roster");
  });

  it("has words for every steering chip", () => {
    expect(Object.keys(DRAFT_CHIP_TEXT).sort()).toEqual([...DRAFT_CHIPS].sort());
    expect(chipText("quote_rate")).toBe("Add my rate");
    expect(chipText("ask_budget")).toBe("Ask their budget");
    expect(chipText("more_hinglish")).toBe("More Hinglish");
    expect(chipText("brand_new_chip" as DraftChip)).toBe("Brand new chip");
  });
});

describe("dates in the org zone", () => {
  const ZONE = "Asia/Kolkata";
  // Saturday 31 Oct 2026, 11:30 in Kolkata.
  const now = Date.parse("2026-10-31T06:00:00Z");

  it("labels today and yesterday by the org's calendar, not the device's", () => {
    expect(dayLabel(Date.parse("2026-10-30T18:30:00Z"), now, "en-IN", ZONE)).toBe("Today"); // 00:00 on the 31st there
    expect(dayLabel(Date.parse("2026-10-30T18:29:00Z"), now, "en-IN", ZONE)).toBe("Yesterday");
    expect(dayLabel(Date.parse("2026-10-29T18:30:00Z"), now, "en-IN", ZONE)).toBe("Yesterday");
    const older = Date.parse("2026-10-29T18:29:00Z");
    expect(dayLabel(older, now, "en-IN", ZONE)).toBe(formatDate(older, "en-IN", ZONE, { weekday: "long", day: "numeric", month: "long" }));
    expect(dayLabel(older, now, "en-IN", ZONE, "short")).toBe(formatDate(older, "en-IN", ZONE, { weekday: "short", day: "numeric", month: "short" }));
    const midnight = Date.parse("2026-10-30T18:30:00Z");
    expect(dayKey(midnight, ZONE)).not.toBe(dayKey(midnight, "UTC"));
  });

  it("shows only the date before the clock starts", () => {
    const at = now - HOUR;
    expect(dayLabel(at, null, "en-IN", ZONE)).toBe(formatDate(at, "en-IN", ZONE, { weekday: "long", day: "numeric", month: "long" }));
    expect(dayLabel(at, 0, "en-IN", ZONE)).not.toBe("Today");
  });

  it("formats repeatably, falls back to the device zone for a bad zone, and blanks bad dates", () => {
    const first = formatDate(now, "en-GB", ZONE);
    expect(formatDate(now, "en-GB", ZONE)).toBe(first);
    expect(formatTime(now, "en-GB", ZONE)).toBe(formatDate(now, "en-GB", ZONE, { hour: "numeric", minute: "2-digit" }));
    expect(formatDate(now, "en-GB", "Not/A_Zone")).toBe(new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(now));
    expect(formatDate("not a date", "en-GB", ZONE)).toBe("");
    expect(compactCount(48_200, "en-US")).toBe("48.2K");
    expect(compactCount(48_200, "en-US")).toBe("48.2K");
  });
});
