"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  daysOverdue, dealOwedMinor, dealRevenueMinor, defaultReceivedMinor, DISCLOSURE_ITEMS, dueFromPaymentDays, EMPTY_DEAL_TERMS, hasNoMetrics, invoiceProof, invoiceRevenueMinor,
  isDealOpen, isStoryDeliverable, metricsLine, nextDeliverable, parseMoneyInput, PostUrlSchema,
  type DealDeliverable, type DealDto, type DealTerms, type DealType, type DeliverableMetrics, type DraftPurpose, type InvoiceDto, type InvoiceKind, type LeadEventDto,
} from "@dealdock/core";
import {
  Ban, BellRing, ChartNoAxesCombined, CheckCheck, ChevronDown, ChevronRight, Circle, Copy, Download, ExternalLink, Eye, FilePlus2, FileText, HandCoins, Link2, MessageSquareText, MoreHorizontal, Pencil, Plus,
  RefreshCw, ScrollText, Send, Trash2, X, type LucideIcon,
} from "lucide-react";
import {
  counterpartyOf, dealNextStep, dealPrimaryAction, dealStage, dealWith, dueWords, endOfDayIso, invoiceKinds, invoiceStatus, liveInvoices, openInvoice, owedAction, resultsText, usageNoteText, usagePriceFor,
  type DealAction,
} from "../lib/deals";
import { atHandle, dayKey, dealTypeForLabel, dealTypeText, formatDate, pluralize } from "../lib/format";
import { useMinuteClock } from "../lib/keyboard";
import { errorMessage } from "../lib/snapshot";
import { appStore, useBillingProfile, useCan, useMoneyContext, useOffers, useSettings, type DemoThread } from "../lib/use-demo";
import { downloadInvoice, InvoicePreviewSheet, InvoiceSheet, VoidInvoiceDialog } from "./invoices";
import { Tag } from "./kit";
import { paidWords } from "./pipeline";
import { Disclosure, SaveError, useLast } from "./sheet-parts";
import { Button, IconButton, buttonClasses } from "./ui/button";
import { cx } from "./ui/cx";
import { DealTypeSelect, MONEY_INPUT_ERROR, MoneyField, Select, Switch, TextArea, TextField, moneyFieldText } from "./ui/field";
import { Menu, type MenuItem } from "./ui/menu";
import { formatMoney, MoneyValue } from "./ui/money-value";
import { Avatar } from "./ui/sender";
import { ConfirmDialog, Sheet } from "./ui/sheet";
import { toast, toastAction } from "./ui/toast";

/* ── Shared pieces ─────────────────────────────────────────────────────── */

function CreatorChip({ handle }: { handle: string }) {
  return <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-medium text-ink-2"><Avatar handle={handle} size={20} /><span className="truncate">@{handle}</span></span>;
}

const threadHref = (threadId: string) => `/thread/${encodeURIComponent(threadId)}`;
const remindHref = (threadId: string, dealId: string) => `${threadHref(threadId)}?remind=${encodeURIComponent(dealId)}`;

/* ── Record or edit a deal ─────────────────────────────────────────────── */

interface DeliverableRow { id: string; label: string; due: string; done: boolean }
interface DealForm {
  /** A deal agreed elsewhere: who it's with, and whose deal it is. */
  who: string;
  creator: string;
  title: string;
  amount: string;
  dealType: DealType;
  paid: boolean;
  tds: string;
  /** Date inputs hold "YYYY-MM-DD" in the org's zone, or "". */
  due: string;
  deliverables: DeliverableRow[];
  usage: string;
  /** When the usage rights and the exclusivity end: "YYYY-MM-DD" or "". */
  usageEnds: string;
  exclusivity: string;
  exclusivityEnds: string;
  revisions: string;
  advance: string;
  paymentDays: string;
  notes: string;
}
type DealErrors = Partial<Record<"who" | "creator" | "title" | "amount" | "tds" | "revisions" | "advance" | "paymentDays", string>>;

// A closing phrase about money that already moved ("Payment's done") starts the deal as paid.
const PAID_PHRASE = /\b(?:paid|payment|sent|transferred|received)\b/i;
const digits = (text: string) => text.replace(/\D/g, "").slice(0, 3);
const numberText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));
const rowId = () => `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function formFor(thread: DemoThread | undefined, deal: DealDto | null | undefined, timeZone: string, creator: string): DealForm {
  const day = (at: string | null | undefined) => (at ? dayKey(at, timeZone) : "");
  const terms = deal?.terms;
  return {
    who: "",
    creator,
    title: deal?.title ?? "",
    amount: moneyFieldText(deal ? deal.amountMinor : thread?.dealSignal?.suggestedAmountMinor),
    dealType: deal?.dealType ?? thread?.dealSignal?.suggestedDealType ?? dealTypeForLabel(thread?.topLabel),
    paid: !deal && PAID_PHRASE.test(thread?.dealSignal?.phrase ?? ""),
    tds: "",
    due: day(deal?.dueAt),
    deliverables: (terms?.deliverables ?? []).map((item) => ({ id: item.id, label: item.label, due: day(item.dueAt), done: item.done })),
    usage: terms?.usage ?? "",
    usageEnds: day(terms?.usageEndsAt),
    exclusivity: terms?.exclusivity ?? "",
    exclusivityEnds: day(terms?.exclusivityEndsAt),
    revisions: numberText(terms?.revisionsIncluded),
    advance: numberText(terms?.advancePercent),
    paymentDays: numberText(terms?.paymentDays),
    notes: terms?.notes ?? "",
  };
}

/**
 * "Record a deal" from a conversation (`thread`), "Edit deal" (`deal`), or,
 * with neither, "Add a deal" agreed outside DealDock: then who it's with and
 * (Roster) whose deal it is come first. Only what most deals need shows: what,
 * amount, type and whether it is already paid; then the due date and
 * deliverables while unpaid. Everything else waits under "More terms".
 * Filling from the chat only fills the form: the creator checks it and saves.
 */
export function DealSheet({ open, onClose, thread, deal, creators = [], igAccountId, payment = null }: {
  open: boolean;
  onClose: () => void;
  thread?: DemoThread;
  deal?: DealDto | null;
  /** Recording a payment a booking or payment tool reported in this conversation: it is handled with the sale. */
  payment?: LeadEventDto | null;
  /** "Add a deal": the creators it can be for (Roster offers a choice), and the one picked first. */
  creators?: Array<{ id: string; handle: string }>;
  igAccountId?: string;
}) {
  const { money, timezone, locale } = useMoneyContext();
  const editing = useLast(deal ?? null);
  const elsewhere = !thread && !editing;
  const reported = editing ? null : payment;
  // The reported amount fills the form only in the org's currency; otherwise the creator enters what reached them.
  const reportedMinor = reported?.amountMinor != null && reported.currencyCode === money.currency ? reported.amountMinor : null;
  const inr = money.currency === "INR";
  const handle = editing ? dealWith(editing) : thread ? atHandle(thread.handle) : null;
  // The fee is what its invoices bill shares of: it changes only once they're voided. A paid or cancelled deal keeps its fee and type.
  const settled = Boolean(editing && !isDealOpen(editing));
  const amountLocked = Boolean(editing && (liveInvoices(editing).length || settled));
  const base = formFor(thread, editing, timezone, igAccountId ?? creators[0]?.id ?? "");
  const initial = reported ? { ...base, paid: true, title: base.title || dealTypeText(base.dealType), amount: reportedMinor === null ? "" : moneyFieldText(reportedMinor) } : base;
  const start = useRef(initial);
  start.current = initial;
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<DealErrors>({});
  const [busy, setBusy] = useState(false);
  const [filling, setFilling] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tdsOpen, setTdsOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const idempotency = useRef("");
  useEffect(() => {
    if (!open) return;
    setForm(start.current);
    setErrors({});
    setMissing(null);
    setMoreOpen(false);
    setTdsOpen(false);
    setSaveError(null);
    idempotency.current = `deal-${thread?.id ?? "elsewhere"}-${Date.now()}`;
    // Resets only when the sheet opens or its subject changes, never under the creator's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, thread?.id, editing?.id, reported?.id]);

  const set = <K extends keyof DealForm>(key: K, value: DealForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setRow = (id: string, patch: Partial<DeliverableRow>) => setForm((current) => ({ ...current, deliverables: current.deliverables.map((row) => (row.id === id ? { ...row, ...patch } : row)) }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const who = counterpartyOf(form.who);

  const fill = async () => {
    if (!thread) return;
    setFilling(true);
    setSaveError(null);
    try {
      const suggestion = await appStore.suggestDeal(thread.id);
      const terms = suggestion.terms;
      const day = (at: string | null) => (at ? dayKey(at, timezone) : "");
      setForm((current) => ({
        ...current,
        title: suggestion.title ?? current.title,
        dealType: suggestion.dealType ?? current.dealType,
        amount: suggestion.amountMinor !== null ? moneyFieldText(suggestion.amountMinor) : current.amount,
        due: day(suggestion.dueAt) || current.due,
        deliverables: terms.deliverables.length ? terms.deliverables.map((item) => ({ id: item.id || rowId(), label: item.label, due: day(item.dueAt), done: item.done })) : current.deliverables,
        usage: terms.usage ?? current.usage,
        usageEnds: day(terms.usageEndsAt) || current.usageEnds,
        exclusivity: terms.exclusivity ?? current.exclusivity,
        exclusivityEnds: day(terms.exclusivityEndsAt) || current.exclusivityEnds,
        revisions: terms.revisionsIncluded !== null ? String(terms.revisionsIncluded) : current.revisions,
        advance: terms.advancePercent !== null ? String(terms.advancePercent) : current.advance,
        paymentDays: terms.paymentDays !== null ? String(terms.paymentDays) : current.paymentDays,
        notes: terms.notes ?? current.notes,
      }));
      if (terms.usage || terms.usageEndsAt || terms.exclusivity || terms.exclusivityEndsAt || terms.notes || terms.revisionsIncluded !== null || terms.advancePercent !== null || terms.paymentDays !== null) setMoreOpen(true);
      setMissing(suggestion.missing);
    } catch (failure) {
      setSaveError(errorMessage(failure, "Couldn't read the terms from this chat. Fill them in yourself."));
    } finally {
      setFilling(false);
    }
  };

  const submit = async () => {
    const next: DealErrors = {};
    const amountMinor = form.amount ? parseMoneyInput(form.amount) : null;
    const tdsMinor = form.paid && inr && form.tds ? parseMoneyInput(form.tds) : null;
    const whole = (text: string, max: number, key: keyof DealErrors, message: string) => {
      if (text && Number(text) > max) next[key] = message;
      return text ? Number(text) : null;
    };
    if (elsewhere && !who) next.who = "Say who it's with: an @handle, an email address or a name.";
    if (elsewhere && !form.creator) next.creator = "Choose whose deal it is.";
    if (!form.title.trim()) next.title = "Say what it's for, like “1 reel + 2 stories”.";
    if (!amountMinor) next.amount = MONEY_INPUT_ERROR;
    if (form.paid && inr && form.tds && (tdsMinor === null || (amountMinor !== null && tdsMinor >= amountMinor))) next.tds = "Enter tax that is less than the amount.";
    const revisionsIncluded = whole(form.revisions, 20, "revisions", "Up to 20.");
    const advancePercent = whole(form.advance, 100, "advance", "Up to 100%.");
    const paymentDays = whole(form.paymentDays, 365, "paymentDays", "Up to 365 days.");
    setErrors(next);
    if (next.revisions || next.advance || next.paymentDays) setMoreOpen(true);
    if (next.tds) setTdsOpen(true);
    if (Object.keys(next).length || !amountMinor) return;
    // A deliverable keeps its post and results through an edit; the checklist stays as ticked.
    const before = new Map((editing?.terms.deliverables ?? []).map((item) => [item.id, item]));
    const terms: DealTerms = {
      // A paid deal has nothing left to track, so it keeps no deliverables or due date.
      deliverables: form.paid ? [] : form.deliverables.filter((row) => row.label.trim()).map((row) => ({ ...before.get(row.id), id: row.id, label: row.label.trim(), dueAt: endOfDayIso(row.due, timezone), done: row.done })),
      usage: form.usage.trim() || null,
      usageEndsAt: endOfDayIso(form.usageEnds, timezone),
      exclusivity: form.exclusivity.trim() || null,
      exclusivityEndsAt: endOfDayIso(form.exclusivityEnds, timezone),
      revisionsIncluded,
      advancePercent,
      paymentDays,
      notes: form.notes.trim() || null,
      disclosure: editing?.terms.disclosure ?? [],
    };
    const dueAt = form.paid ? null : endOfDayIso(form.due, timezone);
    const amount = formatMoney(amountMinor, null, "exact", money);
    const paid = form.paid ? { paid: tdsMinor ? { tdsMinor } : {} } : {};
    setBusy(true);
    setSaveError(null);
    try {
      if (editing) {
        await appStore.updateDeal(editing.id, { title: form.title.trim(), ...(settled ? {} : { dealType: form.dealType }), ...(amountLocked ? {} : { amountMinor }), terms, ...(settled ? {} : { dueAt }) });
        toast("Deal updated.", { tone: "success" });
      } else {
        const subject = thread ? { threadId: thread.id } : { igAccountId: form.creator, ...who! };
        await appStore.createDeal({ ...subject, title: form.title.trim(), dealType: form.dealType, amountMinor, terms, dueAt, ...paid, idempotencyKey: idempotency.current, ...(reported ? { leadEventId: reported.id } : {}) });
        toast(form.paid ? `Deal recorded. ${amount} is in your revenue now.` : `Deal saved. ${amount} is owed to you.`, { tone: "success" });
      }
      onClose();
    } catch (failure) {
      setSaveError(errorMessage(failure, "That didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? "Edit deal" : elsewhere ? "Add a deal" : "Record a deal"}
      description={reported
        ? <>{paidWords(reported, locale)}{reported.payerName ? <> by <bdi>{reported.payerName}</bdi></> : null}. {reportedMinor === null ? "Enter what reached you, then save." : "Check it, then save to add it to your revenue."}</>
        : elsewhere
        ? "For a deal agreed outside DealDock, like on a call or WhatsApp. Only paid deals count as revenue."
        : handle === null ? undefined : editing ? <>With <bdi>{handle}</bdi></> : <>What you agreed with <bdi>{handle}</bdi>. Only paid deals count as revenue.</>}
      placement="center"
      dirty={dirty && !busy}
      footer={editing ? (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} loadingLabel="Saving…" onClick={() => void submit()}>Save</Button>
        </>
      ) : <Button variant="money" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void submit()}>Save deal</Button>}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {thread && !editing && (missing === null ? (
          <Button variant="secondary" size="sm" icon={MessageSquareText} loading={filling} loadingLabel="Reading the chat…" className="self-start" onClick={() => void fill()}>Fill from conversation</Button>
        ) : (
          <div role="status" className="rounded-2xl bg-inset px-4 py-3 text-[14px] leading-5 text-ink-2">
            <p className="font-semibold text-ink">Filled from the chat. Check before saving.</p>
            {missing.length > 0 && <p className="mt-0.5">Not in the chat: {missing.join(", ")}.</p>}
          </div>
        ))}
        {elsewhere && (
          <>
            <TextField
              label="Who it's with"
              value={form.who}
              maxLength={120}
              placeholder="@brand, an email address or a name"
              error={errors.who}
              helper="An Instagram @handle, an email address or a name, as it should show on your deals." 
              onChange={(event) => set("who", event.target.value)}
            />
            {creators.length > 1 && (
              <Select label="Creator" value={form.creator} error={errors.creator} onChange={(event) => set("creator", event.target.value)}>
                {creators.map((item) => <option key={item.id} value={item.id}>@{item.handle}</option>)}
              </Select>
            )}
          </>
        )}
        <TextField label="What" value={form.title} maxLength={120} placeholder="1 reel + 2 stories" error={errors.title} onChange={(event) => set("title", event.target.value)} />
        <MoneyField label="Amount" size="lg" value={form.amount} disabled={amountLocked} onChange={(text) => set("amount", text)} error={errors.amount} placeholder="45000" helper={settled ? "A paid or cancelled deal keeps its amount." : amountLocked ? "Its invoices bill this amount. Void them to change it." : undefined} />
        <DealTypeSelect label="Type" value={form.dealType} disabled={settled} onChange={(type) => set("dealType", type)} />
        {!editing && (
          <Switch
            checked={form.paid}
            onChange={(paid) => set("paid", paid)}
            label="Already paid?"
            description={form.paid ? "It goes into your revenue now." : "DealDock keeps track of it until you're paid."}
          />
        )}
        {form.paid ? inr && (
          <Disclosure summary="Received less than this?" open={tdsOpen} onToggle={setTdsOpen}>
            <MoneyField label="Tax withheld (TDS)" optional value={form.tds} onChange={(text) => set("tds", text)} error={errors.tds} helper="Your revenue still records the full amount." />
          </Disclosure>
        ) : (
          <>
            {!settled && <TextField label="Payment due, optional" type="date" value={form.due} onChange={(event) => set("due", event.target.value)} />}
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-1.5 text-label text-ink">Deliverables, optional</legend>
              {form.deliverables.map((row, index) => (
                <div key={row.id} className="flex items-center gap-2">
                  <TextField label={`Deliverable ${index + 1}`} hideLabel value={row.label} maxLength={120} placeholder="1 reel" className="min-w-0 flex-1" onChange={(event) => setRow(row.id, { label: event.target.value })} />
                  <TextField label={`Deliverable ${index + 1} due`} hideLabel type="date" value={row.due} className="w-[150px] shrink-0" onChange={(event) => setRow(row.id, { due: event.target.value })} />
                  <IconButton label={`Remove deliverable ${index + 1}`} icon={X} size="sm" onClick={() => set("deliverables", form.deliverables.filter((item) => item.id !== row.id))} />
                </div>
              ))}
              <Button variant="ghost" size="sm" icon={Plus} className="self-start" onClick={() => set("deliverables", [...form.deliverables, { id: rowId(), label: "", due: "", done: false }])}>Add a deliverable</Button>
            </fieldset>
          </>
        )}
        <Disclosure summary="More terms" open={moreOpen} onToggle={setMoreOpen}>
          {/* The end dates drive Today's usage reminder and the exclusivity warning on other brands' chats. */}
          <div className="grid grid-cols-[minmax(0,1fr)_150px] items-start gap-2">
            <TextField label="Usage, optional" value={form.usage} maxLength={200} placeholder="Paid ads, 3 months" onChange={(event) => set("usage", event.target.value)} />
            <TextField label="Usage ends" type="date" value={form.usageEnds} onChange={(event) => set("usageEnds", event.target.value)} />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_150px] items-start gap-2">
            <TextField label="Exclusivity, optional" value={form.exclusivity} maxLength={200} placeholder="No other skincare brands" onChange={(event) => set("exclusivity", event.target.value)} />
            <TextField label="Exclusivity ends" type="date" value={form.exclusivityEnds} onChange={(event) => set("exclusivityEnds", event.target.value)} />
          </div>
          {(form.usageEnds || form.exclusivityEnds) && <p className="-mt-2 text-caption text-ink-3">Today reminds you two weeks before usage ends, and other brands&apos; chats show the exclusivity until it ends.</p>}
          <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3">
            <TextField label="Revisions included" inputMode="numeric" value={form.revisions} error={errors.revisions} onChange={(event) => set("revisions", digits(event.target.value))} />
            <TextField label="Advance (%)" inputMode="numeric" value={form.advance} error={errors.advance} onChange={(event) => set("advance", digits(event.target.value))} />
            <TextField label="Pay within (days)" inputMode="numeric" value={form.paymentDays} error={errors.paymentDays} onChange={(event) => set("paymentDays", digits(event.target.value))} />
          </div>
          <TextArea label="Notes, optional" rows={2} maxLength={500} value={form.notes} onChange={(event) => set("notes", event.target.value)} />
        </Disclosure>
        <SaveError message={saveError} />
      </form>
    </Sheet>
  );
}

/* ── Mark paid: a deal, the rest of one, or one invoice ────────────────── */

export interface Paying { deal: DealDto; invoice?: InvoiceDto | null }

/**
 * What arrived, tax withheld (India) and the day. Revenue records the gross:
 * received plus TDS, less the GST/VAT an invoice collected for the government.
 * With an invoice it settles that invoice; after paid invoices (an advance) it
 * records what they left.
 */
export function PaidSheet({ paying, onClose }: { paying: Paying | null; onClose: () => void }) {
  const { money, timezone } = useMoneyContext();
  const shown = useLast(paying);
  const deal = shown?.deal ?? null;
  const invoice = shown?.invoice ?? null;
  const inr = money.currency === "INR";
  const today = dayKey(Date.now(), timezone);
  // What this payment covers: the invoice's total, else the fee less what paid invoices billed.
  const settledMinor = (deal?.invoices ?? []).filter((item) => item.status === "paid").reduce((sum, item) => sum + item.subtotalMinor, 0);
  const dueMinor = invoice ? invoice.totalMinor : Math.max(0, (deal?.amountMinor ?? 0) - settledMinor);
  const taxMinor = invoice?.taxMinor ?? 0;
  const [form, setForm] = useState({ received: "", tds: "", day: today });
  const [typedReceived, setTypedReceived] = useState(false);
  const [tdsOpen, setTdsOpen] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<"received" | "tds" | "day", string>>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const idempotency = useRef("");
  useEffect(() => {
    if (!paying) return;
    setForm({ received: moneyFieldText(dueMinor), tds: "", day: dayKey(Date.now(), timezone) });
    setTypedReceived(false);
    setTdsOpen(false);
    setErrors({});
    setSaveError(null);
    idempotency.current = `paid-${paying.invoice?.id ?? paying.deal.id}-${Date.now()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paying]);

  const receivedMinor = form.received ? parseMoneyInput(form.received) : null;
  const tdsMinor = form.tds ? parseMoneyInput(form.tds) : null;
  const revenueMinor = invoice ? invoiceRevenueMinor(invoice, { receivedMinor: receivedMinor ?? 0, tdsMinor }) : (receivedMinor ?? 0) + (tdsMinor ?? 0);

  const submit = async () => {
    if (!paying) return;
    const next: typeof errors = {};
    if (receivedMinor === null) next.received = MONEY_INPUT_ERROR;
    else if (revenueMinor <= 0) next.received = taxMinor > 0 ? `What you received plus TDS has to be more than the ${formatMoney(taxMinor, null, "exact", money)} tax on this invoice.` : "Enter what you received.";
    if (form.tds && tdsMinor === null) next.tds = MONEY_INPUT_ERROR;
    if (!form.day || form.day > today) next.day = "Choose today or an earlier day.";
    setErrors(next);
    if (next.tds) setTdsOpen(true);
    if (Object.keys(next).length || receivedMinor === null) return;
    const request = {
      receivedMinor,
      ...(tdsMinor ? { tdsMinor } : {}),
      // Today means now; an earlier day counts at the end of that day.
      ...(form.day !== today ? { paidAt: endOfDayIso(form.day, timezone) ?? undefined } : {}),
      idempotencyKey: idempotency.current,
    };
    setBusy(true);
    setSaveError(null);
    try {
      const added = formatMoney(revenueMinor, null, "exact", money);
      if (paying.invoice) {
        const result = await appStore.markInvoicePaid(paying.invoice.id, request);
        toast(result.deal.stage === "paid" ? `Paid in full. ${added} added to your revenue.` : `${added} added to your revenue. Invoice the balance when you're ready.`, { tone: "success" });
      } else {
        await appStore.markDealPaid(paying.deal.id, request);
        toast(`${added} added to your revenue.`, { tone: "success" });
      }
      onClose();
    } catch (failure) {
      setSaveError(errorMessage(failure, "That didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const title = invoice ? "Mark invoice paid" : settledMinor > 0 ? "Mark the rest paid" : "Mark paid";
  return (
    <Sheet
      open={paying !== null}
      onClose={onClose}
      title={title}
      description={deal ? <><bdi>{invoice ? invoice.number : deal.title}</bdi> · <bdi>{dealWith(deal)}</bdi></> : undefined}
      placement="center"
      footer={<Button variant="money" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void submit()}>{title}</Button>}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <MoneyField
          label="Received"
          size="lg"
          value={form.received}
          error={errors.received}
          onChange={(text) => { setTypedReceived(true); setForm((current) => ({ ...current, received: text })); }}
          helper={revenueMinor > 0 ? (
            <>Adds <MoneyValue minor={revenueMinor} mode="exact" kind="confirmed" className="font-semibold" /> to your revenue.{taxMinor > 0 && <> The <MoneyValue minor={taxMinor} mode="exact" /> {invoice?.taxes[0]?.kind === "vat" ? "VAT" : "GST"} goes to the government, so it isn&apos;t revenue.</>}</>
          ) : undefined}
        />
        {inr && deal && (
          <Disclosure summary="Received less than this?" open={tdsOpen} onToggle={setTdsOpen}>
            <MoneyField
              label="Tax withheld (TDS)"
              optional
              value={form.tds}
              error={errors.tds}
              helper="What you received goes down by this; your revenue still counts it."
              // What arrived follows the tax until the creator types it themselves.
              onChange={(text, minor) => setForm((current) => ({ ...current, tds: text, received: typedReceived ? current.received : moneyFieldText(defaultReceivedMinor(dueMinor, minor)) }))}
            />
          </Disclosure>
        )}
        <TextField label="Paid on" type="date" max={today} value={form.day} error={errors.day} onChange={(event) => setForm((current) => ({ ...current, day: event.target.value }))} />
        <SaveError message={saveError} />
      </form>
    </Sheet>
  );
}

/* ── Ask for payment ───────────────────────────────────────────────────── */

/** Moves an agreed deal to "Payment requested", with a due date from the agreed payment days when there is one. */
export function RequestSheet({ deal, onClose }: { deal: DealDto | null; onClose: () => void }) {
  const { timezone } = useMoneyContext();
  const shown = useLast(deal);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const today = dayKey(Date.now(), timezone);
  useEffect(() => {
    if (!deal) return;
    const days = deal.terms.paymentDays;
    setDue(deal.dueAt ? dayKey(deal.dueAt, timezone) : days !== null ? dayKey(dueFromPaymentDays(Date.now(), days), timezone) : "");
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal?.id]);

  const submit = async () => {
    if (!deal) return;
    setBusy(true);
    setSaveError(null);
    try {
      await appStore.updateDeal(deal.id, { stage: "invoiced", dueAt: endOfDayIso(due, timezone) });
      toast(due ? "Payment requested. If it passes the due date, it shows as overdue." : "Payment requested.", { tone: "success" });
      onClose();
    } catch (failure) {
      setSaveError(errorMessage(failure, "That didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={deal !== null}
      onClose={onClose}
      title="Ask for payment"
      description={shown ? <>Do this once you&apos;ve sent <bdi>{dealWith(shown)}</bdi> your invoice or payment details yourself.</> : undefined}
      placement="center"
      footer={<Button variant="primary" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void submit()}>Mark payment requested</Button>}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <TextField
          label="Payment due, optional"
          type="date"
          min={today}
          value={due}
          onChange={(event) => setDue(event.target.value)}
          helper={shown?.terms.paymentDays != null ? `You agreed on payment within ${shown.terms.paymentDays} days.` : "Add it to see when a payment is late."}
        />
        <SaveError message={saveError} />
      </form>
    </Sheet>
  );
}

/* ── Deal cards: one per open deal, each with one next step ────────────── */

const ACTION: Record<DealAction, { label: string; icon: LucideIcon }> = {
  recap: { label: "Send terms recap", icon: ScrollText },
  request: { label: "Ask for payment", icon: HandCoins },
  remind: { label: "Remind", icon: BellRing },
  paid: { label: "Mark paid", icon: CheckCheck },
  invoice: { label: "Create invoice", icon: FilePlus2 },
  send_invoice: { label: "Send with a note", icon: Send },
  invoice_paid: { label: "Mark invoice paid", icon: CheckCheck },
  balance: { label: "Invoice the balance", icon: FilePlus2 },
};
const MONEY_ACTIONS: ReadonlySet<DealAction> = new Set(["paid", "invoice_paid"]);

/**
 * Open deals as cards with one next step each (the rest in its menu), and
 * every sheet those steps open. In a conversation (`thread`) recaps,
 * reminders and invoice notes are drafts for the composer (`onDraft`); nothing
 * sends here. A deal agreed elsewhere has no conversation, so its card offers
 * the invoice PDF to share instead.
 */
function DealCards({ deals, thread, now, drafting = null, onDraft }: {
  deals: DealDto[];
  thread?: DemoThread;
  now: number;
  /** The deal whose recap, reminder or invoice note is being written. */
  drafting?: string | null;
  onDraft?: (deal: DealDto, purpose: DraftPurpose, invoiceId?: string) => void;
}) {
  const router = useRouter();
  // Only seats that manage settings can read billing details; for the rest, creating the invoice says if they're missing.
  const canReadBilling = useCan("manage_settings");
  const billing = useBillingProfile(deals[0]?.igAccountId, deals.length > 0 && canReadBilling === true);
  const billingMissing = billing.status === "ready" && billing.data?.profile === null;
  const [paying, setPaying] = useState<Paying | null>(null);
  const [requesting, setRequesting] = useState<DealDto | null>(null);
  const [editing, setEditing] = useState<DealDto | null>(null);
  const [invoicing, setInvoicing] = useState<{ deal: DealDto; kind?: InvoiceKind } | null>(null);
  const [previewing, setPreviewing] = useState<InvoiceDto | null>(null);
  const [voiding, setVoiding] = useState<InvoiceDto | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "cancel" | "delete"; deal: DealDto } | null>(null);
  const confirming = useLast(confirm);
  const [busy, setBusy] = useState(false);
  const [ticking, setTicking] = useState<string | null>(null);
  const [proofing, setProofing] = useState<DealDto | null>(null);
  // A sheet shows the deal as it is now, not as it was when the sheet opened.
  const live = (deal: DealDto | undefined) => (deal ? deals.find((item) => item.id === deal.id) ?? deal : null);

  const tick = async (deal: DealDto, deliverableId: string, done: boolean) => {
    setTicking(deal.id);
    const deliverables = deal.terms.deliverables.map((item) => (item.id === deliverableId ? { ...item, done } : item));
    const label = deal.terms.deliverables.find((item) => item.id === deliverableId)?.label ?? "Deliverable";
    try {
      await appStore.updateDeal(deal.id, { terms: { deliverables } });
      if (done) toast(`${label} done.`, { tone: "success", action: { label: "Undo", onClick: () => void tick({ ...deal, terms: { ...deal.terms, deliverables } }, deliverableId, false) } });
    } catch (failure) {
      toast(errorMessage(failure, "That didn't save. Try again."), { tone: "error" });
    } finally {
      setTicking(null);
    }
  };

  const act = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "cancel") {
        await appStore.updateDeal(confirm.deal.id, { stage: "cancelled" });
        toast("Deal cancelled.");
      } else {
        await appStore.deleteDeal(confirm.deal.id);
        toast("Deal deleted.");
      }
      setConfirm(null);
    } catch (failure) {
      toast(errorMessage(failure, "That didn't save. Try again."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const voidIt = async () => {
    if (!voiding) return;
    setBusy(true);
    if (await toastAction(() => appStore.voidInvoice(voiding.id), { success: `Invoice ${voiding.number} voided. Its number stays used.`, fallback: "The invoice wasn't voided. Try again." })) setVoiding(null);
    setBusy(false);
  };

  const run = (deal: DealDto, action: DealAction) => {
    const open = openInvoice(deal);
    if (action === "recap") onDraft?.(deal, "recap");
    else if (action === "remind") onDraft?.(deal, "payment_reminder");
    else if (action === "request") setRequesting(deal);
    else if (action === "send_invoice" && open) onDraft?.(deal, "invoice", open.id);
    else if (action === "invoice_paid" && open) setPaying({ deal, invoice: open });
    else if (action === "invoice" || action === "balance") {
      if (billingMissing) router.push("/settings#billing");
      else setInvoicing({ deal, kind: action === "balance" ? "balance" : undefined });
    } else setPaying({ deal });
  };

  return (
    <>
      {deals.map((deal) => {
        // Writing in the conversation since a moment counts as that message having gone out (a recap, an invoice's note).
        const sentSince = thread ? (at: string) => thread.messages.some((message) => message.direction === "outbound" && message.sentAt > Date.parse(at)) : undefined;
        const primary = dealPrimaryAction(deal, now, sentSince);
        const open = openInvoice(deal);
        const invoiced = liveInvoices(deal).length > 0;
        const current = open ?? liveInvoices(deal).at(-1) ?? null;
        const kinds = invoiceKinds(deal);
        const create = kinds[0] === "balance" ? "balance" : "invoice";
        const items: MenuItem[] = [
          ...(thread && primary !== "recap" && !invoiced ? [{ label: ACTION.recap.label, icon: ACTION.recap.icon, onSelect: () => run(deal, "recap") }] : []),
          ...(primary !== "request" && deal.stage === "agreed" && !invoiced ? [{ label: ACTION.request.label, icon: ACTION.request.icon, onSelect: () => run(deal, "request") }] : []),
          ...(kinds.length && primary !== "invoice" && primary !== "balance" ? [{ label: billingMissing ? "Add billing details" : ACTION[create].label, icon: FilePlus2, onSelect: () => run(deal, create) }] : []),
          ...(thread && open && primary !== "send_invoice" ? [{ label: ACTION.send_invoice.label, icon: Send, onSelect: () => run(deal, "send_invoice") }] : []),
          ...(open && primary !== "invoice_paid" ? [{ label: ACTION.invoice_paid.label, icon: CheckCheck, onSelect: () => run(deal, "invoice_paid") }] : []),
          ...(!open && primary !== "paid" ? [{ label: invoiced ? "Mark the rest paid" : ACTION.paid.label, icon: CheckCheck, onSelect: () => run(deal, "paid") }] : []),
          ...(current ? [{ label: "Preview invoice", icon: Eye, onSelect: () => setPreviewing(current) }, { label: "Download PDF", icon: Download, onSelect: () => void downloadInvoice(current) }] : []),
          ...(deal.terms.deliverables.length ? [{ label: "Posts and results", icon: ChartNoAxesCombined, onSelect: () => setProofing(deal) }] : []),
          { label: "Edit deal", icon: Pencil, onSelect: () => setEditing(deal) },
          ...(open ? [{ label: "Void invoice", icon: Ban, destructive: true, onSelect: () => setVoiding(open) }] : []),
          { label: "Cancel deal", icon: Ban, destructive: true, onSelect: () => setConfirm({ kind: "cancel", deal }) },
          { label: "Delete deal", icon: Trash2, destructive: true, onSelect: () => setConfirm({ kind: "delete", deal }) },
        ];
        const action = ACTION[primary];
        const lead = billingMissing && (primary === "invoice" || primary === "balance") ? (
          <Link href="/settings#billing" className={buttonClasses({ variant: "secondary", size: "sm" })}><FilePlus2 aria-hidden size={16} className="shrink-0" />Add billing details</Link>
        ) : (
          <Button size="sm" variant={MONEY_ACTIONS.has(primary) ? "money" : "secondary"} icon={action.icon} loading={drafting === deal.id} loadingLabel="Writing…" onClick={() => run(deal, primary)}>{action.label}</Button>
        );
        return (
          <DealCard
            key={deal.id}
            deal={deal}
            now={now}
            ticking={ticking === deal.id}
            items={items}
            // No conversation to send it from: the PDF is the creator's to share.
            actions={<>{lead}{!thread && open && <IconButton label="Download PDF" icon={Download} variant="secondary" size="sm" onClick={() => void downloadInvoice(open)} />}</>}
            onTick={(id) => void tick(deal, id, true)}
            onPreview={setPreviewing}
            onProof={() => setProofing(deal)}
          />
        );
      })}
      <PaidSheet paying={paying} onClose={() => setPaying(null)} />
      <RequestSheet deal={requesting} onClose={() => setRequesting(null)} />
      <DealSheet open={editing !== null} deal={live(editing ?? undefined)} onClose={() => setEditing(null)} />
      <InvoiceSheet deal={invoicing ? live(invoicing.deal) : null} kind={invoicing?.kind} onClose={() => setInvoicing(null)} />
      <InvoicePreviewSheet
        invoice={previewing ? deals.flatMap((deal) => deal.invoices ?? []).find((item) => item.id === previewing.id) ?? previewing : null}
        proof={previewing ? invoiceProof(deals.find((deal) => deal.id === previewing.dealId)?.terms ?? EMPTY_DEAL_TERMS) : null}
        onClose={() => setPreviewing(null)}
      />
      <ProofSheet deal={live(proofing ?? undefined)} onClose={() => setProofing(null)} />
      <VoidInvoiceDialog invoice={voiding} busy={busy} onClose={() => setVoiding(null)} onConfirm={() => void voidIt()} />
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirming?.kind === "delete" ? "Delete this deal?" : "Cancel this deal?"}
        confirmLabel={confirming?.kind === "delete" ? "Delete deal" : "Cancel deal"}
        cancelLabel="Keep it"
        destructive
        busy={busy}
        busyLabel={confirming?.kind === "delete" ? "Deleting…" : "Cancelling…"}
        onConfirm={() => void act()}
      >
        {confirming && (confirming.kind === "delete"
          ? <>DealDock forgets <bdi>{confirming.deal.title}</bdi>. Nothing is sent to <bdi>{dealWith(confirming.deal)}</bdi>.</>
          : <>It moves to past deals and stops counting as owed. Nothing is sent to <bdi>{dealWith(confirming.deal)}</bdi>.</>)}
      </ConfirmDialog>
    </>
  );
}

/** In a conversation: a card per open deal, and earlier deals folded into a count. */
export function ConversationDeals({ thread, now, drafting, onDraft }: {
  thread: DemoThread;
  now: number;
  drafting: string | null;
  onDraft: (deal: DealDto, purpose: DraftPurpose, invoiceId?: string) => void;
}) {
  if (!thread.deals.length) return null;
  const past = thread.deals.filter((deal) => !isDealOpen(deal));
  return (
    <section aria-label="Deals" className="mx-auto mt-5 flex w-full max-w-[560px] flex-col gap-3">
      <DealCards deals={thread.deals.filter(isDealOpen)} thread={thread} now={now} drafting={drafting} onDraft={onDraft} />
      {past.length > 0 && <PastDeals deals={past} />}
    </section>
  );
}

/** A deal agreed outside DealDock, opened from Today or Revenue: its card and every next step, in a sheet. */
export function DealDetailSheet({ deal, creator, onClose }: { deal: DealDto | null; creator?: string | null; onClose: () => void }) {
  const shown = useLast(deal);
  const now = useMinuteClock();
  return (
    <Sheet
      open={deal !== null}
      onClose={onClose}
      title={shown ? dealWith(shown) : "Deal"}
      description={<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">{creator && <CreatorChip handle={creator} />}<span>Agreed outside DealDock, so there&apos;s no conversation here.</span></span>}
      placement="center"
      initialFocus="title"
    >
      {shown && <div className="flex flex-col gap-3 pb-2"><DealCards deals={[shown]} now={now || Date.now()} /></div>}
    </Sheet>
  );
}

const KIND_WORD: Record<InvoiceDto["kind"], string | null> = { full: null, advance: "Advance", balance: "Balance" };

function DealCard({ deal, now, ticking, items, actions, onTick, onPreview, onProof }: {
  deal: DealDto;
  now: number;
  ticking: boolean;
  items: MenuItem[];
  actions: ReactNode;
  onTick: (deliverableId: string) => void;
  onPreview: (invoice: InvoiceDto) => void;
  onProof: () => void;
}) {
  const { locale, timezone } = useMoneyContext();
  const stage = dealStage(deal, now);
  const next = nextDeliverable(deal.terms);
  const more = deal.terms.deliverables.filter((item) => !item.done).length - (next ? 1 : 0);
  const titleId = `deal-${deal.id}`;
  const invoices = deal.invoices ?? [];
  // With an invoice out, its own row says when it's due.
  const invoiced = liveInvoices(deal).length > 0;
  // Once something is delivered, its post and results are the next thing to keep.
  const posted = deal.terms.deliverables.filter((item) => item.postUrl).length;
  const delivered = deal.terms.deliverables.some((item) => item.done || item.postUrl);
  return (
    <article aria-labelledby={titleId} className="rounded-[20px] bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="break-words text-[15px] font-semibold leading-5 text-ink">{deal.title}</h3>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-3">
            <Tag tone={stage.tone}>{stage.text}</Tag>
            {deal.dealType !== "other" && <span>{dealTypeText(deal.dealType)}</span>}
            {deal.dueAt && stage.tone !== "waiting" && !invoiced && <span>Payment due {dueWords(deal.dueAt, now, locale, timezone)}</span>}
          </p>
        </div>
        <MoneyValue minor={deal.amountMinor} mode="exact" className="shrink-0 text-[16px] font-semibold text-ink" />
      </div>
      {next && (
        // Ticking moves the card on to the next deliverable, so it is an action, not a lasting checkbox.
        <div className="mt-3 flex min-h-11 items-center gap-3 rounded-xl bg-inset px-3 py-1.5">
          <button type="button" disabled={ticking} onClick={() => onTick(next.id)} aria-label={`Mark ${next.label} done`} title="Mark done" className="dd-press dd-hit flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 hover:text-ink disabled:opacity-45">
            <Circle aria-hidden size={20} strokeWidth={1.75} />
          </button>
          <span className="min-w-0 flex-1 break-words text-[14px] text-ink">{next.label}{next.dueAt && <span className="text-ink-3"> · due {dueWords(next.dueAt, now, locale, timezone)}</span>}</span>
          {more > 0 && <span className="shrink-0 text-caption text-ink-3">+{more} more</span>}
        </div>
      )}
      {delivered && (
        <button type="button" onClick={onProof} className="dd-press mt-2 flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl bg-inset px-3 py-2 text-left hover:bg-fill">
          <ChartNoAxesCombined aria-hidden size={18} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 text-[14px] font-medium text-ink">Posts and results</span>
          <span className="shrink-0 text-caption text-ink-3">{posted} of {deal.terms.deliverables.length} posted</span>
          <ChevronRight aria-hidden size={16} className="shrink-0 text-ink-3" />
        </button>
      )}
      {invoices.length > 0 && (
        <ul aria-label="Invoices" className="mt-3 flex flex-col gap-1.5">
          {invoices.map((invoice) => {
            const status = invoiceStatus(invoice, now);
            const voided = invoice.status === "void";
            return (
              <li key={invoice.id}>
                <button type="button" onClick={() => onPreview(invoice)} className="dd-press flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl bg-inset px-3 py-2 text-left hover:bg-fill">
                  <FileText aria-hidden size={18} className="shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cx("min-w-0 flex-1 truncate text-[14px] font-semibold", voided ? "text-ink-3" : "text-ink")}><span className="sr-only">Preview invoice </span>{invoice.number}</span>
                      <MoneyValue minor={invoice.totalMinor} mode="exact" className={cx("shrink-0 text-[14px] font-semibold", voided ? "text-ink-3 line-through" : "text-ink")} />
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-3">
                      <Tag tone={status.tone} className={status.tone === "neutral" ? "bg-surface" : undefined}>{status.text}</Tag>
                      {KIND_WORD[invoice.kind] && <span>{KIND_WORD[invoice.kind]}</span>}
                      {invoice.taxMinor > 0 && !voided && <span>incl. {invoice.taxes[0]?.kind === "vat" ? "VAT" : "GST"}</span>}
                      {invoice.status === "paid" && invoice.paidAt ? <span>Paid {formatDate(invoice.paidAt, locale, timezone, { day: "numeric", month: "short" })}</span>
                        : invoice.status === "issued" ? <span>Due {dueWords(invoice.dueAt, now, locale, timezone)}</span> : null}
                    </span>
                  </span>
                  <ChevronRight aria-hidden size={16} className="shrink-0 text-ink-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {actions}
        <Menu label={`More for ${deal.title}`} icon={MoreHorizontal} items={items} className="ml-auto" />
      </div>
    </article>
  );
}

function PastDeals({ deals }: { deals: DealDto[] }) {
  const { locale, timezone } = useMoneyContext();
  // A paid deal still has posts, results and usage rights to keep: they open from its menu.
  const [proofing, setProofing] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
    <details className="group">
      <summary className="dd-summary mx-auto flex min-h-11 w-fit items-center gap-1 rounded-full px-3 text-label font-semibold text-ink-3 hover:text-ink-2">
        {deals.length} past {pluralize(deals.length, "deal")}<ChevronDown aria-hidden size={15} className="transition-transform group-open:rotate-180" />
      </summary>
      <ul className="mt-1 overflow-hidden rounded-[20px] bg-surface shadow-card">
        {deals.map((deal, index) => (
          <li key={deal.id} className={cx("flex items-center gap-3 py-3 pl-4 pr-2", index > 0 && "border-t border-hairline")}>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-[14px] font-medium leading-5 text-ink">{deal.title}</span>
              <span className="text-caption text-ink-3">{deal.stage === "paid" && deal.paidAt ? `Paid ${formatDate(deal.paidAt, locale, timezone, { day: "numeric", month: "short" })}` : "Cancelled"}</span>
            </span>
            {deal.stage === "paid"
              ? <MoneyValue minor={dealRevenueMinor(deal)} mode="exact" kind="confirmed" className="shrink-0 text-[14px] font-semibold" />
              : <MoneyValue minor={deal.amountMinor} mode="exact" className="shrink-0 text-[14px] font-semibold text-ink-3" />}
            <Menu
              label={`More for ${deal.title}`}
              icon={MoreHorizontal}
              items={[
                ...(deal.terms.deliverables.length ? [{ label: "Posts and results", icon: ChartNoAxesCombined, onSelect: () => setProofing(deal.id) }] : []),
                { label: "Edit deal", icon: Pencil, onSelect: () => setEditing(deal.id) },
              ]}
            />
          </li>
        ))}
      </ul>
    </details>
    {/* Outside the fold, so a sheet never sits in a closed <details>. */}
    <ProofSheet deal={deals.find((deal) => deal.id === proofing) ?? null} onClose={() => setProofing(null)} />
    <DealSheet open={editing !== null} deal={deals.find((deal) => deal.id === editing) ?? null} onClose={() => setEditing(null)} />
    </>
  );
}

/* ── Posts and results: proof for the brand, and for the invoice ───────── */

/** Copied inside the click, so the clipboard accepts it. */
function copyText(text: string, done: string) {
  if (!navigator.clipboard) { toast("Couldn't copy it. Select the text and copy it yourself.", { tone: "error" }); return; }
  void navigator.clipboard.writeText(text).then(() => toast(done, { tone: "success" }), () => toast("Couldn't copy it. Select the text and copy it yourself.", { tone: "error" }));
}

const METRIC_FIELDS: Array<{ key: keyof DeliverableMetrics; label: string }> = [
  { key: "views", label: "Views" }, { key: "reach", label: "Reach" }, { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" }, { key: "shares", label: "Shares" }, { key: "saves", label: "Saves" },
];

/**
 * Posts and results for one deal. Per deliverable, one next step at a time:
 * mark it posted (its link and day), then add the results typed from
 * Instagram's insights (or fetched, when the API can read them; never for a
 * story). Under a fold, the disclosure checklist. "Copy results" gives a
 * plain summary for the brand. Every change saves on its own; the invoice
 * shows the same proof.
 */
export function ProofSheet({ deal, onClose }: { deal: DealDto | null; onClose: () => void }) {
  const shown = useLast(deal);
  const { locale, timezone } = useMoneyContext();
  const settings = useSettings();
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // A tick shows at once; the deal as saved takes over when the save answers (or is refused).
  const [ticking, setTicking] = useState<string[] | null>(null);
  const proof = shown ? invoiceProof(shown.terms) : null;
  const items = shown?.terms.deliverables ?? [];
  const ticked = ticking ?? shown?.terms.disclosure ?? [];

  const toggle = async (id: string, on: boolean) => {
    if (!shown) return;
    const disclosure = on ? [...ticked, id] : ticked.filter((item) => item !== id);
    setTicking(disclosure);
    setSaving(true);
    await toastAction(() => appStore.updateDeal(shown.id, { terms: { disclosure } }), { fallback: "That didn't save. Try again." });
    setSaving(false);
    setTicking(null);
  };

  return (
    <Sheet
      open={deal !== null}
      onClose={onClose}
      title="Posts and results"
      description={shown ? <><bdi>{shown.title}</bdi> · <bdi>{dealWith(shown)}</bdi></> : undefined}
      placement="center"
      initialFocus="title"
      footer={proof?.posts.length ? <Button variant="secondary" icon={Copy} onClick={() => shown && copyText(resultsText(shown, locale, timezone), "Results copied. Paste them into Instagram or an email.")}>Copy results</Button> : undefined}
    >
      {shown && (
        <div className="flex flex-col gap-3 pb-1">
          {items.length === 0 ? (
            <p className="rounded-2xl bg-inset px-4 py-3 text-[14px] text-ink-2">This deal lists no deliverables. Add them with Edit deal, then mark each one posted here.</p>
          ) : (
            <ul aria-label="Deliverables" className="flex flex-col gap-2">
              {items.map((item) => <PostRow key={item.id} deal={shown} item={item} insights={settings.data?.insightsAvailable === true} />)}
            </ul>
          )}
          <Disclosure summary={`Disclosure checklist${ticked.length ? ` · ${ticked.length} of ${DISCLOSURE_ITEMS.length}` : ""}`} open={disclosureOpen} onToggle={setDisclosureOpen}>
            <p className="text-caption text-ink-3">From India&apos;s ASCI rules for paid posts. Ticked items print on the invoice.</p>
            <ul className="flex flex-col">
              {DISCLOSURE_ITEMS.map((item) => (
                <li key={item.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[14px] text-ink">
                    <input type="checkbox" className="h-5 w-5 shrink-0 accent-brand" checked={ticked.includes(item.id)} disabled={saving} onChange={(event) => void toggle(item.id, event.target.checked)} />
                    {item.label}
                  </label>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </Sheet>
  );
}

function PostRow({ deal, item, insights }: { deal: DealDto; item: DealDeliverable; insights: boolean }) {
  const { locale, timezone } = useMoneyContext();
  const today = dayKey(Date.now(), timezone);
  const [mode, setMode] = useState<"view" | "post" | "results">("view");
  const [link, setLink] = useState("");
  const [day, setDay] = useState(today);
  const [numbers, setNumbers] = useState<Record<keyof DeliverableMetrics, string>>({ views: "", reach: "", likes: "", comments: "", shares: "", saves: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "fetch" | null>(null);
  const story = isStoryDeliverable(item.label);
  const counted = !hasNoMetrics(item.metrics);
  const short = (at: string) => formatDate(at, locale, timezone, { day: "numeric", month: "short" });

  const save = async (patch: Partial<DealDeliverable>, success: string) => {
    setBusy("save");
    setError(null);
    try {
      const deliverables = deal.terms.deliverables.map((entry) => (entry.id === item.id ? { ...entry, ...patch } : entry));
      await appStore.updateDeal(deal.id, { terms: { deliverables } });
      toast(success, { tone: "success" });
      setMode("view");
    } catch (failure) {
      setError(errorMessage(failure, "That didn't save. Try again."));
    } finally {
      setBusy(null);
    }
  };
  const savePost = () => {
    if (!PostUrlSchema.safeParse(link.trim()).success) { setError("Use the post's full link, starting with https://"); return; }
    if (!day || day > today) { setError("Choose today or an earlier day."); return; }
    // Posted today counts from now; an earlier day from the end of it.
    const postedAt = day === today ? new Date().toISOString() : endOfDayIso(day, timezone);
    void save({ postUrl: link.trim(), postedAt, done: true }, `${item.label} marked posted.`);
  };
  const saveResults = () => {
    const metrics = Object.fromEntries(METRIC_FIELDS.map(({ key }) => [key, numbers[key] ? Number(numbers[key]) : null])) as unknown as DeliverableMetrics;
    if (hasNoMetrics(metrics)) { setError("Add at least one number from the post's insights."); return; }
    void save({ metrics, metricsAt: new Date().toISOString() }, `Results saved for ${item.label}.`);
  };
  const fetchResults = async () => {
    setBusy("fetch");
    setError(null);
    try {
      await appStore.fetchInsights(deal.id, item.id);
      toast(`Results fetched for ${item.label}.`, { tone: "success" });
    } catch (failure) {
      setError(errorMessage(failure, "Instagram didn't share this post's results. Type them in from its insights."));
    } finally {
      setBusy(null);
    }
  };
  const editPost = () => { setLink(item.postUrl ?? ""); setDay(item.postedAt ? dayKey(item.postedAt, timezone) : today); setError(null); setMode("post"); };
  const editResults = () => {
    setNumbers(Object.fromEntries(METRIC_FIELDS.map(({ key }) => [key, item.metrics?.[key] == null ? "" : String(item.metrics[key])])) as Record<keyof DeliverableMetrics, string>);
    setError(null);
    setMode("results");
  };

  return (
    <li className="rounded-2xl bg-inset px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 break-words text-[15px] font-semibold text-ink">{item.label}</span>
        <Tag tone={counted ? "money" : "neutral"} className="bg-surface">{counted ? "Results added" : item.postUrl ? `Posted ${item.postedAt ? short(item.postedAt) : ""}`.trim() : "Not posted yet"}</Tag>
      </div>
      {item.postUrl && mode !== "post" && (
        <a href={item.postUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 text-caption font-medium text-ink-2 underline underline-offset-4">
          <span className="truncate">{item.postUrl.replace(/^https:\/\/(www\.)?/, "")}</span><ExternalLink aria-hidden size={13} className="shrink-0" />
        </a>
      )}
      {counted && mode === "view" && <p className="mt-1 text-[14px] text-ink">{metricsLine(item.metrics, locale)}{item.metricsAt && <span className="text-ink-3"> · {short(item.metricsAt)}</span>}</p>}

      {mode === "post" ? (
        <form className="mt-2 flex flex-col gap-3" noValidate onSubmit={(event) => { event.preventDefault(); savePost(); }}>
          <TextField label="Post link" type="url" inputMode="url" value={link} placeholder="https://www.instagram.com/reel/…" maxLength={500} onChange={(event) => setLink(event.target.value)} />
          <TextField label="Posted on" type="date" max={today} value={day} onChange={(event) => setDay(event.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy === "save"} loadingLabel="Saving…">Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setMode("view"); setError(null); }}>Cancel</Button>
          </div>
        </form>
      ) : mode === "results" ? (
        <form className="mt-2 flex flex-col gap-3" noValidate onSubmit={(event) => { event.preventDefault(); saveResults(); }}>
          <p className="text-caption text-ink-3">Type them from the post&apos;s insights in Instagram. Leave out any you don&apos;t have.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {METRIC_FIELDS.map(({ key, label }) => (
              <TextField key={key} label={label} inputMode="numeric" value={numbers[key]} onChange={(event) => setNumbers((current) => ({ ...current, [key]: event.target.value.replace(/\D/g, "").slice(0, 12) }))} />
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy === "save"} loadingLabel="Saving…">Save results</Button>
            <Button size="sm" variant="ghost" onClick={() => { setMode("view"); setError(null); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!item.postUrl ? (
            <Button size="sm" variant="secondary" icon={Link2} onClick={editPost}>Mark posted</Button>
          ) : !counted ? (
            <>
              <Button size="sm" variant="secondary" icon={ChartNoAxesCombined} onClick={editResults}>Add results</Button>
              {insights && !story && <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy === "fetch"} loadingLabel="Fetching…" onClick={() => void fetchResults()}>Fetch from Instagram</Button>}
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={Pencil} onClick={editResults}>Edit results</Button>
          )}
          {item.postUrl && <Button size="sm" variant="ghost" onClick={editPost}>Edit link</Button>}
        </div>
      )}
      {story && item.postUrl && !counted && mode === "view" && <p className="mt-2 text-caption text-ink-3">Instagram keeps story results for a day only, so grab them from the story&apos;s insights soon.</p>}
      {error && <p role="alert" className="mt-2 text-[14px] text-danger">{error}</p>}
    </li>
  );
}

/**
 * A usage-rights note to copy, for a deal with no conversation in DealDock:
 * the same message a draft would carry (no AI), ready for Instagram or email.
 */
export function UsageNoteSheet({ deal, onClose }: { deal: DealDto | null; onClose: () => void }) {
  const shown = useLast(deal);
  const offers = useOffers();
  const { money, locale, timezone } = useMoneyContext();
  const price = shown && offers.data ? usagePriceFor(shown, offers.data) : null;
  const [text, setText] = useState("");
  useEffect(() => {
    if (deal && offers.data) setText(usageNoteText(deal, usagePriceFor(deal, offers.data), money, locale, timezone));
    // Written once per deal opened, never over the creator's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal?.id, offers.data === null]);
  return (
    <Sheet
      open={deal !== null}
      onClose={onClose}
      title="Usage rights note"
      description={shown ? <>There&apos;s no conversation with <bdi>{dealWith(shown)}</bdi> in DealDock. Copy this and send it from Instagram or email yourself.</> : undefined}
      placement="center"
      footer={<Button variant="primary" size="lg" fullWidth icon={Copy} disabled={!text.trim()} onClick={() => copyText(text.trim(), "Copied. Send it from Instagram or email.")}>Copy message</Button>}
    >
      <div className="flex flex-col gap-3">
        <TextArea label="Message" rows={5} value={text} onChange={(event) => setText(event.target.value)} />
        {offers.data && price === null && <p className="text-caption text-ink-3">No usage price is set, so it asks how long they&apos;d like. <Link href="/offers" className="font-semibold text-brand">Add one in Offers</Link></p>}
      </div>
    </Sheet>
  );
}

/* ── Today and Revenue rows ────────────────────────────────────────────── */

/**
 * Today: who owes what and what happens next. The whole row opens the
 * conversation (an overdue one with a reminder drafted); a deal agreed
 * elsewhere has none, so the row opens its deal sheet (`onOpen`).
 */
export function DealRow({ deal, now, creator, onOpen }: { deal: DealDto; now: number; creator?: string | null; onOpen?: () => void }) {
  const { locale, timezone } = useMoneyContext();
  const late = daysOverdue(deal, now) > 0;
  const className = "dd-row-press flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none hover:bg-[color-mix(in_oklab,var(--dd-inset)_60%,transparent)] focus-visible:bg-inset focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus";
  const body = (
    <>
      <Avatar handle={deal.counterpartyHandle} name={deal.counterpartyName} size={44} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 text-ink"><bdi>{dealWith(deal)}</bdi></span>
          <MoneyValue minor={dealOwedMinor(deal)} className="shrink-0 text-[14px] font-semibold text-ink" />
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-caption">
          {creator && <CreatorChip handle={creator} />}
          <span className={late ? "font-semibold text-waiting" : "text-ink-2"}>{dealNextStep(deal, now, locale, timezone)}{late && deal.threadId && " · Remind"}</span>
        </span>
      </span>
    </>
  );
  return deal.threadId
    ? <Link href={late ? remindHref(deal.threadId, deal.id) : threadHref(deal.threadId)} className={className}>{body}</Link>
    : <button type="button" onClick={onOpen} className={className}>{body}<ChevronRight aria-hidden size={16} className="shrink-0 text-ink-3" /></button>;
}

/**
 * Revenue: an open deal with its due or overdue chip and its money actions:
 * Remind when late (in its conversation), and settle its open invoice, invoice
 * the balance after an advance, or mark it paid (`onPaid`). A deal agreed
 * elsewhere opens its deal sheet from its name (`onOpen`).
 */
export function OwedRow({ deal, now, creator, onPaid, onOpen }: { deal: DealDto; now: number; creator?: string | null; onPaid: () => void; onOpen?: () => void }) {
  const { locale, timezone } = useMoneyContext();
  const late = daysOverdue(deal, now);
  const action = owedAction(deal);
  const label = action === "invoice_paid" ? ACTION.invoice_paid.label : action === "balance" ? ACTION.balance.label : ACTION.paid.label;
  const paidMinor = deal.paidMinor ?? 0;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Avatar handle={deal.counterpartyHandle} name={deal.counterpartyName} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
            {deal.threadId
              ? <Link href={threadHref(deal.threadId)} className="hover:underline"><bdi>{atHandle(deal.counterpartyHandle)}</bdi></Link>
              : <button type="button" onClick={onOpen} className="dd-hit max-w-full truncate text-left hover:underline"><bdi>{dealWith(deal)}</bdi><span className="sr-only">, open deal</span></button>}
          </p>
          <MoneyValue minor={dealOwedMinor(deal)} mode="exact" className="shrink-0 text-[16px] font-semibold text-ink" />
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-3">
          {creator && <CreatorChip handle={creator} />}
          <span className="min-w-0 break-words text-ink-2">{deal.title}</span>
          {paidMinor > 0 && <span><MoneyValue minor={paidMinor} mode="exact" /> paid</span>}
          {late > 0
            ? <Tag tone="waiting">Overdue {late} {pluralize(late, "day")}</Tag>
            : <Tag>{deal.dueAt ? `Due ${dueWords(deal.dueAt, now, locale, timezone)}` : dealStage(deal, now).text}</Tag>}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {late > 0 && deal.threadId && (
            <Link href={remindHref(deal.threadId, deal.id)} aria-label={`Remind ${atHandle(deal.counterpartyHandle)} about ${deal.title}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>
              <BellRing aria-hidden size={16} className="shrink-0" />Remind
            </Link>
          )}
          <Button size="sm" variant={action === "balance" ? "secondary" : "money"} icon={action === "balance" ? FilePlus2 : CheckCheck} aria-label={`${label}: ${deal.title}`} onClick={onPaid}>{label}</Button>
        </div>
      </div>
    </li>
  );
}
