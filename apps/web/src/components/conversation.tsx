"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EMPTY_DEAL_TERMS, invoiceProof, isDealOpen, type DealDto, type DraftChip, type DraftPurpose, type ExclusivityNote, type InvoiceDto, type LeadEventDto, type LearnedSignal } from "@dealdock/core";
import {
  ArrowLeft, ArrowRight, BookOpenText, CheckCheck, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink, FileText, Handshake, Hourglass, Info, Link2, Mail, MoreHorizontal, RefreshCw, ShieldAlert, Undo2, UserRound, X,
} from "lucide-react";
import { useCommand } from "../lib/commands";
import { atHandle, byValueDesc, chipText, compactCount, confidenceReason, confidenceWords, dayKey, dayLabel, dealTypeText, displayName, fileSize, formatDate, formatTime, isCommerceLabel, languageName, needsYou, replyWindowInfo, textLang } from "../lib/format";
import { useMinuteClock, useShortcut } from "../lib/keyboard";
import { conversationHref, inboxHref } from "../lib/inbox-navigation";
import { errorMessage } from "../lib/snapshot";
import { runUndoable, secondsLeft, undoAction, usePendingAction, type PendingAction } from "../lib/undo";
import { appStore, useApp, useEmailAccounts, useThread, type DemoMessage, type DemoThread } from "../lib/use-demo";
import type { SendResult } from "../lib/types";
import { LabelDot, ListenButton, ScamWarning, SlideToSend, Tag, VoiceNote, VoiceProvenance } from "./kit";
import { PushPrompt } from "./pwa";
import { ConversationDeals, DealSheet } from "./deals";
import { PaymentBanner, StageControl } from "./pipeline";
import { downloadInvoice, InvoicePreviewSheet } from "./invoices";
import { Button, IconButton, buttonClasses } from "./ui/button";
import { cx } from "./ui/cx";
import { Switch } from "./ui/field";
import { Skeleton } from "./ui/feedback";
import { Menu } from "./ui/menu";
import { MoneyValue } from "./ui/money-value";
import { Chip } from "./ui/selection";
import { Avatar, SenderCard, VerifiedBadge } from "./ui/sender";
import { Sheet } from "./ui/sheet";
import { toast, toastAction } from "./ui/toast";

/** Steering chips under a draft, in the order the composer offers them. */
const COMPOSER_CHIPS: DraftChip[] = ["shorter", "warmer", "more_hinglish", "quote_rate", "ask_budget", "more_formal", "decline_politely"];
/** A recap or reminder restates agreed money: quoting a rate, asking a budget or declining don't fit it. */
const PRICE_CHIPS: DraftChip[] = ["quote_rate", "ask_budget", "decline_politely"];
const PURPOSE_TEXT: Record<DraftPurpose, string> = { recap: "Terms recap", payment_reminder: "Payment reminder", invoice: "Invoice note", usage_renewal: "Usage rights", renewal: "Pitch again" };

type Phase = "editing" | "sending" | "sent";

/** One conversation: history, the draft in the creator's voice, approval, and the sale. */
export function Conversation({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const account = params?.get("account");
  const { thread, row, status, error, notFound } = useThread(id);
  const view = thread ?? row;
  const { money, timezone, threads, voice, settings } = useApp();
  const now = useMinuteClock();
  const locale = money.locale ?? "en-IN";

  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  const [phase, setPhase] = useState<Phase>("editing");
  const [result, setResult] = useState<SendResult | null>(null);
  const [learned, setLearned] = useState<LearnedSignal[]>([]);
  const [busyChip, setBusyChip] = useState<DraftChip | "regenerate" | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<DraftChip | "regenerate" | number | { dealId: string; purpose: DraftPurpose; invoiceId?: string } | null>(null);
  // The deal the current recap or reminder is for (a draft doesn't say), and the one being written now.
  const [purposeDeal, setPurposeDeal] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [asVoice, setAsVoice] = useState(false);
  // Extra reply options stay open for one draft version; a new draft starts collapsed.
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"deal" | "why" | "sender" | null>(params?.get("record") === "1" ? "deal" : null);
  // A payment a tool reported, being recorded as the sale: it prefills the deal sheet.
  const [recording, setRecording] = useState<LeadEventDto | null>(null);
  const [previewing, setPreviewing] = useState<InvoiceDto | null>(null);
  // The invoice a note was approved with: the sent panel says whether its PDF went too.
  const [sentInvoice, setSentInvoice] = useState<InvoiceDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The send's undo window lives in lib/undo; its length is the creator's undo setting.
  const [sendId, setSendId] = useState<string | null>(null);
  const pendingSend = usePendingAction(sendId);
  const composer = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Load the draft into the composer whenever a new draft (or version) arrives.
  const draft = thread?.draft ?? null;
  // An invoice's cover note sends that invoice's PDF with it.
  const draftInvoice = draft?.invoiceId ? thread?.deals.flatMap((deal) => deal.invoices ?? []).find((invoice) => invoice.id === draft.invoiceId) ?? null : null;
  // A new draft grows the composer, which would cover the last message: scroll to the end again once it has grown.
  const revealEnd = useRef(false);
  useEffect(() => {
    if (phase !== "editing") return;
    setText(draft?.body ?? "");
    setEdited(false);
    revealEnd.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.version, draft?.chosenAlternative]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length, thread?.deals.length, id]);
  useEffect(() => { setPhase("editing"); setResult(null); setLearned([]); setActionError(null); setAsVoice(false); setPurposeDeal(null); }, [id]);

  // Auto-grow the draft bubble.
  useEffect(() => {
    const node = composer.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
    if (revealEnd.current) { revealEnd.current = false; endRef.current?.scrollIntoView({ block: "end" }); }
  }, [text, phase]);

  const windowInfo = view ? replyWindowInfo(view.replyWindow, now || Date.now(), "header") : null;
  const reviewItem = view?.routedTo === "review_queue";
  const email = view?.channel === "email";
  // An email thread belongs to its creator's account but sends from their Gmail inbox: that inbox's health is what matters.
  const inboxes = useEmailAccounts(email);
  const inbox = email ? inboxes.data?.accounts.find((item) => item.ownerAccountId === view?.igAccountId) : undefined;
  const accountConnection = email ? undefined : settings.data?.accounts.find((item) => item.id === view?.igAccountId);
  const needsReconnect = email ? inbox?.status === "token_expired" : Boolean(accountConnection && accountConnection.status !== "active");
  const recipient = view ? atHandle(view.handle) : "";
  const scam = Boolean(view?.scamReason);
  const writingConsent = settings.data?.voiceConsent.find((item) => item.igAccountId === view?.igAccountId)?.consented;
  // A closed conversation still takes a recap or a payment reminder for one of its deals.
  const canReply = Boolean(view && (view.state !== "closed" || draft?.purpose) && !reviewItem && windowInfo?.canSend && !needsReconnect && writingConsent !== false);
  const sendDisabled = !text.trim() || !draft || Boolean(view?.sendInFlight);

  // Neighbours for "next conversation".
  const queue = useMemo(() => threads.filter((t) => needsYou(t) && (!account || t.igAccountId === account)).sort(byValueDesc), [threads, account]);
  const next = queue.find((t) => t.id !== id) ?? null;

  const navigation = params ?? new URLSearchParams();
  const backHref = inboxHref(navigation);
  const creatorHandle = settings.data?.accounts.find((item) => item.id === view?.igAccountId)?.handle ?? null;
  // The creator's private rate-card link, when they made one: a brand reply can share it in one tap.
  const rateCardToken = settings.data?.accounts.find((item) => item.id === view?.igAccountId)?.rateCardToken ?? null;
  const rateCardUrl = rateCardToken && typeof window !== "undefined" ? `${window.location.origin}/rates/${encodeURIComponent(rateCardToken)}` : null;

  // The store applies every write below to this conversation itself; nothing here reloads it.
  async function regenerate(chip: DraftChip | "regenerate", force = false) {
    if (!view) return;
    if (edited && !force) { setConfirmReplace(chip); return; }
    setConfirmReplace(null);
    setBusyChip(chip);
    setActionError(null);
    // Steering a recap, reminder or invoice note keeps its job, its deal and its invoice.
    const dealId = draftInvoice?.dealId ?? draft?.dealId ?? purposeDeal ?? thread?.deals.find(isDealOpen)?.id;
    const job = draft?.purpose && dealId ? { purpose: draft.purpose, dealId, ...(draft.invoiceId ? { invoiceId: draft.invoiceId } : {}) } : {};
    try {
      await appStore.generateDraft(view.id, { ...(chip === "regenerate" ? {} : { chips: [chip] }), ...job });
    } catch (failure) {
      setActionError(errorMessage(failure, "DealDock couldn't write a draft right now."));
    } finally {
      setBusyChip(null);
    }
  }

  /** A deal's recap, payment reminder or invoice note, as a draft in the composer for the creator to approve. */
  async function draftFor(deal: DealDto, purpose: DraftPurpose, invoiceId?: string, force = false) {
    if (!view || phase === "sending") return;
    if (edited && !force) { setConfirmReplace({ dealId: deal.id, purpose, invoiceId }); return; }
    setConfirmReplace(null);
    setPurposeDeal(deal.id);
    setDrafting(deal.id);
    setActionError(null);
    setResult(null);
    setPhase("editing");
    try {
      await appStore.generateDraft(view.id, { purpose, dealId: deal.id, ...(invoiceId ? { invoiceId } : {}) });
    } catch (failure) {
      // The composer may be hidden (a closed conversation), so the failure is a toast.
      toast(errorMessage(failure, "DealDock couldn't write that message right now."), { tone: "error" });
    } finally {
      setDrafting(null);
    }
  }

  // Revenue's and Today's "Remind" open the conversation with ?remind=<deal>: draft it once, then drop the parameter.
  const remindId = params?.get("remind") ?? null;
  const reminded = useRef<string | null>(null);
  useEffect(() => {
    if (!remindId || !thread || reminded.current === remindId) return;
    reminded.current = remindId;
    const deal = thread.deals.find((item) => item.id === remindId && isDealOpen(item));
    if (deal) void draftFor(deal, "payment_reminder");
    const rest = new URLSearchParams(params?.toString() ?? "");
    rest.delete("remind");
    router.replace(`/thread/${encodeURIComponent(id)}${rest.size ? `?${rest}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remindId, thread]);

  // Today's "Draft a pitch" opens the conversation with ?pitch=<deal>: draft the renewal once, then drop the parameter.
  const pitchId = params?.get("pitch") ?? null;
  const pitched = useRef<string | null>(null);
  useEffect(() => {
    if (!pitchId || !thread || pitched.current === pitchId) return;
    pitched.current = pitchId;
    const deal = thread.deals.find((item) => item.id === pitchId && item.stage === "paid");
    if (deal) void draftFor(deal, "renewal");
    const rest = new URLSearchParams(params?.toString() ?? "");
    rest.delete("pitch");
    router.replace(`/thread/${encodeURIComponent(id)}${rest.size ? `?${rest}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pitchId, thread]);

  // Today's "Draft renewal" for usage rights opens the conversation with ?usage=<deal>: draft the note once, then drop the parameter.
  const usageId = params?.get("usage") ?? null;
  const usageNoted = useRef<string | null>(null);
  useEffect(() => {
    if (!usageId || !thread || usageNoted.current === usageId) return;
    usageNoted.current = usageId;
    // Usage rights outlast the payment: any deal that wasn't cancelled.
    const deal = thread.deals.find((item) => item.id === usageId && item.stage !== "cancelled");
    if (deal) void draftFor(deal, "usage_renewal");
    const rest = new URLSearchParams(params?.toString() ?? "");
    rest.delete("usage");
    router.replace(`/thread/${encodeURIComponent(id)}${rest.size ? `?${rest}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageId, thread]);

  /** Closed reply window: copy the draft, then send it from Instagram. Copied inside the click, before the new tab takes focus. */
  function copyDraft() {
    if (!navigator.clipboard) { toast("Couldn't copy it. Select the text and copy it yourself.", { tone: "error" }); return; }
    // Copying a renewal pitch out to Instagram is pitching them: the brand leaves Today's "Pitch again".
    const renewal = draft?.purpose === "renewal" ? draft.dealId ?? purposeDeal : null;
    void navigator.clipboard.writeText(text.trim()).then(
      () => {
        toast("Copied. Paste it into Instagram and send it there.", { tone: "success" });
        if (renewal) void appStore.handleRenewal(renewal, "copied").catch(() => toast("Copied, but DealDock couldn't take it off Today. Use Not now there.", { tone: "error" }));
      },
      () => toast("Couldn't copy it. Select the text and copy it yourself.", { tone: "error" }),
    );
  }

  /** "Send your rates": the rate-card link goes into the draft on its own line, with no new draft written. */
  function addRateCard() {
    if (!rateCardUrl) return;
    setText((current) => (current.includes(rateCardUrl) ? current : `${current.trimEnd()}${current.trim() ? "\n" : ""}${rateCardUrl}`));
    setEdited(true);
    composer.current?.focus();
  }

  async function chooseAlternative(index: number, force = false) {
    if (!view || !draft) return;
    if (edited && !force) { setConfirmReplace(index); return; }
    setConfirmReplace(null);
    setBusyChip("regenerate");
    setActionError(null);
    try {
      await appStore.chooseAlternative(view.id, { draftId: draft.id, alternative: index });
    } catch (failure) {
      setActionError(errorMessage(failure, "Couldn't switch to that option. Try again."));
    } finally {
      setBusyChip(null);
    }
  }

  function approve() {
    if (!view || sendDisabled || phase !== "editing") return;
    const finalText = text.trim();
    const handle = view.handle;
    setSentInvoice(draftInvoice);
    setPhase("sending");
    setActionError(null);
    const pending = runUndoable({
      kind: "send",
      toast: false,
      message: `Sending to ${atHandle(handle)}`,
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
      else if (outcome.status === "failed") { setPhase("editing"); setActionError(errorMessage(outcome.error, view.channel === "email" ? "The email wasn't sent. Try again." : "Instagram didn't accept this reply. It was not sent.")); }
      else if (outcome.status === "cancelled") { setPhase("editing"); setActionError(outcome.reason === "offline" ? "You went offline, so nothing was sent. Your draft is still here." : "Not sent. Your draft is still here."); }
      else setPhase("editing");
    });
  }

  async function moveTo(state: "open" | "waiting" | "closed") {
    if (!view) return;
    await toastAction(() => appStore.setState(view.id, state), {
      success: state === "waiting" ? `Moved to Waiting. DealDock will draft a follow-up if ${atHandle(view.handle)} goes quiet.` : state === "open" ? "Back in your inbox." : "Conversation closed.",
      fallback: "That didn't save. Try again.",
    });
  }
  const toggleWaiting = () => { if (view && view.state !== "closed") void moveTo(view.state === "waiting" ? "open" : "waiting"); };

  useShortcut("mod+enter", (event) => { event.preventDefault(); approve(); }, { allowInInputs: true, enabled: canReply && phase === "editing" });
  useShortcut("e", (event) => { event.preventDefault(); composer.current?.focus(); }, { enabled: canReply });
  useShortcut("r", () => void regenerate("regenerate"), { enabled: canReply && phase === "editing" });
  useShortcut("c", () => setSheet("deal"), { enabled: Boolean(view) });
  useShortcut("w", toggleWaiting, { enabled: Boolean(view) });
  // The command palette's conversation actions, for this conversation only.
  useCommand("record-sale", (detail) => { if (view && detail.threadId === id) setSheet("deal"); });
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
  const voiceMatch = voice.data?.igAccountId === view.igAccountId ? voice.data.metrics.voiceMatchPct : null;
  // Asked before a new draft replaces the creator's edits, in either composer.
  const replaceAlert = confirmReplace !== null && (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-2xl bg-inset px-3 py-2 text-[14px] text-ink">
      <span className="min-w-0 flex-1">Replace your edits with a new draft?</span>
      <Button size="sm" variant="primary" onClick={() => {
        if (typeof confirmReplace === "number") void chooseAlternative(confirmReplace, true);
        else if (typeof confirmReplace === "object") { const deal = thread?.deals.find((item) => item.id === confirmReplace.dealId); if (deal) void draftFor(deal, confirmReplace.purpose, confirmReplace.invoiceId, true); else setConfirmReplace(null); }
        else void regenerate(confirmReplace, true);
      }}>Replace</Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirmReplace(null)}>Keep mine</Button>
    </div>
  );

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
                <bdi>{name}</bdi>{view.participant.name?.trim() && !email && <span className="sr-only"> {recipient}</span>}
              </h1>
              <span className="flex min-w-0 items-center gap-1.5 truncate text-caption text-ink-3">
                {email ? <bdi className="truncate">{view.handle}</bdi> : creatorHandle ? <>Replying as <bdi className="font-semibold text-ink-2">@{creatorHandle}</bdi></> : view.topLabel && <LabelDot label={view.topLabel} />}
              </span>
            </span>
          </button>
          {/* A possible scam gets no prompt to record a deal; the menu still has it. */}
          {!scam && <Button size="sm" variant="money" icon={Handshake} className="max-md:hidden" onClick={() => setSheet("deal")}>Record a deal</Button>}
          {!scam && <IconButton label="Record a deal" icon={Handshake} variant="secondary" className="md:hidden" onClick={() => setSheet("deal")} />}
          <Menu
            label={`More actions for ${recipient}`}
            icon={MoreHorizontal}
            items={[
              ...(view.state === "open" ? [{ label: "Move to waiting", icon: Hourglass, kbd: "w", onSelect: () => void moveTo("waiting") }] : []),
              ...(view.state === "waiting" ? [{ label: "Back to open", icon: Undo2, kbd: "w", onSelect: () => void moveTo("open") }] : []),
              ...(scam ? [{ label: "Record a deal", icon: Handshake, kbd: "c", onSelect: () => setSheet("deal") }] : []),
              { label: "Sender details", icon: UserRound, onSelect: () => setSheet("sender") },
              ...(draft ? [{ label: "Why this draft", icon: BookOpenText, onSelect: () => setSheet("why") }] : []),
              ...(email ? [] : [{ label: "Open in Instagram", icon: ExternalLink, onSelect: () => window.open(`https://ig.me/m/${encodeURIComponent(view.handle)}`, "_blank", "noopener") }]),
              ...(view.state !== "closed" ? [{ label: "Close conversation", icon: X, destructive: true, onSelect: () => void moveTo("closed") }] : []),
            ]}
          />
        </div>
        {(view.scamReason || (email && view.subject)) && (
          <div className="mx-auto flex max-w-[880px] flex-col gap-2 px-3 pb-2.5 md:px-6">
            {email && view.subject && <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink"><Mail aria-hidden size={16} className="shrink-0 text-ink-3" /><span className="sr-only">Subject: </span><bdi className="truncate" title={view.subject}>{view.subject}</bdi></p>}
            {view.scamReason && <ScamWarning reason={view.scamReason} />}
          </div>
        )}
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
        {thread && <ConversationDeals thread={thread} now={now || Date.now()} drafting={drafting} onDraft={(deal, purpose, invoiceId) => void draftFor(deal, purpose, invoiceId)} />}
        {thread?.exclusivities?.length ? <ExclusivityWarning notes={thread.exclusivities} locale={locale} timezone={timezone} /> : null}
      </div>

      {/* Bottom: banners + composer */}
      <div className="dd-glass sticky bottom-0 z-20 border-t border-hairline pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-[880px] flex-col gap-3 px-3 pb-3 pt-3 md:px-6">
          {phase !== "sending" && thread?.leadPayments?.map((payment) => (
            <PaymentBanner key={payment.id} payment={payment} onRecord={() => { setRecording(payment); setSheet("deal"); }} />
          ))}
          {view.dealSignal && view.state !== "closed" && phase !== "sending" && !scam && !thread?.leadPayments?.length && (
            <button type="button" onClick={() => setSheet("deal")} className="dd-press flex items-center gap-3 rounded-2xl bg-brand-tint p-3 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand"><CheckCheck aria-hidden size={20} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-label font-semibold text-recovered">Looks like this closed</span>
                <span className="block truncate text-[14px] text-ink-2">&ldquo;{view.dealSignal.phrase}&rdquo;</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand px-3 py-1.5 text-label font-semibold text-on-brand">
                Record{view.dealSignal.suggestedAmountMinor ? <> <MoneyValue minor={view.dealSignal.suggestedAmountMinor} className="text-on-brand" /></> : " deal"}
              </span>
            </button>
          )}
          {view.nudgeDue && phase === "editing" && (
            <div className="flex items-center gap-3 rounded-2xl bg-waiting-tint px-3 py-2.5">
              <Hourglass aria-hidden size={18} className="shrink-0 text-waiting" />
              <p className="min-w-0 flex-1 text-[14px] text-ink"><b className="font-semibold">Quiet for {view.waitingSince ? Math.max(1, Math.floor(((now || Date.now()) - view.waitingSince) / 86_400_000)) : 3} days.</b> {windowInfo?.closed ? "Follow up in Instagram; this reply window has closed." : needsReconnect ? `Reconnect ${email ? "this inbox" : "Instagram"} before replying.` : draft ? "Review the follow-up below before sending." : "A follow-up is due. Generate a draft when you're ready."}</p>
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
          ) : view.state === "closed" && !draft?.purpose && phase === "editing" ? (
            drafting
              ? <p role="status" className="py-2 text-center text-[14px] text-ink-2">Writing it in your voice…</p>
              : <p className="py-2 text-center text-[14px] text-ink-2">This conversation is closed. <button type="button" className="font-semibold text-brand" onClick={() => void moveTo("open")}>Reopen</button></p>
          ) : needsReconnect ? (
            <div role="status" className="rounded-2xl bg-waiting-tint p-4">
              <p className="text-label font-semibold text-ink">Reconnect {email ? <bdi>{inbox?.address}</bdi> : <>@{accountConnection?.handle}</>} to reply.</p>
              <p className="mt-1 text-[14px] text-ink-2">Your conversation stays here. DealDock can&apos;t send while this {email ? "Gmail inbox" : "Instagram account"} is disconnected.</p>
              <Link href={email ? "/settings#email" : "/settings#instagram"} className={buttonClasses({ variant: "primary", size: "sm", className: "mt-3" })}>{email ? "Reconnect Gmail" : "Reconnect Instagram"}</Link>
            </div>
          ) : windowInfo && !windowInfo.canSend && !windowInfo.closed ? (
            <div role="status" className="rounded-2xl bg-inset p-4 text-[14px] text-ink-2">
              <p>Instagram hasn't supplied a valid reply window for this conversation. DealDock can't approve a send yet.</p>
              <a href={`https://ig.me/m/${encodeURIComponent(view.handle)}`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold text-ink underline underline-offset-4">Open in Instagram <ExternalLink aria-hidden size={14} /></a>
            </div>
          ) : windowInfo?.closed && draft?.purpose && phase === "editing" ? (
            <div className="flex flex-col gap-3">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-label font-semibold text-ink">{PURPOSE_TEXT[draft.purpose]}</span><VoiceProvenance matchPct={voiceMatch} /></span>
              {replaceAlert}
              <div className="flex justify-end">
                <label className="sr-only" htmlFor={`handoff-${view.id}`}>Edit before copying</label>
                <textarea
                  ref={composer}
                  id={`handoff-${view.id}`}
                  value={text}
                  onChange={(event) => { setText(event.target.value); setEdited(true); }}
                  lang={textLang(text)}
                  rows={3}
                  className="dd-bubble-draft text-message block min-h-[92px] w-full max-w-[94%] resize-none px-4 py-3 text-ink outline-none [field-sizing:content] max-h-[40dvh] focus-visible:shadow-[0_0_0_2px_var(--dd-brand),0_0_0_6px_color-mix(in_oklab,var(--dd-brand)_18%,transparent)] md:max-w-[84%]"
                />
              </div>
              {draftInvoice && <InvoiceChip invoice={draftInvoice} onOpen={() => setPreviewing(draftInvoice)} />}
              <p className="flex items-start gap-2 text-[14px] text-ink-2"><Clock aria-hidden size={18} className="mt-0.5 shrink-0 text-ink-3" /><span><b className="font-semibold text-ink">Instagram&apos;s reply window has closed.</b> {draftInvoice ? "Download the PDF, copy this note, and send both from Instagram yourself." : "Copy this message and send it from Instagram yourself."}</span></p>
              {draftInvoice && <Button variant="secondary" size="lg" fullWidth icon={Download} onClick={() => void downloadInvoice(draftInvoice)}>Download {draftInvoice.number}.pdf</Button>}
              <a href={`https://ig.me/m/${encodeURIComponent(view.handle)}`} target="_blank" rel="noopener noreferrer" onClick={copyDraft} className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}>
                <Copy aria-hidden size={18} className="shrink-0" />Copy and open Instagram
              </a>
            </div>
          ) : windowInfo?.closed ? (
            <div className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-card">
              <Clock aria-hidden size={20} className="shrink-0 text-ink-3" />
              <p className="min-w-0 flex-1 text-[14px] text-ink-2"><b className="font-semibold text-ink">Instagram&apos;s reply window has closed.</b> Reply from Instagram; DealDock can&apos;t send this one.</p>
              <a href={`https://ig.me/m/${encodeURIComponent(view.handle)}`} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "primary", size: "sm", className: "shrink-0" })}>Open <ExternalLink aria-hidden size={14} /></a>
            </div>
          ) : writingConsent === false && phase === "editing" && !view.sendInFlight ? (
            <div role="status" className="rounded-2xl bg-inset p-4">
              <p className="text-label font-semibold text-ink">Writing-style permission is off for {creatorHandle ? `@${creatorHandle}` : "this creator"}.</p>
              <p className="mt-1 text-[14px] text-ink-2">Your inbox and revenue tracking still work. Review the examples and permissions in Your voice before enabling drafts.</p>
              <Link href={`/voice${view.igAccountId ? `?account=${encodeURIComponent(view.igAccountId)}` : ""}`} className={buttonClasses({ variant: "primary", size: "sm", className: "mt-3" })}>Review writing permissions</Link>
            </div>
          ) : phase === "sent" ? (
            <SentPanel
              result={result}
              attachment={sentInvoice}
              learned={learned}
              recipient={recipient}
              email={email}
              igAccountId={view.igAccountId}
              waiting={view.state !== "open"}
              onWaiting={() => void moveTo("waiting")}
              onDismissLearned={(key) => setLearned((items) => items.filter((item) => item.key !== key))}
              next={next}
              onNext={() => next && router.push(conversationHref(next.id, navigation))}
            />
          ) : (
            <>
              {/* Draft */}
              <div className="flex items-center justify-between gap-2">
                {draft ? <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span className="text-label font-semibold text-ink">{draft.purpose ? PURPOSE_TEXT[draft.purpose] : email ? "Email reply" : "Reply draft"}</span><VoiceProvenance matchPct={voiceMatch} />{edited && <span role="status" className="text-caption text-ink-3">Edited by you</span>}</span> : <span className="text-caption font-semibold text-ink-3">Your reply</span>}
                <div className="flex items-center gap-1">
                  {draft && <Button size="sm" variant="ghost" icon={BookOpenText} onClick={() => setSheet("why")}>Why this draft</Button>}
                  {draft && (
                    <IconButton
                      label="Regenerate draft"
                      icon={RefreshCw}
                      size="sm"
                      shortcut="r"
                      disabled={busyChip !== null || phase !== "editing"}
                      className={busyChip === "regenerate" ? "[&_svg]:animate-spin" : undefined}
                      onClick={() => void regenerate("regenerate")}
                    />
                  )}
                </div>
              </div>

              {replaceAlert}

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
                      // Grows with the draft (field-sizing), within limits; older browsers keep the three rows.
                      "dd-bubble-draft text-message block min-h-[92px] w-full max-w-[94%] resize-none px-4 py-3 text-ink outline-none [field-sizing:content] max-h-[40dvh] md:max-w-[84%]",
                      "focus-visible:shadow-[0_0_0_2px_var(--dd-brand),0_0_0_6px_color-mix(in_oklab,var(--dd-brand)_18%,transparent)]",
                      phase === "sending" && "opacity-60",
                    )}
                  />
                </div>
              ) : scam ? (
                <p className="rounded-2xl border border-dashed border-separator px-4 py-4 text-center text-[14px] text-ink-2">DealDock doesn&apos;t draft replies to messages that look like scams. If you know this sender, reply from {email ? "your email" : "Instagram"}.</p>
              ) : (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-separator px-4 py-5 text-center">
                  <p className="text-[14px] text-ink-2">No draft yet. DealDock writes one in your voice, using your offers and past replies.</p>
                  <Button variant="primary" icon={RefreshCw} loading={busyChip === "regenerate"} loadingLabel="Writing…" onClick={() => void regenerate("regenerate")}>Generate draft</Button>
                </div>
              )}
              {draftInvoice && <InvoiceChip invoice={draftInvoice} onOpen={() => setPreviewing(draftInvoice)} />}

              {draft && phase === "editing" && (
                <div className="flex flex-col gap-2" role="group" aria-label="Steer the draft">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(draft.purpose ? (["shorter", "warmer"] as const) : (["shorter", "quote_rate"] as const)).map((chip) => (
                      <Chip key={chip} variant="action" loading={busyChip === chip} disabled={busyChip !== null} onClick={() => void regenerate(chip)}>{chipText(chip)}</Chip>
                    ))}
                    {/* "Send your rates": the creator's private rate-card link, put into the draft as it is, without writing a new one. */}
                    {rateCardUrl && !draft.purpose && view.topLabel === "brand_deal" && (
                      <Chip variant="action" icon={Link2} disabled={busyChip !== null || text.includes(rateCardUrl)} onClick={addRateCard}>Add rate card link</Chip>
                    )}
                    <button
                      type="button"
                      aria-expanded={optionsFor === `${draft.id}-${draft.version}`}
                      aria-controls="more-reply-options"
                      onClick={() => setOptionsFor((open) => open === `${draft.id}-${draft.version}` ? null : `${draft.id}-${draft.version}`)}
                      className="dd-press dd-hit inline-flex h-8 items-center gap-1 rounded-full pl-3 pr-2.5 text-label font-semibold text-ink-2 hover:bg-inset hover:text-ink"
                    >
                      More reply options
                      <ChevronDown aria-hidden size={15} className={cx("transition-transform", optionsFor === `${draft.id}-${draft.version}` && "rotate-180")} />
                    </button>
                  </div>
                  {optionsFor === `${draft.id}-${draft.version}` && (
                    <div id="more-reply-options" className="dd-rise flex flex-wrap gap-1.5">
                      {draft.alternatives.length > 1 && draft.alternatives.map((alternative, index) => (
                        <Chip
                          key={`alt-${index}`}
                          pressed={(draft.chosenAlternative ?? 0) === index}
                          title={alternative}
                          disabled={busyChip !== null}
                          onClick={() => void chooseAlternative(index)}
                        >
                          Option {index + 1}
                        </Chip>
                      ))}
                      {COMPOSER_CHIPS.filter((chip) => chip !== "shorter" && (draft.purpose ? chip !== "warmer" && !PRICE_CHIPS.includes(chip) : chip !== "quote_rate")).map((chip) => (
                        <Chip key={chip} variant="action" loading={busyChip === chip} disabled={busyChip !== null} onClick={() => void regenerate(chip)}>
                          {chipText(chip)}
                        </Chip>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* An invoice goes as text with its PDF, never as a voice note. */}
              {view.canSendVoice && phase === "editing" && draft && !draftInvoice && (
                <VoiceToggle checked={asVoice} onChange={setAsVoice} text={text} igAccountId={view.igAccountId ?? undefined} />
              )}

              {actionError && <div role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-[14px] text-danger"><p>{actionError}</p>{view.igAccountId && /permission|consent/i.test(actionError) && <Link href={`/voice?account=${encodeURIComponent(view.igAccountId)}`} className="mt-2 inline-block font-semibold underline underline-offset-4">Review this creator's voice permissions</Link>}</div>}

              {phase === "sending" ? (
                <SendingBanner action={pendingSend} recipient={recipient} />
              ) : draft ? (
                <SlideToSend onConfirm={approve} disabled={sendDisabled} recipient={recipient} action={email ? "Approve & send email" : undefined} label={asVoice ? "Slide to send voice note" : email ? "Slide to send email" : "Slide to send"} />
              ) : null}
              <p className="text-center text-caption text-ink-3">Nothing sends without you{windowInfo?.visible && !windowInfo.closed ? <> · <span className={cx(windowInfo.tone === "danger" || windowInfo.tone === "strong" ? "font-semibold text-danger" : undefined)}>{windowInfo.text}</span></> : null}</p>
            </>
          )}
        </div>
      </div>
      {/* After the composer: scrolled to the very end, the sticky composer sits below the last message instead of over it. */}
      <div ref={endRef} aria-hidden />

      {/* Opens once the conversation detail is here: its closing phrase prefills the amount and whether it's paid. */}
      <DealSheet open={sheet === "deal" && thread !== null} onClose={() => { setSheet(null); setRecording(null); }} thread={thread ?? undefined} payment={recording} />
      {phase === "sent" && <PushPrompt threadValueMinor={view.estValueMaxMinor ?? null} label={view.topLabel} igAccountId={view.igAccountId} />}
      <WhyDraftSheet open={sheet === "why"} onClose={() => setSheet(null)} thread={view} />
      <InvoicePreviewSheet invoice={previewing} proof={previewing ? invoiceProof(thread?.deals.find((deal) => deal.id === previewing.dealId)?.terms ?? EMPTY_DEAL_TERMS) : null} onClose={() => setPreviewing(null)} />
      <Sheet open={sheet === "sender"} onClose={() => setSheet(null)} title="About this sender" placement="side" initialFocus="title">
        <div className="px-5 pb-6">
          <SenderCard participant={view.participant} variant="full" source={view.source} firstMessageAt={view.messages[0]?.sentAt ?? null} />
          {classification && (
            <div className="mt-5 rounded-2xl bg-inset p-4">
              <p className="text-label font-semibold text-ink">{confidenceWords(classification.confidence, classification.label)}</p>
              <p className="mt-0.5 text-[14px] text-ink-2">{confidenceReason(classification.rationale ?? view.rationale)}</p>
              {view.estValueMaxMinor !== null && !scam && (
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

/** One calm note on a brand's conversation: exclusivities this creator agreed with other brands that are still running. */
function ExclusivityWarning({ notes, locale, timezone }: { notes: ExclusivityNote[]; locale: string; timezone: string }) {
  const terms = notes.map((note) => `${note.threadId ? atHandle(note.counterpartyHandle) : note.counterpartyName?.trim() || note.counterpartyHandle} until ${formatDate(note.endsAt, locale, timezone, { day: "numeric", month: "short" })}: ‘${note.exclusivity}’`);
  return (
    <p role="note" className="mx-auto mt-4 flex w-full max-w-[560px] items-start gap-2.5 rounded-2xl bg-inset px-4 py-3 text-[14px] leading-5 text-ink">
      <ShieldAlert aria-hidden size={18} className="mt-0.5 shrink-0 text-waiting" />
      <span>You agreed to exclusivity with {terms.join(", and with ")}. Check this brand doesn't compete.</span>
    </p>
  );
}

/** The invoice PDF that goes with a cover note, under the draft like an attachment; it opens the invoice. */
function InvoiceChip({ invoice, onOpen }: { invoice: InvoiceDto; onOpen: () => void }) {
  return (
    <div className="flex justify-end">
      <button type="button" onClick={onOpen} className="dd-press flex min-h-11 min-w-0 max-w-[94%] items-center gap-2.5 rounded-2xl bg-surface px-3 py-2 text-left shadow-card hover:bg-inset md:max-w-[84%]">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-2"><FileText aria-hidden size={18} /></span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold text-ink">{invoice.number}.pdf</span>
          <span className="block text-caption text-ink-3">Attached · goes with this note</span>
        </span>
      </button>
    </div>
  );
}

function ProfileHeader({ thread, classification, onDetails, locale }: { thread: DemoThread; classification: DemoMessage["classification"] | null; onDetails: () => void; locale: string }) {
  const p = thread.participant;
  // With no display name the title is already the handle; don't repeat it underneath.
  const named = Boolean(p.name?.trim());
  const facts = [named ? atHandle(thread.handle) : null, p.followerCount !== null ? `${compactCount(p.followerCount, locale)} followers` : null, p.followsYou ? "Follows you" : null].filter(Boolean);
  // A recorded deal or sale answers what DealDock guessed; a possible scam never shows money.
  const settled = thread.deals.length > 0 || thread.closedDeals.length > 0;
  const guess = !settled && !thread.scamReason;
  return (
    // Instagram's own thread intro: who this is, then what DealDock knows, above the first message.
    <section aria-label="Sender" className="flex flex-col items-center px-4 pb-1 pt-6 text-center md:pt-8">
      <Avatar handle={thread.handle} name={p.name} src={p.avatarUrl} size={64} />
      <p className="mt-2.5 flex items-center gap-1.5 text-[18px] font-semibold leading-6 tracking-[-0.015em] text-ink"><bdi>{displayName(p, thread.handle)}</bdi>{p.verified && <VerifiedBadge size={16} title="Verified" />}</p>
      {facts.length > 0 && <p className="text-[14px] text-ink-3">{facts.join(" · ")}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
        {thread.topLabel && isCommerceLabel(thread.topLabel) && (
          <Tag tone="neutral" className="bg-surface shadow-card">
            <LabelDot label={thread.topLabel} />
          </Tag>
        )}
        {guess && thread.estValueMaxMinor !== null && (
          <Tag tone="neutral" className="bg-surface shadow-card">
            <span className="text-ink-3">est.</span>
            <MoneyValue minor={thread.estValueMinMinor ?? thread.estValueMaxMinor} maxMinor={thread.estValueMaxMinor} className="font-semibold text-ink" />
          </Tag>
        )}
        {p.closedDeals > 0 && <Tag tone="money"><CheckCheck aria-hidden size={13} />Closed <MoneyValue minor={p.closedTotalMinor} className="text-recovered" /> with you</Tag>}
      </div>
      {/* Coaching and course conversations: where they stand, set by hand (a tool that reports back moves it too). */}
      {thread.routedTo === "inbox" && <StageControl thread={thread} />}
      {classification && guess && (
        <button type="button" onClick={onDetails} className="dd-hit mt-2 inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-caption text-ink-3 hover:text-ink-2">
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
        {message.attachments && message.attachments.length > 0 && (
          <ul aria-label="Attachments" className="mt-2.5 flex flex-col gap-1.5">
            {message.attachments.map((file) => (
              <li key={file.partId}>
                <button
                  type="button"
                  onClick={() => void toastAction(() => appStore.download(`/email/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(file.partId)}`, file.filename), { fallback: "This file couldn't be downloaded. Try again." })}
                  className={cx("dd-press flex w-full min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left", inbound ? "bg-inset hover:bg-fill" : "bg-white/10 hover:bg-white/15")}
                >
                  <FileText aria-hidden size={18} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold">{file.filename}</span>
                    <span className={cx("block text-caption", inbound ? "text-ink-3" : "text-on-primary/70")}>{fileSize(file.size)} · Download</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
 * Comment leads' private replies use it too.
 */
export function SendingBanner({ action, recipient }: { action: PendingAction | null; recipient: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <div role="status" className="relative flex h-[60px] items-center gap-3 overflow-hidden rounded-full bg-brand px-5 text-on-brand">
      {action && <span aria-hidden className="dd-drain absolute inset-x-0 bottom-0 h-1 bg-on-brand/40" style={{ ["--dd-drain" as string]: `${action.seconds}s` }} />}
      <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">
        Sending to {recipient}
        {action && <><span aria-hidden> in {secondsLeft(action, now)}s</span><span className="sr-only">. You have {action.seconds} seconds to undo.</span></>}
      </span>
      <button type="button" disabled={!action} onClick={() => { if (action) undoAction(action.id); }} className="dd-press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-on-brand px-4 text-label font-semibold text-brand disabled:opacity-60">
        <Undo2 aria-hidden size={16} />Undo
      </button>
    </div>
  );
}

export function SentPanel({ result, attachment = null, learned, recipient, email = false, igAccountId, waiting, onWaiting, onDismissLearned, next, onNext }: {
  result: SendResult | null;
  /** The invoice whose PDF went with the message (an invoice's cover note). */
  attachment?: InvoiceDto | null;
  learned: LearnedSignal[];
  /** "@handle" or an email address. */
  recipient: string;
  email?: boolean;
  igAccountId: string | null;
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
        <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", uncertain ? "bg-waiting-tint text-waiting" : "dd-stamp bg-brand text-on-brand")}>{uncertain ? <Clock aria-hidden size={16} /> : <CheckCheck aria-hidden size={16} />}</span>
        {uncertain ? <>Approval recorded. {email ? "Gmail" : "Instagram"} hasn&apos;t confirmed it yet; DealDock won&apos;t send it again.</> : <>{email ? "Email" : "Reply"} sent to {recipient}</>}
      </p>
      {attachment && result?.attachmentSent && <p className="flex items-center gap-2 text-[14px] text-ink-2"><FileText aria-hidden size={16} className="shrink-0 text-ink-3" />{attachment.number}.pdf went with it.</p>}
      {result?.hint && <p role="note" className="rounded-2xl bg-waiting-tint px-3 py-2 text-[14px] text-ink">{result.hint}</p>}
      {attachment && result?.attachmentSent === false && <Button variant="secondary" icon={Download} className="self-start" onClick={() => void downloadInvoice(attachment)}>Download {attachment.number}.pdf</Button>}
      {uncertain && !email && <a href={`https://ig.me/m/${encodeURIComponent(recipient.replace(/^@/, ""))}`} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1.5 py-1 text-label font-semibold text-ink underline underline-offset-4">Check in Instagram <ExternalLink aria-hidden size={14} /></a>}
      {!uncertain && igAccountId && learned.map((signal) => <LearnedHint key={signal.key} igAccountId={igAccountId} signal={signal} onDone={() => onDismissLearned(signal.key)} />)}
      <div className="flex flex-wrap gap-2">
        {!uncertain && !waiting && <Button variant="secondary" icon={Hourglass} onClick={onWaiting}>Move to waiting</Button>}
        {next && <Button variant="primary" iconRight={ArrowRight} onClick={onNext}>Next: {atHandle(next.handle)}</Button>}
      </div>
    </div>
  );
}

function LearnedHint({ signal, igAccountId, onDone }: { signal: LearnedSignal; igAccountId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const keep = async () => {
    setBusy(true);
    const kept = await toastAction(() => appStore.createRule({ text: signal.text, key: signal.key, scope: signal.scope, status: "active", igAccountId }), {
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
    <Sheet open={open} onClose={onClose} title="Why this draft" placement="center" initialFocus="title" description="The sources and guidance supplied for this reply. Check prices, dates and availability before approving.">
      <div className="flex flex-col gap-5 pt-3">
        {!context ? <p className="text-body text-ink-2">This draft was written before DealDock started recording its sources.</p> : (
          <>
            {context.rules.length > 0 && (
              <WhySection title="Your writing rules">
                <ul className="flex flex-col gap-1.5">{context.rules.map((rule) => <li key={rule.id} className="rounded-xl bg-inset px-3 py-2 text-[14px] text-ink">{rule.text}</li>)}</ul>
              </WhySection>
            )}
            {context.exemplars.length > 0 && (
              <WhySection title="Your reply examples">
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
              <WhySection title="Offers available to the draft">
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
                <p className="mt-1 text-[14px] text-ink">Confirm these before sending: {context.missingFacts.join(", ")}.</p>
                <Link href="/offers" className="mt-2 inline-flex min-h-11 items-center gap-1 text-label font-semibold text-brand">Review your offers <ArrowRight aria-hidden size={14} /></Link>
              </div>
            )}
          </>
        )}
        {thread.igAccountId && <Link href={`/voice?account=${encodeURIComponent(thread.igAccountId)}`} className="inline-flex min-h-11 items-center gap-1 border-t border-hairline pt-3 text-label font-semibold text-brand">Review this creator&apos;s voice <ArrowRight aria-hidden size={14} /></Link>}
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
