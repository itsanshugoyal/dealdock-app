"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AT_RISK_MS, DEFAULT_NUDGE_DELAY_DAYS, isClosingSoon } from "@dealdock/core";
import { ArrowRight, ArrowUpRight, CheckCheck, Clock, Gauge, Hourglass, ScanSearch, Waves } from "lucide-react";
import { byValueDesc, displayName, followUpDue, formatDate, needsYou, pluralize, shortDuration, toCheck, waitingLowMinor } from "../lib/format";
import { useMinuteClock } from "../lib/keyboard";
import { useApp, useInsights, useMe } from "../lib/use-demo";
import { ConversationRow, Group, GroupLink, HeroCard, LargeTitle, Stat, ValueStrip } from "../components/kit";
import { buttonClasses } from "../components/ui/button-classes";
import { Sparkline, ProgressRing } from "../components/ui/charts";
import { cx } from "../components/ui/cx";
import { MoneyCounter, MoneyValue } from "../components/ui/money-value";
import { Avatar } from "../components/ui/sender";
import { Skeleton } from "../components/ui/feedback";

function greeting(now: number, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone }).format(now));
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Today: what is waiting in the DMs, what was recovered, and the next thing to do. */
export default function Today() {
  const router = useRouter();
  const { threads, dashboard, money, timezone, state, loadedAt, settings } = useApp();
  const insights = useInsights(6);
  const me = useMe();
  const now = useMinuteClock();
  const locale = money.locale ?? "en-IN";
  const firstLoad = state === "loading" && loadedAt === null;

  const waiting = threads.filter(needsYou).sort(byValueDesc);
  const closing = waiting.filter((thread) => isClosingSoon(thread.replyWindow, now || Date.now()));
  const drafts = waiting.filter((thread) => thread.draftReady).length;
  const closed = threads.filter((thread) => thread.routedTo === "inbox" && thread.hasDealSignal && thread.state !== "closed");
  const nudges = threads.filter((thread) => thread.routedTo === "inbox" && followUpDue(thread)).sort(byValueDesc);
  const review = threads.filter(toCheck);
  const waitingLow = waitingLowMinor(waiting);
  const top = waiting[0] ?? null;

  const first = me.data?.name?.split(/\s+/)[0] ?? null;
  const goal = insights.data?.goal;
  const months = insights.data?.months ?? [];
  const thisMonth = months[months.length - 1]?.recoveredMinor ?? dashboard?.mtdRecoveredMinor ?? 0;
  const lastMonth = months[months.length - 2]?.recoveredMinor ?? null;
  const delta = lastMonth ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : null;
  const speed = insights.data?.speed;
  const voice = insights.data?.voice;
  // Read from settings only when something already loaded them; Today never fetches them for this.
  const nudgeDays = settings.data?.nudgeDelayDays ?? DEFAULT_NUDGE_DELAY_DAYS;

  return (
    <div className="mx-auto w-full max-w-[1180px] pb-10">
      <LargeTitle
        eyebrow={now ? formatDate(now, locale, timezone, { weekday: "long", day: "numeric", month: "long" }) : " "}
        title={now ? `${greeting(now, timezone)}${first ? `, ${first}` : ""}` : "Today"}
        accessory={<Link href="/settings" aria-label="You and settings" className="rounded-full md:hidden"><Avatar handle={me.data?.name ?? "you"} name={me.data?.name} size={36} /></Link>}
      />

      <div className="grid gap-5 px-4 md:px-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] lg:gap-6">
        {/* Left column: the work */}
        <div className="flex min-w-0 flex-col gap-5">
          <HeroCard aria-labelledby="hero-title" glow="both" className="p-5 md:p-7">
            <p id="hero-title" className="text-label font-semibold text-on-hero/60">Money in your DMs right now</p>
            {firstLoad ? <Skeleton className="mt-2 h-12 w-48 bg-on-hero/10" /> : (
              <p className="mt-1 flex items-baseline gap-2">
                <MoneyValue minor={waitingLow} size="hero" className="text-on-hero [&_.dd-symbol-hero]:text-on-hero/60" />
                <span className="text-body font-medium text-on-hero/55">at least</span>
              </p>
            )}
            <p className="mt-1 text-body text-on-hero/70">
              {waiting.length === 0
                ? "Nothing waiting. Every money conversation has your reply."
                : <>Across {waiting.length} {pluralize(waiting.length, "conversation")} waiting on you{drafts > 0 && <> · <span className="text-on-hero">{drafts} {pluralize(drafts, "draft")} ready</span></>}</>}
            </p>
            {waiting.length > 0 && (
              <ValueStrip threads={waiting} className="mt-5" height={14} onPick={(thread) => router.push(`/thread/${thread.id}`)} />
            )}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {top ? (
                <Link href={`/thread/${top.id}`} className={buttonClasses({ variant: "hero", size: "lg" })}>
                  Reply to the biggest
                  <ArrowRight aria-hidden size={18} strokeWidth={2.2} />
                </Link>
              ) : (
                <Link href="/inbox" className={buttonClasses({ variant: "on-hero", size: "lg" })}>Open inbox</Link>
              )}
              {closing.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-hero-alert-tint px-3 py-1.5 text-label font-semibold text-hero-alert">
                  <Clock aria-hidden size={14} />
                  {closing.length} reply {pluralize(closing.length, "window closes", "windows close")} within {shortDuration(AT_RISK_MS)}
                </span>
              )}
            </div>
          </HeroCard>

          <Group id="needs" title={<>Needs you <span className="ml-1 text-ink-3">{waiting.length || ""}</span></>} action={<GroupLink href="/inbox">Inbox</GroupLink>}>
            {firstLoad ? <RowsSkeleton /> : waiting.length === 0 ? (
              <p className="px-5 py-8 text-center text-body text-ink-2">You&apos;re all caught up. New money DMs land here first.</p>
            ) : (
              <ul className="divide-y divide-hairline">
                {waiting.slice(0, 5).map((thread) => (
                  <li key={thread.id}><ConversationRow thread={thread} href={`/thread/${thread.id}`} now={now} /></li>
                ))}
              </ul>
            )}
          </Group>

          {closed.length > 0 && (
            <Group id="closed" title="Looks closed — record it?">
              <ul className="divide-y divide-hairline">
                {closed.map((thread) => (
                  <li key={thread.id}>
                    <Link href={`/thread/${thread.id}?record=1`} className="dd-row-press flex items-center gap-3 px-4 py-3 hover:bg-[color-mix(in_oklab,var(--dd-inset)_60%,transparent)]">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-tint text-recovered"><CheckCheck aria-hidden size={20} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold text-ink">{displayName(thread.participant, thread.handle)}</span>
                        <span className="block truncate text-[14px] text-ink-2">&ldquo;{thread.dealSignal?.phrase ?? thread.preview}&rdquo;</span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand px-3 py-1.5 text-label font-semibold text-on-brand">Record sale</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {nudges.length > 0 && (
            <Group id="nudges" title={<>Follow-ups due <span className="ml-1 text-ink-3">{nudges.length}</span></>} action={<GroupLink href="/inbox?view=followups">See all</GroupLink>}>
              <ul className="divide-y divide-hairline">
                {nudges.slice(0, 3).map((thread) => (
                  <li key={thread.id}><ConversationRow thread={thread} href={`/thread/${thread.id}`} now={now} /></li>
                ))}
              </ul>
            </Group>
          )}
        </div>

        {/* Right column: proof and pace */}
        <div className="flex min-w-0 flex-col gap-5">
          <section aria-labelledby="recovered-title" className="rounded-[26px] bg-surface p-5 shadow-card md:p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p id="recovered-title" className="text-label font-semibold text-ink-3">
                  Recovered in {now ? formatDate(now, locale, timezone, { month: "long" }) : "this month"}
                </p>
                {firstLoad || !dashboard ? <Skeleton className="mt-2 h-11 w-44" /> : (
                  <MoneyCounter countId="today-mtd" data-testid="mtd-recovered" minor={dashboard.mtdRecoveredMinor} mode="exact" kind="confirmed" size="hero" className="mt-1 block font-semibold" />
                )}
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-ink-2">
                  <span className="inline-flex items-center gap-1 font-semibold text-recovered"><CheckCheck aria-hidden size={14} />Confirmed by you</span>
                  {dashboard && <span>· {dashboard.mtdDealCount} {pluralize(dashboard.mtdDealCount, "sale")}</span>}
                  {delta !== null && (
                    <span className={cx("inline-flex items-center gap-0.5 font-semibold", delta >= 0 ? "text-recovered" : "text-danger")}>
                      · <ArrowUpRight aria-hidden size={14} className={delta < 0 ? "rotate-90" : undefined} />{Math.abs(delta)}% vs last month
                    </span>
                  )}
                </p>
              </div>
              {goal?.monthlyGoalMinor ? (
                <ProgressRing pct={goal.pct ?? 0} projectedPct={goal.projectedMinor ? Math.min(100, (goal.projectedMinor / goal.monthlyGoalMinor) * 100) : null} size={64} label={`${Math.round(goal.pct ?? 0)}% of your monthly goal`} />
              ) : null}
            </div>
            {months.length > 1 && (
              <div className="mt-5 flex items-end justify-between gap-4 border-t border-hairline pt-4">
                <div className="min-w-0">
                  <p className="text-caption text-ink-3">Last {months.length} months</p>
                  {goal?.monthlyGoalMinor ? (
                    <p className="text-label text-ink-2">Goal <MoneyValue minor={goal.monthlyGoalMinor} kind="neutral" className="font-semibold text-ink" />{goal.projectedMinor ? <> · on pace for <MoneyValue minor={goal.projectedMinor} kind="neutral" className="font-semibold text-ink" /></> : null}</p>
                  ) : <Link href="/ledger" className="text-label font-semibold text-brand">Set a monthly goal</Link>}
                </div>
                <Sparkline values={months.map((month) => month.recoveredMinor)} label="Recovered by month" width={128} height={40} />
              </div>
            )}
            <Link href="/ledger" className="mt-4 inline-flex items-center gap-1 text-label font-semibold text-brand">Open revenue <ArrowRight aria-hidden size={14} /></Link>
          </section>

          {review.length > 0 && (
            <Link href="/review" className="dd-press flex items-center gap-4 rounded-[22px] bg-surface p-4 shadow-card hover:bg-[color-mix(in_oklab,var(--dd-surface)_92%,var(--dd-review))]">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-review-tint text-review"><ScanSearch aria-hidden size={22} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink">{review.length} {pluralize(review.length, "message")} to check</span>
                <span className="block text-[14px] text-ink-2">DealDock isn&apos;t sure what these are. A tap each.</span>
              </span>
              <ArrowRight aria-hidden size={18} className="shrink-0 text-ink-3" />
            </Link>
          )}

          <section aria-labelledby="week-title" className="rounded-[26px] bg-surface p-5 shadow-card md:p-6">
            <h2 id="week-title" className="text-heading text-ink">This week</h2>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div className="flex gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-info-tint text-info"><Gauge aria-hidden size={20} /></span>
                <Stat label="Median first reply">{speed?.medianFirstReplyMinutes != null ? formatMinutes(speed.medianFirstReplyMinutes) : "—"}</Stat>
              </div>
              <div className="flex gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-recovered"><Waves aria-hidden size={20} /></span>
                <Stat label="Drafts in your voice">{voice?.voiceMatchPct != null ? `${Math.round(voice.voiceMatchPct)}%` : "—"}</Stat>
              </div>
            </div>
            {(speed?.prevMedianFirstReplyMinutes != null && speed?.medianFirstReplyMinutes != null) && (
              <p className="mt-4 rounded-2xl bg-inset px-4 py-3 text-label text-ink-2">
                {speed.medianFirstReplyMinutes <= speed.prevMedianFirstReplyMinutes
                  ? <>You&apos;re replying <b className="font-semibold text-ink">{formatMinutes(speed.prevMedianFirstReplyMinutes - speed.medianFirstReplyMinutes)} faster</b> than last week. Brands notice.</>
                  : <>Replies are <b className="font-semibold text-ink">{formatMinutes(speed.medianFirstReplyMinutes - speed.prevMedianFirstReplyMinutes)} slower</b> than last week.</>}
              </p>
            )}
            {voice?.voiceMatchPct != null && (
              <Link href="/voice" className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-inset px-4 py-3 text-label text-ink-2 hover:bg-fill">
                <span>{Math.round(voice.voiceMatchPct)}% of drafts went out with light edits or none.</span>
                <ArrowRight aria-hidden size={16} className="shrink-0 text-ink-3" />
              </Link>
            )}
          </section>

          {nudges.length === 0 && closing.length === 0 && (
            <div className="flex items-center gap-3 rounded-[22px] border border-dashed border-separator px-4 py-4 text-label text-ink-2">
              <Hourglass aria-hidden size={18} className="shrink-0 text-ink-3" />
              No follow-ups due. DealDock drafts one when a deal goes quiet for {nudgeDays} {pluralize(nudgeDays, "day")}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatMinutes(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  if (value < 60) return `${value}m`;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function RowsSkeleton() {
  return (
    <div className="divide-y divide-hairline">
      {[0, 1, 2].map((key) => (
        <div key={key} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-3 w-3/5" /></div>
        </div>
      ))}
    </div>
  );
}
