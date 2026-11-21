"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, type KeyboardEvent } from "react";
import type { LeadStage } from "@dealdock/core";
import { isLeadStage, LEAD_STAGES, pipelineStage, stageCounts } from "@dealdock/core";
import { ArrowRight, ScanSearch, Search, X } from "lucide-react";
import { accountBigOneThreshold, byValueDesc, followUpDue, isBigOne, isWaiting, needsYou, pluralize, toCheck, waitingLowMinor } from "../lib/format";
import { useMinuteClock, useShortcut } from "../lib/keyboard";
import { conversationHref, inboxView, type InboxView } from "../lib/inbox-navigation";
import { useApp, useClosedThreads, useCommentLeads, useOffers, useSettings, type DemoThread } from "../lib/use-demo";
import { isOpenLead, leadsInScope, showsComments } from "../lib/comment-leads";
import { CommentLeadsPanel } from "./comment-leads";
import { ConversationRow } from "./kit";
import { STAGE_TEXT } from "./pipeline";
import { cx } from "./ui/cx";
import { Chip } from "./ui/selection";
import { ErrorState, Skeleton } from "./ui/feedback";
import { appStore } from "../lib/use-demo";
import { MoneyValue } from "./ui/money-value";
import { Avatar } from "./ui/sender";

type View = InboxView;
const VIEWS: Array<{ id: View; label: string }> = [
  // Views you act on first, then views that only show status.
  { id: "needs", label: "Needs you" },
  { id: "followups", label: "Follow-ups" },
  { id: "check", label: "Check" },
  { id: "comments", label: "Comments" },
  { id: "waiting", label: "Waiting" },
  { id: "closed", label: "Closed" },
];

/**
 * What each view lists. Its count, its list, the nav badge and Today's hero all
 * come from these same predicates, so a number always matches what it opens.
 * Closed conversations load on demand and are listed as they arrive; Comments lists comment leads, not conversations.
 */
const VIEW_FILTER: Record<Exclude<View, "closed" | "comments">, (thread: DemoThread) => boolean> = {
  needs: needsYou,
  followups: (thread) => thread.routedTo === "inbox" && followUpDue(thread),
  waiting: isWaiting,
  check: toCheck,
};
const newestFirst = (a: DemoThread, b: DemoThread) => b.lastMessageAt - a.lastMessageAt;

function matches(thread: DemoThread, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [thread.handle, thread.participant.name ?? "", thread.preview, thread.subject ?? ""].some((field) => field.toLowerCase().includes(needle));
}

/**
 * The conversation list: full screen on phones, the left pane of the desk on
 * large screens. Money first: biggest open conversations lead.
 */
export function InboxPane({ selectedId, headingLevel = "h1", className }: { selectedId?: string | null; headingLevel?: "h1" | "h2"; className?: string }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/inbox";
  const params = useSearchParams();
  const requestedView = inboxView(params?.get("view"));
  // Today's pipeline opens the inbox at one stage of the coach pipeline: that list replaces the views.
  const stageParam = params?.get("stage");
  const stage = isLeadStage(stageParam) ? stageParam : null;
  const account = params?.get("account") ?? null;
  // Comments shows where keywords are set or leads came in; elsewhere its address opens Needs you.
  const commentLeads = useCommentLeads();
  const commentsShown = showsComments(commentLeads.data, account);
  const view: View = requestedView === "comments" && commentLeads.data && !commentsShown ? "needs" : requestedView;
  const views = VIEWS.filter((item) => item.id !== "comments" || commentsShown);
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

  // Tabs pattern: arrow keys (and Home/End) move the selection along the views.
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = views[(next + views.length) % views.length]!;
    setParam("view", target.id === "needs" ? null : target.id);
    const tab = document.getElementById(`inbox-view-${target.id}`);
    tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const reviewHref = account ? `/review?account=${encodeURIComponent(account)}` : "/review";

  const scoped = useMemo(() => threads.filter((thread) => !account || thread.igAccountId === account), [threads, account]);
  const counts = useMemo(() => {
    const count = (id: Exclude<View, "closed" | "comments">) => scoped.filter(VIEW_FILTER[id]).length;
    return { needs: count("needs"), followups: count("followups"), waiting: count("waiting"), check: count("check"), closed: 0 };
  }, [scoped]);
  const commentCount = leadsInScope(commentLeads.data, account).filter((lead) => isOpenLead(lead, now || Date.now())).length;

  // The pipeline counts conversations still open or waiting, as Today does.
  const pipeline = useMemo(() => scoped.filter((thread) => thread.routedTo === "inbox" && thread.state !== "closed" && pipelineStage(thread) !== null), [scoped]);
  const list = useMemo(() => {
    if (stage) return pipeline.filter((thread) => pipelineStage(thread) === stage && matches(thread, query.trim())).sort(newestFirst);
    const source = view === "closed"
      ? (closed.data ?? []).filter((t) => !account || t.igAccountId === account)
      : view === "comments" ? [] : scoped.filter(VIEW_FILTER[view]);
    return source.filter((thread) => matches(thread, query.trim())).sort(view === "closed" || view === "check" ? newestFirst : byValueDesc);
  }, [view, scoped, closed.data, account, query, stage, pipeline]);

  // The push's bar for each conversation's own account, so "Big ones" are the ones that notify.
  const bigOne = (thread: DemoThread) => isBigOne(thread, accountBigOneThreshold(money.currency, offers.data, thread.igAccountId));
  const groups: Array<{ title: string; items: DemoThread[] }> = view === "needs" && !stage
    ? [
      { title: "Big ones", items: list.filter(bigOne) },
      { title: "Everything else", items: list.filter((t) => !bigOne(t)) },
    ].filter((group) => group.items.length > 0)
    : [{ title: "", items: list }];
  // Sum the lower estimates for this view, matching Today's opportunity total.
  const openValue = view === "needs" && !stage ? waitingLowMinor(list) : 0;

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
      <div className="px-4 pt-5 md:px-5 md:pt-6">
        <Heading className="text-display-xl text-ink lg:text-display">Inbox</Heading>
        {!firstLoad && openValue > 0 && (
          <p className="mt-0.5 text-label text-ink-2">
            <MoneyValue minor={openValue} kind="neutral" className="font-semibold text-ink" /> lower estimate · {list.length} {pluralize(list.length, "conversation")}
          </p>
        )}
        <label className="relative mt-3 block">
          <span className="sr-only">Search conversations</span>
          <Search aria-hidden size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            id="inbox-search"
            type="search"
            value={query}
            onChange={(event) => setParam("q", event.target.value || null)}
            placeholder="Search names, handles, messages"
            className="dd-input h-10 rounded-full pl-10 pr-10"
          />
          {query && (
            <button type="button" onClick={() => setParam("q", null)} aria-label="Clear search" className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:bg-fill">
              <X aria-hidden size={15} />
            </button>
          )}
        </label>
        {/* Creator chips scroll edge to edge; the cut-off chip at the edge says there are more. */}
        {roster && (
          <div role="group" aria-label="Creator" className="dd-scroll-x -mx-4 mt-3 flex gap-2 px-4 pb-0.5 md:-mx-5 md:px-5">
            <CreatorChip active={!account} onClick={() => setParam("account", null)} label="All creators" />
            {accounts.map((item) => (
              <CreatorChip key={item.id} active={account === item.id} onClick={() => setParam("account", item.id)} label={`@${item.handle}`} handle={item.handle} />
            ))}
          </div>
        )}
        {stage ? <StageBar stage={stage} counts={stageCounts(pipeline)} onPick={(next) => setParam("stage", next)} /> : (
        <div role="tablist" aria-label="Inbox views" className="dd-scroll-x -mx-4 mt-2 flex gap-4 border-b border-hairline px-4 md:-mx-5 md:gap-3.5 md:px-5">
          {views.map((item, index) => {
            const active = view === item.id;
            const count = item.id === "comments" ? commentCount : counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`inbox-view-${item.id}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => setParam("view", item.id === "needs" ? null : item.id)}
                onKeyDown={(event) => moveTab(event, index)}
                className={cx(
                  "dd-press relative inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 text-label font-semibold transition-colors md:h-10",
                  active ? "text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {item.label}
                {/* A real space, so the accessible name reads "Check 5", not "Check5". */}
                {count > 0 && <>{" "}<span className={cx("tabular-nums", item.id === "check" ? "text-review" : active ? "text-ink-2" : "text-ink-3")}>{count}</span></>}
                <span aria-hidden className={cx("absolute inset-x-0 bottom-0 h-0.5 rounded-full transition-opacity", active ? "bg-ink opacity-100" : "opacity-0")} />
              </button>
            );
          })}
        </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {view === "comments" && !stage ? (
          <CommentLeadsPanel account={account} query={query.trim()} />
        ) : (state === "error" && loadedAt === null) || (view === "closed" && closed.status === "error" && !closed.data) ? (
          <ErrorState thing="this conversation list" reason="The list hasn't loaded. Try again before deciding you're caught up." onRetry={() => void (view === "closed" ? appStore.loadClosed() : appStore.refresh())} />
        ) : firstLoad || (view === "closed" && !closed.data) ? (
          <div className="space-y-1 px-4 pt-2">
            {[0, 1, 2, 3, 4].map((key) => (
              <div key={key} className="flex items-center gap-3 py-3"><Skeleton className="h-12 w-12 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-3/4" /></div></div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyList view={view} query={query} stage={stage} />
        ) : (
          <>
          {view === "check" && !stage && (
            <Link href={reviewHref} className="dd-press mx-2 mt-3 flex items-center gap-3 rounded-[20px] bg-review-tint px-4 py-3">
              <ScanSearch aria-hidden size={20} className="shrink-0 text-review" />
              <span className="min-w-0 flex-1">
                <span className="block text-label font-semibold text-ink">Sort them one at a time</span>
                <span className="block text-caption text-ink-2">Confirm or relabel each message with a tap. Nothing is sent.</span>
              </span>
              <ArrowRight aria-hidden size={18} className="shrink-0 text-review" />
            </Link>
          )}
          {groups.map((group) => (
            <section key={group.title || view} aria-label={group.title || (stage ? STAGE_TEXT[stage] : VIEWS.find((item) => item.id === view)?.label)}>
              {group.title && (
                <h3 className="sticky top-0 z-10 flex items-baseline justify-between bg-canvas/95 px-4 pb-1.5 pt-3 text-micro uppercase text-ink-3 backdrop-blur md:px-5">
                  {group.title}
                  <span className="normal-case tracking-normal">{group.items.length}</span>
                </h3>
              )}
              <ul ref={listRef} className={cx("mx-2 overflow-hidden rounded-[20px] bg-surface shadow-card", !group.title && "mt-3")}>
                {group.items.map((thread, index) => (
                  <li key={thread.id} className={cx(index > 0 && "border-t border-hairline", "dd-cv")}>
                    <ConversationRow thread={thread} href={href(thread)} now={now} selected={thread.id === selectedId} creator={roster && !account ? accounts.find((item) => item.id === thread.igAccountId)?.handle : null} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          </>
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
        active ? "bg-primary text-on-primary" : "bg-surface text-ink-2 shadow-card hover:text-ink",
      )}
    >
      {handle && <Avatar handle={handle} size={24} />}
      {label}
    </button>
  );
}

/** The coach pipeline in the inbox: one stage at a time, and the way back to every conversation. */
function StageBar({ stage, counts, onPick }: { stage: LeadStage; counts: Record<LeadStage, number>; onPick: (stage: LeadStage | null) => void }) {
  return (
    <div className="mt-2 border-b border-hairline pb-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-label font-semibold text-ink">Coaching and courses</p>
        <button type="button" onClick={() => onPick(null)} className="dd-press dd-hit inline-flex h-8 items-center gap-1 rounded-full px-2 text-label font-semibold text-brand hover:bg-inset">
          <X aria-hidden size={15} />All conversations
        </button>
      </div>
      <div role="group" aria-label="Stage" className="dd-scroll-x -mx-4 mt-1.5 flex gap-1.5 px-4 md:-mx-5 md:px-5">
        {LEAD_STAGES.map((item) => (
          <Chip key={item} pressed={item === stage} count={counts[item]} aria-label={`${STAGE_TEXT[item]}, ${counts[item]}`} onClick={() => onPick(item)}>{STAGE_TEXT[item]}</Chip>
        ))}
      </div>
    </div>
  );
}

function EmptyList({ view, query, stage = null }: { view: View; query: string; stage?: LeadStage | null }) {
  const copy: Record<View, [string, string]> = {
    needs: ["You're all caught up.", "New money DMs land here first, biggest on top."],
    followups: ["No follow-ups due.", "When a deal goes quiet for a few days, DealDock drafts a nudge here."],
    waiting: ["Nothing waiting on them.", "Move a conversation here after you reply. If it goes quiet for a few days, it moves to Follow-ups."],
    check: ["Nothing to check.", "Messages DealDock isn't sure about show up here."],
    comments: ["No keyword comments yet.", "People who comment your keywords show up here with a private reply drafted."],
    closed: ["No closed conversations yet.", "Record a deal from a conversation and it moves here."],
  };
  const [title, body] = query ? [`No matches for "${query}".`, "Try a name, a handle or a word from the message."]
    : stage ? [`No one at ${STAGE_TEXT[stage]} right now.`, "Set a stage in a coaching or course conversation, or connect a booking or payment link in Settings."]
    : copy[view];
  return (
    <div className="mx-auto flex max-w-xs flex-col items-center px-6 py-16 text-center">
      <span aria-hidden className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface text-ink-3 shadow-card"><Search size={24} /></span>
      <p className="text-heading text-ink">{title}</p>
      <p className="mt-1 text-body text-ink-2">{body}</p>
    </div>
  );
}
