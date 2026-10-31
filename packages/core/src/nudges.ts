/**
 * Follow-up ("nudge") clock, shared by the inbox/thread read models, the
 * worker scheduler and the web demo store so "follow-up due" means the same
 * thing on every surface. Same rule as nudgeDueAt/isNudgeDue in
 * @dealdock/db's schedule rules; times may be Dates or epoch ms.
 */

const DAY_MS = 86_400_000;

/** The org default for nudgeDelayDays (the Organization column default). */
export const DEFAULT_NUDGE_DELAY_DAYS = 3;

export interface NudgeClock {
  state: string;
  waitingSince: Date | number | null;
  lastOutboundAt: Date | number | null;
  nudgeDismissedAt: Date | number | null;
}

function ms(at: Date | number): number {
  return typeof at === "number" ? at : at.getTime();
}

/**
 * When the current follow-up cycle falls due (PRD §5.3/§6.5), or null when
 * no cycle is running. A cycle starts at the later of entering "waiting" (a
 * dismissal resets that clock) and our last outbound message (a sent
 * follow-up restarts it). A dismissal recorded after the cycle fell due
 * silences that cycle only — the pre-reset behaviour for legacy rows.
 */
export function nudgeDueAt(clock: NudgeClock, delayDays: number): Date | null {
  if (clock.state !== "waiting" || clock.waitingSince == null) return null;
  const quietSince = Math.max(ms(clock.waitingSince), clock.lastOutboundAt == null ? 0 : ms(clock.lastOutboundAt));
  const dueAt = quietSince + delayDays * DAY_MS;
  if (clock.nudgeDismissedAt != null && ms(clock.nudgeDismissedAt) >= dueAt) return null;
  return new Date(dueAt);
}

export function isNudgeDue(clock: NudgeClock, delayDays: number, now: Date | number): boolean {
  const dueAt = nudgeDueAt(clock, delayDays);
  return dueAt !== null && ms(now) >= dueAt.getTime();
}
