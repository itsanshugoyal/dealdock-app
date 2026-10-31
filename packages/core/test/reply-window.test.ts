import { expect, it } from "vitest";
import { AT_RISK_MS, computeReplyWindow, isClosingSoon, needsHumanAgentTag } from "../src/reply-window";

const inbound = new Date("2026-10-01T10:00:00.000Z");
const at = (hours: number) => new Date(inbound.getTime() + hours * 3_600_000);

it("is open inside 24 hours and needs no tag", () => {
  const w = computeReplyWindow(inbound, at(23.9), true);
  expect(w.status).toBe("open");
  expect(needsHumanAgentTag(w)).toBe(false);
  expect(w.standardClosesAt).toBe("2026-10-02T10:00:00.000Z");
});

it("extends to 7 days only with the human agent permission", () => {
  expect(computeReplyWindow(inbound, at(30), true).status).toBe("extended");
  expect(needsHumanAgentTag(computeReplyWindow(inbound, at(30), true))).toBe(true);
  expect(computeReplyWindow(inbound, at(30), false).status).toBe("closed");
});

it("closes after 7 days even with the permission", () => {
  expect(computeReplyWindow(inbound, at(24 * 7 + 0.01), true).status).toBe("closed");
  expect(computeReplyWindow(inbound, at(24 * 7), true).status).toBe("extended");
});

it("is unknown without an inbound message or with an invalid date", () => {
  expect(computeReplyWindow(null, at(1), true).status).toBe("unknown");
  expect(computeReplyWindow("not a date", at(1), false).status).toBe("unknown");
});

it("accepts ISO strings", () => {
  expect(computeReplyWindow(inbound.toISOString(), at(1), false).lastInboundAt).toBe(inbound.toISOString());
});

it("is closing soon only while the standard window is open with at most 6 hours left", () => {
  const window = (hoursAgo: number, humanAgent = false) => computeReplyWindow(at(-hoursAgo), inbound, humanAgent);
  expect(AT_RISK_MS).toBe(6 * 3_600_000);
  expect(isClosingSoon(window(17.9), inbound)).toBe(false);
  expect(isClosingSoon(window(18), inbound)).toBe(true);
  expect(isClosingSoon(window(23.9), inbound.getTime())).toBe(true);
  expect(isClosingSoon(window(24), inbound)).toBe(true);
  // Past the standard close: extended or closed windows are no longer "closing soon".
  expect(isClosingSoon(window(25, true), inbound)).toBe(false);
  expect(isClosingSoon(window(25), inbound)).toBe(false);
  expect(isClosingSoon(computeReplyWindow(null, inbound, false), inbound)).toBe(false);
});

it("takes a custom horizon for closesWithin-style checks", () => {
  const window = computeReplyWindow(at(-22), inbound, false);
  expect(isClosingSoon(window, inbound, 60 * 60_000)).toBe(false);
  expect(isClosingSoon(window, inbound, 2 * 60 * 60_000)).toBe(true);
});
