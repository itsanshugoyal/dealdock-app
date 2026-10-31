import { describe, expect, it } from "vitest";
import { isNudgeDue, isQuietHour, nudgeDueAt, weeklyDigestSlot } from "../src/schedule-rules";

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
});

describe("weekly digest slot", () => {
  it("opens at Monday 09:00 local and stays open through the week", () => {
    // Monday 2 Nov 2026: 09:00 IST = 03:30Z.
    expect(weeklyDigestSlot(new Date("2026-11-02T03:29:00Z"), "Asia/Kolkata")).toBeNull();
    expect(weeklyDigestSlot(new Date("2026-11-02T03:30:00Z"), "Asia/Kolkata")).toEqual({ isoWeek: "2026-W45" });
    expect(weeklyDigestSlot(new Date("2026-11-04T06:00:00Z"), "Asia/Kolkata")).toEqual({ isoWeek: "2026-W45" });
  });

  it("defers through quiet hours instead of dropping", () => {
    // Tuesday 23:30 IST is quiet; Wednesday 08:00 IST is allowed again.
    expect(weeklyDigestSlot(new Date("2026-11-03T18:00:00Z"), "Asia/Kolkata")).toBeNull();
    expect(weeklyDigestSlot(new Date("2026-11-04T02:30:00Z"), "Asia/Kolkata")).toEqual({ isoWeek: "2026-W45" });
  });

  it("quiet hours are 23:00–07:59 local", () => {
    expect([7, 8, 22, 23].map(isQuietHour)).toEqual([true, false, false, true]);
  });
});
