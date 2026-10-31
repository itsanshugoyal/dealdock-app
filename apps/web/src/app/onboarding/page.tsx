"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CURRENCY_SYMBOL, DEFAULT_LOCALE, formatMoneyExact, parseMoneyInput, type CurrencyCode } from "@dealdock/core";
import { ArrowLeft, ArrowRight, AudioLines, Camera, Check, CheckCheck, Eye, Lock, LogOut, ShieldCheck } from "lucide-react";
import { errorMessage } from "../../lib/snapshot";
import { IS_DEMO_MODE, appStore, useApp, useOnboarding } from "../../lib/use-demo";
import type { LeakScanSummary } from "../../lib/types";
import { LabelDot, Logo } from "../../components/kit";
import { usePoll } from "../../components/use-poll";
import { Button } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { MoneyField } from "../../components/ui/field";
import { MoneyCounter, MoneyValue } from "../../components/ui/money-value";
import { Avatar } from "../../components/ui/sender";

type Step = "welcome" | "region" | "connect" | "business" | "voice" | "scan" | "reveal";
const STEPS: Step[] = ["welcome", "region", "connect", "business", "voice", "scan", "reveal"];
const PROGRESS: Step[] = ["region", "connect", "business", "voice", "scan"];

export default function OnboardingPage() {
  return <Suspense fallback={null}><Onboarding /></Suspense>;
}

/** First run: region → Instagram → what you sell → voice consent → Leak Scan → the reveal. */
function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params?.get("step") as Step | null;
  const step: Step = requested && STEPS.includes(requested) ? requested : "welcome";
  const go = (next: Step) => router.push(`/onboarding?step=${next}`, { scroll: true });
  const dark = step === "scan" || step === "reveal";
  const index = PROGRESS.indexOf(step);

  return (
    <div className={cx("flex min-h-dvh flex-col", dark ? "bg-[#07080A] text-white" : "bg-canvas")}>
      {step !== "welcome" && (
        <header className="mx-auto flex w-full max-w-[560px] items-center gap-3 px-4 pt-[max(16px,env(safe-area-inset-top))]">
          {step !== "reveal" && step !== "scan" ? (
            <button type="button" onClick={() => router.back()} aria-label="Back" className="dd-press flex h-10 w-10 items-center justify-center rounded-full hover:bg-inset">
              <ArrowLeft aria-hidden size={22} />
            </button>
          ) : <Logo size={28} />}
          {index >= 0 && (
            <div className="flex flex-1 gap-1.5" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={PROGRESS.length} aria-valuenow={index + 1}>
              {PROGRESS.map((item, i) => (
                <span key={item} className={cx("h-1 flex-1 rounded-full transition-colors duration-300", i <= index ? (dark ? "bg-hero-accent" : "bg-brand") : dark ? "bg-white/15" : "bg-fill")} />
              ))}
            </div>
          )}
          {step !== "reveal" && <span className={cx("text-caption font-semibold", dark ? "text-white/50" : "text-ink-3")}>{index >= 0 ? `${index + 1} of ${PROGRESS.length}` : ""}</span>}
        </header>
      )}
      <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))]">
        {step === "welcome" && <Welcome onNext={() => go("region")} />}
        {step === "region" && <Region onNext={() => go("connect")} />}
        {step === "connect" && <Connect onNext={() => go("business")} connected={params?.get("connected") ?? null} error={params?.get("error") ?? null} />}
        {step === "business" && <Business onNext={() => go("voice")} />}
        {step === "voice" && <Voice onNext={() => go("scan")} />}
        {step === "scan" && <Scan onDone={() => go("reveal")} />}
        {step === "reveal" && <Reveal />}
      </div>
    </div>
  );
}

/* ── Welcome ───────────────────────────────────────────────────────────── */

const PREVIEW = [
  { handle: "kesarandclay", name: "Kesar & Clay", label: "brand_deal" as const, value: "₹80K–₹1.5L", text: "Our Diwali campaign needs 2 reels + 3 stories…", hot: true },
  { handle: "rhea.runs", name: "Rhea Sharma", label: "coaching_lead" as const, value: "₹24K–₹30K", text: "12-week program abhi open hai? Fees kya hai?" },
  { handle: "meera.codes", name: "Meera Iyer", label: "course_inquiry" as const, value: "₹8K", text: "Is the next cohort open? EMI option hai kya?" },
];

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-1 flex-col pt-[max(28px,env(safe-area-inset-top))]">
      <div className="flex items-center gap-2.5"><Logo size={32} /><span className="text-[19px] font-semibold tracking-[-0.02em] text-ink">DealDock</span></div>
      <h1 className="mt-10 text-[40px] font-bold leading-[44px] tracking-[-0.035em] text-ink md:text-[48px] md:leading-[52px]">Find the money hiding in your DMs.</h1>
      <p className="mt-4 text-[17px] leading-6 text-ink-2">DealDock reads your Instagram DMs, puts brand deals and paying clients on top, and drafts every reply the way you text.</p>

      <div className="relative mt-9 flex flex-col gap-2.5" aria-hidden>
        {PREVIEW.map((item, index) => (
          <div key={item.handle} className="dd-rise flex items-center gap-3 rounded-[20px] bg-surface p-3.5 shadow-raised" style={{ animationDelay: `${120 + index * 110}ms`, transform: `scale(${1 - index * 0.025})` }}>
            <Avatar handle={item.handle} name={item.name} size={44} ring={item.hot ? "urgent" : "none"} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[15px] font-semibold text-ink">{item.name}</span>
                <span className="shrink-0 text-[14px] font-semibold text-ink tabular-nums">{item.value}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-caption"><LabelDot label={item.label} />{item.hot && <span className="font-semibold text-danger">5h left</span>}</div>
              <p className="truncate text-[13px] text-ink-3">{item.text}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-10">
        <Button variant="primary" size="lg" fullWidth iconRight={ArrowRight} onClick={onNext}>Get started</Button>
        <p className="flex items-center justify-center gap-1.5 text-caption text-ink-3"><Lock aria-hidden size={13} />About 4 minutes · Nothing ever sends without you</p>
        <p className="text-center text-caption text-ink-3">Already set up? <Link href="/sign-in" className="font-semibold text-brand">Sign in</Link></p>
      </div>
    </div>
  );
}

/* ── Region ────────────────────────────────────────────────────────────── */

const CURRENCIES: Array<{ code: CurrencyCode; name: string }> = [
  { code: "INR", name: "Indian rupee" },
  { code: "USD", name: "US dollar" },
  { code: "GBP", name: "British pound" },
  { code: "EUR", name: "Euro" },
  { code: "AED", name: "UAE dirham" },
];

function Region({ onNext }: { onNext: () => void }) {
  const { money } = useApp();
  const [currency, setCurrency] = useState<CurrencyCode>(money.currency);
  const [timezone, setTimezone] = useState(() => (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Asia/Kolkata"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => {
    try { return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [timezone]; } catch { return [timezone]; }
  }, [timezone]);
  const example = currency === "INR" ? 32_000_000 : 420_000;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await appStore.bootstrapWorkspace({ currencyCode: currency, locale: DEFAULT_LOCALE[currency], timezone });
      onNext();
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't save that. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepFrame
      title="Where do you get paid?"
      body="Every estimate and every sale shows in this currency. It's fixed once your workspace is set up."
      footer={<><Button variant="primary" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void save()}>Continue</Button>{error && <p role="alert" className="text-center text-caption text-danger">{error}</p>}</>}
    >
      <div role="radiogroup" aria-label="Currency" className="grid grid-cols-1 gap-2">
        {CURRENCIES.map((item) => {
          const active = item.code === currency;
          return (
            <button
              key={item.code}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setCurrency(item.code)}
              className={cx("dd-press flex items-center gap-3 rounded-2xl bg-surface p-3.5 text-left shadow-card", active && "ring-2 ring-brand")}
            >
              <span className={cx("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[18px] font-semibold", active ? "bg-brand text-on-brand" : "bg-inset text-ink")}>{CURRENCY_SYMBOL[item.code].trim()}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink">{item.name}</span>
                <span className="block text-caption text-ink-3">A big deal looks like <span className="font-semibold text-ink-2">{formatMoneyExact(item.code === "INR" ? 32_000_000 : 420_000, { currency: item.code, locale: DEFAULT_LOCALE[item.code] })}</span></span>
              </span>
              {active && <Check aria-hidden size={20} className="shrink-0 text-brand" />}
            </button>
          );
        })}
      </div>
      <label className="mt-5 block">
        <span className="mb-1.5 block text-label font-semibold text-ink">Time zone</span>
        <select value={timezone} onChange={(event) => setTimezone(event.target.value)} className="dd-input">
          {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, " ")}</option>)}
        </select>
        <span className="mt-1.5 block text-caption text-ink-3">Reply windows, months and quiet hours follow this. Preview: <MoneyValue minor={example} mode="exact" ctx={{ currency, locale: DEFAULT_LOCALE[currency] }} className="font-semibold text-ink-2" /></span>
      </label>
    </StepFrame>
  );
}

/* ── Connect Instagram ─────────────────────────────────────────────────── */

function Connect({ onNext, connected, error }: { onNext: () => void; connected: string | null; error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(error ? friendlyConnectError(error) : null);
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { authorizeUrl } = await appStore.connectInstagram();
      window.location.assign(authorizeUrl);
    } catch (failure) {
      setProblem(errorMessage(failure, "Couldn't open Instagram. Try again."));
      setBusy(false);
    }
  };
  return (
    <StepFrame
      title={connected ? "You're connected." : "Connect your Instagram"}
      body={connected ? <>DealDock can now read DMs sent to <b className="font-semibold text-ink">@{connected}</b>.</> : "Use the Business or Creator account your DMs come to. You'll approve it on Instagram's own screen."}
      footer={connected
        ? <Button variant="primary" size="lg" fullWidth iconRight={ArrowRight} onClick={onNext}>Continue</Button>
        : <>
            <button type="button" onClick={() => void start()} disabled={busy} className="dd-press flex h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-[linear-gradient(90deg,#F58529,#DD2A7B_45%,#8134AF_75%,#515BD4)] text-button text-white shadow-raised disabled:opacity-60">
              <Camera aria-hidden size={20} />{busy ? "Opening Instagram…" : "Continue with Instagram"}
            </button>
            {problem && <p role="alert" className="text-center text-caption text-danger">{problem}</p>}
          </>}
    >
      {connected ? (
        <div className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-card">
          <Avatar handle={connected} size={48} />
          <div className="min-w-0 flex-1"><p className="text-[15px] font-semibold text-ink">@{connected}</p><p className="text-caption text-ink-3">Instagram {IS_DEMO_MODE ? "· sample account" : "· Business account"}</p></div>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-on-brand"><Check aria-hidden size={18} /></span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          <Assurance icon={<Eye aria-hidden size={18} />} title="Reads your DMs, through Meta's official API">Including message requests, where most brand briefs land.</Assurance>
          <Assurance icon={<ShieldCheck aria-hidden size={18} />} title="Never posts, never sends on its own">Every reply waits for you to approve it.</Assurance>
          <Assurance icon={<LogOut aria-hidden size={18} />} title="Disconnect any time">Reading stops immediately.</Assurance>
        </ul>
      )}
      {!connected && (
        <details className="mt-4 rounded-2xl bg-surface p-4 shadow-card">
          <summary className="cursor-pointer text-[14px] font-semibold text-ink">On a personal account?</summary>
          <p className="mt-2 text-[14px] text-ink-2">Switching is free and takes about two minutes: Instagram → Settings → Account type and tools → Switch to professional account. Choose Creator or Business, then come back here.</p>
        </details>
      )}
    </StepFrame>
  );
}

function friendlyConnectError(code: string): string {
  if (/personal/i.test(code)) return "That's a personal account. Switch it to Creator or Business, then try again.";
  if (/denied|cancel/i.test(code)) return "Instagram didn't give access. Try again when you're ready.";
  return "Instagram didn't finish connecting. Try again.";
}

function Assurance({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 rounded-2xl bg-surface p-4 shadow-card">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-recovered">{icon}</span>
      <span><span className="block text-[15px] font-semibold text-ink">{title}</span><span className="block text-[14px] text-ink-2">{children}</span></span>
    </li>
  );
}

/* ── What you sell ─────────────────────────────────────────────────────── */

const SELLS = ["Brand collaborations", "1:1 coaching", "Group programs", "Courses or cohorts", "Workshops and talks", "Consulting", "Products"];

function Business({ onNext }: { onNext: () => void }) {
  const { money, timezone } = useApp();
  const onboarding = useOnboarding();
  const [sells, setSells] = useState<string[]>(["Brand collaborations", "1:1 coaching"]);
  const [summary, setSummary] = useState("");
  const [prices, setPrices] = useState({ brandMin: "", brandMax: "", coaching: "", course: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minor = (value: string) => { const parsed = parseMoneyInput(value); return parsed && parsed > 0 ? parsed : null; };
  const range = (min: string, max?: string) => {
    const low = minor(min);
    const high = max !== undefined ? minor(max) : low;
    return low && high ? { min: Math.min(low, high), max: Math.max(low, high) } : null;
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await appStore.saveOnboarding({
        businessContext: {
          businessSummary: summary.trim() || `Creator selling ${sells.join(", ").toLowerCase()}.`,
          sells,
          typicalBrandDealMinor: range(prices.brandMin, prices.brandMax || prices.brandMin),
          typicalCoachingMinor: range(prices.coaching),
          typicalCourseMinor: range(prices.course),
        },
        currencyCode: money.currency,
        locale: money.locale ?? DEFAULT_LOCALE[money.currency],
        timezone,
        igAccountId: onboarding.data?.igAccounts[0]?.id,
      });
      onNext();
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't save that. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepFrame
      title="What do you sell?"
      body="This is how DealDock tells a ₹2L brand deal from a fan saying hi, and what it can quote in your drafts."
      footer={<><Button variant="primary" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void save()}>Continue</Button>{error && <p role="alert" className="text-center text-caption text-danger">{error}</p>}</>}
    >
      <div className="flex flex-wrap gap-2" role="group" aria-label="What you sell">
        {SELLS.map((item) => {
          const active = sells.includes(item);
          return (
            <button key={item} type="button" aria-pressed={active} onClick={() => setSells((current) => (active ? current.filter((value) => value !== item) : [...current, item]))} className={cx("dd-press inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold", active ? "bg-primary text-on-primary" : "bg-surface text-ink-2 shadow-card")}>
              {active && <Check aria-hidden size={16} />}{item}
            </button>
          );
        })}
      </div>
      <h2 className="mt-7 text-heading text-ink">Your usual prices</h2>
      <p className="text-[14px] text-ink-2">Rough is fine. Drafts never quote a price you didn&apos;t give.</p>
      <div className="mt-3 overflow-hidden rounded-2xl bg-surface shadow-card">
        <PriceRow label="Brand deal" hint="per campaign">
          <MoneyField size="inline" label="Brand deal from" value={prices.brandMin} onChange={(value) => setPrices({ ...prices, brandMin: value })} placeholder="50000" />
          <span className="text-ink-3">to</span>
          <MoneyField size="inline" label="Brand deal up to" value={prices.brandMax} onChange={(value) => setPrices({ ...prices, brandMax: value })} placeholder="150000" />
        </PriceRow>
        <PriceRow label="Coaching" hint="per package">
          <MoneyField size="inline" label="Coaching package" value={prices.coaching} onChange={(value) => setPrices({ ...prices, coaching: value })} placeholder="25000" />
        </PriceRow>
        <PriceRow label="Course" hint="per seat">
          <MoneyField size="inline" label="Course price" value={prices.course} onChange={(value) => setPrices({ ...prices, course: value })} placeholder="7999" />
        </PriceRow>
      </div>
      <label className="mt-5 block">
        <span className="mb-1.5 block text-label font-semibold text-ink">In one line, what do you do?</span>
        <input value={summary} onChange={(event) => setSummary(event.target.value)} className="dd-input" placeholder="Fitness coach with a 12-week program and a strength course" />
      </label>
    </StepFrame>
  );
}

function PriceRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-4 py-3 last:border-b-0">
      <span className="min-w-[96px] flex-1"><span className="block text-[15px] font-semibold text-ink">{label}</span><span className="block text-caption text-ink-3">{hint}</span></span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/* ── Voice consent ─────────────────────────────────────────────────────── */

function Voice({ onNext }: { onNext: () => void }) {
  const onboarding = useOnboarding();
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const account = onboarding.data?.igAccounts[0]?.id;
  const decide = async (consented: boolean) => {
    setBusy(consented ? "yes" : "no");
    try {
      if (account) await appStore.setVoiceConsent(account, consented);
    } finally {
      setBusy(null);
      onNext();
    }
  };
  return (
    <StepFrame
      title="Drafts that sound like you"
      body="With your OK, DealDock studies the replies you've already sent, so every draft opens, signs off and mixes Hinglish the way you do. It keeps learning from your edits."
      footer={<>
        <Button variant="money" size="lg" fullWidth loading={busy === "yes"} loadingLabel="Saving…" onClick={() => void decide(true)}>Learn my style</Button>
        <Button variant="ghost" size="lg" fullWidth loading={busy === "no"} onClick={() => void decide(false)}>Not now</Button>
      </>}
    >
      <div className="flex flex-col gap-3 rounded-[22px] bg-surface p-4 shadow-card">
        <p className="text-micro uppercase text-ink-3">A brand asks your rate</p>
        <div className="dd-bubble-in self-start bg-inset px-4 py-2.5 text-[15px] text-ink shadow-none">Hi! Loved your reels. What&apos;s your rate for 2 reels?</div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[11px] font-semibold text-ink-3">Generic AI</span>
          <div className="max-w-[88%] rounded-[20px] rounded-br-md bg-inset px-4 py-2.5 text-[15px] text-ink-3 line-through decoration-ink-3/40">Thank you so much for reaching out! I would be delighted to collaborate. Please find my rate card attached.</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-recovered"><AudioLines aria-hidden size={12} />Your voice</span>
          <div className="dd-bubble-out max-w-[88%] px-4 py-2.5 text-[15px]">Heyy! Love this 🙏 2 reels is ₹60K, usage 3 months. Send the brief? – D</div>
        </div>
      </div>
      <ul className="mt-4 flex flex-col gap-1.5 text-[14px] text-ink-2">
        <li className="flex gap-2"><Check aria-hidden size={16} className="mt-0.5 shrink-0 text-brand" />Only your sent DMs are studied; your contacts never see this.</li>
        <li className="flex gap-2"><Check aria-hidden size={16} className="mt-0.5 shrink-0 text-brand" />See and switch off anything it learns, in Your voice.</li>
        <li className="flex gap-2"><Check aria-hidden size={16} className="mt-0.5 shrink-0 text-brand" />Withdraw any time: learned style and unsent drafts are deleted.</li>
      </ul>
    </StepFrame>
  );
}

/* ── Leak Scan ─────────────────────────────────────────────────────────── */

let lastScan: LeakScanSummary | null = null;

/** Leak Scan polling: 1 s, then 2 s, then every 5 s; paused while the page is hidden; it stops after 5 minutes. */
const SCAN_POLL = { delays: [1_000, 2_000, 5_000], maxMs: 5 * 60_000 } as const;

function Scan({ onDone }: { onDone: () => void }) {
  const [summary, setSummary] = useState<LeakScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const starting = useRef(false);
  const finish = useRef(onDone);
  finish.current = onDone;
  useEffect(() => {
    // Start once, even when development re-runs effects.
    if (starting.current) return;
    starting.current = true;
    void appStore.startLeakScan().then(() => setStarted(true), (failure: unknown) => setError(errorMessage(failure, "Couldn't start the scan.")));
  }, []);
  const expired = usePoll(async () => {
    try {
      const next = await appStore.getLeakScan();
      setSummary(next);
      lastScan = next;
      return next.status === "done";
    } catch (failure) {
      setError(errorMessage(failure, "The scan stopped. Try again."));
      return true;
    }
  }, { ...SCAN_POLL, enabled: started && !error, immediate: true });
  const done = summary?.status === "done";
  useEffect(() => {
    if (!done) return;
    // A beat on the final numbers before the reveal.
    const timer = setTimeout(() => finish.current(), 1100);
    return () => clearTimeout(timer);
  }, [done]);

  const scanned = summary?.scannedCount ?? 0;
  const commerce = summary?.commerceCount ?? 0;
  const total = Math.max(scanned, 180);
  const dots = Math.min(240, total);
  return (
    <div className="flex flex-1 flex-col pt-10">
      <p className="text-label font-semibold text-hero-accent">Leak Scan</p>
      <h1 className="mt-1 text-[32px] font-bold leading-9 tracking-[-0.03em]">Reading your last 30 days…</h1>
      <p className="mt-2 text-[15px] text-white/60">Every conversation, message requests included. Nothing is sent.</p>

      <div aria-hidden className="mt-8 grid grid-cols-[repeat(16,minmax(0,1fr))] gap-[5px] rounded-[22px] bg-white/[0.04] p-4 ring-1 ring-white/10">
        {Array.from({ length: dots }, (_, i) => {
          const read = i < (scanned / total) * dots;
          const business = read && i % Math.max(2, Math.round(dots / Math.max(1, commerce))) === 0;
          return <span key={i} className="aspect-square rounded-full transition-all duration-500" style={{ background: business ? "var(--dd-hero-accent)" : read ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.08)", transform: business ? "scale(1.15)" : "scale(1)", boxShadow: business ? "0 0 10px rgba(47,213,142,0.65)" : "none" }} />;
        })}
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-3" aria-live="polite">
        <ScanStat label="Conversations read" value={scanned.toLocaleString()} />
        <ScanStat label="Look like business" value={commerce.toLocaleString()} accent />
      </dl>
      {error && <p role="alert" className="mt-6 rounded-2xl bg-hero-alert-tint px-4 py-3 text-[14px] text-hero-alert">{error}</p>}
      {expired && !error && (
        <div role="status" className="mt-6 flex flex-col gap-3 rounded-2xl bg-white/[0.05] p-4 ring-1 ring-white/10">
          <p className="text-[14px] text-white/70">This is taking longer than usual. The scan keeps going in the background, so you can look at what it found so far.</p>
          <button type="button" onClick={() => onDone()} className="dd-press inline-flex h-11 items-center justify-center gap-2 self-start rounded-full bg-white/10 px-5 text-button text-white hover:bg-white/15">
            See what it found <ArrowRight aria-hidden size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

function ScanStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-white/[0.05] p-4 ring-1 ring-white/10">
      <dt className="text-caption text-white/55">{label}</dt>
      <dd className={cx("mt-1 text-[30px] font-semibold leading-9 tracking-[-0.03em] tabular-nums", accent ? "text-hero-accent" : "text-white")}>{value}</dd>
    </div>
  );
}

function Reveal() {
  const router = useRouter();
  const [summary, setSummary] = useState<LeakScanSummary | null>(lastScan);
  // Arriving mid-scan (a reload, a shared link, or the scan step gave up waiting): keep polling gently until it is done.
  const [unfinished] = useState(() => lastScan?.status !== "done");
  usePoll(async () => {
    try {
      const next = await appStore.getLeakScan();
      setSummary(next);
      return next.status !== "running";
    } catch {
      return true; // the reveal still offers "Go to Today"
    }
  }, { ...SCAN_POLL, enabled: unfinished, immediate: true });
  const top = summary?.topThreads ?? [];
  const biggest = top[0] ?? null;
  return (
    <div className="flex flex-1 flex-col pt-10">
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 -z-0 h-[60dvh] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(47,213,142,0.22),transparent)]" />
      <div className="relative">
        <p className="text-label font-semibold text-white/60">Last 30 days, at least</p>
        <h1 className="mt-2 text-[17px] font-medium text-white/80">
          {summary ? (
            <MoneyCounter countId="leak-reveal" minor={summary.totalMinMinor} mode="exact" size="hero" className="block text-[56px] font-bold leading-[60px] tracking-[-0.045em] text-white [&_.dd-symbol-hero]:text-white/70" />
          ) : <span className="block h-[60px]" />}
          <span className="mt-2 block text-[22px] font-semibold leading-7 tracking-[-0.02em] text-white">went unanswered in your DMs.</span>
        </h1>
        <p className="mt-3 text-[15px] leading-6 text-white/60">
          Across {summary?.commerceCount ?? "—"} business conversations. We counted only clear asks (brand deals, coaching, courses) and added the low end of each estimate.
        </p>
      </div>

      {top.length > 0 && (
        <div className="relative mt-7">
          <h2 className="mb-2 text-micro uppercase text-white/45">The biggest ones you missed</h2>
          <ul className="overflow-hidden rounded-[22px] bg-white/[0.05] ring-1 ring-white/10">
            {top.slice(0, 3).map((thread, index) => (
              <li key={thread.threadId} className={cx("flex items-center gap-3 px-4 py-3.5", index > 0 && "border-t border-white/10")}>
                <Avatar handle={thread.handle} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-white">@{thread.handle}</span>
                  {thread.label && <span className="text-caption text-white/55"><LabelDot label={thread.label} className="text-white/60" /></span>}
                </span>
                {thread.estValueMaxMinor !== null && <MoneyValue minor={thread.estValueMaxMinor} className="shrink-0 text-[15px] font-semibold text-white" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="relative mt-auto flex flex-col gap-3 pt-10">
        {biggest ? (
          <button type="button" onClick={() => router.push(`/thread/${biggest.threadId}`)} className="dd-press flex h-[56px] w-full items-center justify-center gap-2 rounded-full bg-hero-accent text-button text-on-hero-accent shadow-[0_16px_40px_-12px_rgba(47,213,142,0.8)]">
            Recover the biggest one <ArrowRight aria-hidden size={20} strokeWidth={2.2} />
          </button>
        ) : null}
        <Link href="/" className="dd-press flex h-12 w-full items-center justify-center rounded-full text-button text-white/80 hover:bg-white/10">Go to Today</Link>
        <p className="flex items-center justify-center gap-1.5 text-caption text-white/45"><CheckCheck aria-hidden size={14} />Your draft will be ready. Nothing sends without you.</p>
      </div>
    </div>
  );
}

/* ── Frame ─────────────────────────────────────────────────────────────── */

function StepFrame({ title, body, footer, children }: { title: React.ReactNode; body: React.ReactNode; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col pt-8">
      <h1 className="text-[30px] font-bold leading-9 tracking-[-0.03em] text-ink">{title}</h1>
      <p className="mt-2 text-[16px] leading-6 text-ink-2">{body}</p>
      <div className="mt-6">{children}</div>
      <div className="mt-auto flex flex-col gap-2 pt-8">{footer}</div>
    </div>
  );
}
