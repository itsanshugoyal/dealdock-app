export const INBOX_VIEWS = ["needs", "followups", "waiting", "check", "closed"] as const;
export type InboxView = typeof INBOX_VIEWS[number];

/** URL input is untrusted; an old or mistyped view should still open the inbox. */
export function inboxView(value: string | null | undefined): InboxView {
  return INBOX_VIEWS.includes(value as InboxView) ? value as InboxView : "needs";
}

/** Carry the originating queue through a conversation without accepting a redirect URL. */
export function inboxSearch(params: Pick<URLSearchParams, "get">): string {
  const next = new URLSearchParams();
  const account = params.get("account");
  const view = inboxView(params.get("view"));
  const query = params.get("q");
  if (account) next.set("account", account);
  if (view !== "needs") next.set("view", view);
  if (query) next.set("q", query);
  const search = next.toString();
  return search ? `?${search}` : "";
}

export function inboxHref(params: Pick<URLSearchParams, "get">): string {
  return `/inbox${inboxSearch(params)}`;
}

export function conversationHref(id: string, params: Pick<URLSearchParams, "get">): string {
  return `/thread/${encodeURIComponent(id)}${inboxSearch(params)}`;
}
