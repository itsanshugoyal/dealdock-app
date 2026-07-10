"use client";

import { useState } from "react";
import type { ClassificationLabel } from "@dealdock/core";
import { CLASSIFICATION_LABELS } from "@dealdock/core";
import { useDemoData, demoStore } from "../../lib/use-demo";
import { Badge, labelText } from "../../components/badge";

/** Review Queue (DESIGN.md §4.5): one decision per card, rationale front and center. */
export default function ReviewPage() {
  const { threads } = useDemoData();
  const [changing, setChanging] = useState<string | null>(null);

  const queue = threads
    .filter((t) => t.routedTo === "review_queue" && !t.reviewed)
    .sort((a, b) => a.lastMessageAt - b.lastMessageAt);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-lg font-bold">Review Queue</h1>
        <span className="text-[11px] text-[#525252]">{queue.length} waiting</span>
      </div>
      <p className="mb-5 text-[12px] text-[#737373]">
        Your corrections train your classifier. Nothing here is ever auto-replied to.
      </p>

      {queue.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-[#0a0a0a] p-8 text-center">
          <p className="text-[14px] font-medium text-[#e5e5e5]">Queue clear ✓</p>
          <p className="mt-1 text-[12px] text-[#737373]">
            New uncertain messages will land here for your judgement.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {queue.map((t) => {
            const c = t.messages[0]?.classification;
            if (!c) return null;
            const pct = Math.round(c.confidence * 100);
            return (
              <div
                key={t.id}
                className="rounded-2xl border border-white/[0.07] bg-[#0a0a0a] p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-[#e5e5e5]">@{t.handle}</span>
                  <div className="flex items-center gap-2">
                    <Badge label={c.label} />
                    {/* Confidence meter — never hidden (DESIGN.md principle 9) */}
                    <div
                      role="meter"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`Confidence ${pct} percent`}
                      className="h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.08]"
                    >
                      <div className="h-full bg-[#eab308]" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="money text-[11px] text-[#eab308]">{pct}%</span>
                  </div>
                </div>

                <p className="mt-3 text-[13px] leading-relaxed text-[#e5e5e5]">
                  {t.messages[0]?.text}
                </p>
                <p className="mt-2 text-[12px] text-[#737373]">
                  <span className="text-[#a3a3a3]">Why:</span> {c.rationale}
                </p>

                {changing === t.id ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {CLASSIFICATION_LABELS.filter((l) => l !== "uncertain").map((l) => (
                      <button
                        key={l}
                        onClick={() => {
                          demoStore.review(t.id, "overridden", l as ClassificationLabel);
                          setChanging(null);
                        }}
                        className="min-h-9 rounded-full border border-white/[0.1] px-3 text-[12px] text-[#a3a3a3] transition-colors hover:border-[#ffc107]/40 hover:text-[#ffc107]"
                      >
                        {labelText(l as ClassificationLabel)}
                      </button>
                    ))}
                    <button
                      onClick={() => setChanging(null)}
                      className="min-h-9 px-2 text-[12px] text-[#525252]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => demoStore.review(t.id, "confirmed")}
                      className="min-h-10 flex-1 rounded-full bg-white/[0.07] text-[13px] font-semibold text-[#fafafa] transition-colors hover:bg-white/[0.1]"
                    >
                      Confirm {labelText(c.label)}
                    </button>
                    <button
                      onClick={() => setChanging(t.id)}
                      className="min-h-10 flex-1 rounded-full border border-white/[0.1] text-[13px] font-medium text-[#a3a3a3] transition-colors hover:text-[#fafafa]"
                    >
                      Change…
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
