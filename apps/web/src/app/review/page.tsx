"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import type { ClassificationLabel } from "@dealdock/core";
import { ArrowLeft, Check, CheckCheck, SkipForward } from "lucide-react";
import { compactCount, confidenceReason, confidenceWords, displayName, labelText, relativeAge, textLang, toCheck } from "../../lib/format";
import { useMinuteClock, useShortcut } from "../../lib/keyboard";
import { runUndoable } from "../../lib/undo";
import { appStore, useApp, type DemoThread } from "../../lib/use-demo";
import { buttonClasses } from "../../components/ui/button-classes";
import { Kbd } from "../../components/ui/kbd";
import { cx } from "../../components/ui/cx";
import { LABEL_META } from "../../components/ui/label-chip";
import { Avatar } from "../../components/ui/sender";

/** The labels a message can be sorted into, with their number keys (glyphs come from LABEL_META). */
const CHOICES: Array<{ label: ClassificationLabel; key: string }> = [
  { label: "brand_deal", key: "1" },
  { label: "coaching_lead", key: "2" },
  { label: "course_inquiry", key: "3" },
  { label: "other_commerce", key: "4" },
  { label: "fan", key: "5" },
  { label: "personal", key: "6" },
  { label: "spam", key: "7" },
];

export default function ReviewPage() {
  return <Suspense fallback={null}><Review /></Suspense>;
}

/** Check these: sort what DealDock isn't sure about. Classification only; nothing is drafted or sent here. */
function Review() {
  const router = useRouter();
  const params = useSearchParams();
  const { threads, money, timezone, state, loadedAt } = useApp();
  const now = useMinuteClock();
  const locale = money.locale ?? "en-IN";
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);

  const queue = useMemo(() => {
    const items = threads.filter((thread) => toCheck(thread) && !decided.has(thread.id));
    const first = params?.get("item");
    const ordered = items.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const pinned = first ? ordered.filter((thread) => thread.id === first) : [];
    const rest = ordered.filter((thread) => thread.id !== first);
    const unskipped = rest.filter((thread) => !skipped.includes(thread.id));
    const skippedItems = skipped.map((id) => rest.find((thread) => thread.id === id)).filter(Boolean) as DemoThread[];
    return [...pinned, ...unskipped, ...skippedItems];
  }, [threads, decided, skipped, params]);
  const total = queue.length + decided.size;
  const current = queue[0] ?? null;
  const message = current?.messages.find((item) => item.direction === "inbound" && (item.text || item.audio)) ?? null;
  const guess = message?.classification ?? (current?.topLabel ? { label: current.topLabel, confidence: 0.5, rationale: current.rationale } : null);

  const decide = (label: ClassificationLabel) => {
    if (!current || !guess) return;
    const thread = current;
    const outcome = label === guess.label ? "confirmed" : "overridden";
    setLeaving(outcome === "confirmed" ? "right" : "left");
    setTimeout(() => {
      setDecided((set) => new Set(set).add(thread.id));
      setLeaving(null);
    }, 180);
    runUndoable({
      message: `Marked as ${labelText(label).toLowerCase()}.`,
      commit: () => appStore.review(thread.classificationId ?? thread.id, outcome, outcome === "overridden" ? label : undefined),
      onUndo: () => setDecided((set) => { const next = new Set(set); next.delete(thread.id); return next; }),
    });
  };
  const skip = () => { if (current) setSkipped((list) => [...list.filter((id) => id !== current.id), current.id]); };

  useShortcut("y", () => { if (guess) decide(guess.label); }, { enabled: Boolean(current && guess) });
  useShortcut(CHOICES.map((choice) => choice.key), (event) => { const choice = CHOICES.find((item) => item.key === event.key); if (choice) decide(choice.label); }, { enabled: Boolean(current) });
  useShortcut(["8", "n"], skip, { enabled: Boolean(current) });
  useShortcut("escape", () => router.push("/inbox"));
  useEffect(() => { window.scrollTo({ top: 0 }); }, [current?.id]);

  const firstLoad = state === "loading" && loadedAt === null;
  const done = !firstLoad && !current;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col px-4 pb-8 md:min-h-0">
      <header className="flex items-center gap-2 pt-[max(12px,env(safe-area-inset-top))] md:pt-8">
        <Link href="/inbox" aria-label="Back to inbox" className="dd-press flex h-10 w-10 items-center justify-center rounded-full hover:bg-inset"><ArrowLeft aria-hidden size={22} /></Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-title text-ink">Check these</h1>
          <p className="text-caption text-ink-3">Sorting only. Nothing is drafted or sent from here.</p>
        </div>
        {total > 0 && !done && <span className="rounded-full bg-inset px-3 py-1 text-label font-semibold text-ink-2 tabular-nums">{decided.size + 1} of {total}</span>}
      </header>

      {total > 0 && (
        <div className="mt-4 flex gap-1" aria-hidden>
          {Array.from({ length: total }, (_, index) => <span key={index} className={cx("h-1 flex-1 rounded-full", index < decided.size ? "bg-brand" : index === decided.size ? "bg-ink" : "bg-fill")} />)}
        </div>
      )}

      {done ? (
        <div className="dd-rise flex flex-1 flex-col items-center justify-center py-16 text-center">
          <span className="dd-stamp flex h-16 w-16 items-center justify-center rounded-full bg-brand text-on-brand"><CheckCheck aria-hidden size={30} /></span>
          <h2 className="mt-5 text-title text-ink">All sorted.</h2>
          <p className="mt-1 max-w-xs text-body text-ink-2">Every correction teaches DealDock how to sort your inbox.</p>
          <div className="mt-6 flex gap-2">
            <Link href="/inbox" className={buttonClasses({ variant: "primary" })}>Back to inbox</Link>
            <Link href="/" className={buttonClasses({ variant: "secondary" })}>Today</Link>
          </div>
        </div>
      ) : current ? (
        <div className="flex flex-1 flex-col">
          <article
            key={current.id}
            className={cx("dd-rise mt-5 rounded-[26px] bg-surface p-5 shadow-raised transition-[transform,opacity] duration-200", leaving === "right" && "translate-x-10 opacity-0", leaving === "left" && "-translate-x-10 opacity-0")}
          >
            <div className="flex items-center gap-3">
              <Avatar handle={current.handle} name={current.participant.name} src={current.participant.avatarUrl} size={48} verified={Boolean(current.participant.verified)} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16px] font-semibold text-ink">{displayName(current.participant, current.handle)}</p>
                <p className="truncate text-caption text-ink-3">@{current.handle}{current.participant.followerCount !== null ? ` · ${compactCount(current.participant.followerCount, locale)} followers` : ""}{now ? ` · ${relativeAge(current.lastMessageAt, now, locale, timezone)}` : ""}</p>
              </div>
            </div>
            <p lang={textLang(message?.text || current.preview)} className="dd-bubble-in mt-4 bg-inset px-4 py-3 text-message text-ink shadow-none">
              {message?.audio?.transcript ?? (message?.text || current.preview)}
            </p>
            {guess && (
              <div className="mt-4 rounded-2xl bg-review-tint p-4">
                <p className="text-[15px] font-semibold text-ink">{confidenceWords(guess.confidence, guess.label)}</p>
                <p className="mt-0.5 text-[14px] text-ink-2">{confidenceReason(guess.rationale ?? current.rationale)}</p>
              </div>
            )}
            {guess && (
              <button type="button" onClick={() => decide(guess.label)} className="dd-press mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-primary text-button text-on-primary">
                <Check aria-hidden size={19} />Yes, {labelText(guess.label).toLowerCase()}
                <Kbd keys="y" className="ml-1 bg-white/15 text-on-primary" />
              </button>
            )}
          </article>

          <p className="mb-2 mt-6 px-1 text-micro uppercase text-ink-3">Or it&apos;s actually</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CHOICES.filter((choice) => choice.label !== guess?.label).map((choice) => {
              const meta = LABEL_META[choice.label];
              return (
                <button key={choice.label} type="button" onClick={() => decide(choice.label)} className="dd-press flex h-12 items-center gap-2.5 rounded-2xl bg-surface px-3.5 text-[15px] font-semibold text-ink shadow-card hover:bg-inset">
                  <meta.icon aria-hidden size={18} className="shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-left">{meta.text}</span>
                  <Kbd keys={choice.key} />
                </button>
              );
            })}
            <button type="button" onClick={skip} className="dd-press flex h-12 items-center gap-2.5 rounded-2xl px-3.5 text-[15px] font-semibold text-ink-2 hover:bg-inset">
              <SkipForward aria-hidden size={18} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">Not sure, skip</span>
              <Kbd keys="8" />
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-8 space-y-3"><div className="dd-skeleton h-64 rounded-[26px]" /><div className="dd-skeleton h-24 rounded-[22px]" /></div>
      )}
    </div>
  );
}
