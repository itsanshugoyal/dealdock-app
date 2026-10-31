import { describe, expect, it } from "vitest";
import { emptySnapshot, failed, IDLE, isFresh, ready, SLICE_FRESH_MS } from "../src/lib/snapshot";
import { secondsLeft } from "../src/lib/undo";
import { memoizeSelection } from "../src/lib/use-demo";
import type { AppSnapshot } from "../src/lib/types";

describe("slice freshness (useLazy skips a fresh slice on mount)", () => {
  it("is fresh only while ready, untouched by a write and younger than the stale time", () => {
    const now = Date.now();
    const slice = { ...ready(["a"]), loadedAt: now - 1_000 };
    expect(isFresh(slice, now)).toBe(true);
    expect(isFresh({ ...slice, loadedAt: now - SLICE_FRESH_MS }, now)).toBe(false);
    expect(isFresh({ ...slice, stale: true }, now)).toBe(false);
    expect(isFresh(failed(slice, "Offline", null), now)).toBe(false);
    expect(isFresh(IDLE, now)).toBe(false);
  });
});

describe("memoized selection (useAppSelector, useMoneyContext)", () => {
  const select = (snapshot: AppSnapshot) => ({ currency: snapshot.money.currency, timezone: snapshot.timezone });
  const same = (a: ReturnType<typeof select>, b: ReturnType<typeof select>) => a.currency === b.currency && a.timezone === b.timezone;

  it("keeps the same object until a selected value changes", () => {
    const pick = memoizeSelection(select, same);
    const first = emptySnapshot("ready");
    const value = pick(first);
    expect(pick(first)).toBe(value);
    expect(pick({ ...first, threads: [] })).toBe(value);
    const moved = pick({ ...first, timezone: "Europe/London" });
    expect(moved).not.toBe(value);
    expect(moved.timezone).toBe("Europe/London");
  });

  it("returns what the component last rendered when its selector is recreated", () => {
    const snapshot = emptySnapshot("ready");
    const rendered = memoizeSelection(select, same)(snapshot);
    expect(memoizeSelection(select, same, { value: rendered })({ ...snapshot })).toBe(rendered);
  });
});

describe("undo countdown", () => {
  it("counts whole seconds down from the window's start", () => {
    const action = { seconds: 5, startedAt: 10_000 };
    expect(secondsLeft(action, 10_000)).toBe(5);
    expect(secondsLeft(action, 11_999)).toBe(4);
    expect(secondsLeft(action, 15_000)).toBe(0);
    expect(secondsLeft(action, 99_000)).toBe(0);
  });
});
