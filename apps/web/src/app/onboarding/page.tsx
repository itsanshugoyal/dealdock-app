"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CURRENCY_SYMBOL, DEFAULT_LOCALE, formatMoneyExact, parseMoneyInput, type CurrencyCode } from "@dealdock/core";
import { ArrowLeft, ArrowRight, AudioLines, Camera, Check, CheckCheck, ChevronDown, Eye, Info, Lock, LogOut, Mail, ShieldCheck } from "lucide-react";
import { atHandle } from "../../lib/format";
import { EMAIL_ERRORS, PILOT_CONTACT, connectChecklist, friendlyConnectError, nextStep, progressSteps, stepFromQuery, type Step } from "../../lib/onboarding-flow";
import { errorMessage } from "../../lib/snapshot";
import { IS_DEMO_MODE, appStore, useApp, useEmailAccounts, useFeature, useOnboarding } from "../../lib/use-demo";
import type { LeakScanSummary } from "../../lib/types";
import { LabelDot, Logo } from "../../components/kit";
import { usePoll } from "../../components/use-poll";
import { Button, buttonClasses } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { MoneyField } from "../../components/ui/field";
import { MoneyCounter, MoneyValue } from "../../components/ui/money-value";
import { Avatar } from "../../components/ui/sender";

export default function OnboardingPage() {
  return <Suspense fallback={null}><Onboarding /></Suspense>;
}

/**
 * First run: region → Instagram → Gmail (when this deployment has it) → what
 * you sell → voice consent → Leak Scan → the reveal. "Connect later" skips
 * everything that needs Instagram and ends on "You're set up" (`later=1`
 * stays in the address so the path survives reloads).
 */
function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const connected = params?.get("connected") ?? null;
  const igError = params?.get("error") ?? null;
  const step = stepFromQuery(params?.get("step"), Boolean(connected || igError));
  const later = params?.get("later") === "1";
  const openAccess = useFeature("instagramOpenAccess");
  // GET /email/accounts needs a workspace, which the Region step creates.
  const inboxes = useEmailAccounts(step !== "welcome" && step !== "region");
  const gmail = inboxes.data?.available !== false;
  const context = { instagram: !later, gmail };
  const go = (next: Step) => router.push(`/onboarding?step=${next}${later ? "&later=1" : ""}`, { scroll: true });
  const advance = () => go(nextStep(step, context));
  const progress = progressSteps(context);
  const index = progress.findIndex((item) => item.step === step);
  const dark = step === "scan" || step === "reveal";
  const end = step === "reveal" || step === "done";
  // No Gmail on this deployment (or Google said so just now): the step quietly moves on.
  useEffect(() => {
    if (step === "email" && !gmail) router.replace(`/onboarding?step=${nextStep("email", context)}`);
  }, [step, gmail]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cx("flex flex-1 flex-col", dark ? "bg-[#07080A] text-white" : "bg-canvas")}>
      {step !== "welcome" && (
        <header className="mx-auto w-full max-w-[560px] px-5 pt-[max(20px,env(safe-area-inset-top))]">
          <div className="flex items-center gap-3">
          {!end && step !== "scan" ? (
            <button type="button" onClick={() => router.back()} aria-label="Back" className="dd-press flex h-11 w-11 items-center justify-center rounded-full hover:bg-inset focus-visible:outline-2 focus-visible:outline-info">
              <ArrowLeft aria-hidden size={22} />
            </button>
          ) : <Logo size={28} />}
          {index >= 0 && (
            <div className="flex flex-1 gap-1.5" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={progress.length} aria-valuenow={index + 1}>
              {progress.map((item, i) => (
                <span key={item.step} className={cx("h-1 flex-1 rounded-full transition-colors duration-300", i <= index ? (dark ? "bg-hero-accent" : "bg-brand") : dark ? "bg-white/15" : "bg-fill")} />
              ))}
            </div>
          )}
          {!end && <span className={cx("text-caption font-semibold", dark ? "text-white/50" : "text-ink-3")}>{index >= 0 ? `${index + 1} of ${progress.length}` : ""}</span>}
          </div>
          {index >= 0 && <div className={cx("mt-3 flex justify-between gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] sm:text-[11px]", dark ? "text-white/40" : "text-ink-3")} aria-hidden>{progress.map((item, i) => <span key={item.step} className={cx(i === index && (dark ? "text-white" : "text-ink"))}>{item.label}</span>)}</div>}
        </header>
      )}
      {/* Phones pin each step's action to the bottom edge; wider screens centre the step as one group. */}
      <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] md:justify-center md:pb-12">
        {step === "welcome" && <Welcome onNext={() => go("region")} />}
        {step === "region" && <Region onNext={() => go("connect")} />}
        {step === "connect" && (
          <Connect
            onNext={advance}
            onLater={() => router.push(`/onboarding?step=${nextStep("connect", { ...context, instagram: false })}&later=1`, { scroll: true })}
            connected={connected}
            error={igError}
            openAccess={openAccess}
          />
        )}
        {step === "email" && gmail && <Email onNext={advance} connected={params?.get("email") === "connected"} error={params?.get("email_error") ?? null} />}
        {step === "business" && <Business onNext={advance} />}
        {step === "voice" && <Voice onNext={advance} />}
        {step === "scan" && <Scan onDone={advance} />}
        {step === "reveal" && <Reveal />}
        {step === "done" && <Done openAccess={openAccess} gmail={gmail} />}
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
    <div className="flex flex-1 flex-col pt-[max(28px,env(safe-area-inset-top))] md:flex-none">
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
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [zones, setZones] = useState<string[]>(["Asia/Kolkata"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Detected after mount: the server's and the browser's time-zone data differ, so rendering either on the server breaks hydration.
  useEffect(() => {
    let detected = "Asia/Kolkata";
    let all: string[] = [];
    try { detected = Intl.DateTimeFormat().resolvedOptions().timeZone || detected; } catch { /* keep the default */ }
    try { all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { /* list just the detected zone */ }
    // Chromium still reports the legacy alias for India.
    const zone = detected === "Asia/Calcutta" && all.includes("Asia/Kolkata") ? "Asia/Kolkata" : detected;
    setTimezone(zone);
    setZones(all.includes(zone) ? all : [zone, ...all]);
  }, []);
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
              className={cx("dd-press flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-3.5 text-left", active && "border-brand ring-1 ring-brand")}
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

function Connect({ onNext, onLater, connected, error, openAccess }: { onNext: () => void; onLater: () => void; connected: string | null; error: string | null; openAccess: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(error ? friendlyConnectError(error) : null);
  const checklist = connectChecklist(openAccess);
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { authorizeUrl } = await appStore.connectInstagram();
      window.location.assign(authorizeUrl);
    } catch (failure) {
      const code = (failure as { code?: unknown }).code;
      setProblem(code === "meta_app_not_configured" ? friendlyConnectError(code) : errorMessage(failure, "Couldn't open Instagram. Try again."));
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
            <Button variant="ghost" size="lg" fullWidth onClick={onLater}>I&apos;ll connect Instagram later</Button>
          </>}
    >
      {connected ? (
        <div className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-card">
          <Avatar handle={connected} size={48} />
          <div className="min-w-0 flex-1"><p className="text-[15px] font-semibold text-ink">@{connected}</p><p className="text-caption text-ink-3">Instagram {IS_DEMO_MODE ? "· sample account" : "· Business account"}</p></div>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-on-brand"><Check aria-hidden size={18} /></span>
        </div>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl bg-surface shadow-card">
          <Assurance icon={<Eye aria-hidden size={18} />} title="Reads your DMs, through Meta's official API">Available messages and requests supplied by Instagram.</Assurance>
          <Assurance icon={<ShieldCheck aria-hidden size={18} />} title="Never posts, never sends on its own">Every reply waits for you to approve it.</Assurance>
          <Assurance icon={<LogOut aria-hidden size={18} />} title="Disconnect any time">You control the connection in Settings.</Assurance>
        </ul>
      )}
      {!connected && checklist.length > 0 && (
        <>
          <h2 className="mt-7 text-heading text-ink">Before you connect</h2>
          <p className="text-[14px] text-ink-2">DealDock is in a private pilot, so Instagram only lets in accounts we&apos;ve added.</p>
          <ol className="mt-3 divide-y divide-hairline overflow-hidden rounded-2xl bg-surface shadow-card">
            {checklist.map((item, i) => {
              const [before, after] = item.body.split(PILOT_CONTACT);
              return (
                <Assurance key={item.title} icon={<span className="text-[15px] font-semibold tabular-nums">{i + 1}</span>} title={item.title}>
                  {after === undefined ? item.body : <>{before}<b className="font-semibold text-ink">{PILOT_CONTACT}</b>{after}</>}
                </Assurance>
              );
            })}
          </ol>
        </>
      )}
      {!connected && checklist.length === 0 && (
        <details className="group mt-4 rounded-[20px] bg-surface px-4 shadow-card">
          <summary className="dd-summary flex min-h-12 items-center justify-between gap-3 rounded text-[14px] font-semibold text-ink focus-visible:outline-2 focus-visible:outline-info">On a personal account?<ChevronDown aria-hidden size={16} className="shrink-0 text-ink-3 transition-transform group-open:rotate-180" /></summary>
          <p className="pb-4 text-[14px] text-ink-2">Switching is free and takes about two minutes: Instagram → Settings → Account type and tools → Switch to professional account. Choose Creator or Business, then come back here.</p>
        </details>
      )}
    </StepFrame>
  );
}

function Assurance({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-recovered">{icon}</span>
      <span><span className="block text-[15px] font-semibold text-ink">{title}</span><span className="block text-[14px] text-ink-2">{children}</span></span>
    </li>
  );
}

/* ── Gmail (optional) ──────────────────────────────────────────────────── */

function Email({ onNext, connected, error }: { onNext: () => void; connected: boolean; error: string | null }) {
  const onboarding = useOnboarding();
  const inboxes = useEmailAccounts();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(error ? EMAIL_ERRORS[error] ?? "Gmail couldn't be connected. Try again." : null);
  const address = inboxes.data?.accounts.find((inbox) => inbox.status === "active")?.address;
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      // The inbox belongs to the Instagram account just connected; Google comes back here, not to Settings.
      const { authorizeUrl } = await appStore.connectEmail(onboarding.data?.igAccounts[0]?.id, "onboarding");
      window.location.assign(authorizeUrl);
    } catch (failure) {
      setProblem(errorMessage(failure, "Couldn't open Google. Try again."));
      setBusy(false);
    }
  };
  return (
    <StepFrame
      title={connected ? "Gmail connected." : "Brand emails too?"}
      body={connected ? "Brand emails show up in your inbox in a few minutes, next to your DMs." : "Connect Gmail and brand emails land in the same inbox as your DMs. Replies still wait for you to approve them."}
      footer={connected
        ? <Button variant="primary" size="lg" fullWidth iconRight={ArrowRight} onClick={onNext}>Continue</Button>
        : <>
            <Button variant="primary" size="lg" fullWidth icon={Mail} loading={busy} loadingLabel="Opening Google…" onClick={() => void start()}>Connect Gmail</Button>
            {problem && <p role="alert" className="text-center text-caption text-danger">{problem}</p>}
            <Button variant="ghost" size="lg" fullWidth disabled={busy} onClick={onNext}>Skip for now</Button>
          </>}
    >
      {connected ? (
        <div className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-card">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-info-tint text-info"><Mail aria-hidden size={22} /></span>
          <div className="min-w-0 flex-1"><p className="truncate text-[15px] font-semibold text-ink"><bdi>{address ?? "Gmail"}</bdi></p><p className="text-caption text-ink-3">Gmail · Connected</p></div>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-on-brand"><Check aria-hidden size={18} /></span>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-hairline overflow-hidden rounded-2xl bg-surface shadow-card">
            <Assurance icon={<Mail aria-hidden size={18} />} title="One inbox for DMs and email">DealDock reads your primary inbox and puts brand deals on top.</Assurance>
            <Assurance icon={<ShieldCheck aria-hidden size={18} />} title="Nothing sends without you">Every email reply waits for you to approve it.</Assurance>
          </ul>
          <div className="mt-4 flex gap-3 rounded-[20px] bg-surface p-4 shadow-card">
            <Info aria-hidden size={18} className="mt-0.5 shrink-0 text-ink-3" />
            <p className="text-[14px] text-ink-2"><span className="block font-semibold text-ink">Google may say &ldquo;Google hasn&apos;t verified this app&rdquo;</span>Google is still reviewing DealDock. Tap Advanced, then Continue to DealDock.</p>
          </div>
        </>
      )}
    </StepFrame>
  );
}

/* ── You're set up (without Instagram) ─────────────────────────────────── */

function Done({ openAccess, gmail }: { openAccess: boolean; gmail: boolean }) {
  return (
    <StepFrame
      title="You're set up."
      body="Your workspace is ready. Here's what's left, whenever you are."
      footer={<>
        <Link href="/" className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}>Go to Today<ArrowRight aria-hidden size={20} className="shrink-0" /></Link>
        <Link href="/settings#instagram" className={buttonClasses({ variant: "ghost", size: "lg", fullWidth: true })}>Open Settings</Link>
        <p className="flex items-center justify-center gap-1.5 text-caption text-ink-3"><Lock aria-hidden size={13} />Nothing ever sends without you</p>
      </>}
    >
      <ul className="divide-y divide-hairline overflow-hidden rounded-2xl bg-surface shadow-card">
        <Assurance icon={<Camera aria-hidden size={18} />} title="Connect Instagram">
          {openAccess ? "Connect your Creator or Business account from Settings → Instagram." : "Once you've accepted your tester invite, connect it from Settings → Instagram."}
        </Assurance>
        {gmail && <Assurance icon={<Mail aria-hidden size={18} />} title="Connect Gmail">After Instagram, add Gmail in Settings so brand emails land in the same inbox.</Assurance>}
      </ul>
      {!openAccess && <p className="mt-4 text-[14px] text-ink-2">Not a tester yet? Message your Instagram username to <b className="font-semibold text-ink">{PILOT_CONTACT}</b> and we&apos;ll add you within a day.</p>}
    </StepFrame>
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
            <button key={item} type="button" aria-pressed={active} onClick={() => setSells((current) => (active ? current.filter((value) => value !== item) : [...current, item]))} className={cx("dd-press inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold", active ? "bg-primary text-on-primary" : "bg-surface text-ink-2 shadow-card")}>
              {active && <Check aria-hidden size={16} />}{item}
            </button>
          );
        })}
      </div>
      <h2 className="mt-7 text-heading text-ink">Your usual prices</h2>
      <p className="text-[14px] text-ink-2">Use your usual range, or skip prices for now and add exact offers later.</p>
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
      <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/* ── Voice consent ─────────────────────────────────────────────────────── */

function Voice({ onNext }: { onNext: () => void }) {
  const onboarding = useOnboarding();
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = onboarding.data?.igAccounts[0]?.id;
  const decide = async (consented: boolean) => {
    if (!account || busy) return;
    setBusy(consented ? "yes" : "no");
    setError(null);
    try {
      await appStore.setVoiceConsent(account, consented);
      onNext();
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't save your permission. Try again before continuing."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <StepFrame
      title="Drafts that sound like you"
      body="With your permission, DealDock uses selected sent replies to build your writing style. You can inspect its examples and rules, and it learns from the edits you approve."
      footer={<>
        {!account && <p role="status" className="text-caption text-ink-2">{onboarding.status === "error" ? "Your account couldn't load. Refresh before choosing your permissions." : "Loading your connected Instagram account…"}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" fullWidth disabled={!account || busy !== null} loading={busy === "no"} onClick={() => void decide(false)}>Not now</Button>
          <Button variant="money" fullWidth disabled={!account || busy !== null} loading={busy === "yes"} loadingLabel="Saving…" onClick={() => void decide(true)}>Learn my style</Button>
        </div>
        {error && <p role="alert" className="text-caption text-danger">{error}</p>}
        <p className="text-caption text-ink-3">You can use sorting and revenue tracking without style learning. Drafts stay off until you give permission.</p>
      </>}
    >
      <div className="flex flex-col gap-3 rounded-[22px] bg-surface p-4 shadow-card">
        <p className="text-micro uppercase text-ink-3">A brand asks your rate</p>
        <div className="dd-bubble-in self-start bg-inset px-4 py-2.5 text-[15px] text-ink shadow-none">Hi! Loved your reels. What&apos;s your rate for 2 reels?</div>
        <div className="flex flex-col items-end gap-1">
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-recovered"><AudioLines aria-hidden size={12} />Example draft · yours to review</span>
          <div className="dd-bubble-out max-w-[88%] px-4 py-2.5 text-[15px]">Heyy! Love this 🙏 Send the brief + timeline? – D</div>
        </div>
      </div>
      <ul className="mt-4 flex flex-col gap-2 text-[14px] leading-5 text-ink-2">
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
      <h1 className="mt-1 text-[32px] font-bold leading-9 tracking-[-0.03em]">Scanning available recent DMs…</h1>
      <p className="mt-2 text-[15px] text-white/60">We request up to 30 days, including available message requests. Instagram may limit history. Nothing is sent.</p>

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
    <div className="flex flex-1 flex-col pt-10 md:flex-none">
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 -z-0 h-px" />
      <div className="relative">
        <p className="text-label font-semibold text-white/60">Potential value · lower estimate</p>
        <h1 className="mt-2 text-[17px] font-medium text-white/80">
          {summary ? (
            <MoneyCounter countId="leak-reveal" minor={summary.totalMinMinor} mode="exact" size="hero" className="block text-[56px] font-bold leading-[60px] tracking-[-0.045em] text-white [&_.dd-symbol-hero]:text-white/70" />
          ) : <span className="block h-[60px]" />}
          <span className="mt-2 block text-[22px] font-semibold leading-7 tracking-[-0.02em] text-white">in unanswered DMs.</span>
        </h1>
        <p className="mt-3 text-[15px] leading-6 text-white/60">
          Across {summary?.commerceCount ?? "—"} business conversations, adding the low end of each estimate. This is potential value, not confirmed revenue.
        </p>
      </div>

      {top.length > 0 && (
        <div className="relative mt-7">
          <h2 className="mb-2 text-micro uppercase text-white/45">Conversations worth a look</h2>
          <ul className="overflow-hidden rounded-[22px] bg-white/[0.05] ring-1 ring-white/10">
            {top.slice(0, 3).map((thread, index) => (
              <li key={thread.threadId} className={cx("flex items-center gap-3 px-4 py-3.5", index > 0 && "border-t border-white/10")}>
                <Avatar handle={thread.handle} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-white">{atHandle(thread.handle)}</span>
                  {thread.label && <span className="text-caption text-white/55"><LabelDot label={thread.label} className="text-white/60" /></span>}
                </span>
                {thread.estValueMaxMinor !== null && <span className="shrink-0 text-right"><span className="block text-caption text-white/55">Upper estimate</span><MoneyValue minor={thread.estValueMaxMinor} className="text-[15px] font-semibold text-white" /></span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="relative mt-auto flex flex-col gap-3 pt-10">
        {biggest ? (
          <button type="button" onClick={() => router.push(`/thread/${biggest.threadId}`)} className="dd-press flex h-[56px] w-full items-center justify-center gap-2 rounded-full bg-hero-accent text-button text-on-hero-accent shadow-[0_16px_40px_-12px_rgba(47,213,142,0.8)]">
            Review the biggest <ArrowRight aria-hidden size={20} strokeWidth={2.2} />
          </button>
        ) : null}
        <Link href="/" className="dd-press flex h-12 w-full items-center justify-center rounded-full text-button text-white/80 hover:bg-white/10">Go to Today</Link>
        <p className="flex items-center justify-center gap-1.5 text-caption text-white/45"><CheckCheck aria-hidden size={14} />Review each conversation before replying. Nothing sends without you.</p>
      </div>
    </div>
  );
}

/* ── Frame ─────────────────────────────────────────────────────────────── */

function StepFrame({ title, body, footer, children }: { title: React.ReactNode; body: React.ReactNode; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col pt-10 md:flex-none">
      <h1 className="text-[30px] font-bold leading-9 tracking-[-0.03em] text-ink">{title}</h1>
      <p className="mt-2 text-[16px] leading-6 text-ink-2">{body}</p>
      <div className="mt-6">{children}</div>
      <div className="mt-auto flex flex-col gap-2 pt-8">{footer}</div>
    </div>
  );
}
