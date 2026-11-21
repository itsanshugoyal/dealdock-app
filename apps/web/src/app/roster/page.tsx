"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, AudioLines, ChartNoAxesCombined, Check, ChevronDown, ScanSearch, UsersRound } from "lucide-react";
import { byValueDesc, needsYou, pluralize, waitingLowMinor } from "../../lib/format";
import { useMinuteClock } from "../../lib/keyboard";
import { appStore, useApp, useRoster, useSettings } from "../../lib/use-demo";
import { ConversationRow, Group, GroupLink, HeroCard, LargeTitle, ValueStrip } from "../../components/kit";
import { buttonClasses } from "../../components/ui/button-classes";
import { cx } from "../../components/ui/cx";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui/feedback";
import { MoneyValue } from "../../components/ui/money-value";
import { Avatar } from "../../components/ui/sender";

/** All creators (agency desk): every creator's money at a glance, and one queue across all of them. */
export default function RosterPage() {
  const router = useRouter();
  const roster = useRoster();
  const settings = useSettings();
  const { threads } = useApp();
  const now = useMinuteClock();

  if (settings.data && settings.data.tier !== "roster") {
    return (
      <EmptyState
        as="h1"
        icon={UsersRound}
        title="All creators is part of the Roster plan."
        description="Manage up to five creators' inboxes, voices and revenue from one desk."
        action={<Link href="/settings#plan" className={buttonClasses({ variant: "primary" })}>See plans</Link>}
        className="min-h-[60dvh] justify-center"
      />
    );
  }

  const rows = roster.data ?? [];
  const handles = new Map(rows.map((row) => [row.igAccountId, row.handle]));
  const open = threads.filter(needsYou);
  const queue = [...open].sort(byValueDesc);
  const totals = {
    recovered: rows.reduce((sum, row) => sum + row.mtdRecoveredMinor, 0),
    waiting: waitingLowMinor(open),
    needs: rows.reduce((sum, row) => sum + row.unreadHighPriority, 0),
    check: rows.reduce((sum, row) => sum + row.reviewQueueSize, 0),
  };
  const loading = !roster.data;

  if (roster.status === "error" && !roster.data) {
    return <ErrorState as="h1" thing="your creators" reason={roster.error} onRetry={() => void appStore.loadRoster()} className="min-h-[60dvh] justify-center" />;
  }

  return (
    <div className="mx-auto w-full max-w-[1240px] pb-12">
      <LargeTitle
        eyebrow="Roster"
        title="All creators"
        subtitle={rows.length ? `${rows.length} ${pluralize(rows.length, "creator")} on this desk` : undefined}
      />

      <div className="px-4 md:px-8">
        <HeroCard aria-label="Totals across creators" glow="both" className="grid grid-cols-2 gap-x-4 gap-y-5 p-5 md:p-6 lg:grid-cols-4">
          <Total label="Recovered this month" tone="money">{loading ? <Skeleton className="h-8 w-28 bg-on-hero/10" /> : <MoneyValue minor={totals.recovered} className="font-semibold text-hero-money" />}</Total>
          <Total label="In DMs · lower estimate">{loading ? <Skeleton className="h-8 w-28 bg-on-hero/10" /> : <MoneyValue minor={totals.waiting} className="font-semibold text-on-hero" />}</Total>
          <Total label="Need a reply">{loading ? <Skeleton className="h-8 w-12 bg-on-hero/10" /> : totals.needs}</Total>
          <Total label="To check">{loading ? <Skeleton className="h-8 w-12 bg-on-hero/10" /> : totals.check}</Total>
        </HeroCard>

        <h2 className="mb-3 mt-8 text-heading text-ink">Creators</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {loading && [0, 1, 2].map((key) => <Skeleton key={key} className="h-[236px] rounded-[24px]" />)}
          {rows.map((row) => {
            const mine = open.filter((thread) => thread.igAccountId === row.igAccountId);
            const waiting = waitingLowMinor(mine);
            const disconnected = row.status !== "active";
            return (
              <article key={row.igAccountId} className="flex flex-col rounded-[24px] bg-surface p-4 shadow-card md:p-5">
                <div className="flex items-center gap-3">
                  <Avatar handle={row.handle} size={44} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-heading text-ink">@{row.handle}</h3>
                    {disconnected
                      ? <p className="inline-flex items-center gap-1 text-caption font-semibold text-waiting"><AlertTriangle aria-hidden size={13} />Needs reconnecting</p>
                      : <p className="text-caption text-ink-3">{row.unreadHighPriority} {pluralize(row.unreadHighPriority, "needs", "need")} a reply{row.reviewQueueSize ? ` · ${row.reviewQueueSize} to check` : ""}</p>}
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-hairline pt-4">
                  <div>
                    <dt className="text-caption text-ink-3">Recovered</dt>
                    <dd className="text-[22px] font-semibold leading-7 tracking-[-0.02em]"><MoneyValue minor={row.mtdRecoveredMinor} kind="confirmed" /></dd>
                  </div>
                  <div>
                    <dt className="text-caption text-ink-3">Lower estimate</dt>
                    <dd className="text-[22px] font-semibold leading-7 tracking-[-0.02em] text-ink"><MoneyValue minor={waiting} kind="neutral" /></dd>
                  </div>
                </dl>
                <ValueStrip threads={mine} className="mt-3" height={8} onPick={(thread) => router.push(`/thread/${thread.id}?account=${row.igAccountId}`)} />
                <div className="mt-4">
                  {disconnected ? (
                    <Link href="/settings#instagram" className="dd-press flex h-11 w-full items-center justify-center gap-1.5 rounded-full bg-waiting-tint text-button text-waiting">Reconnect Instagram</Link>
                  ) : (
                    <Link href={`/inbox?account=${encodeURIComponent(row.igAccountId)}`} className={buttonClasses({ variant: "secondary", fullWidth: true })}>
                      Open inbox <ArrowRight aria-hidden size={15} />
                    </Link>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-center gap-1 text-caption font-semibold text-ink-2">
                  <Link href={`/voice?account=${encodeURIComponent(row.igAccountId)}`} aria-label={`Voice for @${row.handle}`} className="dd-press inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 hover:bg-inset hover:text-ink"><AudioLines aria-hidden size={15} />Voice</Link>
                  <Link href={`/ledger?account=${encodeURIComponent(row.igAccountId)}`} aria-label={`Revenue for @${row.handle}`} className="dd-press inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 hover:bg-inset hover:text-ink"><ChartNoAxesCombined aria-hidden size={15} />Revenue</Link>
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Group id="sweep" title="Biggest first, across every creator" action={queue.length > 8 ? <GroupLink href="/inbox">See all {queue.length}</GroupLink> : <span className="text-caption text-ink-3">{queue.length} waiting</span>}>
            {queue.length === 0 ? <p className="px-5 py-8 text-center text-body text-ink-2">Nothing waiting on any creator.</p> : (
              <ul className="divide-y divide-hairline">
                {queue.slice(0, 8).map((thread) => (
                  <li key={thread.id}>
                    <ConversationRow thread={thread} href={`/thread/${thread.id}?account=${thread.igAccountId ?? ""}`} now={now} creator={thread.igAccountId ? handles.get(thread.igAccountId) ?? null : null} />
                  </li>
                ))}
              </ul>
            )}
          </Group>
          <div className="flex flex-col gap-4">
            {totals.check > 0 && (
              <Link href="/review" className="dd-press flex items-center gap-4 rounded-[22px] bg-surface shadow-card p-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-review-tint text-review"><ScanSearch aria-hidden size={22} /></span>
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">{totals.check} {pluralize(totals.check, "message")} to check</span><span className="block text-[14px] text-ink-2">Across all creators</span></span>
                <ArrowRight aria-hidden size={18} className="text-ink-3" />
              </Link>
            )}
            <details className="group rounded-[22px] bg-surface px-5 py-1 shadow-card">
              <summary className="dd-summary flex min-h-12 items-center justify-between gap-3 text-label font-semibold text-ink-2 hover:text-ink">How the desk works<ChevronDown aria-hidden size={16} className="shrink-0 transition-transform group-open:rotate-180" /></summary>
              <ul className="mt-3 flex flex-col gap-3 text-[14px] text-ink-2">
                <li className="flex gap-3"><Check aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-3" />Writing voices stay separate. Account offers apply to that creator; shared offers apply across the workspace.</li>
                <li className="flex gap-3"><Check aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-3" />Every send is approved by a person and logged with who sent it.</li>
                <li className="flex gap-3"><Check aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-3" />Creators can see the activity on their own account.</li>
              </ul>
              <Link href="/activity" className="mb-3 mt-4 inline-flex items-center gap-1 text-label font-semibold text-brand">Open activity <ArrowRight aria-hidden size={14} /></Link>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

function Total({ label, tone = "neutral", children }: { label: string; tone?: "neutral" | "money"; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-caption font-semibold text-on-hero/60">{label}</p>
      <div className={cx("mt-1 text-[26px] font-semibold leading-8 tracking-[-0.025em] tabular-nums", tone === "money" ? "text-hero-money" : "text-on-hero")}>{children}</div>
    </div>
  );
}
