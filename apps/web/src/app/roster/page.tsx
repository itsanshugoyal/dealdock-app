"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, AudioLines, ScanSearch, UsersRound } from "lucide-react";
import { byValueDesc, needsYou, pluralize, waitingLowMinor } from "../../lib/format";
import { useMinuteClock } from "../../lib/keyboard";
import { useApp, useRoster, useSettings } from "../../lib/use-demo";
import { ConversationRow, Group, HeroCard, LargeTitle, ValueStrip } from "../../components/kit";
import { buttonClasses } from "../../components/ui/button-classes";
import { EmptyState, Skeleton } from "../../components/ui/feedback";
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
  const loading = roster.status === "loading" && !roster.data;

  return (
    <div className="mx-auto w-full max-w-[1240px] pb-12">
      <LargeTitle
        eyebrow="Roster"
        title="All creators"
        subtitle={rows.length ? `${rows.length} ${pluralize(rows.length, "creator")} on this desk` : undefined}
      />

      <div className="px-4 md:px-8">
        <section aria-label="Totals across creators" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Total label="Recovered this month" tone="money">{loading ? <Skeleton className="h-8 w-28" /> : <MoneyValue minor={totals.recovered} kind="confirmed" className="font-semibold" />}</Total>
          <Total label="Waiting in DMs, at least">{loading ? <Skeleton className="h-8 w-28" /> : <MoneyValue minor={totals.waiting} kind="neutral" className="font-semibold" />}</Total>
          <Total label="Need a reply">{totals.needs}</Total>
          <Total label="To check">{totals.check}</Total>
        </section>

        <h2 className="mb-3 mt-8 text-heading text-ink">Creators</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {loading && [0, 1, 2].map((key) => <Skeleton key={key} className="h-[236px] rounded-[24px]" />)}
          {rows.map((row) => {
            const mine = open.filter((thread) => thread.igAccountId === row.igAccountId);
            const waiting = waitingLowMinor(mine);
            const disconnected = row.status !== "active";
            return (
              <article key={row.igAccountId} className="flex flex-col rounded-[24px] bg-surface p-5 shadow-card">
                <div className="flex items-center gap-3">
                  <Avatar handle={row.handle} size={52} ring={row.unreadHighPriority > 0 ? "money" : "none"} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-heading text-ink">@{row.handle}</h3>
                    {disconnected
                      ? <p className="inline-flex items-center gap-1 text-caption font-semibold text-waiting"><AlertTriangle aria-hidden size={13} />Needs reconnecting</p>
                      : <p className="text-caption text-ink-3">{row.unreadHighPriority} {pluralize(row.unreadHighPriority, "needs", "need")} a reply{row.reviewQueueSize ? ` · ${row.reviewQueueSize} to check` : ""}</p>}
                  </div>
                </div>
                <dl className="mt-5 grid grid-cols-2 gap-3">
                  <div>
                    <dt className="text-caption text-ink-3">Recovered</dt>
                    <dd className="text-[22px] font-semibold leading-7 tracking-[-0.02em]"><MoneyValue minor={row.mtdRecoveredMinor} kind="confirmed" /></dd>
                  </div>
                  <div>
                    <dt className="text-caption text-ink-3">Waiting, at least</dt>
                    <dd className="text-[22px] font-semibold leading-7 tracking-[-0.02em] text-ink"><MoneyValue minor={waiting} kind="neutral" /></dd>
                  </div>
                </dl>
                <ValueStrip threads={mine} className="mt-4" height={8} onPick={(thread) => router.push(`/thread/${thread.id}?account=${row.igAccountId}`)} />
                <div className="mt-5 flex gap-2">
                  {disconnected ? (
                    <Link href="/settings#instagram" className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-waiting-tint text-label font-semibold text-waiting">Reconnect Instagram</Link>
                  ) : (
                    <Link href={`/inbox?account=${encodeURIComponent(row.igAccountId)}`} className={buttonClasses({ variant: "primary", className: "flex-1" })}>
                      Open inbox <ArrowRight aria-hidden size={15} />
                    </Link>
                  )}
                  <Link href={`/voice?account=${encodeURIComponent(row.igAccountId)}`} aria-label={`@${row.handle}'s voice`} className="dd-press inline-flex h-10 w-10 items-center justify-center rounded-full bg-inset text-ink-2 hover:bg-fill">
                    <AudioLines aria-hidden size={18} />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Group id="sweep" title="Biggest first, across every creator" action={<span className="text-caption text-ink-3">{queue.length} waiting</span>}>
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
            <div className="rounded-[24px] bg-surface p-5 shadow-card">
              <h2 className="text-heading text-ink">How the desk works</h2>
              <ul className="mt-3 flex flex-col gap-3 text-[14px] text-ink-2">
                <li className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[12px] font-bold text-recovered">1</span>Replies use each creator&apos;s own voice and offers, never another creator&apos;s.</li>
                <li className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[12px] font-bold text-recovered">2</span>Every send is approved by a person and logged with who sent it.</li>
                <li className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[12px] font-bold text-recovered">3</span>Creators can see the activity on their own account.</li>
              </ul>
              <Link href="/activity" className="mt-4 inline-flex items-center gap-1 text-label font-semibold text-brand">Open activity <ArrowRight aria-hidden size={14} /></Link>
            </div>
            {totals.check > 0 && (
              <Link href="/review" className="dd-press flex items-center gap-4 rounded-[24px] bg-surface p-4 shadow-card">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-review-tint text-review"><ScanSearch aria-hidden size={22} /></span>
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">{totals.check} {pluralize(totals.check, "message")} to check</span><span className="block text-[14px] text-ink-2">Across all creators</span></span>
                <ArrowRight aria-hidden size={18} className="text-ink-3" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Total({ label, tone = "neutral", children }: { label: string; tone?: "neutral" | "money"; children: React.ReactNode }) {
  const value = "mt-1 text-[26px] font-semibold leading-8 tracking-[-0.025em] tabular-nums";
  if (tone === "money") {
    return (
      <HeroCard as="div" flat glow="none" className="rounded-[22px] p-4 md:p-5">
        <p className="text-caption font-semibold text-on-hero/60">{label}</p>
        <div className={`${value} [&_.money]:text-hero-money`}>{children}</div>
      </HeroCard>
    );
  }
  return (
    <div className="rounded-[22px] bg-surface p-4 shadow-card md:p-5">
      <p className="text-caption font-semibold text-ink-3">{label}</p>
      <div className={`${value} text-ink`}>{children}</div>
    </div>
  );
}
