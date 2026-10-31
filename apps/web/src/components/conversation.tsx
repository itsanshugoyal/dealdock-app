"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DraftChip, LearnedSignal } from "@dealdock/core";
import {
  ArrowLeft, ArrowRight, BookOpenText, CheckCheck, ChevronRight, Clock, ExternalLink, Hourglass, Info, MoreHorizontal, RefreshCw, Stamp, Undo2, UserRound, X,
} from "lucide-react";
import { useCommand } from "../lib/commands";
import { byValueDesc, chipText, compactCount, confidenceReason, confidenceWords, dayKey, dayLabel, dealTypeText, displayName, formatTime, isCommerceLabel, languageName, needsYou, replyWindowInfo, textLang } from "../lib/format";
import { useMinuteClock, useShortcut } from "../lib/keyboard";
import { errorMessage } from "../lib/snapshot";
import { runUndoable, secondsLeft, undoAction, usePendingAction, type PendingAction } from "../lib/undo";
import { appStore, useApp, useThread, type DemoMessage, type DemoThread } from "../lib/use-demo";
import type { SendResult } from "../lib/types";
import { LabelDot, ListenButton, SlideToSend, Tag, VoiceNote, VoiceProvenance } from "./kit";
import { PushPrompt } from "./pwa";
import { SaleSheet } from "./sale-sheet";
import { Button, IconButton, buttonClasses } from "./ui/button";
import { cx } from "./ui/cx";
import { Switch } from "./ui/field";
import { Skeleton } from "./ui/feedback";
import { Menu } from "./ui/menu";
import { MoneyValue } from "./ui/money-value";
import { Chip } from "./ui/selection";
import { Avatar, SenderCard, VerifiedBadge } from "./ui/sender";
import { Sheet } from "./ui/sheet";
import { toastAction } from "./ui/toast";

/** Steering chips under a draft, in the order the composer offers them. */
const COMPOSER_CHIPS: DraftChip[] = ["shorter", "warmer", "more_hinglish", "quote_rate", "ask_budget", "more_formal", "decline_politely"];

type Phase = "editing" | "sending" | "sent";

/** One conversation: history, the draft in the creator's voice, approval, and the sale. */
export function Conversation({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const account = params?.get("account");
  const { thread, row, status, error, notFound } = useThread(id);
  const view = thread ?? row;
  const { money, timezone, threads, voice, insights } = useApp();
  const now = useMinuteClock();
  const locale = money.locale ?? "en-IN";

  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  const [phase, setPhase] = useState<Phase>("editing");
  const [result, setResult] = useState<SendResult | null>(null);
  const [learned, setLearned] = useState<LearnedSignal[]>([]);
  const [busyChip, setBusyChip] = useState<DraftChip | "regenerate" | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<DraftChip | "regenerate" | null>(null);
  const [asVoice, setAsVoice] = useState(false);
  const [sheet, setSheet] = useState<"sale" | "why" | "sender" | null>(params?.get("record") === "1" ? "sale" : null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The send's undo window lives in lib/undo; its length is the creator's undo setting.
  const [sendId, setSendId] = useState<string | null>(null);
  const pendingSend = usePendingAction(sendId);
  const composer = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Load the draft into the composer whenever a new draft (or version) arrives.
  const draft = thread?.draft ?? null;
  useEffect(() => {
    if (phase !== "editing") return;
    setText(draft?.body ?? "");
    setEdited(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.version, draft?.chosenAlternative]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length, id]);
  useEffect(() => { setPhase("editing"); setResult(null); setLearned([]); setActionError(null); setAsVoice(false); }, [id]);

  // Auto-grow the draft bubble.
  useEffect(() => {
    const node = composer.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
  }, [text, phase]);

  const windowInfo = view ? replyWindowInfo(view.replyWindow, now || Date.now(), "header") : null;
  const reviewItem = view?.routedTo === "review_queue";
  const canReply = Boolean(view && view.state !== "closed" && !reviewItem && !windowInfo?.closed);
  const sendDisabled = !text.trim() || !draft || Boolean(view?.sendInFlight);

  // Neighbours for "next conversation".
  const queue = useMemo(() => threads.filter((t) => needsYou(t) && (!account || t.igAccountId === account)).sort(byValueDesc), [threads, account]);
  const next = queue.find((t) => t.id !== id) ?? null;

  const backHref = `/inbox${account ? `?account=${account}` : ""}`;

  // The store applies every write below to this conversation itself; nothing here reloads it.
  async function regenerate(chip: DraftChip | "regenerate", force = false) {
    if (!view) return;
    if (edited && !force) { setConfirmReplace(chip); return; }
    setConfirmReplace(null);
    setBusyChip(chip);
    setActionError(null);
    try {
      await appStore.generateDraft(view.id, chip === "regenerate" ? {} : { chips: [chip] });
    } catch (failure) {
      setActionError(errorMessage(failure, "DealDock couldn't write a draft right now."));
    } finally {
      setBusyChip(null);
    }
  }

  function approve() {
    if (!view || sendDisabled || phase !== "editing") return;
    const finalText = text.trim();
    const handle = view.handle;
    setPhase("sending");
    setActionError(null);
    const pending = runUndoable({
      kind: "send",
      toast: false,
      message: `Sending to @${handle}`,
      commit: async () => {
        const sent = await appStore.send(view.id, finalText, { asVoice: asVoice && view.canSendVoice });
        setResult(sent);
        setLearned(sent.learned ?? []);
      },
      onUndo: () => { setPhase("editing"); },
    });
    setSendId(pending.id);
    void pending.outcome.then((outcome) => {
      setSendId(null);
      if (outcome.status === "committed") { setPhase("sent"); setText(""); }
      else if (outcome.status === "failed") { setPhase("editing"); setActionError(errorMessage(outcome.error, "Instagram didn't accept this reply. It was not sent.")); }
      else if (outcome.status === "cancelled") { setPhase("editing"); setActionError(outcome.reason === "offline" ? "You went offline, so nothing was sent. Your draft is still here." : "Not sent. Your draft is still here."); }
      else setPhase("editing");
    });
  }

  async function moveTo(state: "open" | "waiting" | "closed") {
    if (!view) return;
    await toastAction(() => appStore.setState(view.id, state), {
      success: state === "waiting" ? `Moved to Waiting. DealDock will draft a follow-up if @${view.handle} goes quiet.` : state === "open" ? "Back in your inbox." : "Conversation closed.",
      fallback: "That didn't save. Try again.",
    });
  }
  const toggleWaiting = () => { if (view && view.state !== "closed") void moveTo(view.state === "waiting" ? "open" : "waiting"); };

  useShortcut("mod+enter", (event) => { event.preventDefault(); approve(); }, { allowInInputs: true, enabled: canReply && phase === "editing" });
  useShortcut("e", (event) => { event.preventDefault(); composer.current?.focus(); }, { enabled: canReply });
  useShortcut("r", () => void regenerate("regenerate"), { enabled: canReply && phase === "editing" });
  useShortcut("c", () => setSheet("sale"), { enabled: Boolean(view) });
  useShortcut("w", toggleWaiting, { enabled: Boolean(view) });
  // The command palette's conversation actions, for this conversation only.
  useCommand("record-sale", (detail) => { if (view && detail.threadId === id) setSheet("sale"); });
  useCommand("toggle-waiting", (detail) => { if (detail.threadId === id) toggleWaiting(); });
  useCommand("regenerate-draft", (detail) => { if (detail.threadId === id && canReply && phase === "editing") void regenerate("regenerate"); });

  if (!view) {
    if (status === "error" || notFound) {
      return (
        <div className="flex min-h-[70dvh] flex-col items-center justify-center px-8 text-center">
          <span aria-hidden className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface text-ink-3 shadow-card"><Info size={24} /></span>
          <h1 className="text-title text-ink">This conversation isn&apos;t available.</h1>
          <p className="mt-1 max-w-sm text-body text-ink-2">{notFound ? "It may belong to another workspace, or it was deleted." : error}</p>
          <Link href={backHref} className={buttonClasses({ variant: "primary", className: "mt-5" })}>Back to inbox</Link>
        </div>
      );
    }
    return <ConversationSkeleton />;
  }

  const name = displayName(view.participant, view.handle);
  const classification = view.messages.find((message) => message.classification)?.classification ?? null;
  const days = groupByDay(view.messages, now || Date.now(), locale, timezone);
  // The match shown on drafts comes from data already loaded, never a fetch of the whole voice studio.
  const voiceMatch = (voice.data && voice.data.igAccountId === view.igAccountId ? voice.data.metrics.voiceMatchPct : null) ?? insights.data?.voice.voiceMatchPct ?? null;

  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas lg:min-h-full">
      {/* Header */}
      <header className="dd-glass sticky top-0 z-30 border-b border-hairline pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-[60px] max-w-[880px] items-center gap-2 px-2 md:px-4">
          <Link href={backHref} aria-label="Back to inbox" className="dd-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink hover:bg-inset lg:hidden">
            <ArrowLeft aria-hidden size={22} />
          </Link>
          <button type="button" onClick={() => setSheet("sender")} className="dd-press flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-1 text-left hover:bg-inset">
            <Avatar handle={view.handle} name={view.participant.name} src={view.participant.avatarUrl} size={40} verified={Boolean(view.participant.verified)} />
            <span className="min-w-0">
              <h1 className="truncate text-[16px] font-semibold leading-5 tracking-[-0.01em] text-ink">
                <bdi>{name}</bdi><span className="sr-only"> @{view.handle}</span>
              </h1>
              <span className="flex min-w-0 items-center gap-1.5 truncate text-caption text-ink-3">
                {view.topLabel && <LabelDot label={view.topLabel} />}
                {view.estValueMaxMinor !== null && <><span aria-hidden>·</span><MoneyValue minor={view.estValueMinMinor ?? view.estValueMaxMinor} maxMinor={view.estValueMaxMinor} kind="estimate" className="font-semibold text-ink-2" /></>}
              </span>
            </span>
          </button>
          <Button size="sm" variant="money" icon={Stamp} className="max-md:hidden" onClick={() => setSheet("sale")}>Record a sale</Button>
          <IconButton label="Record a sale" icon={Stamp} variant="secondary" className="md:hidden" onClick={() => setSheet("sale")} />
          <Menu
            label={`More actions for @${view.handle}`}
            icon={MoreHorizontal}
            items={[
              ...(view.state === "open" ? [{ label: "Move to waiting", icon: Hourglass, kbd: "w", onSelect: () => void moveTo("waiting") }] : []),
              ...(view.state === "waiting" ? [{ label: "Back to open", icon: Undo2, kbd: "w", onSelect: () => void moveTo("open") }] : []),
              { label: "Sender details", icon: UserRound, onSelect: () => setSheet("sender") },
              ...(draft ? [{ label: "Why this draft", icon: BookOpenText, onSelect: () => setSheet("why") }] : []),
              { label: "Open in Instagram", icon: ExternalLink, onSelect: () => window.open(`https://ig.me/m/${encodeURIComponent(view.handle)}`, "_blank", "noopener") },
              ...(view.state !== "closed" ? [{ label: "Close conversation", icon: X, destructive: true, onSelect: () => void moveTo("closed") }] : []),
            ]}
          />
        </div>
      </header>

      {/* Conversation */}
      <div className="mx-auto w-full max-w-[880px] flex-1 px-3 pb-6 md:px-6">
        <ProfileHeader thread={view} onDetails={() => setSheet("sender")} classification={classification} locale={locale} />

        <ol aria-label="Conversation history" className="mt-2 flex flex-col gap-1.5">
          {days.map((day) => (
            <li key={day.key} className="flex flex-col gap-1.5">
              <p className="my-3 text-center text-caption font-semibold text-ink-3">{day.label}</p>
              <ol className="flex flex-col gap-1.5">
                {day.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} locale={locale} timezone={timezone} />
                ))}
              </ol>
            </li>
          ))}
          {view.closedDeals.map((deal) => (
            <li key={deal.id} className="dd-stamp my-3 flex justify-center">
              <span className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-4 py-2 text-label font-semibold text-recovered">
                <CheckCheck aria-hidden size={16} />
                Sale recorded · <MoneyValue minor={deal.amountMinor} mode="exact" kind="confirmed" /> · {dealTypeText(deal.dealType)}
              </span>
            </li>
          ))}
        </ol>
        <div ref={endRef} />
      </div>

      {/* Bottom: banners + composer */}
      <div className="dd-glass sticky bottom-0 z-20 border-t border-hairline pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-[880px] flex-col gap-3 px-3 pb-3 pt-3 md:px-6">
          {view.dealSignal && view.state !== "closed" && phase !== "sending" && (
            <button type="button" onClick={() => setSheet("sale")} className="dd-press flex items-center gap-3 rounded-2xl bg-brand-tint p-3 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand"><CheckCheck aria-hidden size={20} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-label font-semibold text-recovered">Looks like this closed</span>
                <span className="block truncate text-[14px] text-ink-2">&ldquo;{view.dealSignal.phrase}&rdquo;</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand px-3 py-1.5 text-label font-semibold text-on-brand">
                Record{view.dealSignal.suggestedAmountMinor ? <> <MoneyValue minor={view.dealSignal.suggestedAmountMinor} kind="neutral" className="text-on-brand" /></> : " sale"}
              </span>
            </button>
          )}
          {view.nudgeDue && phase === "editing" && (
            <div className="flex items-center gap-3 rounded-2xl bg-waiting-tint px-3 py-2.5">
              <Hourglass aria-hidden size={18} className="shrink-0 text-waiting" />
              <p className="min-w-0 flex-1 text-[14px] text-ink"><b className="font-semibold">Quiet for {view.waitingSince ? Math.max(1, Math.floor(((now || Date.now()) - view.waitingSince) / 86_400_000)) : 3} days.</b> A follow-up is drafted below.</p>
              <Button size="sm" variant="ghost" onClick={() => void toastAction(() => appStore.dismissNudge(view.id), { fallback: "Couldn't dismiss the follow-up. Try again." })}>Dismiss</Button>
            </div>
          )}

          {reviewItem ? (
            <div className="rounded-2xl bg-surface p-4 shadow-card">
              <p className="text-label font-semibold text-review">DealDock isn&apos;t sure what this is</p>
              <p className="mt-1 text-body text-ink">{classification ? confidenceWords(classification.confidence, classification.label) : "Not sure"}</p>
              <p className="text-[14px] text-ink-2">{confidenceReason(classification?.rationale ?? view.rationale)}</p>
              <Link href={`/review?item=${view.id}`} className={buttonClasses({ variant: "primary", className: "mt-3" })}>Sort it <ArrowRight aria-hidden size={16} /></Link>
            </div>
          ) : view.state === "closed" ? (
            <p className="py-2 text-center text-[14px] text-ink-2">This conversation is closed. <button type="button" className="font-semibold text-brand" onClick={() => void moveTo("open")}>Reopen</button></p>
          ) : windowInfo?.closed ? (
            <div className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-card">
              <Clock aria-hidden size={20} className="shrink-0 text-ink-3" />
              <p className="min-w-0 flex-1 text-[14px] text-ink-2"><b className="font-semibold text-ink">Instagram&apos;s reply window has closed.</b> Reply from Instagram; DealDock can&apos;t send this one.</p>
              <a href={`https://ig.me/m/${encodeURIComponent(view.handle)}`} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "primary", size: "sm", className: "shrink-0" })}>Open <ExternalLink aria-hidden size={14} /></a>
            </div>
          ) : phase === "sent" ? (
            <SentPanel
              result={result}
              learned={learned}
              handle={view.handle}
              waiting={view.state === "waiting"}
              onWaiting={() => void moveTo("waiting")}
              onDismissLearned={(key) => setLearned((items) => items.filter((item) => item.key !== key))}
              next={next}
              onNext={() => next && router.push(`/thread/${next.id}${account ? `?account=${account}` : ""}`)}
            />
          ) : (
            <>
              {/* Draft */}
              <div className="flex items-center justify-between gap-2">
                {draft ? <VoiceProvenance matchPct={voiceMatch} /> : <span className="text-caption font-semibold text-ink-3">Your reply</span>}
                <div className="flex items-center gap-1">
                  {draft && <Button size="sm" variant="ghost" icon={BookOpenText} onClick={() => setSheet("why")}>Why this draft</Button>}
                  <IconButton
                    label={draft ? "Regenerate draft" : "Generate draft"}
                    icon={RefreshCw}
                    size="sm"
                    shortcut="r"
                    disabled={busyChip !== null || phase !== "editing"}
                    className={busyChip === "regenerate" ? "[&_svg]:animate-spin" : undefined}
                    onClick={() => void regenerate("regenerate")}
                  />
                </div>
              </div>

              {confirmReplace && (
                <div role="alert" className="flex flex-wrap items-center gap-2 rounded-2xl bg-inset px-3 py-2 text-[14px] text-ink">
                  <span className="min-w-0 flex-1">Replace your edits with a new draft?</span>
                  <Button size="sm" variant="primary" onClick={() => void regenerate(confirmReplace, true)}>Replace</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmReplace(null)}>Keep mine</Button>
                </div>
              )}

              {draft || text ? (
                <div className="flex justify-end">
                  <label className="sr-only" htmlFor={`draft-${view.id}`}>Review and edit before sending</label>
                  <textarea
                    ref={composer}
                    id={`draft-${view.id}`}
                    value={text}
                    disabled={phase !== "editing"}
                    onChange={(event) => { setText(event.target.value); setEdited(true); }}
                    lang={textLang(text)}
                    rows={3}
                    className={cx(
                      "dd-bubble-draft text-message block w-full max-w-[92%] resize-none px-4 py-3 text-ink outline-none md:max-w-[80%]",
                      "focus-visible:shadow-[0_0_0_2px_var(--dd-brand),0_0_0_6px_color-mix(in_oklab,var(--dd-brand)_18%,transparent)]",
                      phase === "sending" && "opacity-60",
                    )}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-separator px-4 py-5 text-center">
                  <p className="text-[14px] text-ink-2">No draft yet. DealDock writes one in your voice, using your offers and past replies.</p>
                  <Button variant="primary" icon={RefreshCw} loading={busyChip === "regenerate"} loadingLabel="Writing…" onClick={() => void regenerate("regenerate")}>Generate draft</Button>
                </div>
              )}

              {draft && phase === "editing" && (
                <div className="dd-scroll-x -mx-3 flex gap-1.5 px-3 md:-mx-6 md:px-6" role="group" aria-label="Steer the draft">
                  {draft.alternatives.length > 1 && draft.alternatives.map((alternative, index) => (
                    <Chip
                      key={`alt-${index}`}
                      pressed={(draft.chosenAlternative ?? 0) === index}
                      title={alternative}
                      onClick={() => void toastAction(() => appStore.chooseAlternative(view.id, { draftId: draft.id, alternative: index }), { fallback: "Couldn't switch to that option. Try again." })}
                    >
                      Option {index + 1}
                    </Chip>
                  ))}
                  {COMPOSER_CHIPS.map((chip) => (
                    <Chip key={chip} variant="action" loading={busyChip === chip} disabled={busyChip !== null} onClick={() => void regenerate(chip)}>
                      {chipText(chip)}
                    </Chip>
                  ))}
                </div>
              )}

              {view.canSendVoice && phase === "editing" && draft && (
                <VoiceToggle checked={asVoice} onChange={setAsVoice} text={text} igAccountId={view.igAccountId ?? undefined} />
              )}

              {actionError && <p role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-[14px] text-danger">{actionError}</p>}

              {phase === "sending" ? (
                <SendingBanner action={pendingSend} handle={view.handle} />
              ) : (
                <SlideToSend onConfirm={approve} disabled={sendDisabled} recipient={view.handle} label={asVoice ? "Slide to send voice note" : "Slide to send"} />
              )}
              <p className="text-center text-caption text-ink-3">Nothing sends without you{windowInfo?.visible && !windowInfo.closed ? <> · <span className={cx(windowInfo.tone === "danger" || windowInfo.tone === "strong" ? "font-semibold text-danger" : undefined)}>{windowInfo.text}</span></> : null}</p>
            </>
          )}
        </div>
      </div>

      <SaleSheet open={sheet === "sale"} onClose={() => setSheet(null)} thread={view} />
      {phase === "sent" && <PushPrompt threadValueMinor={view.estValueMaxMinor ?? null} label={view.topLabel} igAccountId={view.igAccountId} />}
      <WhyDraftSheet open={sheet === "why"} onClose={() => setSheet(null)} thread={view} />
      <Sheet open={sheet === "sender"} onClose={() => setSheet(null)} title="About this sender" placement="side" initialFocus="title">
        <div className="px-5 pb-6">
          <SenderCard participant={view.participant} variant="full" source={view.source} firstMessageAt={view.messages[0]?.sentAt ?? null} />
          {classification && (
            <div className="mt-5 rounded-2xl bg-inset p-4">
              <p className="text-label font-semibold text-ink">{confidenceWords(classification.confidence, classification.label)}</p>
              <p className="mt-0.5 text-[14px] text-ink-2">{confidenceReason(classification.rationale ?? view.rationale)}</p>
              {view.estValueMaxMinor !== null && (
                <p className="mt-3 text-[14px] text-ink-2">Estimated value <MoneyValue minor={view.estValueMinMinor ?? view.estValueMaxMinor} maxMinor={view.estValueMaxMinor} kind="estimate" className="font-semibold text-ink" />. A signal from what they asked, who they are and your prices, not a promise.</p>
              )}
            </div>
          )}
        </div>
      </Sheet>
    </div>
  );
}

/* ── Pieces ────────────────────────────────────────────────────────────── */

function ProfileHeader({ thread, classification, onDetails, locale }: { thread: DemoThread; classification: DemoMessage["classification"] | null; onDetails: () => void; locale: string }) {
  const p = thread.participant;
  return (
    <section aria-label="Sender" className="flex flex-col items-center px-4 pb-2 pt-8 text-center">
      <Avatar handle={thread.handle} name={p.name} src={p.avatarUrl} size={72} />
      <p className="mt-3 flex items-center gap-1.5 text-title text-ink"><bdi>{displayName(p, thread.handle)}</bdi>{p.verified && <VerifiedBadge size={18} title="Verified" />}</p>
      <p className="text-[14px] text-ink-3">
        @{thread.handle}
        {p.followerCount !== null && <> · {compactCount(p.followerCount, locale)} followers</>}
        {p.followsYou && <> · Follows you</>}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
        {thread.topLabel && isCommerceLabel(thread.topLabel) && (
          <Tag tone="neutral" className="bg-surface shadow-card">
            <LabelDot label={thread.topLabel} />
          </Tag>
        )}
        {thread.estValueMaxMinor !== null && (
          <Tag tone="neutral" className="bg-surface shadow-card">
            <span className="text-ink-3">est.</span>
            <MoneyValue minor={thread.estValueMinMinor ?? thread.estValueMaxMinor} maxMinor={thread.estValueMaxMinor} className="font-semibold text-ink" />
          </Tag>
        )}
        {p.closedDeals > 0 && <Tag tone="money"><CheckCheck aria-hidden size={13} />Closed <MoneyValue minor={p.closedTotalMinor} kind="neutral" className="text-recovered" /> with you</Tag>}
      </div>
      {classification && (
        <button type="button" onClick={onDetails} className="mt-3 inline-flex items-center gap-1 text-caption text-ink-3 hover:text-ink-2">
          {confidenceWords(classification.confidence, classification.label)}<ChevronRight aria-hidden size={14} />
        </button>
      )}
    </section>
  );
}

function MessageBubble({ message, locale, timezone }: { message: DemoMessage; locale: string; timezone: string }) {
  const inbound = message.direction === "inbound";
  const audio = message.contentType === "audio" || message.audio;
  return (
    <li className={cx("flex flex-col", inbound ? "items-start" : "items-end")}>
      <div className={cx("max-w-[86%] px-4 py-2.5 md:max-w-[72%]", inbound ? "dd-bubble-in text-ink" : "dd-bubble-out")}>
        {audio ? (
          <div className="flex min-w-[220px] flex-col gap-2">
            <VoiceNote id={message.id} url={message.audio?.url ?? null} durationMs={message.audio?.durationMs ?? null} tone={inbound ? "in" : "out"} />
            {message.audio?.transcript && (
              <p lang={textLang(message.audio.transcript)} className={cx("border-t pt-2 text-[14px] leading-5", inbound ? "border-hairline text-ink-2" : "border-white/15 text-on-primary/80")}>
                <span className={cx("mb-0.5 block text-[11px] font-semibold uppercase tracking-[0.04em]", inbound ? "text-ink-3" : "text-on-primary/60")}>
                  Transcript{languageName(message.audio.transcriptLanguage) ? ` · ${languageName(message.audio.transcriptLanguage)}` : ""}
                </span>
                {message.audio.transcript}
              </p>
            )}
            {!message.audio?.transcript && message.text && <p className="text-message">{message.text}</p>}
          </div>
        ) : (
          <p lang={textLang(message.text)} className="text-message whitespace-pre-wrap break-words">{message.text}</p>
        )}
      </div>
      <span className="mt-0.5 px-2 text-[11px] text-ink-3">
        {formatTime(message.sentAt, locale, timezone)}
        {!inbound && message.origin === "dealdock" && " · Sent with DealDock"}
      </span>
    </li>
  );
}

/** Messages by calendar day in the org's zone, headed "Today", "Yesterday" or "Mon 12 Oct". */
function groupByDay(messages: DemoMessage[], now: number, locale: string, timezone: string) {
  const days: Array<{ key: string; label: string; messages: DemoMessage[] }> = [];
  for (const message of [...messages].sort((a, b) => a.sentAt - b.sentAt)) {
    const key = dayKey(message.sentAt, timezone);
    const last = days[days.length - 1];
    if (last && last.key === key) last.messages.push(message);
    else days.push({ key, label: dayLabel(message.sentAt, now, locale, timezone, "short"), messages: [message] });
  }
  return days;
}

function VoiceToggle({ checked, onChange, text, igAccountId }: { checked: boolean; onChange: (value: boolean) => void; text: string; igAccountId?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-surface px-3 py-2 shadow-card">
      <Switch checked={checked} onChange={onChange} label={<span className="text-[14px] font-semibold">Send as a voice note in your voice</span>} className="flex-1 items-center" />
      <ListenButton text={text} igAccountId={igAccountId} />
    </div>
  );
}

/**
 * The send's undo window: it counts down the creator's undo setting (5, 10 or
 * 20 s). Undo stops being offered once the reply has gone to Instagram.
 */
function SendingBanner({ action, handle }: { action: PendingAction | null; handle: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <div role="status" className="relative flex h-[60px] items-center gap-3 overflow-hidden rounded-full bg-brand px-5 text-on-brand">
      {action && <span aria-hidden className="dd-drain absolute inset-x-0 bottom-0 h-1 bg-on-brand/40" style={{ ["--dd-drain" as string]: `${action.seconds}s` }} />}
      <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">
        Sending to @{handle}
        {action && <><span aria-hidden> in {secondsLeft(action, now)}s</span><span className="sr-only">. You have {action.seconds} seconds to undo.</span></>}
      </span>
      <button type="button" disabled={!action} onClick={() => { if (action) undoAction(action.id); }} className="dd-press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-on-brand px-4 text-label font-semibold text-brand disabled:opacity-60">
        <Undo2 aria-hidden size={16} />Undo
      </button>
    </div>
  );
}

function SentPanel({ result, learned, handle, waiting, onWaiting, onDismissLearned, next, onNext }: {
  result: SendResult | null;
  learned: LearnedSignal[];
  handle: string;
  waiting: boolean;
  onWaiting: () => void;
  onDismissLearned: (key: string) => void;
  next: DemoThread | null;
  onNext: () => void;
}) {
  const uncertain = result?.pending || result?.ambiguous;
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        <span className="dd-stamp flex h-7 w-7 items-center justify-center rounded-full bg-brand text-on-brand"><CheckCheck aria-hidden size={16} /></span>
        {uncertain ? <>Approval recorded. Instagram hasn&apos;t confirmed it yet; DealDock won&apos;t send it again.</> : <>Reply sent to @{handle}</>}
      </p>
      {learned.map((signal) => <LearnedHint key={signal.key} signal={signal} onDone={() => onDismissLearned(signal.key)} />)}
      <div className="flex flex-wrap gap-2">
        {!waiting && <Button variant="secondary" icon={Hourglass} onClick={onWaiting}>Move to waiting</Button>}
        {next && <Button variant="primary" iconRight={ArrowRight} onClick={onNext}>Next: @{next.handle}</Button>}
      </div>
    </div>
  );
}

function LearnedHint({ signal, onDone }: { signal: LearnedSignal; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const keep = async () => {
    setBusy(true);
    const kept = await toastAction(() => appStore.createRule({ text: signal.text, key: signal.key, scope: signal.scope, status: "active" }), {
      success: "Added to Your voice. Drafts will do this from now on.",
      fallback: "Couldn't save that. Try again.",
    });
    setBusy(false);
    if (kept) onDone();
  };
  return (
    <div className="dd-rise flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-3 shadow-card">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-recovered"><BookOpenText aria-hidden size={18} /></span>
      <p className="min-w-0 flex-1 text-[14px] text-ink"><b className="font-semibold">Noted:</b> {signal.text}</p>
      <div className="flex gap-1.5">
        <Button size="sm" variant="money" loading={busy} onClick={() => void keep()}>Keep it</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Not me</Button>
      </div>
    </div>
  );
}

function WhyDraftSheet({ open, onClose, thread }: { open: boolean; onClose: () => void; thread: DemoThread }) {
  const context = thread.draft?.context ?? null;
  return (
    <Sheet open={open} onClose={onClose} title="Why this draft" placement="side" initialFocus="title" description="What DealDock used to write it. It never invents prices, dates or availability.">
      <div className="flex flex-col gap-5 px-5 pb-6">
        {!context ? <p className="text-body text-ink-2">This draft was written before DealDock started recording its sources.</p> : (
          <>
            {context.rules.length > 0 && (
              <WhySection title="Your rules it followed">
                <ul className="flex flex-col gap-1.5">{context.rules.map((rule) => <li key={rule.id} className="rounded-xl bg-inset px-3 py-2 text-[14px] text-ink">{rule.text}</li>)}</ul>
              </WhySection>
            )}
            {context.exemplars.length > 0 && (
              <WhySection title="Your past replies it learned from">
                <ul className="flex flex-col gap-2">
                  {context.exemplars.map((exemplar) => (
                    <li key={exemplar.messageId} className="flex flex-col items-end gap-1">
                      {exemplar.inboundText && <span className="dd-bubble-in max-w-[90%] self-start px-3 py-2 text-[13px] text-ink-2">{exemplar.inboundText}</span>}
                      <span className="dd-bubble-out max-w-[90%] px-3 py-2 text-[13px]">{exemplar.text}</span>
                    </li>
                  ))}
                </ul>
              </WhySection>
            )}
            {context.offers.length > 0 && (
              <WhySection title="Offers it used">
                <div className="flex flex-wrap gap-1.5">{context.offers.map((offer) => <Tag key={offer.id} tone="money">{offer.name}</Tag>)}</div>
              </WhySection>
            )}
            {context.lessons.length > 0 && (
              <WhySection title="Lessons from your edits">
                <ul className="list-disc space-y-1 pl-5 text-[14px] text-ink-2">{context.lessons.map((lesson) => <li key={lesson}>{lesson}</li>)}</ul>
              </WhySection>
            )}
            {context.missingFacts.length > 0 && (
              <div className="rounded-2xl bg-waiting-tint p-4">
                <p className="text-label font-semibold text-waiting">Missing facts</p>
                <p className="mt-1 text-[14px] text-ink">The draft asks instead of guessing: {context.missingFacts.join(", ")}.</p>
                <Link href="/offers" className="mt-2 inline-flex items-center gap-1 text-label font-semibold text-brand">Add it to your offers <ArrowRight aria-hidden size={14} /></Link>
              </div>
            )}
          </>
        )}
        <Link href="/voice" className="inline-flex items-center gap-1 text-label font-semibold text-brand">See everything DealDock learned <ArrowRight aria-hidden size={14} /></Link>
      </div>
    </Sheet>
  );
}

function WhySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-micro uppercase text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function ConversationSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pt-6">
      <div className="flex items-center gap-3"><Skeleton className="h-10 w-10 rounded-full" /><Skeleton className="h-5 w-40" /></div>
      <div className="flex flex-col items-center gap-3 py-6"><Skeleton className="h-[72px] w-[72px] rounded-full" /><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-32" /></div>
      <Skeleton className="h-16 w-3/4 rounded-[20px]" />
      <Skeleton className="ml-auto h-24 w-2/3 rounded-[20px]" />
    </div>
  );
}
