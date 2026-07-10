"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { isNudgeDue, useDemoData, demoStore } from "../../../lib/use-demo";
import { MoneyValue } from "../../../components/money";
import { Badge, labelText } from "../../../components/badge";
import { PushPrompt } from "../../../components/pwa";

/** Thread view (DESIGN.md §4.4): history + draft composer + the close-deal action. */
export default function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { threads } = useDemoData();
  const thread = threads.find((t) => t.id === id);

  const [draftText, setDraftText] = useState<string | null>(null);
  const [showClose, setShowClose] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [justSent, setJustSent] = useState(false);

  useEffect(() => {
    if (thread && !thread.draft) void demoStore.ensureDraft(thread.id);
  }, [thread]);

  if (!thread) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10 text-center">
        <p className="text-[14px] text-[#737373]">Thread not found.</p>
        <Link href="/inbox" className="mt-2 inline-block text-[13px] text-[#ffc107]">
          ← Back to inbox
        </Link>
      </main>
    );
  }

  const classification = thread.messages[0]?.classification;
  const composerValue = draftText ?? thread.draft?.body ?? "";

  const handleSend = () => {
    if (!composerValue.trim()) return;
    demoStore.send(thread.id, composerValue.trim());
    setDraftText(null);
    setJustSent(true);
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link href="/inbox" aria-label="Back to inbox" className="flex min-h-11 min-w-11 items-center text-[#737373] hover:text-[#fafafa]">
            ←
          </Link>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold">@{thread.handle}</p>
            <div className="mt-0.5 flex items-center gap-2">
              {thread.topLabel && (
                <button onClick={() => setShowWhy((v) => !v)} aria-expanded={showWhy}>
                  <Badge label={thread.topLabel} />
                </button>
              )}
              {thread.estValueMaxMinor !== null && (
                <MoneyValue
                  minor={thread.estValueMinMinor ?? thread.estValueMaxMinor}
                  maxMinor={thread.estValueMaxMinor}
                  className="text-[13px] font-bold text-[#ffc107]"
                />
              )}
            </div>
          </div>
        </div>

        {/* State toggle + close action */}
        <div className="flex shrink-0 items-center gap-2">
          {thread.state !== "closed" && (
            <button
              onClick={() =>
                demoStore.setState(thread.id, thread.state === "waiting" ? "open" : "waiting")
              }
              className={`min-h-9 rounded-full border px-3 text-[12px] font-medium transition-colors ${
                thread.state === "waiting"
                  ? "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b]"
                  : "border-white/[0.1] text-[#737373] hover:text-[#a3a3a3]"
              }`}
            >
              {thread.state === "waiting" ? "Waiting ✓" : "Move to waiting"}
            </button>
          )}
          <button
            onClick={() => setShowClose(true)}
            className="min-h-9 rounded-full border border-[#ffc107]/50 px-3 text-[12px] font-bold text-[#ffc107] transition-colors hover:bg-[#ffc107]/10"
          >
            Mark closed ₹
          </button>
        </div>
      </div>

      {/* Rationale — AI you can interrogate (DESIGN.md principle 9) */}
      {showWhy && classification && (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-[#111111] p-3 text-[12px] text-[#a3a3a3]">
          <span className="font-semibold text-[#e5e5e5]">
            Why {labelText(classification.label)}:
          </span>{" "}
          {classification.rationale} ·{" "}
          <span className="money">{Math.round(classification.confidence * 100)}%</span> confident
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto py-5">
        {thread.messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
              m.direction === "inbound"
                ? "bg-[#111111] text-[#e5e5e5]"
                : "ml-auto bg-[#2a2408] text-[#f5e9c0]"
            }`}
          >
            {m.text}
          </div>
        ))}
        {justSent && (
          <div className="ml-auto flex max-w-[85%] items-center justify-end gap-2 pr-1 text-[11px] text-[#22c55e]">
            Sent ✓ ·
            <button
              onClick={() => {
                demoStore.setState(thread.id, "waiting");
                setJustSent(false);
              }}
              className="min-h-8 font-semibold underline underline-offset-2"
            >
              Move to waiting?
            </button>
          </div>
        )}
      </div>

      {/* Nudge banner (DESIGN.md §4.4): due follow-up with draft pre-loaded */}
      {isNudgeDue(thread) && thread.draft?.kind === "nudge" && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-[#f59e0b]/30 bg-[#f59e0b]/[0.08] px-4 py-2.5">
          <p className="text-[12px] text-[#f59e0b]">
            @{thread.handle} has been quiet for{" "}
            {Math.round((Date.now() - (thread.waitingSince ?? Date.now())) / 86_400_000)} days —
            follow-up drafted below.
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => demoStore.dismissNudge(thread.id)}
              className="min-h-8 rounded-full px-2 text-[11px] font-medium text-[#f59e0b]/80 hover:text-[#f59e0b]"
            >
              Dismiss
            </button>
            <button
              onClick={() => demoStore.setState(thread.id, "closed")}
              className="min-h-8 rounded-full px-2 text-[11px] font-medium text-[#737373] hover:text-[#a3a3a3]"
            >
              Close thread
            </button>
          </div>
        </div>
      )}

      {/* Draft composer */}
      {thread.state !== "closed" && (
        <div className="rounded-2xl border border-white/[0.08] bg-[#161616] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-[#ffc107]">
              {thread.draft?.kind === "nudge" ? "✦ Follow-up — in your voice" : "✦ Draft — in your voice"}
            </span>
            <button
              onClick={() => {
                setDraftText(null);
                void demoStore.regenerateDraft(thread.id);
              }}
              className="min-h-8 text-[11px] text-[#737373] hover:text-[#a3a3a3]"
            >
              ↻ Regenerate
            </button>
          </div>
          <textarea
            value={composerValue}
            onChange={(e) => setDraftText(e.target.value)}
            rows={4}
            aria-label="Reply draft"
            placeholder={thread.draft ? "" : "Drafting…"}
            className="w-full resize-none rounded-xl bg-black/30 p-3 text-[13px] leading-relaxed text-[#fafafa] outline-none placeholder:text-[#525252] focus:ring-1 focus:ring-[#ffc107]/40"
          />
          <div className="mt-2 flex items-center justify-between">
            <p className="text-[10px] text-[#525252]">Nothing sends without you.</p>
            <button
              onClick={handleSend}
              disabled={!composerValue.trim()}
              className="min-h-10 rounded-full bg-[#ffc107] px-5 text-[13px] font-bold text-[#050505] transition-colors hover:bg-[#e5a800] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Approve &amp; Send
            </button>
          </div>
        </div>
      )}

      {thread.state === "closed" && (
        <div className="rounded-2xl border border-[#22c55e]/25 bg-[#22c55e]/[0.06] p-4 text-center text-[13px] text-[#22c55e]">
          Deal closed ✓ ·{" "}
          <Link href="/ledger" className="font-semibold underline underline-offset-2">
            View in Ledger
          </Link>
        </div>
      )}

      {/* Contextual push ask — only after seeing a high-value thread (PRD §6.8) */}
      <PushPrompt threadValueMinor={thread.estValueMaxMinor} />

      {showClose && (
        <CloseDealModal
          onClose={() => setShowClose(false)}
          onConfirm={(amountMinor, dealType) => {
            demoStore.closeDeal(thread.id, amountMinor, dealType);
            setShowClose(false);
          }}
        />
      )}
    </main>
  );
}

const DEAL_TYPES = [
  { key: "brand", text: "Brand" },
  { key: "coaching", text: "Coaching" },
  { key: "course", text: "Course" },
  { key: "other", text: "Other" },
] as const;

function CloseDealModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (amountMinor: number, dealType: "brand" | "coaching" | "course" | "other") => void;
}) {
  const [amount, setAmount] = useState("");
  const [dealType, setDealType] = useState<(typeof DEAL_TYPES)[number]["key"]>("brand");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus management (DESIGN.md §7): trap-lite — focus in, Escape closes.
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const major = Number(amount.replace(/[^0-9]/g, ""));
  const formatted = major ? `₹${major.toLocaleString("en-IN")}` : "";

  const confirm = () => {
    if (!major || major <= 0) {
      setError("Enter the deal amount to log it.");
      return;
    }
    onConfirm(major * 100, dealType);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Mark deal closed"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-t-3xl bg-white/[0.02] p-1.5 ring-1 ring-white/[0.08] sm:rounded-3xl"
      >
        <div className="rounded-t-[calc(1.5rem-0.375rem)] bg-[#111111] p-5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)] sm:rounded-[calc(1.5rem-0.375rem)]">
          <h2 className="text-[15px] font-bold">Mark closed for…</h2>
          <input
            ref={inputRef}
            inputMode="numeric"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9]/g, ""));
              setError(null);
            }}
            aria-describedby={error ? "close-error" : undefined}
            placeholder="₹ amount"
            className="money mt-4 w-full rounded-xl bg-black/30 p-3 text-2xl font-bold text-[#ffc107] outline-none placeholder:text-[#404040] focus:ring-1 focus:ring-[#ffc107]/40"
          />
          {formatted && <p className="money mt-1 text-[12px] text-[#737373]">{formatted}</p>}
          {error && (
            <p id="close-error" role="alert" className="mt-1 text-[12px] text-[#ef4444]">
              {error}
            </p>
          )}

          <div className="mt-4 flex gap-1.5">
            {DEAL_TYPES.map((d) => (
              <button
                key={d.key}
                onClick={() => setDealType(d.key)}
                className={`min-h-9 flex-1 rounded-full border text-[12px] font-medium transition-colors ${
                  dealType === d.key
                    ? "border-[#ffc107]/40 bg-[#ffc107]/10 text-[#ffc107]"
                    : "border-white/[0.08] text-[#737373]"
                }`}
              >
                {d.text}
              </button>
            ))}
          </div>

          <div className="mt-5 flex gap-2">
            <button
              onClick={onClose}
              className="min-h-11 flex-1 rounded-full border border-white/[0.1] text-[13px] font-medium text-[#a3a3a3]"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              className="min-h-11 flex-1 rounded-full bg-[#ffc107] text-[13px] font-bold text-[#050505] hover:bg-[#e5a800]"
            >
              Log the deal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
