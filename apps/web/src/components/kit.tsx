"use client";

import Link from "next/link";
import { memo, useEffect, useId, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { VOICE_CLIP_LIMITS, type ClassificationLabel } from "@dealdock/core";
import { ArrowRight, AudioLines, CheckCheck, ChevronRight, Clock, Hourglass, Mic, Pause, PenLine, Play, Volume2 } from "lucide-react";
import { byValueDesc, clockDuration, displayName, followUpDue, relativeAge, replyWindowInfo, textLang } from "../lib/format";
import { useMediaQuery, useReducedMotion } from "../lib/keyboard";
import { errorMessage } from "../lib/snapshot";
import { appStore, useMoneyContext, type DemoThread } from "../lib/use-demo";
import { Button } from "./ui/button";
import { cx } from "./ui/cx";
import { labelMeta } from "./ui/label-chip";
import { MoneyValue } from "./ui/money-value";
import { Avatar, type AvatarRing } from "./ui/sender";
import { toast } from "./ui/toast";

/* ── Brand ─────────────────────────────────────────────────────────────── */

/** The DealDock mark: a message bubble carrying an upward line — conversations that turn into money. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  // Unique per instance: several marks can share a page, and ids must not collide.
  const gradient = `dd-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1FCB86" />
          <stop offset="1" stopColor="#078A5B" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradient})`} />
      <path d="M9 11.5A3.5 3.5 0 0 1 12.5 8h7A3.5 3.5 0 0 1 23 11.5v5a3.5 3.5 0 0 1-3.5 3.5H15l-4 3.6V20.4A3.5 3.5 0 0 1 9 17Z" fill="#fff" />
      <path d="M12.6 16.4l2.3-2.3 1.7 1.6 3.1-3.2" fill="none" stroke="#078A5B" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Layout pieces ─────────────────────────────────────────────────────── */

/**
 * The page title, iOS large-title style on phones and a quiet header on desktop.
 * `eyebrow` sits above the title (a date, an account); `accessory` on the right.
 */
export function LargeTitle({ title, eyebrow, subtitle, accessory, as: Tag = "h1", className }: {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  accessory?: ReactNode;
  as?: "h1" | "h2";
  className?: string;
}) {
  return (
    <header className={cx("px-4 pb-3 pt-4 md:px-8 md:pb-5 md:pt-8", className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <p className="mb-0.5 text-label font-semibold text-ink-3">{eyebrow}</p>}
          <Tag className="truncate text-display-xl text-ink">{title}</Tag>
        </div>
        {accessory && <div className="flex shrink-0 items-center gap-2">{accessory}</div>}
      </div>
      {subtitle && <p className="mt-1 max-w-[62ch] text-body text-ink-2">{subtitle}</p>}
    </header>
  );
}

/**
 * An inset grouped card (the platform's list group) under a heading. `id`
 * names the section, so /page#id links land on it. `bare` keeps the heading
 * but drops the card, for a list of separate cards.
 */
export function Group({ title, description, action, children, className, padded = false, bare = false, id }: {
  title?: ReactNode;
  /** One quiet line under the heading. */
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
  bare?: boolean;
  id?: string;
}) {
  const titleId = title && id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={titleId} className={cx("min-w-0 scroll-mt-6", className)}>
      {(title || action) && (
        <div className={cx("mb-2 flex justify-between gap-3 px-1", description ? "items-end" : "items-baseline")}>
          {title && (
            <div className="min-w-0">
              <h2 id={titleId} className="text-heading text-ink">{title}</h2>
              {description && <p className="mt-0.5 text-caption text-ink-3">{description}</p>}
            </div>
          )}
          {action}
        </div>
      )}
      {bare ? children : <div className={cx("overflow-hidden rounded-[20px] bg-surface shadow-card", padded && "p-4 md:p-5")}>{children}</div>}
    </section>
  );
}

/** A "See all" style link for group headers. */
export function GroupLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="dd-press inline-flex items-center gap-0.5 rounded-full text-label font-semibold text-brand hover:text-brand-strong">
      {children}
      <ChevronRight aria-hidden size={16} />
    </Link>
  );
}

/**
 * The dark hero card (Today, Revenue, Your voice, sign-in, the roster total):
 * the same near-black in both themes, with an emerald glow in the top corner;
 * `glow="both"` adds a cool one at the bottom left. Inside it use the hero
 * tokens: text-on-hero (with an opacity for captions), text-hero-money, and
 * buttonClasses "hero" and "on-hero".
 */
export function HeroCard({ as: Tag = "section", glow = "money", glowSize = "md", flat = false, className, children, ...rest }: Omit<HTMLAttributes<HTMLElement>, "children"> & {
  as?: "section" | "div";
  glow?: "money" | "both" | "none";
  /** "lg" for a full-height panel (sign-in). */
  glowSize?: "md" | "lg";
  /** No corners, shadow or ring: a band inside another card, a page panel or a tile. */
  flat?: boolean;
  children: ReactNode;
}) {
  const large = glowSize === "lg";
  return (
    // `isolate` keeps the glows (z-index -10) above the card's own background and under every child.
    <Tag className={cx("relative isolate overflow-hidden bg-hero text-on-hero", !flat && "rounded-[26px] shadow-raised ring-1 ring-on-hero/5", className)} {...rest}>
      {glow !== "none" && <span aria-hidden className={cx("dd-hero-glow pointer-events-none absolute -z-10 rounded-full", large ? "-right-32 -top-32 h-[420px] w-[420px]" : "-right-24 -top-28 h-72 w-72")} />}
      {glow === "both" && <span aria-hidden className={cx("dd-hero-glow-cool pointer-events-none absolute -z-10 rounded-full", large ? "-bottom-40 -left-24 h-[360px] w-[360px]" : "-bottom-32 -left-20 h-64 w-64")} />}
      {children}
    </Tag>
  );
}

/* ── Conversation row: the most-seen component in the app ─────────────── */

export function urgencyRing(thread: DemoThread, now: number): AvatarRing {
  if (thread.routedTo === "review_queue") return "none";
  if (!thread.unreplied || thread.state !== "open") return "none";
  const info = replyWindowInfo(thread.replyWindow, now, "row");
  if (info.visible && !info.closed && (info.tone === "danger" || info.tone === "strong")) return "urgent";
  return "none";
}

/**
 * One conversation, messaging-app anatomy with money where the time usually
 * sits: avatar (ring = waiting on you) · name · value · label + state · preview.
 * Memoised: long lists re-render a row only when its own props change.
 */
export const ConversationRow = memo(function ConversationRow({ thread, href, now, selected = false, onSelect, className, showValue = true, creator = null }: {
  thread: DemoThread;
  href: string;
  now: number;
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
  showValue?: boolean;
  /** Agency views: which creator's inbox this conversation is in. */
  creator?: string | null;
}) {
  const { timezone, locale } = useMoneyContext();
  const window = replyWindowInfo(thread.replyWindow, now, "row");
  const name = displayName(thread.participant, thread.handle);
  const unread = thread.unreplied && thread.state === "open" && thread.routedTo === "inbox";
  const review = thread.routedTo === "review_queue";
  const hasValue = showValue && thread.estValueMaxMinor !== null && !review;
  const preview = thread.hasAudio && !thread.preview
    ? null
    : thread.preview;
  return (
    <Link
      href={href}
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-thread-row={thread.id}
      className={cx(
        "dd-row-press group relative flex min-w-0 items-start gap-3 px-4 py-3 outline-none md:px-4",
        selected ? "bg-inset" : "hover:bg-[color-mix(in_oklab,var(--dd-inset)_60%,transparent)]",
        "focus-visible:bg-inset focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
        className,
      )}
    >
      <Avatar handle={thread.handle} name={thread.participant.name} src={thread.participant.avatarUrl} size={48} ring={urgencyRing(thread, now)} verified={Boolean(thread.participant.verified)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className={cx("min-w-0 flex-1 truncate text-[15px] leading-5 tracking-[-0.01em] text-ink", unread ? "font-semibold" : "font-medium")}>
            <bdi>{name}</bdi>
            <span className="sr-only">, @{thread.handle}</span>
          </p>
          {hasValue
            ? <MoneyValue minor={thread.estValueMinMinor ?? thread.estValueMaxMinor!} maxMinor={thread.estValueMaxMinor} kind="estimate" estimatePrefix={false} className="shrink-0 text-[14px] font-semibold text-ink" />
            : <span className="shrink-0 text-caption text-ink-3">{relativeAge(thread.lastMessageAt, now, locale, timezone)}</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-caption">
          {creator && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-inset py-0.5 pl-0.5 pr-2 font-semibold text-ink-2"><Avatar handle={creator} size={20} />@{creator}</span>}
          {thread.topLabel && <LabelDot label={thread.topLabel} />}
          <RowState thread={thread} window={window} />
        </div>
        <p lang={textLang(preview)} className={cx("mt-1 line-clamp-1 text-[14px] leading-5", unread ? "text-ink-2" : "text-ink-3")}>
          {thread.hasAudio && !preview
            ? <span className="inline-flex items-center gap-1"><Mic aria-hidden size={14} />Voice note</span>
            : <>{thread.previewOutbound && <span className="text-ink-3">You: </span>}<bdi>{preview}</bdi></>}
        </p>
      </div>
    </Link>
  );
});

/** Label as a coloured dot and word ("● Brand deal"). Colour is never the only carrier. */
export function LabelDot({ label, className }: { label: ClassificationLabel; className?: string }) {
  const meta = labelMeta(label);
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 font-medium text-ink-2", className)}>
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {meta.text}
    </span>
  );
}

function RowState({ thread, window }: { thread: DemoThread; window: ReturnType<typeof replyWindowInfo> }) {
  const items: ReactNode[] = [];
  if (thread.routedTo === "review_queue") items.push(<span key="check" className="font-medium text-review">Check this</span>);
  if (thread.hasDealSignal) items.push(<span key="signal" className="inline-flex items-center gap-1 font-medium text-recovered"><CheckCheck aria-hidden size={13} />Looks closed</span>);
  if (followUpDue(thread)) items.push(<span key="nudge" className="inline-flex items-center gap-1 font-medium text-waiting"><Hourglass aria-hidden size={12} />Follow-up due</span>);
  else if (thread.state === "waiting") items.push(<span key="waiting" className="text-ink-3">Waiting on them</span>);
  if (thread.draftReady && thread.state === "open") items.push(<span key="draft" className="inline-flex items-center gap-1 font-medium text-ink-2"><PenLine aria-hidden size={12} />Draft ready</span>);
  if (window.visible && !window.closed && thread.unreplied) {
    items.push(
      <span key="window" className={cx("inline-flex items-center gap-1 font-semibold", window.tone === "danger" ? "text-danger" : window.tone === "strong" ? "text-danger" : "text-ink-3")}>
        <Clock aria-hidden size={12} />{window.text}
      </span>,
    );
  } else if (window.closed && thread.unreplied) {
    items.push(<span key="closed" className="text-ink-3">Reply in Instagram</span>);
  }
  return <span className="flex min-w-0 items-center gap-2 truncate">{items.map((item, index) => <span key={index} className="flex shrink-0 items-center gap-2">{index > 0 && <span aria-hidden className="text-ink-3">·</span>}{item}</span>)}</span>;
}

/* ── Money on the table ────────────────────────────────────────────────── */

/** One segment per conversation, sized by its estimate: where the money in the inbox is. */
export function ValueStrip({ threads, onPick, className, height = 12 }: {
  threads: DemoThread[];
  onPick?: (thread: DemoThread) => void;
  className?: string;
  height?: number;
}) {
  const items = threads.filter((thread) => (thread.estValueMaxMinor ?? 0) > 0).sort(byValueDesc);
  const total = items.reduce((sum, thread) => sum + (thread.estValueMaxMinor ?? 0), 0);
  if (!total) return <div className={cx("rounded-full bg-inset", className)} style={{ height }} />;
  return (
    <div className={cx("flex w-full gap-[3px]", className)} style={{ height }} role="img" aria-label={`${items.length} conversations with an estimated value, largest first`}>
      {items.map((thread) => {
        const share = (thread.estValueMaxMinor ?? 0) / total;
        return (
          // A pointer shortcut only: the same conversations are listed (and keyboard-reachable) right below.
          <span
            key={thread.id}
            onClick={onPick ? () => onPick(thread) : undefined}
            title={`@${thread.handle}`}
            className={cx("h-full min-w-[6px] rounded-full transition-[filter,transform] duration-150", onPick && "cursor-pointer hover:brightness-110 active:scale-y-90")}
            style={{ flexGrow: share, flexBasis: 0, background: labelMeta(thread.topLabel).fill }}
          />
        );
      })}
    </div>
  );
}

/* ── Voice note ────────────────────────────────────────────────────────── */

function bars(seed: string, count: number): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return Array.from({ length: count }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0;
    const envelope = 0.45 + 0.55 * Math.sin((Math.PI * (i + 0.5)) / count);
    return Math.max(0.16, ((h % 1000) / 1000) * envelope);
  });
}

/** Voice-note player: real <audio> when a URL exists, otherwise a still waveform with its length. */
export function VoiceNote({ id, url, durationMs, tone = "in", className }: {
  id: string;
  url: string | null;
  durationMs: number | null;
  tone?: "in" | "out";
  className?: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const shape = useMemo(() => bars(id, 34), [id]);
  useEffect(() => {
    const node = audio.current;
    if (!node) return;
    const tick = () => setProgress(node.duration ? node.currentTime / node.duration : 0);
    const end = () => { setPlaying(false); setProgress(0); };
    node.addEventListener("timeupdate", tick);
    node.addEventListener("ended", end);
    return () => { node.removeEventListener("timeupdate", tick); node.removeEventListener("ended", end); };
  }, [url]);
  const toggle = () => {
    const node = audio.current;
    if (!node) return;
    if (playing) { node.pause(); setPlaying(false); } else { void node.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
  };
  const out = tone === "out";
  return (
    <div className={cx("flex items-center gap-3", className)}>
      {url && <audio ref={audio} src={url} preload="none" />}
      <button
        type="button"
        onClick={toggle}
        disabled={!url}
        aria-label={playing ? "Pause voice note" : `Play voice note, ${clockDuration(durationMs)}`}
        className={cx("dd-press flex h-9 w-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50", out ? "bg-on-primary text-primary" : "bg-ink text-on-primary")}
      >
        {playing ? <Pause aria-hidden size={16} fill="currentColor" /> : <Play aria-hidden size={16} fill="currentColor" className="ml-0.5" />}
      </button>
      <div aria-hidden className="flex h-8 min-w-0 flex-1 items-center gap-[2px]">
        {shape.map((value, index) => (
          <span
            key={index}
            className="w-[3px] shrink-0 rounded-full transition-colors"
            style={{
              height: `${Math.round(value * 100)}%`,
              background: index / shape.length <= progress && playing
                ? (out ? "var(--dd-on-ink)" : "var(--dd-brand)")
                : (out ? "color-mix(in oklab, var(--dd-on-ink) 45%, transparent)" : "var(--dd-chart-muted)"),
            }}
          />
        ))}
      </div>
      <span className={cx("shrink-0 text-caption tabular-nums", out ? "text-on-primary/70" : "text-ink-3")}>{clockDuration(durationMs)}</span>
    </div>
  );
}

/**
 * Plays `text` in the creator's speaking voice (the first characters a preview
 * allows); pressing again stops it. Leaving the screen stops playback, even a
 * preview that is still loading.
 */
export function ListenButton({ text, igAccountId, label = "Listen", className }: { text: string; igAccountId?: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      audio.current?.pause();
      audio.current = null;
    };
  }, []);
  const play = async () => {
    if (state === "playing") { audio.current?.pause(); setState("idle"); return; }
    const clip = text.trim().slice(0, VOICE_CLIP_LIMITS.previewMaxChars);
    if (!clip) return;
    setState("loading");
    try {
      const preview = await appStore.previewSpeaking(clip, igAccountId);
      if (!mounted.current) return;
      audio.current?.pause();
      const player = new Audio(preview.url);
      audio.current = player;
      player.onended = () => setState("idle");
      await player.play();
      if (mounted.current) setState("playing");
    } catch (failure) {
      if (!mounted.current) return;
      setState("idle");
      toast(errorMessage(failure, "Couldn't play a preview right now."), { tone: "error" });
    }
  };
  return (
    <Button size="sm" variant="secondary" icon={state === "playing" ? Pause : Volume2} loading={state === "loading"} loadingLabel="Loading…" className={className} onClick={() => void play()}>
      {state === "playing" ? "Stop" : label}
    </Button>
  );
}

/* ── Slide to send: the human approval gate, made physical ─────────────── */

/**
 * On touch screens the creator slides a knob across the track to approve a
 * send (the gesture India already trusts from UPI apps). With a mouse or
 * keyboard it is a plain "Approve & send" button with ⌘↵. Either way the
 * accessible name is "Approve & send" and `onConfirm` runs exactly once.
 * The composer swaps it for the sending banner, so a fresh one mounts for the next send.
 */
export function SlideToSend({ onConfirm, disabled = false, label = "Slide to send", recipient, className }: {
  onConfirm: () => void;
  disabled?: boolean;
  label?: string;
  recipient: string;
  className?: string;
}) {
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const narrow = useMediaQuery("(max-width: 1023.98px)");
  const [touch, setTouch] = useState(false);
  useEffect(() => { setTouch(typeof navigator !== "undefined" && navigator.maxTouchPoints > 0); }, []);
  const coarse = coarsePointer || (touch && narrow);
  const reduced = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [max, setMax] = useState(1);
  const drag = useRef<{ start: number; from: number } | null>(null);
  const [done, setDone] = useState(false);
  const hintId = useId();

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const measure = () => setMax(Math.max(1, node.clientWidth - 60));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [coarse]);

  if (!coarse) {
    return (
      <Button
        variant="primary"
        size="lg"
        fullWidth
        disabled={disabled}
        kbd="mod+enter"
        aria-keyshortcuts="Meta+Enter Control+Enter"
        onClick={onConfirm}
        iconRight={ArrowRight}
        className={className}
      >
        Approve &amp; send
      </Button>
    );
  }

  const finish = () => {
    if (x >= max * 0.86) {
      setX(max);
      setDone(true);
      if (navigator.vibrate) navigator.vibrate(12);
      onConfirm();
    } else {
      setX(0);
    }
    drag.current = null;
  };
  const progress = Math.min(1, x / max);
  return (
    <>
    <span id={hintId} className="sr-only">Sends your reply to @{recipient}. You get a few seconds to undo.</span>
    <div
      ref={track}
      className={cx("dd-slide-track", disabled && "opacity-45", className)}
      onPointerMove={(event) => {
        if (!drag.current || disabled) return;
        setX(Math.max(0, Math.min(max, drag.current.from + event.clientX - drag.current.start)));
      }}
      onPointerUp={finish}
      onPointerCancel={() => { drag.current = null; setX(0); }}
    >
      <span className="dd-slide-fill" style={{ width: x + 60, opacity: progress, transition: drag.current ? "none" : reduced ? "none" : "width 260ms var(--ease-dd-out), opacity 260ms" }} />
      <span aria-hidden className={cx("pointer-events-none absolute inset-0 flex items-center justify-center pl-12 text-[16px] font-semibold tracking-[-0.01em]", done ? "text-on-brand" : "dd-slide-hint")} style={{ opacity: done ? 1 : 1 - progress * 1.4 }}>
        {done ? "Sending…" : `${label} to @${recipient}`}
      </span>
      <button
        type="button"
        aria-label="Approve & send"
        aria-describedby={hintId}
        disabled={disabled}
        className="dd-slide-knob"
        style={{ transform: `translateX(${x}px)`, transition: drag.current ? "none" : reduced ? "none" : "transform 300ms var(--ease-dd-spring)" }}
        onPointerDown={(event) => {
          if (disabled) return;
          (event.currentTarget.parentElement as HTMLElement).setPointerCapture(event.pointerId);
          drag.current = { start: event.clientX, from: x };
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setDone(true); onConfirm(); }
        }}
        onClick={(event) => { if (event.detail === 0) { setDone(true); onConfirm(); } }}
      >
        {done ? <CheckCheck aria-hidden size={22} /> : <ArrowRight aria-hidden size={22} strokeWidth={2.25} />}
      </button>
    </div>
    </>
  );
}

/* ── Small pieces ──────────────────────────────────────────────────────── */

/** "In your voice" provenance line for drafts — a waveform glyph, never a sparkle. */
export function VoiceProvenance({ matchPct, className }: { matchPct?: number | null; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-caption font-semibold text-recovered", className)}>
      <AudioLines aria-hidden size={14} />
      In your voice
      {typeof matchPct === "number" && <span className="font-medium text-ink-3">· {Math.round(matchPct)}% match</span>}
    </span>
  );
}

/** A stat with a label underneath, for metric strips. */
export function Stat({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="truncate text-[20px] font-semibold leading-7 tracking-[-0.02em] text-ink tabular-nums">{children}</div>
      <div className="truncate text-caption text-ink-3">{label}</div>
    </div>
  );
}

/** Pill used for small state tags ("Draft ready", "Follow-up due"). */
export function Tag({ tone = "neutral", icon, children, className }: { tone?: "neutral" | "money" | "danger" | "waiting" | "review" | "info"; icon?: ReactNode; children: ReactNode; className?: string }) {
  const tones = {
    neutral: "bg-inset text-ink-2",
    money: "bg-brand-tint text-recovered",
    danger: "bg-danger-tint text-danger",
    waiting: "bg-waiting-tint text-waiting",
    review: "bg-review-tint text-review",
    info: "bg-info-tint text-info",
  } as const;
  return <span className={cx("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption font-semibold", tones[tone], className)}>{icon}{children}</span>;
}
