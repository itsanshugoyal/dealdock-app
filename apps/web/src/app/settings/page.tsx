"use client";

import { useState } from "react";
import { DEFAULT_LOCALE, type CurrencyCode } from "@dealdock/core";
import { useDemoData, demoStore } from "../../lib/use-demo";
import { MoneyValue } from "../../components/money";

/** Settings (DESIGN.md §4.8) — trust is the brand: zero-guilt cancel, honest data view. */
export default function SettingsPage() {
  const { money, threads, ledger } = useDemoData();
  const [voiceOn, setVoiceOn] = useState(true);
  const [prefs, setPrefs] = useState({ highValue: true, nudge: true, weekly: true });
  const [ignoreInput, setIgnoreInput] = useState("");
  const [ignoreList, setIgnoreList] = useState<string[]>(["priyasharma_sis", "cousin.neha"]);
  const [cancelState, setCancelState] = useState<"none" | "confirm" | "done">("none");
  const [deleteState, setDeleteState] = useState<"none" | "confirm" | "done">("none");

  const exportArchive = () => {
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), threads, ledger }, null, 2)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dealdock-export.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="mb-6 text-lg font-bold">Settings</h1>

      {/* Region */}
      <Section title="Region" sub="One currency per account. Changing it never rewrites your ledger history.">
        <div className="flex flex-wrap gap-1.5">
          {(["INR", "USD", "GBP", "EUR", "AED"] as CurrencyCode[]).map((c) => (
            <button
              key={c}
              onClick={() => demoStore.setRegion({ currency: c, locale: DEFAULT_LOCALE[c] })}
              className={`min-h-9 rounded-full border px-3 text-[12px] font-medium transition-colors ${
                money.currency === c
                  ? "border-[#ffc107]/40 bg-[#ffc107]/10 text-[#ffc107]"
                  : "border-white/[0.08] text-[#737373]"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-[#525252]">
          Deals display as <MoneyValue minor={32_000_000} className="text-[#ffc107]" /> ·
          nudge delay 3 days · timezone Asia/Kolkata
        </p>
      </Section>

      {/* Notifications */}
      <Section title="Notifications" sub="Each type individually controllable. Quiet hours 11pm–8am, your timezone.">
        {(
          [
            ["highValue", "New high-value DM"],
            ["nudge", "Follow-up due"],
            ["weekly", "Weekly summary"],
          ] as const
        ).map(([key, label]) => (
          <Toggle
            key={key}
            label={label}
            on={prefs[key]}
            onChange={(v) => setPrefs((p) => ({ ...p, [key]: v }))}
          />
        ))}
      </Section>

      {/* Voice */}
      <Section title="Voice & drafting" sub="Off = classification only, no drafts. Your sent messages train only your account.">
        <Toggle label="Voice-matched drafting" on={voiceOn} onChange={setVoiceOn} />
      </Section>

      {/* Ignore list */}
      <Section title="Ignore list" sub="These handles are never classified or drafted — family, collaborators, your alt.">
        <div className="flex flex-wrap gap-1.5">
          {ignoreList.map((h) => (
            <span
              key={h}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-white/[0.08] px-3 text-[12px] text-[#a3a3a3]"
            >
              @{h}
              <button
                aria-label={`Remove ${h}`}
                onClick={() => setIgnoreList((l) => l.filter((x) => x !== h))}
                className="text-[#525252] hover:text-[#ef4444]"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const h = ignoreInput.replace(/^@/, "").trim().toLowerCase();
            if (h && !ignoreList.includes(h)) setIgnoreList((l) => [...l, h]);
            setIgnoreInput("");
          }}
        >
          <input
            value={ignoreInput}
            onChange={(e) => setIgnoreInput(e.target.value)}
            placeholder="@handle"
            aria-label="Add handle to ignore list"
            className="min-h-10 flex-1 rounded-xl border border-white/[0.08] bg-[#161616] px-3 text-[13px] text-[#fafafa] outline-none placeholder:text-[#525252] focus:border-[#ffc107]/40"
          />
          <button className="min-h-10 rounded-full border border-white/[0.1] px-4 text-[12px] font-medium text-[#a3a3a3]">
            Add
          </button>
        </form>
      </Section>

      {/* Data & privacy */}
      <Section
        title="Data & privacy"
        sub={`We store ${threads.length} threads, ${ledger.length} ledger entries, and the drafts we generated. Nothing is sold or used to train public models.`}
      >
        <div className="flex gap-2">
          <button
            onClick={exportArchive}
            className="min-h-10 rounded-full border border-white/[0.1] px-4 text-[12px] font-medium text-[#a3a3a3] hover:text-[#fafafa]"
          >
            Export everything (JSON)
          </button>
          {deleteState === "none" && (
            <button
              onClick={() => setDeleteState("confirm")}
              className="min-h-10 rounded-full border border-[#ef4444]/30 px-4 text-[12px] font-medium text-[#ef4444]/80 hover:text-[#ef4444]"
            >
              Delete account
            </button>
          )}
        </div>
        {deleteState === "confirm" && (
          <div className="mt-3 rounded-xl border border-[#ef4444]/25 bg-[#ef4444]/[0.05] p-3">
            <p className="text-[12px] text-[#e5e5e5]">
              7-day grace period, then everything is permanently deleted. Sign in during the
              grace window to cancel. Export first?
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setDeleteState("done")}
                className="min-h-9 rounded-full bg-[#ef4444] px-4 text-[12px] font-bold text-white"
              >
                Schedule deletion
              </button>
              <button
                onClick={() => setDeleteState("none")}
                className="min-h-9 rounded-full border border-white/[0.1] px-4 text-[12px] text-[#a3a3a3]"
              >
                Keep my account
              </button>
            </div>
          </div>
        )}
        {deleteState === "done" && (
          <p className="mt-3 rounded-xl border border-[#ef4444]/25 bg-[#ef4444]/[0.05] p-3 text-[12px] text-[#e5e5e5]">
            Deletion scheduled (demo). In production: hard delete after 7 days, ledger CSV
            downloadable until then.
          </p>
        )}
      </Section>

      {/* Billing */}
      <Section
        title="Billing"
        sub="Pilot pricing locked as long as you stay subscribed. First invoice ran after your first week of active use."
      >
        <div className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-[#0a0a0a] p-3">
          <div>
            <p className="text-[13px] font-semibold text-[#fafafa]">
              Solo · <MoneyValue minor={money.currency === "INR" ? 4_000_00 : 49_00} className="text-[#ffc107]" />
              /month
            </p>
            <p className="text-[11px] text-[#525252]">
              {money.currency === "INR" ? "Razorpay · UPI Autopay" : "Paddle · card"} · demo mode
            </p>
          </div>
          {cancelState === "none" && (
            <button
              onClick={() => setCancelState("confirm")}
              className="min-h-9 rounded-full border border-white/[0.1] px-4 text-[12px] text-[#737373] hover:text-[#a3a3a3]"
            >
              Cancel
            </button>
          )}
        </div>
        {/* Zero-guilt cancel: ONE confirmation, consequences stated plainly (PRD §5.7) */}
        {cancelState === "confirm" && (
          <div className="mt-3 rounded-xl border border-white/[0.1] bg-[#0a0a0a] p-3">
            <p className="text-[12px] text-[#e5e5e5]">
              Your plan runs to the end of this cycle. After that: ledger read-only for 30
              days, CSV export anytime. No fees, no questions.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setCancelState("done")}
                className="min-h-9 rounded-full bg-white/[0.08] px-4 text-[12px] font-semibold text-[#fafafa]"
              >
                Confirm cancellation
              </button>
              <button
                onClick={() => setCancelState("none")}
                className="min-h-9 rounded-full border border-white/[0.1] px-4 text-[12px] text-[#a3a3a3]"
              >
                Never mind
              </button>
            </div>
          </div>
        )}
        {cancelState === "done" && (
          <p className="mt-3 rounded-xl border border-white/[0.1] bg-[#0a0a0a] p-3 text-[12px] text-[#a3a3a3]">
            Cancelled (demo). Runs until period end — thanks for trying DealDock.
          </p>
        )}
      </Section>
    </main>
  );
}

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-[13px] font-semibold text-[#e5e5e5]">{title}</h2>
      {sub && <p className="mb-3 mt-0.5 text-[11px] leading-relaxed text-[#525252]">{sub}</p>}
      {children}
    </section>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className="mb-2 flex min-h-10 w-full items-center justify-between rounded-xl border border-white/[0.07] px-3 text-[13px] text-[#e5e5e5]"
    >
      {label}
      <span
        className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${
          on ? "justify-end bg-[#ffc107]" : "justify-start bg-white/[0.15]"
        }`}
      >
        <span className="h-4 w-4 rounded-full bg-[#050505]" />
      </span>
    </button>
  );
}
