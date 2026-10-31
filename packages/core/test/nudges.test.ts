import { describe, expect, it } from "vitest";
import { DEFAULT_NUDGE_DELAY_DAYS, isNudgeDue, nudgeDueAt } from "../src/nudges";

// Same cases as @dealdock/db's schedule-rules test: the two copies must agree until db uses this one.
const DAY = 86_400_000;
const t0 = new Date("2026-10-01T10:00:00Z");
const days = (n: number) => new Date(t0.getTime() + n * DAY);
const waiting = { state: "waiting", waitingSince: t0, lastOutboundAt: null, nudgeDismissedAt: null };

describe("nudge clock", () => {
  it("falls due after the org delay of silence while waiting", () => {
    expect(nudgeDueAt(waiting, 3)).toEqual(days(3));
    expect(isNudgeDue(waiting, 3, days(2.9))).toBe(false);
    expect(isNudgeDue(waiting, 3, days(3))).toBe(true);
  });

  it("never runs outside the waiting state", () => {
    expect(nudgeDueAt({ ...waiting, state: "open" }, 3)).toBeNull();
    expect(nudgeDueAt({ ...waiting, waitingSince: null }, 3)).toBeNull();
  });

  it("restarts from our last outbound message (a sent follow-up)", () => {
    const sentNudge = { ...waiting, lastOutboundAt: days(3.5) };
    expect(nudgeDueAt(sentNudge, 3)).toEqual(days(6.5));
    expect(isNudgeDue(sentNudge, 3, days(4))).toBe(false);
    // An outbound reply before waiting began does not move the clock.
    expect(nudgeDueAt({ ...waiting, lastOutboundAt: days(-1) }, 3)).toEqual(days(3));
  });

  it("a dismissal resets waitingSince, so the follow-up returns after another delay", () => {
    const dismissed = { ...waiting, waitingSince: days(4) };
    expect(isNudgeDue(dismissed, 3, days(5))).toBe(false);
    expect(isNudgeDue(dismissed, 3, days(7))).toBe(true);
  });

  it("honours a legacy dismissal made after the cycle fell due", () => {
    expect(nudgeDueAt({ ...waiting, nudgeDismissedAt: days(3.2) }, 3)).toBeNull();
    // ...but not one from before this cycle began.
    expect(nudgeDueAt({ ...waiting, nudgeDismissedAt: days(-2) }, 3)).toEqual(days(3));
  });

  it("accepts epoch milliseconds (web view-models) with the same answers", () => {
    const ms = { state: "waiting", waitingSince: t0.getTime(), lastOutboundAt: days(3.5).getTime(), nudgeDismissedAt: null };
    expect(nudgeDueAt(ms, 3)).toEqual(days(6.5));
    expect(isNudgeDue(ms, 3, days(6.5).getTime())).toBe(true);
    expect(isNudgeDue(ms, 3, days(6.4))).toBe(false);
    expect(nudgeDueAt({ ...ms, nudgeDismissedAt: days(7).getTime() }, 3)).toBeNull();
  });

  it("uses the org's delay, defaulting to three days", () => {
    expect(DEFAULT_NUDGE_DELAY_DAYS).toBe(3);
    expect(nudgeDueAt(waiting, 7)).toEqual(days(7));
    expect(isNudgeDue(waiting, 1, days(1))).toBe(true);
  });
});
