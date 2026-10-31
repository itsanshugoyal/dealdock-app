"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { VOICE_CLIP_LIMITS, type ClassificationLabel, type DraftChip, type MeasuredStyle, type StyleCard, type VoicePreviewResponse, type VoiceRuleDto, type VoiceRuleScope, type VoiceSampleDto, type VoiceStudio } from "@dealdock/core";
import { AudioLines, Check, ChevronDown, Ellipsis, Mic, MessageSquareQuote, Pause, Pencil, Pin, PinOff, Plus, RefreshCw, Trash2, VolumeX, X } from "lucide-react";
import { agoText, chipText, formatDate, labelText, pluralize, scopeText } from "../../lib/format";
import { useMinuteClock } from "../../lib/keyboard";
import { errorMessage } from "../../lib/snapshot";
import { appStore, useApp, useCan, useVoice } from "../../lib/use-demo";
import { Group, HeroCard, LargeTitle, ListenButton, Tag, VoiceProvenance } from "../../components/kit";
import { usePoll } from "../../components/use-poll";
import { VoiceRecorderSheet } from "../../components/voice-recorder";
import { Button } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { ErrorState, Skeleton } from "../../components/ui/feedback";
import { Select, Switch, TextArea, TextField } from "../../components/ui/field";
import { Menu, type MenuItem } from "../../components/ui/menu";
import { Chip, Segmented } from "../../components/ui/selection";
import { ConfirmDialog, Sheet } from "../../components/ui/sheet";
import { toast, toastAction } from "../../components/ui/toast";
import { Avatar } from "../../components/ui/sender";

const SCOPES: VoiceRuleScope[] = ["all", "brand_deal", "coaching_lead", "course_inquiry", "other_commerce", "nudge"];

function ruleSource(rule: VoiceRuleDto): string {
  if (rule.source === "user") return "Added by you";
  if (rule.source === "feedback") return "From your feedback on drafts";
  if (rule.source === "samples") return `In ${rule.evidence} of your replies`;
  return `You made this edit ${rule.evidence} ${pluralize(rule.evidence, "time")}`;
}

export default function VoicePage() {
  return <Suspense fallback={null}><Voice /></Suspense>;
}

/** Your voice: what DealDock learned about how you write and speak, and every control over it. */
function Voice() {
  const router = useRouter();
  const params = useSearchParams();
  const account = params?.get("account") ?? undefined;
  const voice = useVoice(account);
  const studio = voice.data;

  if (voice.status === "error" && !studio) {
    return <ErrorState as="h1" thing="your voice" reason={voice.error} onRetry={() => void appStore.loadVoice(account)} className="min-h-[60dvh] justify-center" />;
  }

  const switcher = studio && studio.accounts.length > 1 ? (
    <Menu
      label="Switch creator"
      align="end"
      items={studio.accounts.map((item) => ({ label: `@${item.handle}`, checked: item.id === studio.igAccountId, onSelect: () => router.replace(`/voice?account=${encodeURIComponent(item.id)}`) }))}
      trigger={(props) => (
        <button {...props} type="button" className="dd-press inline-flex h-10 items-center gap-2 rounded-full bg-surface pl-1 pr-3 text-label font-semibold text-ink shadow-card">
          <Avatar handle={studio.handle} size={32} />
          <span className="max-w-[140px] truncate">@{studio.handle}</span>
          <ChevronDown aria-hidden size={16} className="text-ink-3" />
        </button>
      )}
    />
  ) : null;

  return (
    <div className="mx-auto w-full max-w-[1180px] pb-12">
      <LargeTitle
        eyebrow={studio ? (studio.accounts.length > 1 ? "Writing and speaking" : `@${studio.handle}`) : " "}
        title="Your voice"
        subtitle="Drafts are written the way you write. Every edit you make teaches it something."
        accessory={switcher}
      />
      <div className="px-4 md:px-8">
        {!studio ? <VoiceSkeleton /> : !studio.consent.granted ? (
          <ConsentGate studio={studio} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)] lg:gap-6">
            <div className="flex min-w-0 flex-col gap-5">
              <MatchHero studio={studio} />
              <Noticed studio={studio} />
              <TryIt studio={studio} />
              <Rules studio={studio} />
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <HowYouWrite studio={studio} />
              <SpeakingVoice studio={studio} />
              <Samples studio={studio} />
              <Learning studio={studio} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VoiceSkeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)]">
      <div className="flex flex-col gap-5"><Skeleton className="h-[260px] rounded-[26px]" /><Skeleton className="h-48 rounded-[20px]" /></div>
      <div className="flex flex-col gap-5"><Skeleton className="h-64 rounded-[20px]" /><Skeleton className="h-40 rounded-[20px]" /></div>
    </div>
  );
}

/* ── Consent ──────────────────────────────────────────────────────────── */

function ConsentGate({ studio }: { studio: VoiceStudio }) {
  const [busy, setBusy] = useState(false);
  const turnOn = async () => {
    setBusy(true);
    try {
      await appStore.setVoiceConsent(studio.igAccountId, true);
      await appStore.loadVoice(studio.igAccountId);
      toast(`Learning @${studio.handle}'s voice from their sent replies.`, { tone: "success" });
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't turn on voice learning. Try again."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="consent-title" className="dd-rise mx-auto max-w-[640px] overflow-hidden rounded-[26px] bg-surface shadow-card">
      <HeroCard as="div" flat className="px-6 pb-6 pt-7">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-on-hero/10 text-hero-money"><AudioLines aria-hidden size={24} /></span>
        <h2 id="consent-title" className="mt-4 text-title">Teach DealDock how @{studio.handle} writes</h2>
        <p className="mt-2 max-w-md text-body text-on-hero/70">It reads the replies already sent from this account to learn the greeting, tone, length and sign-off. Drafts then sound like you, and get closer every time you edit one.</p>
      </HeroCard>
      <ul className="flex flex-col gap-3 px-6 py-5 text-[15px] leading-6 text-ink">
        <li className="flex gap-3"><Check aria-hidden size={18} className="mt-0.5 shrink-0 text-recovered" />Only replies you sent are used, never your followers&apos; messages.</li>
        <li className="flex gap-3"><Check aria-hidden size={18} className="mt-0.5 shrink-0 text-recovered" />Leave out any reply, pause learning, or turn it off. Turning it off deletes what was learned.</li>
        <li className="flex gap-3"><Check aria-hidden size={18} className="mt-0.5 shrink-0 text-recovered" />Drafts are never sent without someone approving them.</li>
      </ul>
      <div className="px-6 pb-6">
        <Button variant="money" size="lg" fullWidth loading={busy} loadingLabel="Turning on…" onClick={() => void turnOn()}>Turn on voice learning</Button>
      </div>
    </section>
  );
}

/* ── Voice match ──────────────────────────────────────────────────────── */

function MatchHero({ studio }: { studio: VoiceStudio }) {
  const { timezone, money } = useApp();
  const now = useMinuteClock();
  const locale = money.locale ?? "en-IN";
  const weeks = studio.metrics.weekly.filter((week) => week.voiceMatchPct !== null);
  const match = studio.metrics.voiceMatchPct;
  const first = weeks[0]?.voiceMatchPct ?? null;
  const delta = match !== null && first !== null && weeks.length > 1 ? match - first : null;
  const learnedAt = studio.lastDistilledAt ? Date.parse(studio.lastDistilledAt) : null;
  const summary = weeks.map((week) => `${formatDate(week.weekStart, locale, timezone, { day: "numeric", month: "short" })} ${week.voiceMatchPct}%`).join(", ");

  return (
    <HeroCard aria-labelledby="match-title" className="p-5 md:p-7">
      <p id="match-title" className="flex items-center gap-2 text-label font-semibold text-on-hero/60"><AudioLines aria-hidden size={16} className="text-hero-money" />Voice match</p>
      {match === null ? (
        <>
          <p className="mt-2 text-[28px] font-semibold leading-9 tracking-[-0.02em]">No drafts sent yet</p>
          <p className="mt-1 text-body text-on-hero/65">Your match appears after your first few replies. It&apos;s the share of drafts you send with light edits or none.</p>
        </>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-[56px] font-semibold leading-[60px] tracking-[-0.04em] tabular-nums">{match}<span className="text-[32px] text-on-hero/55">%</span></p>
            {delta !== null && delta !== 0 && (
              <span className={cx("rounded-full px-2.5 py-1 text-label font-semibold", delta > 0 ? "bg-hero-accent/15 text-hero-money" : "bg-on-hero/10 text-on-hero/70")}>
                {delta > 0 ? "+" : "−"}{Math.abs(delta)} pts in {weeks.length} weeks
              </span>
            )}
          </div>
          <p className="mt-1 max-w-md text-body text-on-hero/70">of drafts this week went out with light edits or none. It climbs as DealDock learns from your changes.</p>
        </>
      )}

      {weeks.length > 1 && (
        <div className="mt-6">
          <div role="img" aria-label={`Voice match by week: ${summary}`} className="flex h-28 items-end gap-1.5 sm:gap-2">
            {weeks.map((week, index) => {
              const last = index === weeks.length - 1;
              return (
                <div key={week.weekStart} className="flex h-full flex-1 flex-col justify-end">
                  {(index === 0 || last) && <span aria-hidden className={cx("mb-1 text-center text-caption font-semibold tabular-nums", last ? "text-hero-money" : "text-on-hero/45")}>{week.voiceMatchPct}%</span>}
                  <span
                    className={cx("block w-full rounded-t-[6px] rounded-b-[3px] transition-[height] duration-500", last ? "bg-hero-accent shadow-[0_0_24px_-4px_color-mix(in_oklab,var(--dd-hero-accent)_70%,transparent)]" : "bg-hero-accent/30")}
                    style={{ height: `${Math.max(6, week.voiceMatchPct ?? 0)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div aria-hidden className="mt-2 flex justify-between text-caption text-on-hero/45">
            <span>{formatDate(weeks[0]!.weekStart, locale, timezone, { day: "numeric", month: "short" })}</span>
            <span>This week</span>
          </div>
        </div>
      )}

      <dl className="mt-6 grid grid-cols-3 gap-3 border-t border-on-hero/10 pt-4">
        <div><dt className="text-caption text-on-hero/50">Sent with DealDock</dt><dd className="mt-0.5 text-[20px] font-semibold tabular-nums">{studio.metrics.sentCount}</dd></div>
        <div><dt className="text-caption text-on-hero/50">Sent as written</dt><dd className="mt-0.5 text-[20px] font-semibold tabular-nums">{studio.metrics.sentAsIsPct === null ? "—" : `${studio.metrics.sentAsIsPct}%`}</dd></div>
        <div><dt className="text-caption text-on-hero/50">Last learned</dt><dd className="mt-0.5 truncate text-[20px] font-semibold">{learnedAt && now ? agoText(learnedAt, now, locale, timezone) : "—"}</dd></div>
      </dl>
      {studio.learningPaused && <p className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-on-hero/10 px-3 py-1.5 text-label font-semibold text-on-hero/80"><Pause aria-hidden size={14} />Learning is paused</p>}
    </HeroCard>
  );
}

/* ── Noticed (candidate rules) ────────────────────────────────────────── */

function Noticed({ studio }: { studio: VoiceStudio }) {
  const candidates = studio.rules.filter((rule) => rule.status === "candidate");
  if (!candidates.length) return null;
  return (
    <Group id="noticed" title="Picked up from your edits" action={<span className="text-caption text-ink-3">{candidates.length} to confirm</span>} bare>
      <ul className="flex flex-col gap-3">
        {candidates.map((rule) => <CandidateCard key={rule.id} rule={rule} />)}
      </ul>
    </Group>
  );
}

function CandidateCard({ rule }: { rule: VoiceRuleDto }) {
  const [busy, setBusy] = useState<"keep" | "mute" | null>(null);
  const example = rule.examples[0];
  const decide = async (status: "active" | "muted") => {
    setBusy(status === "active" ? "keep" : "mute");
    try {
      await appStore.updateRule(rule.id, { status });
      toast(status === "active" ? "Kept. Drafts will do this from now on." : "Got it. Drafts won't do this.", {
        tone: "success",
        action: { label: "Undo", onClick: () => void appStore.updateRule(rule.id, { status: "candidate" }) },
      });
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't save that. Try again."), { tone: "error" });
      setBusy(null);
    }
  };
  return (
    <li className="dd-rise rounded-[22px] bg-surface p-4 shadow-card md:p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-recovered"><MessageSquareQuote aria-hidden size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold leading-6 text-ink">{rule.text}</p>
          <p className="mt-0.5 text-caption text-ink-3">{ruleSource(rule)} · {scopeText(rule.scope)}</p>
        </div>
      </div>
      {example && (
        <div className="mt-3 grid gap-2 rounded-2xl bg-inset p-3 text-[14px] leading-5">
          <p className="text-ink-3"><span className="mr-1.5 font-semibold text-ink-2">Draft said</span><span className="line-through decoration-ink-3/60">{example.before}</span></p>
          <p className="text-ink"><span className="mr-1.5 font-semibold text-recovered">You sent</span>{example.after}</p>
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" size="sm" icon={Check} loading={busy === "keep"} disabled={busy !== null} onClick={() => void decide("active")}>Keep it</Button>
        <Button variant="secondary" size="sm" icon={X} loading={busy === "mute"} disabled={busy !== null} onClick={() => void decide("muted")}>Not me</Button>
      </div>
    </li>
  );
}

/* ── Rules ────────────────────────────────────────────────────────────── */

function Rules({ studio }: { studio: VoiceStudio }) {
  const [editing, setEditing] = useState<VoiceRuleDto | "new" | null>(null);
  const [showMuted, setShowMuted] = useState(false);
  const live = studio.rules.filter((rule) => rule.status === "pinned" || rule.status === "active")
    .sort((a, b) => Number(b.status === "pinned") - Number(a.status === "pinned"));
  const muted = studio.rules.filter((rule) => rule.status === "muted");

  return (
    <Group
      id="rules"
      title="What drafts always follow"
      action={<Button variant="ghost" size="sm" icon={Plus} onClick={() => setEditing("new")}>Add a rule</Button>}
    >
      {live.length === 0 ? (
        <p className="px-5 py-8 text-center text-body text-ink-2">No rules yet. Add one, or keep editing drafts and DealDock will suggest some.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {live.map((rule) => <RuleRow key={rule.id} rule={rule} onEdit={() => setEditing(rule)} />)}
        </ul>
      )}
      {muted.length > 0 && (
        <div className="border-t border-hairline">
          <button type="button" aria-expanded={showMuted} onClick={() => setShowMuted((value) => !value)} className="flex w-full items-center justify-between px-4 py-3 text-label font-semibold text-ink-2 hover:bg-inset">
            Turned off ({muted.length})
            <ChevronDown aria-hidden size={16} className={cx("transition-transform", showMuted && "rotate-180")} />
          </button>
          {showMuted && (
            <ul className="divide-y divide-hairline">
              {muted.map((rule) => <RuleRow key={rule.id} rule={rule} onEdit={() => setEditing(rule)} />)}
            </ul>
          )}
        </div>
      )}
      <RuleSheet key={editing === "new" ? "new" : editing?.id ?? "closed"} rule={editing} igAccountId={studio.igAccountId} onClose={() => setEditing(null)} />
    </Group>
  );
}

function RuleRow({ rule, onEdit }: { rule: VoiceRuleDto; onEdit: () => void }) {
  const set = (patch: Parameters<typeof appStore.updateRule>[1], done: string) =>
    toastAction(() => appStore.updateRule(rule.id, patch), { success: done, fallback: "Couldn't save that. Try again." });
  const items: MenuItem[] = [
    rule.status === "pinned"
      ? { label: "Unpin", icon: PinOff, onSelect: () => void set({ status: "active" }, "Unpinned. DealDock can adapt this rule.") }
      : rule.status === "muted"
        ? { label: "Turn back on", icon: Check, onSelect: () => void set({ status: "active" }, "Turned back on.") }
        : { label: "Always do this", icon: Pin, onSelect: () => void set({ status: "pinned" }, "Pinned. Drafts always follow this.") },
    { label: "Edit", icon: Pencil, onSelect: onEdit },
    ...(rule.status !== "muted" ? [{ label: "Turn off", icon: VolumeX, onSelect: () => void set({ status: "muted" }, "Turned off. Drafts won't do this.") }] : []),
    { label: "Delete", icon: Trash2, destructive: true, onSelect: () => void toastAction(() => appStore.deleteRule(rule.id), { success: "Rule deleted.", fallback: "Couldn't delete that rule." }) },
  ];
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", rule.status === "pinned" ? "bg-brand text-on-brand" : rule.status === "muted" ? "bg-inset text-ink-3" : "bg-brand-tint text-recovered")}>
        {rule.status === "pinned" ? <Pin aria-hidden size={15} /> : rule.status === "muted" ? <VolumeX aria-hidden size={15} /> : <Check aria-hidden size={15} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx("text-[15px] font-semibold leading-5", rule.status === "muted" ? "text-ink-3" : "text-ink")}>{rule.text}</p>
        <p className="mt-0.5 truncate text-caption text-ink-3">{scopeText(rule.scope)} · {rule.status === "pinned" ? "Always" : ruleSource(rule)}</p>
      </div>
      <Menu label={`Options for “${rule.text}”`} items={items} icon={Ellipsis} />
    </li>
  );
}

function RuleSheet({ rule, igAccountId, onClose }: { rule: VoiceRuleDto | "new" | null; igAccountId: string; onClose: () => void }) {
  const existing = rule && rule !== "new" ? rule : null;
  const [text, setText] = useState(existing?.text ?? "");
  const [scope, setScope] = useState<VoiceRuleScope>(existing?.scope ?? "all");
  const [pinned, setPinned] = useState(existing ? existing.status === "pinned" : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== (existing?.text ?? "") || scope !== (existing?.scope ?? "all");

  const save = async () => {
    if (!text.trim()) { setError("Write the rule first."); return; }
    setBusy(true);
    setError(null);
    try {
      if (existing) await appStore.updateRule(existing.id, { text: text.trim(), scope, ...(existing.status !== "muted" ? { status: pinned ? "pinned" : "active" } : {}) });
      else await appStore.createRule({ text: text.trim(), scope, status: pinned ? "pinned" : "active", igAccountId });
      toast(existing ? "Rule updated." : "Rule added. The next draft follows it.", { tone: "success" });
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't save the rule. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={rule !== null}
      onClose={onClose}
      title={existing ? "Edit rule" : "Add a rule"}
      dirty={dirty && !busy}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void save()} loading={busy} loadingLabel="Saving…">Save rule</Button></>}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <TextField label="Rule" value={text} maxLength={120} onChange={(event) => setText(event.target.value)} helper="Say it the way you'd tell an assistant, like “Never quote prices in the first reply to a brand”." error={error} />
        <Select label="Applies to" value={scope} onChange={(event) => setScope(event.target.value as VoiceRuleScope)}>
          {SCOPES.map((item) => <option key={item} value={item}>{scopeText(item)}</option>)}
        </Select>
        {(!existing || existing.status !== "muted") && (
          <Switch checked={pinned} onChange={setPinned} label="Always do this" description="Pinned rules are never unlearned, even if your edits drift." />
        )}
      </form>
    </Sheet>
  );
}

/* ── Try it ───────────────────────────────────────────────────────────── */

const EXAMPLES: Array<{ id: string; title: string; text: string; label: ClassificationLabel }> = [
  { id: "brand", title: "A brand asks your rate", text: "Hi! Would love to collaborate on our launch. What are your rates?", label: "brand_deal" },
  { id: "coaching", title: "Coaching fees", text: "Is your coaching open? Fees kya hai?", label: "coaching_lead" },
  { id: "course", title: "Course question", text: "Hey, is the next batch of your course open? Is it live or recorded?", label: "course_inquiry" },
];
const TRY_CHIPS: DraftChip[] = ["shorter", "warmer", "more_hinglish", "more_formal", "quote_rate"];
const TRY_LABELS: ClassificationLabel[] = ["brand_deal", "coaching_lead", "course_inquiry", "other_commerce"];

function TryIt({ studio }: { studio: VoiceStudio }) {
  const [example, setExample] = useState(EXAMPLES[0]!.id);
  const [inbound, setInbound] = useState(EXAMPLES[0]!.text);
  const [label, setLabel] = useState<ClassificationLabel>(EXAMPLES[0]!.label);
  const [chips, setChips] = useState<DraftChip[]>([]);
  const [result, setResult] = useState<VoicePreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (id: string) => {
    const item = EXAMPLES.find((entry) => entry.id === id)!;
    setExample(id);
    setInbound(item.text);
    setLabel(item.label);
    setResult(null);
  };
  const write = async () => {
    if (!inbound.trim()) { setError("Type a message to reply to."); return; }
    setBusy(true);
    setError(null);
    try {
      setResult(await appStore.previewVoice({ igAccountId: studio.igAccountId, inboundText: inbound.trim(), label, chips }));
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't write a preview right now."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group id="try" title="Try it" action={<span className="text-caption text-ink-3">Nothing here is saved or sent</span>} padded>
      <div className="dd-scroll-x -mx-1 flex gap-2 px-1 pb-1">
        {EXAMPLES.map((item) => <Chip key={item.id} pressed={example === item.id} onClick={() => pick(item.id)}>{item.title}</Chip>)}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <TextArea label="Their message" value={inbound} rows={2} className="[&_textarea]:min-h-[72px]" onChange={(event) => { setInbound(event.target.value); setExample(""); }} />
        <Select label="It's about" value={label} onChange={(event) => setLabel(event.target.value as ClassificationLabel)}>
          {TRY_LABELS.map((item) => <option key={item} value={item}>{labelText(item)}</option>)}
        </Select>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Adjust the reply">
        {TRY_CHIPS.map((chip) => (
          <Chip key={chip} pressed={chips.includes(chip)} onClick={() => setChips((list) => (list.includes(chip) ? list.filter((item) => item !== chip) : [...list, chip]))}>{chipText(chip)}</Chip>
        ))}
      </div>
      <Button variant="primary" className="mt-4" icon={AudioLines} loading={busy} loadingLabel="Writing…" onClick={() => void write()}>Write a reply in my voice</Button>
      {error && <p role="alert" className="mt-3 text-caption text-danger">{error}</p>}

      {result && (
        <div className="dd-rise mt-5 flex flex-col gap-2 rounded-[20px] bg-inset p-3 sm:p-4" aria-live="polite">
          <p className="dd-bubble-in max-w-[85%] self-start px-4 py-2.5 text-message text-ink">{inbound}</p>
          <p className="dd-bubble-out max-w-[85%] self-end whitespace-pre-wrap px-4 py-2.5 text-message">{result.body}</p>
          <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
            <VoiceProvenance matchPct={studio.metrics.voiceMatchPct} />
            {studio.speaking.status === "ready" && <ListenButton text={result.body} igAccountId={studio.igAccountId} />}
          </div>
        </div>
      )}
    </Group>
  );
}

/* ── How you write ────────────────────────────────────────────────────── */

const LENGTH_TEXT = { short: "Short", medium: "Medium", long: "Long" } as const;
const EMOJI_TEXT = { none: "None", light: "A few", heavy: "Lots" } as const;

function HowYouWrite({ studio }: { studio: VoiceStudio }) {
  const measured = studio.measured.filter((item) => item.samples > 0);
  const [scope, setScope] = useState<VoiceRuleScope>("all");
  const [editing, setEditing] = useState(false);
  const current: MeasuredStyle | undefined = measured.find((item) => item.scope === scope) ?? measured[0];
  const style = studio.styleCard ? { ...studio.styleCard, ...studio.overrides } : null;
  const overridden = (key: keyof StyleCard) => studio.overrides[key] !== undefined;

  return (
    <Group id="how" title="How you write" action={style ? <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(true)}>Adjust</Button> : undefined}>
      {current ? (
        <div className="p-4 md:p-5">
          {measured.length > 1 && (
            <div className="dd-scroll-x -mx-1 mb-4 flex gap-2 px-1 pb-1" role="group" aria-label="Measured for">
              {measured.map((item) => <Chip key={item.scope} pressed={item.scope === current.scope} onClick={() => setScope(item.scope)}>{scopeText(item.scope)}</Chip>)}
            </div>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Measure label="Words per reply" value={String(current.avgWords)} meter={Math.min(1, current.avgWords / 60)} />
            <Measure label="Replies with emoji" value={`${Math.round(current.emojiRate * 100)}%`} meter={current.emojiRate} />
            <Measure label="Hindi words mixed in" value={`${Math.round(current.hinglishIndex * 100)}%`} meter={Math.min(1, current.hinglishIndex * 3)} />
            <Measure label="Replies measured" value={String(current.samples)} />
          </dl>
          {(current.topOpeners.length > 0 || current.topSignoffs.length > 0) && (
            <div className="mt-4 flex flex-col gap-2 text-[14px]">
              {current.topOpeners.length > 0 && <p className="flex flex-wrap items-center gap-1.5 text-ink-2">You open with {current.topOpeners.map((opener) => <span key={opener} className="rounded-full bg-inset px-2.5 py-0.5 font-semibold text-ink">{opener}</span>)}</p>}
              {current.topSignoffs.length > 0 && <p className="flex flex-wrap items-center gap-1.5 text-ink-2">You sign off with {current.topSignoffs.map((signoff) => <span key={signoff} className="rounded-full bg-inset px-2.5 py-0.5 font-semibold text-ink">{signoff}</span>)}</p>}
            </div>
          )}
        </div>
      ) : (
        <p className="px-5 py-6 text-body text-ink-2">DealDock measures your style once you&apos;ve sent a few replies from @{studio.handle}.</p>
      )}

      {style && (
        <dl className="divide-y divide-hairline border-t border-hairline">
          <StyleRow label="Greeting" value={style.greeting || "—"} mine={overridden("greeting")} />
          <StyleRow label="Tone" value={style.tone} mine={overridden("tone")} />
          <StyleRow label="Length" value={LENGTH_TEXT[style.sentenceLength]} mine={overridden("sentenceLength")} />
          <StyleRow label="Emoji" value={EMOJI_TEXT[style.emojiUsage]} mine={overridden("emojiUsage")} />
          <StyleRow label="Sign-off" value={style.signoff || "None"} mine={overridden("signoff")} />
          <StyleRow label="Language" value={style.codeSwitching} mine={overridden("codeSwitching")} />
          {style.characteristicPhrases.length > 0 && <StyleRow label="Says" value={style.characteristicPhrases.map((phrase) => `“${phrase}”`).join(", ")} mine={overridden("characteristicPhrases")} />}
          {(style.avoidPhrases?.length ?? 0) > 0 && <StyleRow label="Never says" value={style.avoidPhrases!.map((phrase) => `“${phrase}”`).join(", ")} mine={overridden("avoidPhrases")} />}
        </dl>
      )}
      {style && studio.styleCard && <StyleSheet open={editing} onClose={() => setEditing(false)} studio={studio} learned={studio.styleCard} />}
    </Group>
  );
}

function Measure({ label, value, meter }: { label: string; value: string; meter?: number }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-caption text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[22px] font-semibold leading-7 tracking-[-0.02em] text-ink tabular-nums">{value}</dd>
      {meter !== undefined && (
        <span aria-hidden className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-inset">
          <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(4, Math.round(meter * 100))}%` }} />
        </span>
      )}
    </div>
  );
}

function StyleRow({ label, value, mine }: { label: string; value: string; mine: boolean }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-3 md:px-5">
      <dt className="w-24 shrink-0 text-caption font-semibold text-ink-3">{label}</dt>
      <dd className="min-w-0 flex-1 text-[15px] leading-5 text-ink">{value}</dd>
      {mine && <Tag tone="money" className="h-5 px-2">Set by you</Tag>}
    </div>
  );
}

const splitPhrases = (value: string) => value.split(",").map((phrase) => phrase.trim().replace(/^["“]|["”]$/g, "")).filter(Boolean);

function StyleSheet({ open, onClose, studio, learned }: { open: boolean; onClose: () => void; studio: VoiceStudio; learned: StyleCard }) {
  const effective = { ...learned, ...studio.overrides };
  const initial = useMemo(() => ({
    greeting: effective.greeting,
    tone: effective.tone,
    signoff: effective.signoff,
    codeSwitching: effective.codeSwitching,
    sentenceLength: effective.sentenceLength,
    emojiUsage: effective.emojiUsage,
    says: effective.characteristicPhrases.join(", "),
    avoid: (effective.avoidPhrases ?? []).join(", "),
    // Reset when the sheet opens; the studio may have changed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [open]);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(initial), [initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const field = <K extends keyof typeof form>(key: K) => (value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));

  const save = async (reset = false) => {
    setBusy(true);
    try {
      const next: Partial<StyleCard> = {};
      if (!reset) {
        const says = splitPhrases(form.says);
        const avoid = splitPhrases(form.avoid);
        if (form.greeting.trim() !== learned.greeting) next.greeting = form.greeting.trim();
        if (form.tone.trim() !== learned.tone) next.tone = form.tone.trim();
        if (form.signoff.trim() !== learned.signoff) next.signoff = form.signoff.trim();
        if (form.codeSwitching.trim() !== learned.codeSwitching) next.codeSwitching = form.codeSwitching.trim();
        if (form.sentenceLength !== learned.sentenceLength) next.sentenceLength = form.sentenceLength;
        if (form.emojiUsage !== learned.emojiUsage) next.emojiUsage = form.emojiUsage;
        if (says.join("|") !== learned.characteristicPhrases.join("|")) next.characteristicPhrases = says;
        if (avoid.join("|") !== (learned.avoidPhrases ?? []).join("|")) next.avoidPhrases = avoid;
      }
      await appStore.setStyleOverrides(next, studio.igAccountId);
      toast(reset ? "Back to what DealDock learned." : "Style saved. The next draft uses it.", { tone: "success" });
      onClose();
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't save your style. Try again."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Adjust your style"
      description="What you set here wins over what DealDock learned."
      dirty={dirty && !busy}
      footer={
        <>
          {Object.keys(studio.overrides).length > 0 && <Button variant="ghost" onClick={() => void save(true)} disabled={busy} className="mr-auto">Reset to learned</Button>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} loadingLabel="Saving…">Save</Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Greeting" value={form.greeting} maxLength={40} onChange={(event) => field("greeting")(event.target.value)} />
          <TextField label="Sign-off" value={form.signoff} maxLength={40} onChange={(event) => field("signoff")(event.target.value)} helper="Leave empty for none." />
        </div>
        <TextField label="Tone" value={form.tone} maxLength={80} onChange={(event) => field("tone")(event.target.value)} />
        <div className="flex flex-col gap-1.5">
          <span className="text-label text-ink">Reply length</span>
          <Segmented label="Reply length" value={form.sentenceLength} onChange={field("sentenceLength")} options={(["short", "medium", "long"] as const).map((value) => ({ value, label: LENGTH_TEXT[value] }))} className="self-start" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-label text-ink">Emoji</span>
          <Segmented label="Emoji" value={form.emojiUsage} onChange={field("emojiUsage")} options={(["none", "light", "heavy"] as const).map((value) => ({ value, label: EMOJI_TEXT[value] }))} className="self-start" />
        </div>
        <TextField label="Language" value={form.codeSwitching} maxLength={80} onChange={(event) => field("codeSwitching")(event.target.value)} helper="For example: Hinglish with followers, English with brands." />
        <TextField label="Phrases you use" value={form.says} onChange={(event) => field("says")(event.target.value)} helper="Separate with commas." />
        <TextField label="Phrases you never use" value={form.avoid} onChange={(event) => field("avoid")(event.target.value)} helper="Separate with commas." />
      </form>
    </Sheet>
  );
}

/* ── Speaking voice ───────────────────────────────────────────────────── */

const TEST_PHRASE = "Heyy! Thanks for the message. Sending the details now, let me know if you have any questions.";

/** A pending voice becomes ready server-side: check at 4, 8, then every 16 s while the page is visible, for about 3 minutes. */
const TRAINING_POLL = { delays: [4_000, 8_000, 16_000], maxMs: 180_000 } as const;

function SpeakingVoice({ studio }: { studio: VoiceStudio }) {
  const speaking = studio.speaking;
  // Recording, deleting and the AI label are the creator's own (creator-only "manage_voice"); hidden until /me answers.
  const canManage = useCan("manage_voice");
  const [recording, setRecording] = useState(false);
  const [phrase, setPhrase] = useState(TEST_PHRASE);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const gaveUp = usePoll(async () => {
    await appStore.loadVoice(studio.igAccountId);
    return false;
  }, { ...TRAINING_POLL, enabled: speaking.status === "pending" });

  const remove = async () => {
    setDeleting(true);
    try {
      await appStore.deleteSpeakingVoice(studio.igAccountId);
      toast("Speaking voice deleted, with its recordings.", { tone: "success" });
      setConfirmDelete(false);
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't delete the voice. Try again."), { tone: "error" });
    } finally {
      setDeleting(false);
    }
  };
  const setDisclosure = (enabled: boolean) => toastAction(() => appStore.setSpeakingDisclosure(enabled, studio.igAccountId), { fallback: "Couldn't save that setting." });

  const canRecord = studio.speechAvailable && canManage === true;
  const status = speaking.status;

  return (
    <Group id="speaking" title="Speaking voice" action={status === "ready" ? <Tag tone="money" icon={<Check aria-hidden size={13} />}>Ready</Tag> : status === "pending" ? <Tag tone="info">Creating…</Tag> : undefined}>
      <div className="p-4 md:p-5">
        {!studio.speechAvailable ? (
          <p className="text-body text-ink-2">Voice notes in your voice aren&apos;t switched on for this workspace yet. Once they are, you can record your voice here in about a minute.</p>
        ) : status === "ready" ? (
          <div className="flex flex-col gap-4">
            <p className="text-body text-ink-2">Approved replies can go out as voice notes that sound like you. You choose per reply; text stays the default.</p>
            <TextArea label="Hear it say" value={phrase} rows={2} maxLength={VOICE_CLIP_LIMITS.previewMaxChars} className="[&_textarea]:min-h-[72px]" onChange={(event) => setPhrase(event.target.value)} />
            <ListenButton text={phrase} igAccountId={studio.igAccountId} label="Play in my voice" />
            <Switch
              checked={speaking.disclosureEnabled}
              onChange={(value) => void setDisclosure(value)}
              disabled={canManage !== true}
              label="Label voice notes as AI"
              description="Sends “AI voice note in my voice” after each one. Recommended, and expected in some countries."
            />
          </div>
        ) : status === "pending" ? (
          <div className="flex items-center gap-4">
            <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-info-tint text-info"><AudioLines aria-hidden size={22} className="animate-pulse motion-reduce:animate-none" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-body text-ink-2">
                {gaveUp
                  ? "This is taking longer than usual. It keeps going on our side, so check back in a few minutes."
                  : <>Creating your speaking voice from {speaking.sampleSeconds} seconds of recordings. This usually takes a minute.</>}
              </p>
              {gaveUp && <Button variant="ghost" size="sm" icon={RefreshCw} className="-ml-3 mt-1" onClick={() => void appStore.loadVoice(studio.igAccountId)}>Check again</Button>}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-tint text-recovered"><Mic aria-hidden size={22} /></span>
              <p className="text-body text-ink-2">
                {status === "failed"
                  ? <>That recording didn&apos;t work{speaking.lastError ? ` (${speaking.lastError})` : ""}. Record it again in a quiet room.</>
                  : "Reply with voice notes that sound like you. Record three short reads, about a minute in total."}
              </p>
            </div>
            {canRecord
              ? <Button variant="money" icon={Mic} className="self-start" onClick={() => setRecording(true)}>{status === "failed" ? "Record again" : "Record my voice"}</Button>
              : canManage === false && <p className="text-caption text-ink-3">Only @{studio.handle} can record their own voice.</p>}
          </div>
        )}
      </div>

      {(status === "ready" || status === "pending" || status === "failed") && canManage === true && (
        <div className="flex flex-wrap gap-2 border-t border-hairline px-4 py-3 md:px-5">
          {status === "ready" && <Button variant="ghost" size="sm" icon={Mic} onClick={() => setRecording(true)}>Record again</Button>}
          <Button variant="danger-ghost" size="sm" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete voice</Button>
        </div>
      )}

      <VoiceRecorderSheet open={recording} onClose={() => setRecording(false)} handle={studio.handle} igAccountId={studio.igAccountId} />
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete your speaking voice?" confirmLabel="Delete voice" destructive busy={deleting} busyLabel="Deleting…" onConfirm={() => void remove()}>
        Voice notes stop right away. Your recordings are deleted, and so is the copy held by the voice provider. Replies you already sent stay in Instagram.
      </ConfirmDialog>
    </Group>
  );
}

/* ── Samples ──────────────────────────────────────────────────────────── */

function sampleOrigin(sample: VoiceSampleDto): string {
  if (sample.origin === "native") return "You wrote this";
  if (sample.weight >= 0.8) return "DealDock draft, lightly edited";
  return "DealDock draft you reworked";
}

function Samples({ studio }: { studio: VoiceStudio }) {
  const { money, timezone } = useApp();
  const [all, setAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const locale = money.locale ?? "en-IN";
  const included = studio.samples.filter((sample) => !sample.excluded).length;
  const shown = all ? studio.samples : studio.samples.slice(0, 4);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await appStore.refreshVoice(studio.igAccountId);
      toast(`Voice refreshed from ${included} ${pluralize(included, "reply", "replies")}.`, { tone: "success" });
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't refresh right now. Try again."), { tone: "error" });
    } finally {
      setRefreshing(false);
    }
  };
  const toggle = (sample: VoiceSampleDto, use: boolean) => toastAction(() => appStore.setSampleExcluded(sample.messageId, !use, studio.igAccountId), { fallback: "Couldn't change that reply." });

  return (
    <Group id="samples" title="Replies it learns from" action={<Button variant="ghost" size="sm" icon={RefreshCw} loading={refreshing} loadingLabel="Refreshing…" onClick={() => void refresh()}>Refresh</Button>}>
      {studio.samples.length === 0 ? (
        <p className="px-5 py-6 text-body text-ink-2">No sent replies yet. DealDock learns from replies you send from @{studio.handle}.</p>
      ) : (
        <>
          <p className="px-4 pt-3 text-caption text-ink-3 md:px-5">Using {included} of {studio.samples.length}. Leave out anything that isn&apos;t how you normally write.</p>
          <ul className="divide-y divide-hairline">
            {shown.map((sample) => (
              <li key={sample.messageId} className="flex items-start gap-3 px-4 py-3 md:px-5">
                <div className="min-w-0 flex-1">
                  <p className={cx("line-clamp-2 text-[15px] leading-5", sample.excluded ? "text-ink-3 line-through decoration-ink-3/50" : "text-ink")}>{sample.text}</p>
                  <p className="mt-1 text-caption text-ink-3">{formatDate(sample.sentAt, locale, timezone, { day: "numeric", month: "short" })} · {sampleOrigin(sample)}</p>
                </div>
                <Switch checked={!sample.excluded} onChange={(use) => void toggle(sample, use)} label={<span className="sr-only">Learn from this reply</span>} className="shrink-0 gap-0" />
              </li>
            ))}
          </ul>
          {studio.samples.length > 4 && (
            <button type="button" onClick={() => setAll((value) => !value)} className="w-full border-t border-hairline px-4 py-3 text-label font-semibold text-brand hover:bg-inset">
              {all ? "Show fewer" : `Show all ${studio.samples.length} replies`}
            </button>
          )}
        </>
      )}
    </Group>
  );
}

/* ── Learning controls ────────────────────────────────────────────────── */

function Learning({ studio }: { studio: VoiceStudio }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const pause = (paused: boolean) => toastAction(() => appStore.setLearningPaused(paused, studio.igAccountId), {
    success: paused ? "Learning paused. Drafts keep your current voice." : "Learning again from your edits.",
    fallback: "Couldn't change that.",
  });
  const turnOff = async () => {
    setBusy(true);
    try {
      await appStore.setVoiceConsent(studio.igAccountId, false);
      await appStore.loadVoice(studio.igAccountId);
      toast(`Voice learning is off for @${studio.handle}. What it learned was deleted.`, { tone: "success" });
      setConfirm(false);
    } catch (failure) {
      toast(errorMessage(failure, "Couldn't turn it off. Try again."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group id="learning" title="Learning" padded>
      <Switch checked={!studio.learningPaused} onChange={(on) => void pause(!on)} label="Learn from my edits" description="When off, drafts keep your current voice but stop picking up new habits." />
      <div className="mt-4 border-t border-hairline pt-4">
        <Button variant="danger-ghost" size="sm" className="-ml-3" onClick={() => setConfirm(true)}>Stop using my replies</Button>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Turn off voice learning for @${studio.handle}?`} confirmLabel="Turn off and delete" destructive busy={busy} busyLabel="Turning off…" onConfirm={() => void turnOff()}>
        DealDock deletes the rules and style it learned, plus any unsent drafts for this account. New drafts use a neutral voice until you turn learning back on. Sent messages and your revenue aren&apos;t affected.
      </ConfirmDialog>
    </Group>
  );
}
