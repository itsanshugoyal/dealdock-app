import { canReplyPrivately, type CommentLeadDto } from "@dealdock/core";
import { pluralize } from "./format";
import type { CommentLeadsView } from "./types";

/** Waiting for its private reply, inside Instagram's 7 days. */
export function isOpenLead(lead: CommentLeadDto, now: number): boolean {
  return (lead.status === "new" || lead.status === "sending") && canReplyPrivately(lead.commentedAt, now);
}

/** Never answered and past the 7 days: shown greyed until cleared. */
export function isExpiredLead(lead: CommentLeadDto, now: number): boolean {
  return lead.status === "new" && !canReplyPrivately(lead.commentedAt, now);
}

/** "6 days left", "5 hours left", "20 min left"; urgent in its last 6 hours, like a closing reply window. */
export function replyTimeLeft(lead: Pick<CommentLeadDto, "replyBy">, now: number): { text: string; urgent: boolean } {
  const ms = Date.parse(lead.replyBy) - now;
  if (ms <= 0) return { text: "Too late to reply privately", urgent: false };
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const text = days >= 1 ? `${days} ${pluralize(days, "day")} left` : hours >= 1 ? `${hours} ${pluralize(hours, "hour")} left` : `${Math.max(1, Math.floor(ms / 60_000))} min left`;
  return { text, urgent: ms < 6 * 3_600_000 };
}

/** The leads one creator scope shows (every creator's without one). */
export function leadsInScope(view: CommentLeadsView | null, account: string | null): CommentLeadDto[] {
  return (view?.leads ?? []).filter((lead) => !account || lead.igAccountId === account);
}

/** Whether the Comments view belongs in this scope: the feature is on, and keywords are set or leads exist. */
export function showsComments(view: CommentLeadsView | null, account: string | null): boolean {
  if (!view?.available) return false;
  const keywords = account ? (view.keywords[account] ?? []) : Object.values(view.keywords).flat();
  return keywords.length > 0 || leadsInScope(view, account).length > 0;
}

/** Today's line: "4 people commented PRICE", "5 people commented PRICE or LINK", else "your keywords". */
export function commentLeadsLine(open: readonly CommentLeadDto[]): string | null {
  if (!open.length) return null;
  const counts = new Map<string, { keyword: string; count: number }>();
  for (const lead of open) {
    const key = lead.keyword.toLowerCase();
    counts.set(key, { keyword: counts.get(key)?.keyword ?? lead.keyword, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const keywords = [...counts.values()].sort((a, b) => b.count - a.count).map((item) => item.keyword);
  const words = keywords.length === 1 ? keywords[0] : keywords.length === 2 ? `${keywords[0]} or ${keywords[1]}` : "your keywords";
  return `${open.length} ${pluralize(open.length, "person", "people")} commented ${words}`;
}
