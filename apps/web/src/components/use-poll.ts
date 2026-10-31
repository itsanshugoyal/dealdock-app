"use client";

import { useEffect, useRef, useState } from "react";

export interface PollOptions {
  /** Poll only while true; turning it off (or unmounting) stops at once. */
  enabled: boolean;
  /** The wait before each call; the last one repeats, so the back-off levels off. */
  delays: readonly number[];
  /** Give up after this much waiting in total. Time the page spends hidden doesn't count. */
  maxMs: number;
  /** Make the first call straight away instead of after the first delay. */
  immediate?: boolean;
}

/**
 * Repeats `poll` while `enabled`, waiting longer each time (`delays`). A call
 * that falls due while the page is hidden waits until it is visible again, so
 * a background tab costs nothing. `poll` resolves true when there is nothing
 * left to wait for; a rejection also stops it (the screen shows its own
 * error). Returns true once polling gave up after `maxMs`, so the screen can say so.
 */
export function usePoll(poll: () => Promise<boolean>, { enabled, delays, maxMs, immediate = false }: PollOptions): boolean {
  const latest = useRef(poll);
  latest.current = poll;
  const [expired, setExpired] = useState(false);
  const steps = delays.join(",");
  useEffect(() => {
    if (!enabled) return;
    const waits = steps.split(",").map(Number);
    let active = true;
    let attempt = 0;
    let waited = 0;
    let parked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (!active) return;
      if (document.hidden) { parked = true; return; }
      let done: boolean;
      try {
        done = await latest.current();
      } catch {
        return;
      }
      if (active && !done) schedule();
    };
    const schedule = () => {
      const delay = waits[Math.min(attempt, waits.length - 1)] ?? 0;
      attempt += 1;
      if (waited + delay > maxMs) { setExpired(true); return; }
      waited += delay;
      timer = setTimeout(() => { timer = undefined; void run(); }, delay);
    };
    const resume = () => {
      if (!parked || document.hidden) return;
      parked = false;
      void run();
    };
    document.addEventListener("visibilitychange", resume);
    if (immediate) void run(); else schedule();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      setExpired(false);
    };
  }, [enabled, steps, maxMs, immediate]);
  return expired;
}
