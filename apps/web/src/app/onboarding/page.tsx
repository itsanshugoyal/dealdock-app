"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, type CurrencyCode } from "@dealdock/core";
import { useDemoData, demoStore } from "../../lib/use-demo";
import { MoneyValue } from "../../components/money";
import { Badge } from "../../components/badge";

/**
 * Onboarding wizard (DESIGN.md §4.1): one concern per screen, the Leak Scan
 * reveal as the climax, and the first task is DOING the loop — the CTA opens
 * the biggest still-live thread with a draft ready (do, don't show).
 */

const STEPS = ["welcome", "connect", "region", "business", "voice", "scan"] as const;
type Step = (typeof STEPS)[number];

const CURRENCIES: Array<{ code: CurrencyCode; flag: string; name: string }> = [
  { code: "INR", flag: "🇮🇳", name: "Indian Rupee" },
  { code: "USD", flag: "🇺🇸", name: "US Dollar" },
  { code: "GBP", flag: "🇬🇧", name: "British Pound" },
  { code: "EUR", flag: "🇪🇺", name: "Euro" },
  { code: "AED", flag: "🇦🇪", name: "UAE Dirham" },
];

const SELLS = ["Coaching / 1-on-1", "Course / cohort", "Brand collabs", "Consulting", "Workshops"];
const DEAL_RANGES = ["Under ₹50K", "₹50K – ₹1.5L", "₹1.5L – ₹4L", "₹4L+"];

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>("welcome");
  const idx = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)]!);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-8">
      {/* Progress dots */}
      <div className="mb-8 flex justify-center gap-1.5" aria-label={`Step ${idx + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1.5 rounded-full transition-all ${
              i === idx ? "w-6 bg-[#ffc107]" : i < idx ? "w-1.5 bg-[#ffc107]/50" : "w-1.5 bg-white/[0.12]"
            }`}
          />
        ))}
      </div>

      <div className="flex flex-1 flex-col justify-center">
        {step === "welcome" && <Welcome onNext={next} />}
        {step === "connect" && <Connect onNext={next} />}
        {step === "region" && <Region onNext={next} />}
        {step === "business" && <Business onNext={next} />}
        {step === "voice" && <Voice onNext={next} />}
        {step === "scan" && <LeakScan />}
      </div>
    </main>
  );
}

function StepShell({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-xl font-bold leading-snug">{title}</h1>
      {sub && <p className="mt-2 text-[13px] leading-relaxed text-[#737373]">{sub}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

function NextButton({ onClick, label = "Continue" }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="mt-8 min-h-12 w-full rounded-full bg-[#ffc107] text-[14px] font-bold text-[#050505] transition-colors hover:bg-[#e5a800]"
    >
      {label}
    </button>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <StepShell
      title="Welcome to the pilot."
      sub="DealDock finds the money buried in your DMs — brand deals, coaching leads, course inquiries — sorts it by value, and drafts replies in your voice. You approve everything. Nothing ever sends without you."
    >
      <div className="rounded-2xl border border-white/[0.07] bg-[#0a0a0a] p-4 text-[12px] leading-relaxed text-[#a3a3a3]">
        Next 3 minutes: connect Instagram, tell us about your business, and we'll
        show you exactly how much went unanswered last month.
      </div>
      <NextButton onClick={onNext} label="Let's go" />
    </StepShell>
  );
}

function Connect({ onNext }: { onNext: () => void }) {
  const [connecting, setConnecting] = useState(false);
  return (
    <StepShell
      title="Connect your Instagram."
      sub="Official Meta API only — no passwords, no scraping, disconnect anytime. Business and Creator accounts supported."
    >
      <button
        onClick={() => {
          setConnecting(true);
          setTimeout(onNext, 900); // demo: instant OAuth
        }}
        disabled={connecting}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-white/[0.1] bg-[#111111] text-[14px] font-semibold text-[#fafafa] transition-colors hover:bg-white/[0.06]"
      >
        {connecting ? "Connecting…" : "◫ Continue with Instagram"}
      </button>
      <p className="mt-3 text-center text-[11px] text-[#525252]">
        Demo mode connects a sample account (@demo.creator).
      </p>
    </StepShell>
  );
}

function Region({ onNext }: { onNext: () => void }) {
  const { money } = useDemoData();
  const [currency, setCurrency] = useState<CurrencyCode>(money.currency);
  const preview = { currency, locale: DEFAULT_LOCALE[currency] };

  return (
    <StepShell
      title="Where does your money live?"
      sub="One currency per account — every estimate, ledger entry, and invoice follows it. You can change this later in Settings."
    >
      <div className="space-y-2">
        {CURRENCIES.map((c) => (
          <button
            key={c.code}
            onClick={() => setCurrency(c.code)}
            className={`flex min-h-11 w-full items-center justify-between rounded-xl border px-4 text-[13px] transition-colors ${
              currency === c.code
                ? "border-[#ffc107]/40 bg-[#ffc107]/[0.07] text-[#fafafa]"
                : "border-white/[0.07] text-[#a3a3a3] hover:border-white/[0.15]"
            }`}
          >
            <span>
              {c.flag} {c.name}
            </span>
            <span className="money text-[12px] text-[#737373]">{c.code}</span>
          </button>
        ))}
      </div>

      {/* Live preview — the user SEES what they're choosing (DESIGN.md §4.1.3) */}
      <div className="mt-4 rounded-xl border border-white/[0.07] bg-[#0a0a0a] p-3 text-center">
        <p className="text-[10px] uppercase tracking-widest text-[#525252]">
          your deals will look like
        </p>
        <MoneyValue minor={32_000_000} ctx={preview} className="mt-1 block text-xl font-bold text-[#ffc107]" />
      </div>

      <NextButton
        onClick={() => {
          demoStore.setRegion({ currency, locale: DEFAULT_LOCALE[currency] });
          onNext();
        }}
      />
    </StepShell>
  );
}

function Business({ onNext }: { onNext: () => void }) {
  const [sells, setSells] = useState<string[]>([]);
  const [dealRange, setDealRange] = useState<string | null>(null);

  return (
    <StepShell
      title="What do you sell?"
      sub="This calibrates the value estimates on every DM — the better we know your prices, the sharper the ₹ ranges."
    >
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[#737373]">
        You offer <span className="normal-case">(pick all that apply)</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {SELLS.map((s) => (
          <button
            key={s}
            onClick={() =>
              setSells((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
            }
            className={`min-h-9 rounded-full border px-3 text-[12px] font-medium transition-colors ${
              sells.includes(s)
                ? "border-[#ffc107]/40 bg-[#ffc107]/10 text-[#ffc107]"
                : "border-white/[0.08] text-[#737373]"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <p className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-wider text-[#737373]">
        Typical brand deal size
      </p>
      <div className="flex flex-wrap gap-1.5">
        {DEAL_RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setDealRange(r)}
            className={`min-h-9 rounded-full border px-3 text-[12px] font-medium transition-colors ${
              dealRange === r
                ? "border-[#ffc107]/40 bg-[#ffc107]/10 text-[#ffc107]"
                : "border-white/[0.08] text-[#737373]"
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      <NextButton onClick={onNext} />
    </StepShell>
  );
}

function Voice({ onNext }: { onNext: () => void }) {
  const [enabled, setEnabled] = useState(true);
  return (
    <StepShell
      title="Drafts in your voice — with your consent."
      sub="We read a sample of replies you've already sent to learn your greeting, tone, and sign-off. That's it — we never post, never send, never train public models on your data."
    >
      <button
        onClick={() => setEnabled(!enabled)}
        role="switch"
        aria-checked={enabled}
        className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-4 text-[13px] transition-colors ${
          enabled ? "border-[#ffc107]/40 bg-[#ffc107]/[0.07]" : "border-white/[0.08]"
        }`}
      >
        <span className="font-medium text-[#fafafa]">Voice-matched drafting</span>
        <span
          className={`flex h-6 w-11 items-center rounded-full p-0.5 transition-colors ${
            enabled ? "justify-end bg-[#ffc107]" : "justify-start bg-white/[0.15]"
          }`}
        >
          <span className="h-5 w-5 rounded-full bg-[#050505]" />
        </span>
      </button>
      <p className="mt-3 text-[11px] leading-relaxed text-[#525252]">
        Off = classification only, no drafts. Toggle anytime in Settings. Drafts get
        sharper over your first week as we learn your voice.
      </p>
      <NextButton onClick={onNext} label={enabled ? "Consent & continue" : "Continue without drafts"} />
    </StepShell>
  );
}

/** The climax (DESIGN.md §4.1.6): scan progress → count-up reveal → recover-the-biggest CTA. */
function LeakScan() {
  const { threads } = useDemoData();
  const [phase, setPhase] = useState<"scanning" | "reveal">("scanning");
  const [progress, setProgress] = useState(0);

  const scan = useMemo(() => demoStore.leakScan(), [threads]);

  useEffect(() => {
    if (threads.length === 0) return; // store still initializing
    const total = 1800;
    const start = Date.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / total);
      setProgress(p);
      if (p >= 1) {
        clearInterval(timer);
        setPhase("reveal");
        demoStore.completeOnboarding();
      }
    }, 60);
    return () => clearInterval(timer);
  }, [threads.length]);

  if (phase === "scanning") {
    return (
      <div className="text-center">
        <p className="text-[11px] font-medium uppercase tracking-widest text-[#737373]">
          Leak Scan
        </p>
        <h1 className="mt-2 text-xl font-bold">Scanning your last 30 days…</h1>
        <p className="money mt-1 text-[13px] text-[#ffc107]">
          {Math.round(progress * scan.scannedCount)} messages classified
        </p>
        <div className="mx-auto mt-6 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full bg-[#ffc107] transition-[width] duration-100"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
    );
  }

  const biggest = scan.topThreads[0];

  return (
    <div>
      <p className="text-center text-[11px] font-medium uppercase tracking-widest text-[#737373]">
        Last 30 days
      </p>

      {/* The reveal — Double-Bezel, count-up energy */}
      <div className="mt-3 rounded-3xl bg-white/[0.02] p-1.5 ring-1 ring-white/[0.06]">
        <div className="rounded-[calc(1.5rem-0.375rem)] bg-[#111111] p-6 text-center shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]">
          <p className="text-[12px] text-[#a3a3a3]">At least</p>
          <MoneyValue
            minor={scan.totalMinMinor}
            className="mt-1 block text-4xl font-bold text-[#ffc107]"
          />
          <p className="mt-2 text-[13px] leading-snug text-[#e5e5e5]">
            in commerce DMs went unanswered.
          </p>
          <p className="mt-1 text-[11px] text-[#525252]">
            {scan.commerceCount} real opportunities out of {scan.scannedCount} messages.
          </p>
        </div>
      </div>

      {/* Top missed threads */}
      <div className="mt-4 divide-y divide-white/[0.05] rounded-xl border border-white/[0.06] bg-[#0a0a0a]">
        {scan.topThreads.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              {t.topLabel && <Badge label={t.topLabel} />}
              <span className="truncate text-[12px] font-medium text-[#e5e5e5]">@{t.handle}</span>
            </div>
            {t.estValueMaxMinor !== null && (
              <MoneyValue
                minor={t.estValueMinMinor ?? t.estValueMaxMinor}
                maxMinor={t.estValueMaxMinor}
                className="shrink-0 text-[12px] font-bold text-[#ffc107]"
              />
            )}
          </div>
        ))}
      </div>

      {/* Do, don't show: the first task IS the loop */}
      {biggest ? (
        <Link
          href={`/thread/${biggest.id}`}
          className="mt-6 flex min-h-12 w-full items-center justify-center rounded-full bg-[#ffc107] text-[14px] font-bold text-[#050505] transition-colors hover:bg-[#e5a800]"
        >
          Recover your biggest one →
        </Link>
      ) : (
        <Link
          href="/inbox"
          className="mt-6 flex min-h-12 w-full items-center justify-center rounded-full bg-[#ffc107] text-[14px] font-bold text-[#050505] transition-colors hover:bg-[#e5a800]"
        >
          Stop the next leak →
        </Link>
      )}
      <p className="mt-3 text-center text-[11px] text-[#525252]">
        A reply is already drafted in your voice. Review, edit, send.
      </p>
    </div>
  );
}
