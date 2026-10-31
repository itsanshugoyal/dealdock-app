"use client";

import { useEffect, useRef, useState } from "react";
import { parseMoneyInput, type DealType } from "@dealdock/core";
import { dealTypeForLabel } from "../lib/format";
import { errorMessage } from "../lib/snapshot";
import { appStore, useMoneyContext, type DemoLedgerEntry, type DemoThread } from "../lib/use-demo";
import { Button } from "./ui/button";
import { DealTypeSelect, MONEY_INPUT_ERROR, MoneyField, TextArea, moneyFieldText } from "./ui/field";
import { formatMoney } from "./ui/money-value";
import { Sheet } from "./ui/sheet";
import { toast } from "./ui/toast";

interface SaleForm { amount: string; dealType: DealType; note: string }

/** `thread`: record a sale from that conversation. `entry`: edit that ledger entry (null while closed). */
export type SaleSheetProps = { open: boolean; onClose: () => void } & (
  | { thread: DemoThread; entry?: undefined }
  | { entry: DemoLedgerEntry | null; thread?: undefined }
);

/**
 * "Record a sale" (from a conversation) and "Edit sale" (from Revenue) are one
 * form: what was actually paid, the offer type and a note. Estimates never
 * count as revenue, so nothing here starts from one unless the conversation
 * itself named an amount.
 */
export function SaleSheet({ open, onClose, thread, entry }: SaleSheetProps) {
  const { money } = useMoneyContext();
  const editing = thread === undefined;
  const handle = thread?.handle ?? entry?.handle ?? null;
  const initial: SaleForm = thread
    ? { amount: moneyFieldText(thread.dealSignal?.suggestedAmountMinor), dealType: thread.dealSignal?.suggestedDealType ?? dealTypeForLabel(thread.topLabel), note: "" }
    : { amount: moneyFieldText(entry?.amountMinor), dealType: entry?.dealType ?? "brand", note: entry?.note ?? "" };
  const start = useRef(initial);
  start.current = initial;
  const startKey = `${thread?.id ?? entry?.id ?? ""}|${initial.amount}|${initial.dealType}|${initial.note}`;
  const [form, setForm] = useState<SaleForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotency = useRef("");
  useEffect(() => {
    if (!open) return;
    setForm(start.current);
    setError(null);
    if (thread) idempotency.current = `close-${thread.id}-${Date.now()}`;
    // Resets when the sheet opens and when what it starts from changes; `startKey` covers the thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startKey]);

  const set = <K extends keyof SaleForm>(key: K, value: SaleForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = form.amount !== initial.amount || form.dealType !== initial.dealType || form.note !== initial.note;

  const submit = async () => {
    const minor = parseMoneyInput(form.amount);
    if (!minor || minor <= 0) { setError(MONEY_INPUT_ERROR); return; }
    setBusy(true);
    setError(null);
    try {
      const note = form.note.trim() || undefined;
      if (thread) {
        await appStore.closeDeal(thread.id, minor, form.dealType, { note, idempotencyKey: idempotency.current });
        toast(`Sale recorded: ${formatMoney(minor, null, "exact", money)}. It's in your revenue now.`, { tone: "success" });
      } else if (entry) {
        await appStore.updateLedger(entry.id, { amountMinor: minor, dealType: form.dealType, note });
        toast(`Sale updated: ${formatMoney(minor, null, "exact", money)}.`, { tone: "success" });
      }
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "That didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? "Edit sale" : "Record a sale"}
      description={handle === null ? undefined : editing
        ? <>With <bdi>@{handle}</bdi></>
        : <>Only money you&apos;ve actually been paid by <bdi>@{handle}</bdi>. Estimates never count as revenue.</>}
      placement="center"
      dirty={dirty && !busy}
      footer={<Button variant={editing ? "primary" : "money"} size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void submit()}>{editing ? "Save" : "Confirm sale"}</Button>}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <MoneyField
          label="Amount"
          size="lg"
          value={form.amount}
          onChange={(text) => set("amount", text)}
          error={error}
          placeholder="45000"
          preview={(amount) => <>{editing ? "Saves" : "Records"} {amount} as confirmed revenue.</>}
          previewKind="confirmed"
        />
        <DealTypeSelect value={form.dealType} onChange={(type) => set("dealType", type)} />
        <TextArea label="Note (optional)" rows={2} value={form.note} onChange={(event) => set("note", event.target.value)} placeholder="2 reels + 3 stories, paid via UPI" />
      </form>
    </Sheet>
  );
}
