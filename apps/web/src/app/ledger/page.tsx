"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { byDealUrgency, isDealOpen, owedTotals, type DealDto, type DealType } from "@dealdock/core";
import { CheckCheck, Download, Pencil, Plus, Target, Trash2, TrendingUp } from "lucide-react";
import { openInvoice, owedAction, whoFrom } from "../../lib/deals";
import { atHandle, dealTypeText, formatDate, pluralize } from "../../lib/format";
import { useMinuteClock } from "../../lib/keyboard";
import { runUndoable } from "../../lib/undo";
import { errorMessage } from "../../lib/snapshot";
import { appStore, useApp, useDeals, useInsights, useLedger, useSettings, type DemoLedgerEntry } from "../../lib/use-demo";
import { DealDetailSheet, DealSheet, OwedRow, PaidSheet, type Paying } from "../../components/deals";
import { InvoiceSheet } from "../../components/invoices";
import { Group, HeroCard, LargeTitle } from "../../components/kit";
import { GoalSheet } from "../../components/goal-editor";
import { SaleSheet } from "../../components/sale-sheet";
import { Bars, ProgressRing, StackedBar } from "../../components/ui/charts";
import { Button, IconButton, buttonClasses } from "../../components/ui/button";
import { Select } from "../../components/ui/field";
import { cx } from "../../components/ui/cx";
import { ErrorState, Skeleton } from "../../components/ui/feedback";
import { DEAL_TYPE_FILL } from "../../components/ui/label-chip";
import { MoneyCounter, MoneyValue } from "../../components/ui/money-value";
import { Avatar } from "../../components/ui/sender";
import { toast, toastAction } from "../../components/ui/toast";

/** Revenue: only money the creator confirmed. Estimates never count here. */
export default function RevenuePage() {
  return <Suspense fallback={null}><Revenue /></Suspense>;
}

function Revenue() {
  const router = useRouter();
  const params = useSearchParams();
  const monthInput = params?.get("month");
  const month = monthInput && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthInput) ? monthInput : undefined;
  const account = params?.get("account") || undefined;
  const ledger = useLedger(month, account);
  // Owed money isn't tied to a month: every open deal for the selected creator.
  const deals = useDeals("open", account);
  const settings = useSettings();
  const insights = useInsights(6);
  const { money, timezone } = useApp();
  const locale = money.locale ?? "en-IN";
  const [editing, setEditing] = useState<DemoLedgerEntry | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [paying, setPaying] = useState<Paying | null>(null);
  const [invoicing, setInvoicing] = useState<DealDto | null>(null);
  const [adding, setAdding] = useState(false);
  // A deal agreed outside DealDock opens here, in a sheet: it has no conversation.
  const [opened, setOpened] = useState<string | null>(null);
  const now = useMinuteClock();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const view = ledger.data;
  const goal = account ? null : insights.data?.goal;
  const accounts = settings.data?.accounts ?? [];
  const creator = accounts.find((item) => item.id === account);
  const owing = (deals.data ?? []).filter(isDealOpen).sort(byDealUrgency);
  const openedDeal = owing.find((deal) => deal.id === opened) ?? null;
  const settle = (deal: DealDto) => {
    const action = owedAction(deal);
    if (action === "balance") setInvoicing(deal);
    else setPaying({ deal, invoice: action === "invoice_paid" ? openInvoice(deal) : null });
  };
  const owed = owedTotals(owing, now || Date.now());
  // Creator chips are agency wording: Roster plan, all creators.
  const dealCreator = (igAccountId: string) => settings.data?.tier === "roster" && accounts.length > 1 && !account ? accounts.find((item) => item.id === igAccountId)?.handle : null;
  const months = view?.months ?? [];
  const selected = view?.selectedMonth ?? month;
  const isCurrent = months.length > 0 && selected === months[months.length - 1]?.month;
  const entries = (view?.entries ?? []).filter((entry) => !hidden.has(entry.id));
  const byType = (Object.entries(view?.byType ?? {}) as Array<[DealType, number]>).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const monthName = (key: string, style: "long" | "short" = "long") => formatDate(`${key}-15T12:00:00Z`, locale, timezone, { month: style, ...(style === "long" ? { year: "numeric" } : {}) });
  const setFilter = (key: "account" | "month", value: string | undefined) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (value) next.set(key, value); else next.delete(key);
    router.replace(`/ledger${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  const setMonth = (value: string) => setFilter("month", value);
  const exportQuery = new URLSearchParams();
  if (selected) exportQuery.set("month", selected);
  if (account) exportQuery.set("igAccountId", account);

  const remove = (entry: DemoLedgerEntry) => {
    setHidden((current) => new Set(current).add(entry.id));
    const action = runUndoable({
      message: `Sale with ${atHandle(entry.handle)} deleted.`,
      commit: () => appStore.deleteLedger(entry.id),
      onUndo: () => setHidden((current) => { const next = new Set(current); next.delete(entry.id); return next; }),
    });
    void action.outcome.then((outcome) => {
      if (outcome.status !== "failed") return;
      setHidden((current) => { const next = new Set(current); next.delete(entry.id); return next; });
      toast(errorMessage(outcome.error, "Couldn't delete this sale. It's still in your ledger."), { tone: "error" });
    });
  };

  if (ledger.status === "error" && !view) {
    return <ErrorState as="h1" thing="your revenue" reason={ledger.error} onRetry={() => void appStore.loadLedger(month, account)} className="min-h-[60dvh] justify-center" />;
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] pb-12">
      <LargeTitle
        title="Revenue"
        eyebrow={creator ? `Confirmed sales · @${creator.handle}` : "Confirmed by you"}
        accessory={(() => {
          const exportCsv = () => void toastAction(() => appStore.download(`/ledger/export.csv${exportQuery.size ? `?${exportQuery}` : ""}`, "dealdock-revenue.csv"), { fallback: "Export failed." });
          return (
            <>
              <Button size="sm" variant="money" icon={Plus} disabled={!accounts.length} onClick={() => setAdding(true)}>Add a deal</Button>
              <Button size="sm" variant="secondary" icon={Download} disabled={!view} title="Export the displayed month and creator" className="max-sm:hidden" onClick={exportCsv}>Export CSV</Button>
              <IconButton label="Export CSV" icon={Download} variant="secondary" disabled={!view} className="sm:hidden" onClick={exportCsv} />
            </>
          );
        })()}
      />

      <div className="mb-4 flex min-w-0 flex-col gap-3 px-4 md:flex-row md:items-end md:gap-5 md:px-8">
        {accounts.length > 1 && <div className="w-full max-w-sm md:w-64 md:shrink-0"><Select label="Revenue for" value={account ?? ""} onChange={(event) => setFilter("account", event.target.value || undefined)}><option value="">All creators</option>{accounts.map((item) => <option key={item.id} value={item.id}>@{item.handle}</option>)}</Select></div>}

        {months.length > 1 && (
        <div className="dd-scroll-x flex min-w-0 gap-1.5 md:pb-1" role="tablist" aria-label="Month">
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
      </div>

      <div className="grid gap-4 px-4 md:gap-5 md:px-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <HeroCard aria-labelledby="month-total" className="flex flex-col p-6 md:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p id="month-total" className="text-label font-semibold text-on-hero/60">{selected ? monthName(selected) : "This month"}</p>
              {!view ? <Skeleton className="mt-2 h-12 w-52 bg-on-hero/10" /> : (
                <MoneyCounter countId={`ledger-${selected}`} minor={view.totalMinor} mode="exact" size="hero" className="mt-1 block font-semibold text-hero-money [&_.dd-symbol-hero]:text-hero-money/70" />
              )}
              {view ? <p className="mt-1 inline-flex items-center gap-1.5 text-label font-semibold text-on-hero/70"><CheckCheck aria-hidden size={15} className="text-hero-money" />{entries.length} {pluralize(entries.length, "sale")} you confirmed</p> : <Skeleton className="mt-3 h-4 w-36 bg-on-hero/10" />}
            </div>
            {!account && isCurrent && goal?.monthlyGoalMinor ? (
              <button type="button" onClick={() => setGoalOpen(true)} className="dd-press shrink-0 rounded-full" aria-label="Change monthly goal">
                <ProgressRing pct={goal.pct ?? 0} size={96} label={`${Math.round(goal.pct ?? 0)}% of your monthly goal`} className="[&_circle:first-child]:stroke-on-hero/10 [&_circle:nth-child(2)]:stroke-hero-money [&_span]:text-on-hero" />
              </button>
            ) : !account && isCurrent ? (
              <Button size="sm" variant="on-hero" icon={Target} onClick={() => setGoalOpen(true)}>Set a goal</Button>
            ) : null}
          </div>
          {/* Stats sit on the bottom edge, level with the trend card beside it. */}
          <div className="mt-auto pt-6">
          {view && (
            <dl className="grid grid-cols-2 gap-3 border-t border-on-hero/10 pt-5">
              <div><dt className="text-caption text-on-hero/55">Biggest sale</dt><dd className="text-[20px] font-semibold tracking-[-0.02em]"><MoneyValue minor={view.biggestMinor} className="text-on-hero" /></dd></div>
              <div><dt className="text-caption text-on-hero/55">Average sale</dt><dd className="text-[20px] font-semibold tracking-[-0.02em]"><MoneyValue minor={view.avgMinor} className="text-on-hero" /></dd></div>
            </dl>
          )}
          {isCurrent && goal?.monthlyGoalMinor ? (
            <p className="mt-4 text-[14px] text-on-hero/65">Goal <MoneyValue minor={goal.monthlyGoalMinor} className="font-semibold text-on-hero" />{goal.projectedMinor ? <> · on pace for <MoneyValue minor={goal.projectedMinor} className="font-semibold text-on-hero" /></> : null}</p>
          ) : null}
          </div>
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
            <div className="mt-5 border-t border-hairline pt-4">
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

        {owing.length > 0 && (
          <Group
            id="owed"
            title="Owed to you"
            description={<><MoneyValue minor={owed.owedMinor} mode="exact" className="font-semibold text-ink-2" /> across {owing.length} {pluralize(owing.length, "deal")}{owed.overdueMinor > 0 && <> · <span className="font-semibold text-waiting"><MoneyValue minor={owed.overdueMinor} mode="exact" /> overdue</span></>}</>}
            className="lg:col-span-2"
          >
            <ul className="divide-y divide-hairline">
              {owing.map((deal) => <OwedRow key={deal.id} deal={deal} now={now || Date.now()} creator={dealCreator(deal.igAccountId)} onPaid={() => settle(deal)} onOpen={() => setOpened(deal.id)} />)}
            </ul>
          </Group>
        )}

        <Group id="sales" title="Sales" className="lg:col-span-2">
          {!view ? (
            <div className="space-y-1 p-4">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-12 w-full" />)}</div>
          ) : entries.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="text-heading text-ink">No sales recorded {isCurrent ? "this month yet" : "in this month"}.</p>
              <p className="mt-1 text-body text-ink-2">When a deal closes, open the conversation and tap <b className="font-semibold text-ink">Record a deal</b>. It lands here with the receipt trail.</p>
              <Link href="/inbox" className={buttonClasses({ variant: "primary", size: "sm", className: "mt-4" })}>Open inbox</Link>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar handle={entry.handle} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink">
                      {entry.threadId ? <Link href={`/thread/${entry.threadId}`} className="hover:underline">{atHandle(entry.handle)}</Link> : <bdi>{whoFrom(entry.handle, false)}</bdi>}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 text-caption text-ink-3">
                      <span className="inline-flex items-center gap-1.5 font-medium text-ink-2"><span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", DEAL_TYPE_FILL[entry.dealType])} />{dealTypeText(entry.dealType)}</span>
                      <span>· {formatDate(entry.closedAt, locale, timezone, { day: "numeric", month: "short" })}</span>
                      {entry.note && <span className="min-w-0 break-words">· {entry.note}</span>}
                    </p>
                  </div>
                  {/* Phones stack the amount over its actions so the handle keeps its width. */}
                  <div className="flex shrink-0 flex-col items-end sm:flex-row sm:items-center sm:gap-2">
                    <MoneyValue minor={entry.amountMinor} mode="exact" kind="confirmed" className="text-[16px] font-semibold" />
                    <div className="-mr-2 flex items-center sm:mr-0">
                      <button type="button" aria-label={`Edit sale for ${entry.handle}`} onClick={() => setEditing(entry)} className="dd-press dd-hit flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-inset hover:text-ink sm:h-10 sm:w-10"><Pencil aria-hidden size={16} /></button>
                      <button type="button" aria-label={`Delete sale for ${entry.handle}`} onClick={() => remove(entry)} className="dd-press dd-hit flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-danger-tint hover:text-danger sm:h-10 sm:w-10"><Trash2 aria-hidden size={16} /></button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Group>
      </div>

      <SaleSheet open={editing !== null} entry={editing} onClose={() => setEditing(null)} />
      <GoalSheet open={goalOpen} onClose={() => setGoalOpen(false)} current={goal?.monthlyGoalMinor ?? null} />
      <PaidSheet paying={paying} onClose={() => setPaying(null)} />
      <InvoiceSheet deal={invoicing} kind="balance" onClose={() => setInvoicing(null)} />
      <DealSheet open={adding} onClose={() => setAdding(false)} creators={accounts} igAccountId={account ?? accounts[0]?.id} />
      <DealDetailSheet deal={openedDeal} creator={openedDeal ? dealCreator(openedDeal.igAccountId) : null} onClose={() => setOpened(null)} />
    </div>
  );
}
