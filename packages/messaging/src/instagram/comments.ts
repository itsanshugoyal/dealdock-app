/**
 * Instagram `comments` webhooks (Instagram API with Instagram Login). Meta's
 * Instagram Login example puts `field`/`value` directly on each entry; its
 * Facebook Login examples nest them in `entry[].changes[]`. Both are read.
 * `entry.id` is the creator's account. Mentions arrive under `comments` too,
 * and nothing documented tells them apart, so they are read like any comment
 * (to confirm on a live account).
 */

/** One comment by someone else, with text, on the creator's media. */
export interface InboundComment {
  /** The creator's Instagram account id (entry.id). */
  accountPlatformUserId: string;
  commentId: string;
  mediaId: string;
  /** "FEED", "REELS", "AD"…; null when Meta leaves it out. */
  mediaProductType: string | null;
  commenterId: string;
  /** Their username; their id when Meta leaves it out. */
  commenterHandle: string;
  text: string;
  /** When Meta sent the notification: the closest time the payload gives to the comment's. */
  commentedAt: Date;
}

/** Instagram's caption and comment limit. */
const MAX_TEXT = 2_200;
const id = (value: unknown) => (typeof value === "string" && /^[\w:.-]{1,128}$/.test(value) ? value : null);

/** Meta's entry.time: seconds in its Graph webhooks, milliseconds in some; anything missing, unparseable or ahead of now reads as now. */
function sentAt(time: unknown, now: number): Date {
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) return new Date(now);
  const ms = time < 1e12 ? time * 1000 : time;
  return new Date(Math.min(ms, now));
}

interface CommentChange {
  field?: unknown;
  value?: {
    id?: unknown;
    /** Unified Login (Facebook Login for Business format) names the comment comment_id. */
    comment_id?: unknown;
    text?: unknown;
    from?: { id?: unknown; username?: unknown };
    media?: { id?: unknown; media_product_type?: unknown };
  };
}

export function parseCommentWebhook(payload: unknown, now: number = Date.now()): InboundComment[] {
  const body = payload as { object?: unknown; entry?: unknown };
  if (body?.object !== "instagram" || !Array.isArray(body.entry)) return [];
  const comments: InboundComment[] = [];
  for (const entry of body.entry as Array<CommentChange & { id?: unknown; time?: unknown; changes?: unknown }>) {
    const account = id(entry?.id);
    if (!account) continue;
    const changes: CommentChange[] = Array.isArray(entry.changes) ? entry.changes : [entry];
    for (const change of changes) {
      if (change?.field !== "comments" || !change.value) continue;
      const { value } = change;
      const commentId = id(value.id ?? value.comment_id);
      const commenterId = id(value.from?.id);
      const mediaId = id(value.media?.id);
      const text = typeof value.text === "string" ? value.text.trim() : "";
      // Comments without text (a sticker, a GIF) can't name a keyword; the creator's own never become leads.
      if (!commentId || !commenterId || !mediaId || !text || commenterId === account) continue;
      const username = typeof value.from?.username === "string" ? value.from.username.trim().replace(/^@/, "") : "";
      const product = value.media?.media_product_type;
      comments.push({
        accountPlatformUserId: account,
        commentId,
        mediaId,
        mediaProductType: typeof product === "string" && product.length <= 40 ? product : null,
        commenterId,
        commenterHandle: /^[\w.]{1,64}$/.test(username) ? username : commenterId,
        text: text.slice(0, MAX_TEXT),
        commentedAt: sentAt(entry.time, now),
      });
    }
  }
  return comments;
}
