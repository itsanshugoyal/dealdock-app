"use client";

import { useMemo } from "react";
import { useDemoData } from "../../lib/use-demo";
import { MoneyValue } from "../../components/money";

const TYPE_COLORS: Record<string, string> = {
  brand: "#22c55e",
  coaching: "#3b82f6",
  course: "#a855f7",
  other: "#f97316",
};

/** Revenue Ledger (DESIGN.md §4.6): proof of recovery — the retention asset. */
export default function LedgerPage() {
  const { ledger } = useDemoData();

  const { months, mtdTotal, biggest, avg } = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const e of ledger) {
      const key = new Date(e.closedAt).toISOString().slice(0, 7);
      byMonth.set(key, (byMonth.get(key) ?? 0) + e.amountMinor);
    }
    const months = [...byMonth.entries()]
      .map(([m, total]) => ({ month: m, total }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-6);

    const currentKey = new Date().toISOString().slice(0, 7);
    const mtd = ledger.filter(
      (e) => new Date(e.closedAt).toISOString().slice(0, 7) === currentKey
    );
    const mtdTotal = mtd.reduce((a, e) => a + e.amountMinor, 0);
    return {
      months,
      mtdTotal,
      biggest: mtd.length ? Math.max(...mtd.map((e) => e.amountMinor)) : 0,
      avg: mtd.length ? Math.round(mtdTotal / mtd.length) : 0,
    };
  }, [ledger]);

  const maxMonth = Math.max(1, ...months.map((m) => m.total));
  const currentKey = new Date().toISOString().slice(0, 7);

  const exportCsv = () => {
    const header = "date,handle,deal_type,amount_inr";
    const lines = ledger.map((e) =>
      [
        new Date(e.closedAt).toISOString().slice(0, 10),
        `@${e.handle}`,
        e.dealType,
        Math.round(e.amountMinor / 100),
      ].join(",")
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dealdock-ledger.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-lg font-bold">Revenue Ledger</h1>
        <button
          onClick={exportCsv}
          className="min-h-9 rounded-full border border-white/[0.1] px-3 text-[12px] font-medium text-[#a3a3a3] transition-colors hover:text-[#fafafa]"
        >
          Export CSV
        </button>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-2.5">
        {[
          { label: "This month", value: mtdTotal, highlight: true },
          { label: "Biggest deal", value: biggest, highlight: false },
          { label: "Avg size", value: avg, highlight: false },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border p-3"
            style={{
              borderColor: tile.highlight ? "rgba(255,193,7,0.25)" : "rgba(255,255,255,0.06)",
              backgroundColor: tile.highlight ? "rgba(255,193,7,0.05)" : "#0a0a0a",
            }}
          >
            <p className="text-[10px] uppercase tracking-wider text-[#737373]">{tile.label}</p>
            <MoneyValue
              minor={tile.value}
              className={`mt-1 block text-lg font-bold ${tile.highlight ? "text-[#ffc107]" : "text-[#e5e5e5]"}`}
            />
          </div>
        ))}
      </div>

      {/* Monthly bars */}
      <div className="mt-6 rounded-xl border border-white/[0.06] bg-[#0a0a0a] p-4">
        <p className="mb-4 text-[11px] uppercase tracking-wider text-[#737373]">
          Monthly recovered
        </p>
        <div className="flex h-28 gap-2">
          {months.map((m) => {
            const isCurrent = m.month === currentKey;
            return (
              <div key={m.month} className="flex h-full flex-1 flex-col items-center gap-1.5">
                <div className="flex min-h-0 w-full flex-1 items-end">
                  <div
                    className="w-full rounded-t-md"
                    style={{
                      height: `${Math.max(6, (m.total / maxMonth) * 100)}%`,
                      background: isCurrent
                        ? "linear-gradient(to top, #e5a800, #ffc107)"
                        : "linear-gradient(to top, #2a2a2a, #404040)",
                    }}
                  />
                </div>
                <span
                  className={`text-[9px] font-medium ${isCurrent ? "text-[#ffc107]" : "text-[#525252]"}`}
                >
                  {new Date(`${m.month}-01`).toLocaleString("en", { month: "short" })}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Deals table */}
      <div className="mt-6">
        <p className="mb-2 text-[11px] uppercase tracking-wider text-[#737373]">All deals</p>
        {ledger.length === 0 ? (
          <p className="rounded-xl border border-white/[0.06] bg-[#0a0a0a] p-6 text-center text-[13px] text-[#737373]">
            Close your first deal from a thread — one tap on &quot;Mark closed ₹&quot;.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06] bg-[#0a0a0a]">
            {ledger.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="w-12 shrink-0 text-[11px] text-[#525252]">
                    {new Date(e.closedAt).toLocaleDateString("en", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{
                      color: TYPE_COLORS[e.dealType],
                      backgroundColor: `${TYPE_COLORS[e.dealType]}18`,
                    }}
                  >
                    {e.dealType}
                  </span>
                  <span className="truncate text-[12px] text-[#a3a3a3]">@{e.handle}</span>
                </div>
                <MoneyValue
                  minor={e.amountMinor}
                  className="shrink-0 text-[13px] font-bold text-[#ffc107]"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
