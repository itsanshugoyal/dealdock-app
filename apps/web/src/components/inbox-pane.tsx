"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef } from "react";
import { ScanSearch, Search, X } from "lucide-react";
import { accountBigOneThreshold, byValueDesc, followUpDue, isBigOne, isWaiting, needsYou, pluralize, toCheck, waitingLowMinor } from "../lib/format";
import { useMinuteClock, useShortcut } from "../lib/keyboard";
import { conversationHref, inboxView, type InboxView } from "../lib/inbox-navigation";
import { useApp, useClosedThreads, useOffers, useSettings, type DemoThread } from "../lib/use-demo";
import { ConversationRow } from "./kit";
import { cx } from "./ui/cx";
import { ErrorState, Skeleton } from "./ui/feedback";
import { appStore } from "../lib/use-demo";
import { MoneyValue } from "./ui/money-value";
import { Avatar } from "./ui/sender";

type View = InboxView;
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "needs", label: "Needs you" },
  { id: "followups", label: "Follow-ups" },
  { id: "waiting", label: "Waiting" },
  { id: "check", label: "Check these" },
  { id: "closed", label: "Closed" },
];

/**
 * What each view lists. Its count, its list, the nav badge and Today's hero all
 * come from these same predicates, so a number always matches what it opens.
 * Closed conversations load on demand and are listed as they arrive.
 */
const VIEW_FILTER: Record<Exclude<View, "closed">, (thread: DemoThread) => boolean> = {
  needs: needsYou,
  followups: (thread) => thread.routedTo === "inbox" && followUpDue(thread),
  waiting: isWaiting,
  check: toCheck,
};
const newestFirst = (a: DemoThread, b: DemoThread) => b.lastMessageAt - a.lastMessageAt;

function matches(thread: DemoThread, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [thread.handle, thread.participant.name ?? "", thread.preview].some((field) => field.toLowerCase().includes(needle));
}

/**
 * The conversation list: full screen on phones, the left pane of the desk on
 * large screens. Money first: biggest open conversations lead.
 */
export function InboxPane({ selectedId, headingLevel = "h1", className }: { selectedId?: string | null; headingLevel?: "h1" | "h2"; className?: string }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/inbox";
  const params = useSearchParams();
  const view = inboxView(params?.get("view"));
  const account = params?.get("account") ?? null;
  const { threads, money, state, loadedAt } = useApp();
  const settings = useSettings();
  const offers = useOffers();
  const closed = useClosedThreads(view === "closed");
  const now = useMinuteClock();
  const query = params?.get("q") ?? "";
  const listRef = useRef<HTMLUListElement>(null);
  const Heading = headingLevel;
  const accounts = settings.data?.accounts ?? [];
  const roster = settings.data?.tier === "roster" && accounts.length > 1;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (value) next.set(key, value); else next.delete(key);
    const search = next.toString();
    router.replace(`${pathname}${search ? `?${search}` : ""}`, { scroll: false });
  };

  const scoped = useMemo(() => threads.filter((thread) => !account || thread.igAccountId === account), [threads, account]);
  const counts = useMemo(() => {
    const count = (id: Exclude<View, "closed">) => scoped.filter(VIEW_FILTER[id]).length;
    return { needs: count("needs"), followups: count("followups"), waiting: count("waiting"), check: count("check"), closed: 0 };
  }, [scoped]);

  const list = useMemo(() => {
    const source = view === "closed"
      ? (closed.data ?? []).filter((t) => !account || t.igAccountId === account)
      : scoped.filter(VIEW_FILTER[view]);
    return source.filter((thread) => matches(thread, query.trim())).sort(view === "closed" || view === "check" ? newestFirst : byValueDesc);
  }, [view, scoped, closed.data, account, query]);

  // The push's bar for each conversation's own account, so "Big ones" are the ones that notify.
  const bigOne = (thread: DemoThread) => isBigOne(thread, accountBigOneThreshold(money.currency, offers.data, thread.igAccountId));
  const groups: Array<{ title: string; items: DemoThread[] }> = view === "needs"
    ? [
      { title: "Big ones", items: list.filter(bigOne) },
      { title: "Everything else", items: list.filter((t) => !bigOne(t)) },
    ].filter((group) => group.items.length > 0)
    : [{ title: "", items: list }];
  // Every "Needs you" conversation is commerce, so this is the same at-least total as Today's hero.
  const openValue = view === "needs" ? waitingLowMinor(list) : 0;

  // j / k move through the list and open the conversation (desk) or focus it (phone).
  const flat = groups.flatMap((group) => group.items);
  useShortcut(["j", "k"], (event) => {
    if (!flat.length) return;
    const index = flat.findIndex((thread) => thread.id === selectedId);
    const next = event.key === "j" ? Math.min(flat.length - 1, index + 1) : Math.max(0, index - 1);
    const target = flat[index < 0 ? 0 : next];
    if (target) router.push(conversationHref(target.id, params ?? new URLSearchParams()));
  });
  useShortcut("/", (event) => { event.preventDefault(); document.getElementById("inbox-search")?.focus(); });

  const firstLoad = loadedAt === null;
  const href = (thread: DemoThread) => thread.routedTo === "review_queue"
    ? `/review?item=${encodeURIComponent(thread.id)}${account ? `&account=${encodeURIComponent(account)}` : ""}`
    : conversationHref(thread.id, params ?? new URLSearchParams());

  return (
    <div className={cx("flex min-h-0 flex-col", className)}>
      <div className="px-4 pb-2 pt-4 md:px-5 md:pt-6">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <Heading className="text-display-xl text-ink lg:text-display">Inbox</Heading>
            {!firstLoad && openValue > 0 && (
              <p className="mt-0.5 text-label text-ink-2">
                <MoneyValue minor={openValue} kind="neutral" className="font-semibold text-ink" /> at least, across {list.length} {pluralize(list.length, "conversation")}
              </p>
            )}
          </div>
          {counts.check > 0 && (
            <Link href="/review" className="dd-press inline-flex h-11 items-center gap-1.5 rounded-full bg-review-tint px-3 text-label font-semibold text-review md:h-9">
              <ScanSearch aria-hidden size={16} />Check {counts.check}
            </Link>
          )}
        </div>
        <label className="relative mt-3 block">
          <span className="sr-only">Search conversations</span>
          <Search aria-hidden size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            id="inbox-search"
            type="search"
            value={query}
            onChange={(event) => setParam("q", event.target.value || null)}
            placeholder="Search names, handles, messages"
            className="dd-input h-10 rounded-full pl-10 pr-10 text-[15px]"
          />
          {query && (
            <button type="button" onClick={() => setParam("q", null)} aria-label="Clear search" className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:bg-fill">
              <X aria-hidden size={15} />
            </button>
          )}
        </label>
        {roster && (
          <div className="dd-scroll-x -mx-4 mt-3 flex gap-2 px-4 md:-mx-5 md:px-5" role="group" aria-label="Creator">
            <CreatorChip active={!account} onClick={() => setParam("account", null)} label="All creators" />
            {accounts.map((item) => (
              <CreatorChip key={item.id} active={account === item.id} onClick={() => setParam("account", item.id)} label={`@${item.handle}`} handle={item.handle} />
            ))}
          </div>
        )}
        <div className="dd-scroll-x -mx-4 mt-3 flex gap-1.5 px-4 md:-mx-5 md:px-5" role="tablist" aria-label="Inbox views">
          {VIEWS.map((item) => {
            const active = view === item.id;
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setParam("view", item.id === "needs" ? null : item.id)}
                className={cx(
                  "dd-press inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-label font-semibold md:h-8",
                  active ? "bg-primary text-on-primary" : "bg-inset text-ink-2 hover:bg-fill hover:text-ink",
                )}
              >
                {item.label}
                {count > 0 && <span className={cx("tabular-nums", active ? "text-on-primary/70" : "text-ink-3")}>{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {(state === "error" && loadedAt === null) || (view === "closed" && closed.status === "error" && !closed.data) ? (
          <ErrorState thing="this conversation list" reason="The list hasn't loaded. Try again before deciding you're caught up." onRetry={() => void (view === "closed" ? appStore.loadClosed() : appStore.refresh())} />
        ) : firstLoad || (view === "closed" && !closed.data) ? (
          <div className="space-y-1 px-4 pt-2">
            {[0, 1, 2, 3, 4].map((key) => (
              <div key={key} className="flex items-center gap-3 py-3"><Skeleton className="h-12 w-12 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-3/4" /></div></div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyList view={view} query={query} />
        ) : (
          groups.map((group) => (
            <section key={group.title || view} aria-label={group.title || VIEWS.find((item) => item.id === view)?.label}>
              {group.title && (
                <h3 className="sticky top-0 z-10 flex items-baseline justify-between bg-canvas/95 px-4 pb-1.5 pt-3 text-micro uppercase text-ink-3 backdrop-blur md:px-5">
                  {group.title}
                  <span className="normal-case tracking-normal">{group.items.length}</span>
                </h3>
              )}
              <ul ref={listRef} className="mx-2 overflow-hidden rounded-[20px] bg-surface shadow-card md:mx-3">
                {group.items.map((thread, index) => (
                  <li key={thread.id} className={cx(index > 0 && "border-t border-hairline", "dd-cv")}>
                    <ConversationRow thread={thread} href={href(thread)} now={now} selected={thread.id === selectedId} creator={roster && !account ? accounts.find((item) => item.id === thread.igAccountId)?.handle : null} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function CreatorChip({ active, onClick, label, handle }: { active: boolean; onClick: () => void; label: string; handle?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "dd-press inline-flex h-11 shrink-0 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-label font-semibold md:h-9",
        !handle && "pl-3.5",
        active ? "bg-surface text-ink shadow-card ring-1 ring-brand" : "bg-surface text-ink-2 shadow-card hover:text-ink",
      )}
    >
      {handle && <Avatar handle={handle} size={24} />}
      {label}
    </button>
  );
}

function EmptyList({ view, query }: { view: View; query: string }) {
  const copy: Record<View, [string, string]> = {
    needs: ["You're all caught up.", "New money DMs land here first, biggest on top."],
    followups: ["No follow-ups due.", "When a deal goes quiet for a few days, DealDock drafts a nudge here."],
    waiting: ["Nothing waiting on them.", "After you reply, move a conversation to Waiting to start the follow-up clock."],
    check: ["Nothing to check.", "Messages DealDock isn't sure about show up here."],
    closed: ["No closed conversations yet.", "Record a sale from a conversation and it moves here."],
  };
  const [title, body] = query ? [`No matches for "${query}".`, "Try a name, a handle or a word from the message."] : copy[view];
  return (
    <div className="mx-auto flex max-w-xs flex-col items-center px-6 py-16 text-center">
      <span aria-hidden className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface text-ink-3 shadow-card"><Search size={24} /></span>
      <p className="text-heading text-ink">{title}</p>
      <p className="mt-1 text-body text-ink-2">{body}</p>
    </div>
  );
}
