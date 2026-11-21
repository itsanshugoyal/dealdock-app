"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  amountInWords, computeInvoice, formatMoneyFixed, INDIAN_STATES, invoiceLineDescription, InvoicePartySchema, invoiceShareMinor, invoiceTitle, isValidGstin, metricsLine,
  type CurrencyCode, type DealDto, type InvoiceDto, type InvoiceKind, type InvoiceParty, type InvoiceProof,
} from "@dealdock/core";
import { Ban, Download } from "lucide-react";
import { countryName, countryOptions, issueErrors, partyForm, partyInput, type PartyForm } from "../lib/billing";
import { dealWith, endOfDayIso, invoiceDueDefault, invoiceKinds, invoiceStatus, liveInvoices } from "../lib/deals";
import { dayKey, formatDate } from "../lib/format";
import { errorMessage } from "../lib/snapshot";
import { appStore, useBillingProfile, useCan, useMoneyContext } from "../lib/use-demo";
import { Tag } from "./kit";
import { Disclosure, SaveError, useLast } from "./sheet-parts";
import { Button, buttonClasses } from "./ui/button";
import { Select, TextArea, TextField } from "./ui/field";
import { MoneyValue } from "./ui/money-value";
import { Segmented } from "./ui/selection";
import { ConfirmDialog, Sheet } from "./ui/sheet";
import { toast, toastAction } from "./ui/toast";

/** GST state codes by name, for every place a state is picked. */
export const STATE_OPTIONS = Object.entries(INDIAN_STATES).sort((a, b) => a[1].localeCompare(b[1]));

/** A bill-to party's state for people: "Karnataka" for an Indian GST code, else as typed. */
const stateName = (party: Pick<InvoiceParty, "state" | "country">) => (party.state && party.country === "IN" ? INDIAN_STATES[party.state] ?? party.state : party.state);
const placeOf = (party: Pick<InvoiceParty, "city" | "state" | "country">) => [party.city, stateName(party), countryName(party.country)].filter(Boolean).join(", ");

/** Downloads the invoice's PDF: the API's, fetched with the session; the demo's is a labelled placeholder. */
export function downloadInvoice(invoice: Pick<InvoiceDto, "id" | "number">) {
  return toastAction(() => appStore.download(`/invoices/${encodeURIComponent(invoice.id)}/pdf`, `${invoice.number}.pdf`), { fallback: "The PDF couldn't be downloaded. Try again." });
}

/* ── Create an invoice ─────────────────────────────────────────────────── */

const KIND_TEXT: Record<InvoiceKind, string> = { full: "Full amount", advance: "Advance", balance: "Balance" };

/**
 * "Create invoice" for a deal: what it bills (the full fee, or its advance
 * then the balance), who it's to, when it's due and a note, with a live total
 * worked out by core's tax rules from the creator's billing details.
 */
export function InvoiceSheet({ deal, kind: preset, onClose }: { deal: DealDto | null; kind?: InvoiceKind; onClose: () => void }) {
  const { money, timezone } = useMoneyContext();
  const shown = useLast(deal);
  const canReadBilling = useCan("manage_settings");
  const billing = useBillingProfile(shown?.igAccountId, Boolean(shown) && canReadBilling !== false);
  const profile = billing.data?.profile ?? null;
  const kinds = shown ? invoiceKinds(shown) : [];
  const today = dayKey(Date.now(), timezone);
  const [kind, setKind] = useState<InvoiceKind>("full");
  const [party, setParty] = useState<PartyForm>(() => partyForm(null, { name: "", country: "IN" }));
  const [due, setDue] = useState("");
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; billing: boolean } | null>(null);
  const start = useRef("");

  useEffect(() => {
    if (!deal) return;
    const first = preset && invoiceKinds(deal).includes(preset) ? preset : invoiceKinds(deal)[0] ?? "full";
    // The balance goes to whoever the advance went to.
    const previous = liveInvoices(deal).at(-1)?.billTo ?? null;
    const initial = partyForm(previous, { name: deal.counterpartyName ?? "", country: profile?.country ?? (money.currency === "INR" ? "IN" : "US") });
    setKind(first);
    setParty(initial);
    setDue(dayKey(invoiceDueDefault(first, deal, Date.now()), timezone));
    setNotes("");
    setNotesOpen(false);
    setErrors({});
    setSaveError(null);
    start.current = JSON.stringify(initial);
    // Resets when the sheet opens for a deal, never under the creator's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal?.id]);

  const setField = <K extends keyof PartyForm>(key: K, value: PartyForm[K]) => setParty((current) => ({ ...current, [key]: value }));
  const pickKind = (next: InvoiceKind) => {
    setKind(next);
    if (shown) setDue(dayKey(invoiceDueDefault(next, shown, Date.now()), timezone));
  };
  const india = party.country === "IN";

  // The live total: core's own numbers, from the billing details and who it's to.
  let preview: ReturnType<typeof computeInvoice> | null = null;
  if (shown && profile) {
    try {
      const invoiced = liveInvoices(shown).reduce((sum, invoice) => sum + invoice.subtotalMinor, 0);
      const base = invoiceShareMinor(kind, { amountMinor: shown.amountMinor, advancePercent: shown.terms.advancePercent }, invoiced);
      preview = computeInvoice({ baseMinor: base, description: invoiceLineDescription(kind, shown.title, shown.terms.advancePercent), supplier: profile, billTo: partyInput(party) });
    } catch {
      preview = null;
    }
  }

  const submit = async () => {
    if (!deal) return;
    const billTo = partyInput(party);
    const checked = InvoicePartySchema.safeParse(billTo);
    const next = checked.success ? {} : issueErrors(checked.error.issues);
    if (!billTo.name) next.name = "Add the brand's legal name, as the invoice should show it.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due < today) next.due = "Choose today or a later day.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setSaveError(null);
    try {
      const invoice = await appStore.createInvoice(deal.id, { kind, billTo, dueAt: endOfDayIso(due, timezone) ?? undefined, notes: notes.trim() || null });
      toast(`Invoice ${invoice.number} created.`, { tone: "success" });
      onClose();
    } catch (failure) {
      setSaveError({ message: errorMessage(failure, "The invoice wasn't created. Try again."), billing: (failure as { code?: unknown }).code === "billing_profile_required" });
    } finally {
      setBusy(false);
    }
  };

  const missing = billing.status === "ready" && profile === null;
  const advance = shown?.terms.advancePercent;
  return (
    <Sheet
      open={deal !== null}
      onClose={onClose}
      title={kinds.length === 1 && kinds[0] === "balance" ? "Invoice the balance" : "Create invoice"}
      description={shown ? <><bdi>{shown.title}</bdi> · <bdi>{dealWith(shown)}</bdi></> : undefined}
      placement="center"
      dirty={!busy && !missing && (JSON.stringify(party) !== start.current || Boolean(notes))}
      footer={missing ? undefined : <Button variant="money" size="lg" fullWidth loading={busy} loadingLabel="Creating…" disabled={!kinds.length} onClick={() => void submit()}>Create invoice</Button>}
    >
      {missing ? (
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-body text-ink-2">Add your billing details first. Every invoice prints your legal name, tax registration and how to pay you.</p>
          <Link href="/settings#billing" onClick={onClose} className={buttonClasses({ variant: "primary" })}>Add billing details</Link>
        </div>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {kinds.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-label text-ink">What it bills</span>
              <Segmented label="What it bills" value={kind} onChange={pickKind} className="self-start" options={kinds.map((item) => ({ value: item, label: item === "advance" ? `Advance ${advance}%` : KIND_TEXT[item] }))} />
            </div>
          ) : kinds.length === 1 ? (
            <p className="rounded-2xl bg-inset px-4 py-3 text-[14px] text-ink-2">
              {kinds[0] === "balance" ? <>The balance: what&apos;s left after the invoices already made for this deal.</> : <>The full amount of this deal.</>}
            </p>
          ) : <p role="alert" className="rounded-2xl bg-inset px-4 py-3 text-[14px] text-ink-2">Everything on this deal is already invoiced.</p>}

          <fieldset className="flex min-w-0 flex-col gap-4">
            <legend className="mb-1 text-heading text-ink">Bill to</legend>
            <TextField label="Brand's legal name" value={party.name} maxLength={120} autoComplete="organization" error={errors.name} onChange={(event) => setField("name", event.target.value)} />
            <Select label="Country" value={party.country} error={errors.country} onChange={(event) => setParty((current) => ({ ...current, country: event.target.value, state: "", taxNumber: event.target.value === "IN" ? current.taxNumber : "" }))}>
              {countryOptions().map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
            </Select>
            <TextField
              label={india ? "Their GSTIN, optional" : "Their VAT or tax number, optional"}
              value={party.taxNumber}
              maxLength={30}
              autoCapitalize="characters"
              error={errors.taxNumber}
              helper={india ? "A GSTIN sets their state, and so which GST applies." : undefined}
              onChange={(event) => {
                const typed = event.target.value.toUpperCase();
                const number = typed.replace(/\s+/g, "");
                // A valid GSTIN already says the state; the place of supply follows it.
                setParty((current) => ({ ...current, taxNumber: typed, ...(india && isValidGstin(number) ? { state: number.slice(0, 2) } : {}) }));
                if (errors.taxNumber) setErrors(({ taxNumber: _done, ...rest }) => rest);
              }}
              onBlur={() => { const number = party.taxNumber.replace(/\s+/g, ""); if (india && number && !isValidGstin(number)) setErrors((current) => ({ ...current, taxNumber: "This GSTIN doesn't look right. Check the 15 characters." })); }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {india ? (
                <Select label="State" value={party.state} error={errors.state} helper={party.state ? undefined : "Empty uses your own state."} onChange={(event) => setField("state", event.target.value)}>
                  <option value="">Not set</option>
                  {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </Select>
              ) : <TextField label="State or region, optional" value={party.state} maxLength={80} onChange={(event) => setField("state", event.target.value)} />}
              <TextField label="City, optional" value={party.city} maxLength={80} autoComplete="address-level2" onChange={(event) => setField("city", event.target.value)} />
            </div>
            <TextArea label="Address, optional" rows={2} maxLength={480} value={party.address} helper="Street, area and postal code, one per line." onChange={(event) => setField("address", event.target.value)} />
          </fieldset>

          <TextField label="Due" type="date" min={today} value={due} error={errors.due} onChange={(event) => setDue(event.target.value)} />
          <Disclosure summary="Add a note, optional" open={notesOpen} onToggle={setNotesOpen}>
            <TextArea label="Note on the invoice, optional" rows={2} maxLength={500} value={notes} placeholder="PO number, campaign name" onChange={(event) => setNotes(event.target.value)} />
          </Disclosure>

          {preview ? <TotalPreview computed={preview} currency={money.currency} title={invoiceTitle(preview.supplyType, profile!.tax.kind)} /> : profile === null && canReadBilling === false ? (
            <p className="rounded-2xl bg-inset px-4 py-3 text-[14px] text-ink-2">DealDock works out the tax from the creator&apos;s billing details when the invoice is created.</p>
          ) : null}
          <SaveError message={saveError?.message ?? null}>
            {saveError?.billing && <Link href="/settings#billing" onClick={onClose} className="mt-1 inline-block font-semibold underline underline-offset-4">Add billing details</Link>}
          </SaveError>
        </form>
      )}
    </Sheet>
  );
}

/** The total as the invoice will print it: taxable value, each tax line, the total and the amount in words. */
function TotalPreview({ computed, currency, title }: { computed: ReturnType<typeof computeInvoice>; currency: CurrencyCode; title: string }) {
  const supply = computed.supplyType === "export_lut" ? "Export under your LUT: no IGST."
    : computed.supplyType === "export_tax" ? "Export with IGST. Add your LUT in Billing details to invoice without it."
    : computed.supplyType === "untaxed" ? "No tax: your billing details say you're not registered."
    : computed.placeOfSupply ? `Place of supply: ${INDIAN_STATES[computed.placeOfSupply] ?? computed.placeOfSupply}.` : null;
  return (
    <section aria-label="Invoice total" className="rounded-2xl bg-inset p-4">
      <p className="text-caption font-semibold text-ink-3">{title}</p>
      <dl className="mt-2 flex flex-col gap-1.5 text-[14px]">
        <div className="flex justify-between gap-3"><dt className="text-ink-2">{computed.taxes.length ? "Taxable value" : "Amount"}</dt><dd><MoneyValue minor={computed.subtotalMinor} mode="exact" className="text-ink" /></dd></div>
        {computed.taxes.map((tax) => (
          <div key={tax.label} className="flex justify-between gap-3"><dt className="text-ink-2">{tax.label}</dt><dd><MoneyValue minor={tax.amountMinor} mode="exact" className="text-ink" /></dd></div>
        ))}
        <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-hairline pt-2"><dt className="font-semibold text-ink">Total</dt><dd><MoneyValue minor={computed.totalMinor} mode="exact" className="text-[18px] font-semibold text-ink" /></dd></div>
      </dl>
      <p className="mt-1 text-caption text-ink-3">{amountInWords(computed.totalMinor, currency)}</p>
      {supply && <p className="mt-2 text-caption text-ink-2">{supply}</p>}
    </section>
  );
}

/* ── Preview ───────────────────────────────────────────────────────────── */

/** The invoice on screen, with Download PDF and, while unpaid, Void (asks first). */
export function InvoicePreviewSheet({ invoice, proof = null, onClose }: { invoice: InvoiceDto | null; proof?: InvoiceProof | null; onClose: () => void }) {
  const shown = useLast(invoice);
  const [voiding, setVoiding] = useState(false);
  const [busy, setBusy] = useState(false);
  const voidIt = async () => {
    if (!shown) return;
    setBusy(true);
    if (await toastAction(() => appStore.voidInvoice(shown.id), { success: `Invoice ${shown.number} voided. Its number stays used.`, fallback: "The invoice wasn't voided. Try again." })) {
      setVoiding(false);
      onClose();
    }
    setBusy(false);
  };
  return (
    <>
      <Sheet
        open={invoice !== null}
        onClose={onClose}
        title={shown ? `Invoice ${shown.number}` : "Invoice"}
        placement="center"
        initialFocus="title"
        footer={shown && (
          <>
            {shown.status === "issued" && <Button variant="danger-ghost" icon={Ban} className="mr-auto" onClick={() => setVoiding(true)}>Void invoice</Button>}
            <Button variant="secondary" icon={Download} onClick={() => void downloadInvoice(shown)}>Download PDF</Button>
          </>
        )}
      >
        {shown && <InvoiceDocument invoice={shown} proof={proof} />}
      </Sheet>
      <VoidInvoiceDialog invoice={voiding ? shown : null} busy={busy} onClose={() => setVoiding(false)} onConfirm={() => void voidIt()} />
    </>
  );
}

export function VoidInvoiceDialog({ invoice, busy, onClose, onConfirm }: { invoice: InvoiceDto | null; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const shown = useLast(invoice);
  return (
    <ConfirmDialog open={invoice !== null} onClose={onClose} title="Void this invoice?" confirmLabel="Void invoice" cancelLabel="Keep it" destructive busy={busy} busyLabel="Voiding…" onConfirm={onConfirm}>
      {shown && <>{shown.number} stops being owed and its number is never reused. Nothing is sent to <bdi>{shown.billTo.name}</bdi>; tell them yourself if they already have it.</>}
    </ConfirmDialog>
  );
}

/**
 * An HTML rendering of the invoice that mirrors its PDF (apps/api
 * invoice-pdf.ts): the issuer, the invoice's number and dates, who it's to,
 * its line, tax and total in words, how to pay, any declaration and notes.
 */
export function InvoiceDocument({ invoice, proof = null }: { invoice: InvoiceDto; proof?: InvoiceProof | null }) {
  const { locale: appLocale } = useMoneyContext();
  const s = invoice.supplier;
  const ctx = { currency: invoice.currencyCode as CurrencyCode, locale: s.locale };
  const fixed = (minor: number) => formatMoneyFixed(minor, ctx);
  const date = (at: string) => formatDate(at, s.locale || appLocale, s.timezone, { day: "numeric", month: "short", year: "numeric" });
  const status = invoiceStatus(invoice, Date.now());
  const ids = [
    s.tax.kind === "gst_in" && s.tax.number ? `GSTIN: ${s.tax.number}` : null,
    s.tax.kind === "vat" && s.tax.number ? `VAT: ${s.tax.number}` : null,
    s.pan ? `PAN: ${s.pan}` : null,
    s.udyamNumber ? `Udyam: ${s.udyamNumber}` : null,
  ].filter(Boolean);
  const meta: Array<[string, string]> = [
    ["Invoice no.", invoice.number],
    ["Date", date(invoice.issuedAt)],
    ["Due", date(invoice.dueAt)],
    ...(invoice.placeOfSupply ? [["Place of supply", invoice.placeOfSupply === "96" ? "Outside India" : `${INDIAN_STATES[invoice.placeOfSupply] ?? invoice.placeOfSupply} (${invoice.placeOfSupply})`] as [string, string]] : []),
    ...(s.tax.kind === "gst_in" ? [["Reverse charge", "No"] as [string, string]] : []),
  ];
  const p = s.payment;
  const bank = ([["Account name", p.accountName], ["Account number", p.accountNumber], ["Bank", p.bankName], ["IFSC", p.ifsc], ["SWIFT", p.swift], ["IBAN", p.iban]] as const).filter(([, value]) => value);
  // UPI pays rupees within India; a foreign payer uses the bank details.
  const upi = invoice.currencyCode === "INR" && invoice.billTo.country === "IN" ? p.upiId : null;
  const withSac = invoice.lines.some((line) => line.sacCode);
  const label = "mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3";
  return (
    <div className="flex flex-col gap-3">
      {invoice.status === "paid" && invoice.paidAt ? (
        <p className="rounded-2xl bg-brand-tint px-4 py-3 text-[14px] text-ink">
          <b className="font-semibold text-recovered">Paid {date(invoice.paidAt)}.</b> <MoneyValue minor={invoice.receivedMinor ?? 0} mode="exact" /> received{invoice.tdsMinor ? <>, <MoneyValue minor={invoice.tdsMinor} mode="exact" /> TDS withheld</> : null}.
        </p>
      ) : invoice.status === "void" ? (
        <p className="rounded-2xl bg-inset px-4 py-3 text-[14px] text-ink-2"><b className="font-semibold text-ink">Voided.</b> Nothing is owed on it, and its number isn&apos;t reused.</p>
      ) : status.tone === "waiting" ? (
        <p className="rounded-2xl bg-waiting-tint px-4 py-3 text-[14px] text-ink"><b className="font-semibold text-waiting">Overdue.</b> It was due {date(invoice.dueAt)}.</p>
      ) : null}
      {/* Focusable: it is all text, and keyboard users scroll it with the arrow keys. */}
      <article tabIndex={0} aria-label={`${invoice.title} ${invoice.number}`} className="flex flex-col gap-4 rounded-2xl bg-surface p-4 text-[13px] leading-[18px] text-ink shadow-card outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <header className="flex flex-col gap-3">
          <div className="min-w-0">
            <p className="break-words text-[15px] font-semibold leading-5">{s.legalName}</p>
            {s.addressLines.map((line) => <p key={line} className="break-words">{line}</p>)}
            <p>{placeOf(s)}</p>
            {(s.email || s.phone) && <p className="break-words">{[s.email, s.phone].filter(Boolean).join(" · ")}</p>}
            {ids.map((line) => <p key={line} className="break-words text-ink-3">{line}</p>)}
          </div>
          <div className="flex items-center gap-2">
            <h3 className="text-[20px] font-bold leading-6 tracking-[-0.01em]">{invoice.title}</h3>
            <Tag tone={status.tone}>{status.text}</Tag>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            {meta.map(([name, value]) => <div key={name} className="contents"><dt className="text-ink-3">{name}</dt><dd className="break-words text-right font-semibold">{value}</dd></div>)}
          </dl>
        </header>

        <section className="border-t border-hairline pt-3">
          <h4 className={label}>Bill to</h4>
          <p className="break-words text-[14px] font-semibold">{invoice.billTo.name}</p>
          {invoice.billTo.addressLines.map((line) => <p key={line} className="break-words">{line}</p>)}
          <p>{placeOf(invoice.billTo)}</p>
          {invoice.billTo.taxNumber && <p className="text-ink-3">{invoice.billTo.country === "IN" ? "GSTIN" : "Tax no."}: {invoice.billTo.taxNumber}</p>}
        </section>

        <section className="border-t border-hairline pt-3">
          <h4 className="sr-only">Lines</h4>
          <ol className="flex flex-col gap-2">
            {invoice.lines.map((line, index) => (
              <li key={index} className="flex items-start gap-3">
                <span className="w-4 shrink-0 text-ink-3">{index + 1}</span>
                <span className="min-w-0 flex-1 break-words">{line.description}{withSac && line.sacCode && <span className="block text-ink-3">SAC {line.sacCode}</span>}</span>
                <span className="shrink-0 tabular-nums">{fixed(line.amountMinor)}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-hairline pt-3">
          <h4 className="sr-only">Totals</h4>
          <dl className="flex flex-col gap-1">
            <div className="flex justify-between gap-3 text-ink-2"><dt>{invoice.taxes.length ? "Taxable value" : "Subtotal"}</dt><dd className="tabular-nums">{fixed(invoice.subtotalMinor)}</dd></div>
            {invoice.taxes.map((tax) => <div key={tax.label} className="flex justify-between gap-3 text-ink-2"><dt>{tax.label}</dt><dd className="tabular-nums">{fixed(tax.amountMinor)}</dd></div>)}
            <div className="flex justify-between gap-3 text-[15px] font-semibold"><dt>Total ({invoice.currencyCode})</dt><dd className="tabular-nums">{fixed(invoice.totalMinor)}</dd></div>
          </dl>
          <p className="mt-1 text-ink-3">Amount in words: {amountInWords(invoice.totalMinor, invoice.currencyCode as CurrencyCode)}</p>
        </section>

        {(upi || p.paymentLink || bank.length > 0) && (
          <section className="border-t border-hairline pt-3">
            <h4 className={label}>Payment</h4>
            {upi && <p><b className="font-semibold">UPI: {upi}</b>{invoice.totalMinor <= 1_00_000_00 && <span className="block text-ink-3">The PDF has a QR code to scan and pay {fixed(invoice.totalMinor)}.</span>}</p>}
            {bank.map(([name, value]) => <p key={name} className="break-words">{name}: {value}</p>)}
            {p.paymentLink && <p className="break-words">Pay online: {p.paymentLink}</p>}
          </section>
        )}
        {proof && (
          // As the PDF prints it: the posts read from the deal now, so results added later go to the brand too.
          <section className="border-t border-hairline pt-3">
            <h4 className={label}>Proof of delivery</h4>
            <ul className="flex flex-col gap-2">
              {proof.posts.map((post) => (
                <li key={post.postUrl}>
                  <p className="font-semibold">{post.label}{post.postedAt && <>, posted {date(post.postedAt)}</>}</p>
                  <p className="break-all text-ink-3">{post.postUrl}</p>
                  {post.metrics && <p>Results{post.metricsAt && <> as of {date(post.metricsAt)}</>}: {metricsLine(post.metrics, s.locale || appLocale)}</p>}
                </li>
              ))}
            </ul>
            {proof.disclosure.length > 0 && <p className="mt-2">Disclosure: {proof.disclosure.join("; ")}</p>}
          </section>
        )}
        {invoice.declaration && <p className="border-t border-hairline pt-3 font-semibold">{invoice.declaration}</p>}
        {invoice.notes && (
          <section className="border-t border-hairline pt-3">
            <h4 className={label}>Notes</h4>
            <p className="whitespace-pre-wrap break-words">{invoice.notes}</p>
          </section>
        )}
        <p className="text-[11px] text-ink-3">Computer-generated invoice; no signature required.</p>
      </article>
    </div>
  );
}
