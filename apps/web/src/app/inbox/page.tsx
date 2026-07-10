"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ClassificationLabel } from "@dealdock/core";
import { isNudgeDue, useDemoData } from "../../lib/use-demo";
import { MoneyValue } from "../../components/money";
import { Badge } from "../../components/badge";

const FILTERS: Array<{ key: string; text: string }> = [
  { key: "all", text: "All" },
  { key: "brand_deal", text: "Brand" },
  { key: "coaching_lead", text: "Coaching" },
  { key: "course_inquiry", text: "Course" },
  { key: "waiting", text: "Waiting" },
  { key: "unreplied", text: "Unreplied" },
];

function age(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

/** Revenue Inbox (DESIGN.md §4.3) — sorted by estimated value, money loudest. */
export default function InboxPage() {
  const { threads } = useDemoData();
  const [filter, setFilter] = useState("all");

  const rows = useMemo(() => {
    let list = threads.filter((t) => t.routedTo === "inbox");
    if (filter === "waiting") list = list.filter((t) => t.state === "waiting");
    else if (filter === "unreplied")
      list = list.filter((t) => t.unreplied && t.state === "open");
    else if (filter !== "all")
      list = list.filter(
        (t) => t.state !== "closed" && t.topLabel === (filter as ClassificationLabel)
      );
    else list = list.filter((t) => t.state !== "closed");

    return list.sort(
      (a, b) =>
        (b.estValueMaxMinor ?? -1) - (a.estValueMaxMinor ?? -1) ||
        b.lastMessageAt - a.lastMessageAt
    );
  }, [threads, filter]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-lg font-bold">Revenue Inbox</h1>
        <span className="text-[11px] text-[#525252]">sorted by ₹ value</span>
      </div>

      {/* Filter chips */}
      <div className="mb-4 flex gap-1.5 overflow-x-auto py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`min-h-8 shrink-0 rounded-full border px-3 text-[12px] font-medium transition-colors ${
              filter === f.key
                ? "border-[#ffc107]/40 bg-[#ffc107]/10 text-[#ffc107]"
                : "border-white/[0.08] text-[#737373] hover:text-[#a3a3a3]"
            }`}
          >
            {f.text}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-[#0a0a0a] p-8 text-center">
          <p className="text-[14px] font-medium text-[#e5e5e5]">Nothing here</p>
          <p className="mt-1 text-[12px] text-[#737373]">
            {filter === "all" ? "Inbox clear — money recovered, nothing waiting." : "No threads match this filter."}
          </p>
          {filter !== "all" && (
            <button
              onClick={() => setFilter("all")}
              className="mt-3 min-h-9 rounded-full border border-white/[0.1] px-4 text-[12px] text-[#a3a3a3]"
            >
              Clear filter
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06] bg-[#0a0a0a]">
          {rows.map((t) => {
            const preview = t.messages[0]?.text ?? "";
            return (
              <Link
                key={t.id}
                href={`/thread/${t.id}`}
                className={`block px-4 py-3 transition-colors hover:bg-white/[0.03] ${
                  t.unreplied && t.state === "open" ? "border-l-2 border-l-[#ffc107]" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-[#e5e5e5]">
                      @{t.handle}
                    </span>
                    <span className="shrink-0 text-[11px] text-[#525252]">
                      {age(t.lastMessageAt)}
                    </span>
                    {t.state === "waiting" &&
                      (isNudgeDue(t) ? (
                        <span className="shrink-0 rounded-full bg-[#f59e0b] px-2 py-0.5 text-[10px] font-bold text-[#050505]">
                          Follow up?
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-2 py-0.5 text-[10px] font-semibold text-[#f59e0b]">
                          waiting {t.waitingSince ? age(t.waitingSince) : ""}
                        </span>
                      ))}
                  </div>
                  {t.estValueMaxMinor !== null && (
                    <MoneyValue
                      minor={t.estValueMinMinor ?? t.estValueMaxMinor}
                      maxMinor={t.estValueMaxMinor}
                      className="shrink-0 text-[14px] font-bold text-[#ffc107]"
                    />
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {t.topLabel && <Badge label={t.topLabel} />}
                  {t.draft && (
                    <span className="text-[10px] font-medium text-[#ffc107]">● draft ready</span>
                  )}
                </div>
                <p className="mt-1 truncate text-[12px] text-[#737373]">{preview}</p>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
