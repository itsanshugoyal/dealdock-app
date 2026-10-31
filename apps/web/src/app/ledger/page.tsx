"use client";

import Link from "next/link";
import { useState } from "react";
import type { DealType } from "@dealdock/core";
import { CheckCheck, Download, Pencil, Target, Trash2, TrendingUp } from "lucide-react";
import { dealTypeText, formatDate, pluralize } from "../../lib/format";
import { runUndoable } from "../../lib/undo";
import { appStore, useApp, useInsights, useLedger, type DemoLedgerEntry } from "../../lib/use-demo";
import { Group, HeroCard, LargeTitle } from "../../components/kit";
import { GoalSheet } from "../../components/goal-editor";
import { SaleSheet } from "../../components/sale-sheet";
import { Bars, ProgressRing, StackedBar } from "../../components/ui/charts";
import { Button, buttonClasses } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { Skeleton } from "../../components/ui/feedback";
import { DEAL_TYPE_FILL } from "../../components/ui/label-chip";
import { MoneyCounter, MoneyValue } from "../../components/ui/money-value";
import { Avatar } from "../../components/ui/sender";
import { toastAction } from "../../components/ui/toast";

/** Revenue: only money the creator confirmed. Estimates never count here. */
export default function RevenuePage() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const ledger = useLedger(month);
  const insights = useInsights(6);
  const { money, timezone } = useApp();
  const locale = money.locale ?? "en-IN";
  const [editing, setEditing] = useState<DemoLedgerEntry | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const view = ledger.data;
  const goal = insights.data?.goal;
  const months = view?.months ?? [];
  const selected = view?.selectedMonth ?? month;
  const isCurrent = months.length > 0 && selected === months[months.length - 1]?.month;
  const entries = (view?.entries ?? []).filter((entry) => !hidden.has(entry.id));
  const byType = (Object.entries(view?.byType ?? {}) as Array<[DealType, number]>).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const monthName = (key: string, style: "long" | "short" = "long") => formatDate(`${key}-15T12:00:00Z`, locale, timezone, { month: style, ...(style === "long" ? { year: "numeric" } : {}) });

  const remove = (entry: DemoLedgerEntry) => {
    setHidden((current) => new Set(current).add(entry.id));
    runUndoable({
      message: `Sale with @${entry.handle} deleted.`,
      commit: () => appStore.deleteLedger(entry.id),
      onUndo: () => setHidden((current) => { const next = new Set(current); next.delete(entry.id); return next; }),
    });
  };

  return (
    <div className="mx-auto w-full max-w-[1120px] pb-12">
      <LargeTitle
        title="Revenue"
        eyebrow="Confirmed by you"
        accessory={<Button size="sm" variant="secondary" icon={Download} onClick={() => void toastAction(() => appStore.download("/ledger/export.csv", "dealdock-revenue.csv"), { fallback: "Export failed." })}>Export CSV</Button>}
      />

      {months.length > 1 && (
        <div className="dd-scroll-x flex gap-1.5 px-4 pb-4 md:px-8" role="tablist" aria-label="Month">
          {months.map((item) => (
            <button
              key={item.month}
              type="button"
              role="tab"
              aria-selected={item.month === selected}
              onClick={() => setMonth(item.month)}
              className={cx("dd-press h-8 shrink-0 rounded-full px-3.5 text-label font-semibold", item.month === selected ? "bg-primary text-on-primary" : "bg-inset text-ink-2 hover:bg-fill")}
            >
              {monthName(item.month, "short")}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-5 px-4 md:px-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <HeroCard aria-labelledby="month-total" className="p-6 md:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p id="month-total" className="text-label font-semibold text-on-hero/60">{selected ? monthName(selected) : "This month"}</p>
              {!view ? <Skeleton className="mt-2 h-12 w-52 bg-on-hero/10" /> : (
                <MoneyCounter countId={`ledger-${selected}`} minor={view.totalMinor} mode="exact" size="hero" className="mt-1 block font-semibold text-hero-money [&_.dd-symbol-hero]:text-hero-money/70" />
              )}
              <p className="mt-1 inline-flex items-center gap-1.5 text-label font-semibold text-on-hero/70"><CheckCheck aria-hidden size={15} className="text-hero-money" />{entries.length} {pluralize(entries.length, "sale")} you confirmed</p>
            </div>
            {isCurrent && goal?.monthlyGoalMinor ? (
              <button type="button" onClick={() => setGoalOpen(true)} className="shrink-0 rounded-full" aria-label="Change monthly goal">
                <ProgressRing pct={goal.pct ?? 0} size={96} label={`${Math.round(goal.pct ?? 0)}% of your monthly goal`} className="[&_circle:first-child]:stroke-on-hero/10 [&_span]:text-on-hero" />
              </button>
            ) : isCurrent ? (
              <Button size="sm" variant="on-hero" icon={Target} onClick={() => setGoalOpen(true)}>Set a goal</Button>
            ) : null}
          </div>
          {view && (
            <dl className="mt-6 grid grid-cols-2 gap-3 border-t border-on-hero/10 pt-5">
              <div><dt className="text-caption text-on-hero/55">Biggest sale</dt><dd className="text-[20px] font-semibold tracking-[-0.02em]"><MoneyValue minor={view.biggestMinor} className="text-on-hero" /></dd></div>
              <div><dt className="text-caption text-on-hero/55">Average sale</dt><dd className="text-[20px] font-semibold tracking-[-0.02em]"><MoneyValue minor={view.avgMinor} className="text-on-hero" /></dd></div>
            </dl>
          )}
          {isCurrent && goal?.monthlyGoalMinor ? (
            <p className="mt-4 text-[14px] text-on-hero/65">Goal <MoneyValue minor={goal.monthlyGoalMinor} className="font-semibold text-on-hero" />{goal.projectedMinor ? <> · on pace for <MoneyValue minor={goal.projectedMinor} className="font-semibold text-on-hero" /></> : null}</p>
          ) : null}
        </HeroCard>

        <section aria-labelledby="trend-title" className="rounded-[26px] bg-surface p-5 shadow-card md:p-6">
          <div className="flex items-baseline justify-between">
            <h2 id="trend-title" className="text-heading text-ink">Last {months.length || 6} months</h2>
            <TrendingUp aria-hidden size={18} className="text-brand" />
          </div>
          {months.length ? (
            <Bars
              className="mt-4"
              label="Confirmed revenue by month"
              selectedKey={selected}
              onSelect={setMonth}
              data={months.map((item) => ({
                key: item.month,
                label: monthName(item.month, "short"),
                value: item.totalMinor,
                top: <MoneyValue minor={item.totalMinor} className="text-[11px] font-semibold text-ink-2" />,
                ariaLabel: `${monthName(item.month)}: ${item.count} ${pluralize(item.count, "sale")}`,
              }))}
            />
          ) : <Skeleton className="mt-4 h-40 w-full" />}
          {byType.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 text-caption font-semibold text-ink-3">Where it came from</p>
              <StackedBar label="Revenue by type" segments={byType.map(([type, value]) => ({ type, value }))} />
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {byType.map(([type, value]) => (
                  <li key={type} className="flex items-center justify-between gap-2 text-[14px]">
                    <span className="inline-flex items-center gap-2 text-ink-2"><span aria-hidden className={cx("h-2 w-2 rounded-full", DEAL_TYPE_FILL[type])} />{dealTypeText(type)}</span>
                    <MoneyValue minor={value} className="font-semibold text-ink" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <Group id="sales" title="Sales" className="lg:col-span-2" action={<span className="text-caption text-ink-3">Tap a sale to edit it</span>}>
          {!view ? (
            <div className="space-y-1 p-4">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-12 w-full" />)}</div>
          ) : entries.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="text-heading text-ink">No sales recorded {isCurrent ? "this month yet" : "in this month"}.</p>
              <p className="mt-1 text-body text-ink-2">When a deal closes, open the conversation and tap <b className="font-semibold text-ink">Record a sale</b>. It lands here with the receipt trail.</p>
              <Link href="/inbox" className={buttonClasses({ variant: "primary", size: "sm", className: "mt-4" })}>Open inbox</Link>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {entries.map((entry) => (
                <li key={entry.id} className="group flex items-center gap-3 px-4 py-3">
                  <Avatar handle={entry.handle} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink">
                      <Link href={`/thread/${entry.threadId}`} className="hover:underline">@{entry.handle}</Link>
                    </p>
                    <p className="flex items-center gap-2 truncate text-caption text-ink-3">
                      <span className="inline-flex items-center gap-1.5 font-medium text-ink-2"><span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", DEAL_TYPE_FILL[entry.dealType])} />{dealTypeText(entry.dealType)}</span>
                      <span>· {formatDate(entry.closedAt, locale, timezone, { day: "numeric", month: "short" })}</span>
                      {entry.note && <span className="truncate">· {entry.note}</span>}
                    </p>
                  </div>
                  <MoneyValue minor={entry.amountMinor} mode="exact" kind="confirmed" className="shrink-0 text-[16px] font-semibold" />
                  <div className="flex shrink-0 items-center">
                    <button type="button" aria-label={`Edit sale for ${entry.handle}`} onClick={() => setEditing(entry)} className="dd-press flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-inset hover:text-ink"><Pencil aria-hidden size={16} /></button>
                    <button type="button" aria-label={`Delete sale for ${entry.handle}`} onClick={() => remove(entry)} className="dd-press flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-danger-tint hover:text-danger"><Trash2 aria-hidden size={16} /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Group>
      </div>

      <SaleSheet open={editing !== null} entry={editing} onClose={() => setEditing(null)} />
      <GoalSheet open={goalOpen} onClose={() => setGoalOpen(false)} current={goal?.monthlyGoalMinor ?? null} />
    </div>
  );
}
