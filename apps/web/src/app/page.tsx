"use client";

import Link from "next/link";
import { useDemoData } from "../lib/use-demo";
import { MoneyValue } from "../components/money";
import { Badge } from "../components/badge";

/** Dashboard (DESIGN.md §4.2): Revenue Recovered front and center. */
export default function Dashboard() {
  const { threads, ledger } = useDemoData();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const mtd = ledger.filter((l) => l.closedAt >= monthStart.getTime());
  const mtdTotal = mtd.reduce((a, l) => a + l.amountMinor, 0);
  const biggest = mtd.length ? Math.max(...mtd.map((l) => l.amountMinor)) : 0;
  const avg = mtd.length ? Math.round(mtdTotal / mtd.length) : 0;

  const needsYou = threads
    .filter((t) => t.state === "open" && t.routedTo === "inbox" && t.unreplied && t.estValueMaxMinor)
    .sort((a, b) => (b.estValueMaxMinor ?? 0) - (a.estValueMaxMinor ?? 0))
    .slice(0, 3);
  const reviewCount = threads.filter((t) => t.routedTo === "review_queue" && !t.reviewed).length;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-widest text-[#737373]">
        Revenue Recovered · this month
      </p>

      {/* The single most important pixel-area in the product (Double-Bezel). */}
      <div className="rounded-3xl bg-white/[0.02] p-1.5 ring-1 ring-white/[0.06]">
        <div className="rounded-[calc(1.5rem-0.375rem)] bg-[#111111] p-6 shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]">
          <MoneyValue minor={mtdTotal} exact className="text-4xl font-bold text-[#ffc107]" />
          <div className="mt-4 flex gap-6 text-[12px] text-[#737373]">
            <span>
              Biggest deal{" "}
              <MoneyValue minor={biggest} className="font-semibold text-[#e5e5e5]" />
            </span>
            <span>
              Avg size <MoneyValue minor={avg} className="font-semibold text-[#e5e5e5]" />
            </span>
            <span>
              Deals <span className="money font-semibold text-[#e5e5e5]">{mtd.length}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Needs you */}
      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-[#e5e5e5]">Needs you</h2>
          <Link href="/inbox" className="text-[12px] text-[#ffc107] hover:text-[#e5a800]">
            Open inbox →
          </Link>
        </div>
        {needsYou.length === 0 ? (
          <p className="rounded-xl border border-white/[0.06] bg-[#0a0a0a] p-4 text-[13px] text-[#737373]">
            Inbox clear. Every high-value thread has a reply.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06] bg-[#0a0a0a]">
            {needsYou.map((t) => (
              <Link
                key={t.id}
                href={`/thread/${t.id}`}
                className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {t.topLabel && <Badge label={t.topLabel} />}
                  <span className="truncate text-[13px] font-medium text-[#e5e5e5]">
                    @{t.handle}
                  </span>
                </div>
                {t.estValueMaxMinor && (
                  <MoneyValue
                    minor={t.estValueMinMinor ?? t.estValueMaxMinor}
                    maxMinor={t.estValueMaxMinor}
                    className="shrink-0 text-[13px] font-bold text-[#ffc107]"
                  />
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Review nudge */}
      {reviewCount > 0 && (
        <Link
          href="/review"
          className="mt-4 flex min-h-11 items-center justify-between rounded-xl border border-[#eab308]/25 bg-[#eab308]/[0.06] px-4 py-3 text-[13px] text-[#eab308] transition-colors hover:bg-[#eab308]/[0.1]"
        >
          <span>{reviewCount} messages need your judgement</span>
          <span>Review →</span>
        </Link>
      )}
    </main>
  );
}
