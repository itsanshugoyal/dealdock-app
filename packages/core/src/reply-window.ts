import type { ReplyWindow } from "./api-types";

/** Meta's standard messaging window after the other person's last message. */
export const STANDARD_REPLY_WINDOW_MS = 24 * 60 * 60_000;
/** Window for human-approved replies sent with the HUMAN_AGENT message tag. */
export const HUMAN_AGENT_REPLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Where a conversation sits in Instagram's reply window. Pure so the API send
 * gate, the thread DTO and the web countdown all agree on one rule.
 */
export function computeReplyWindow(
  lastInboundAt: Date | string | null,
  now: Date,
  humanAgentEnabled: boolean,
): ReplyWindow {
  const inbound = lastInboundAt === null ? null : new Date(lastInboundAt);
  if (!inbound || !Number.isFinite(inbound.getTime())) {
    return { status: "unknown", lastInboundAt: null, standardClosesAt: null, extendedClosesAt: null, humanAgentEnabled };
  }
  const standard = inbound.getTime() + STANDARD_REPLY_WINDOW_MS;
  const extended = inbound.getTime() + HUMAN_AGENT_REPLY_WINDOW_MS;
  const t = now.getTime();
  const status = t <= standard ? "open" : humanAgentEnabled && t <= extended ? "extended" : "closed";
  return {
    status,
    lastInboundAt: inbound.toISOString(),
    standardClosesAt: new Date(standard).toISOString(),
    extendedClosesAt: new Date(extended).toISOString(),
    humanAgentEnabled,
  };
}

/** A send needs the HUMAN_AGENT tag exactly when it falls in the extended part of the window. */
export function needsHumanAgentTag(window: ReplyWindow): boolean {
  return window.status === "extended";
}

/** "Closing soon" / at risk: the standard window closes within this long (Today, Insights pipeline). */
export const AT_RISK_MS = 6 * 60 * 60_000;

/**
 * The standard 24h window is still open and closes within `withinMs`
 * (default AT_RISK_MS). Extended, closed and unknown windows never count:
 * an extended window is already past the standard close.
 */
export function isClosingSoon(window: ReplyWindow, now: Date | number, withinMs: number = AT_RISK_MS): boolean {
  if (window.status !== "open") return false;
  const left = Date.parse(window.standardClosesAt ?? "") - (typeof now === "number" ? now : now.getTime());
  return Number.isFinite(left) && left >= 0 && left <= withinMs;
}
