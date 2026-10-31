import { describe, expect, it } from "vitest";
import {
  daysInZonedMonth,
  isoWeekKey,
  startOfZonedMonth,
  startOfZonedWeek,
  zonedMonthKey,
  zonedMonthKeys,
  zonedParts,
  zonedTimeToUtc,
} from "../src/zoned-time";
import { currentMonthKeyInTimeZone, monthKeyInTimeZone } from "../src/money";

describe("zoned calendar math", () => {
  it("reads the local wall clock and ISO weekday", () => {
    // 2026-10-31T20:00Z is Sunday 01:30 on 1 Nov in Kolkata.
    expect(zonedParts(new Date("2026-10-31T20:00:00Z"), "Asia/Kolkata")).toEqual({
      year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0, weekday: 7,
    });
  });

  it("finds the instant of a local wall time, with fractional offsets", () => {
    expect(zonedTimeToUtc(2026, 11, 1, 0, 0, "Asia/Kolkata").toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(zonedTimeToUtc(2026, 11, 2, 9, 0, "Asia/Kathmandu").toISOString()).toBe("2026-11-02T03:15:00.000Z");
  });

  it("handles DST transitions in both directions", () => {
    // London: BST ends 25 Oct 2026, starts 29 Mar 2026.
    expect(zonedTimeToUtc(2026, 10, 26, 0, 0, "Europe/London").toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(zonedTimeToUtc(2026, 10, 24, 0, 0, "Europe/London").toISOString()).toBe("2026-10-23T23:00:00.000Z");
    expect(zonedTimeToUtc(2026, 3, 30, 9, 0, "Europe/London").toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });

  it("starts the org's month, not the server's", () => {
    // 1 Nov 01:30 IST belongs to November even though it is still 31 Oct in UTC.
    const now = new Date("2026-10-31T20:00:00Z");
    expect(startOfZonedMonth(now, "Asia/Kolkata").toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(startOfZonedMonth(now, "Asia/Kolkata", 1).toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(startOfZonedMonth(new Date("2026-01-15T00:00:00Z"), "UTC", 1).toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });

  it("starts the ISO week on local Monday", () => {
    const sunday = new Date("2026-11-01T06:00:00Z"); // Sunday in Kolkata
    expect(startOfZonedWeek(sunday, "Asia/Kolkata").toISOString()).toBe("2026-10-25T18:30:00.000Z");
    expect(startOfZonedWeek(sunday, "Asia/Kolkata", 1).toISOString()).toBe("2026-10-18T18:30:00.000Z");
  });

  it("keys ISO weeks across year boundaries", () => {
    expect(isoWeekKey(new Date("2026-11-02T12:00:00Z"), "UTC")).toBe("2026-W45");
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"), "UTC")).toBe("2026-W53");
    expect(isoWeekKey(new Date("2025-12-29T12:00:00Z"), "UTC")).toBe("2026-W01");
  });

  it("keys a close-out by the org's month, not UTC's", () => {
    // 23:30Z on 31 Jan is already 1 Feb in Kiritimati (UTC+14) and still January in UTC.
    const lateJanuary = new Date("2026-01-31T23:30:00.000Z");
    expect(zonedMonthKey(lateJanuary, "Pacific/Kiritimati")).toBe("2026-02");
    expect(zonedMonthKey(lateJanuary, "UTC")).toBe("2026-01");
    expect(zonedMonthKey(new Date("2026-10-31T20:00:00Z"), "Asia/Kolkata")).toBe("2026-11");
    // The old money.ts names are the same helper.
    expect(monthKeyInTimeZone(lateJanuary, "Pacific/Kiritimati")).toBe("2026-02");
    expect(currentMonthKeyInTimeZone("UTC", lateJanuary)).toBe("2026-01");
    expect(() => zonedMonthKey(lateJanuary, "Mars/Olympus")).toThrow(RangeError);
  });

  it("lists month keys oldest first and counts days in the local month", () => {
    expect(zonedMonthKeys(new Date("2026-02-10T00:00:00Z"), "UTC", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(daysInZonedMonth(new Date("2028-02-10T00:00:00Z"), "UTC")).toBe(29);
    expect(daysInZonedMonth(new Date("2026-10-31T20:00:00Z"), "Asia/Kolkata")).toBe(30);
  });
});
