"use client";

import { useEffect, useRef, useState } from "react";
import { parseMoneyInput, type DealType } from "@dealdock/core";
import { whoFrom } from "../lib/deals";
import { errorMessage } from "../lib/snapshot";
import { appStore, useMoneyContext, type DemoLedgerEntry } from "../lib/use-demo";
import { Button } from "./ui/button";
import { DealTypeSelect, MONEY_INPUT_ERROR, MoneyField, TextArea, moneyFieldText } from "./ui/field";
import { formatMoney } from "./ui/money-value";
import { Sheet } from "./ui/sheet";
import { toast } from "./ui/toast";

interface SaleForm { amount: string; dealType: DealType; note: string }

/**
 * "Edit sale" in Revenue: what was actually paid, the offer type and a note.
 * Sales are recorded from a conversation with "Record a deal" (deals.tsx).
 * `entry` is null while the sheet is closed.
 */
export function SaleSheet({ open, onClose, entry }: { open: boolean; onClose: () => void; entry: DemoLedgerEntry | null }) {
  const { money } = useMoneyContext();
  const handle = entry?.handle ?? null;
  const initial: SaleForm = { amount: moneyFieldText(entry?.amountMinor), dealType: entry?.dealType ?? "brand", note: entry?.note ?? "" };
  const start = useRef(initial);
  start.current = initial;
  const startKey = `${entry?.id ?? ""}|${initial.amount}|${initial.dealType}|${initial.note}`;
  const [form, setForm] = useState<SaleForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(start.current);
    setError(null);
    // Resets when the sheet opens and when what it starts from changes; `startKey` covers the entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startKey]);

  const set = <K extends keyof SaleForm>(key: K, value: SaleForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = form.amount !== initial.amount || form.dealType !== initial.dealType || form.note !== initial.note;

  const submit = async () => {
    const minor = parseMoneyInput(form.amount);
    if (!minor || minor <= 0) { setError(MONEY_INPUT_ERROR); return; }
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      await appStore.updateLedger(entry.id, { amountMinor: minor, dealType: form.dealType, note: form.note.trim() || undefined });
      toast(`Sale updated: ${formatMoney(minor, null, "exact", money)}.`, { tone: "success" });
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
      title="Edit sale"
      description={handle === null ? undefined : <>With <bdi>{whoFrom(handle, entry?.threadId != null)}</bdi></>}
      placement="center"
      dirty={dirty && !busy}
      footer={<Button variant="primary" size="lg" fullWidth loading={busy} loadingLabel="Saving…" onClick={() => void submit()}>Save</Button>}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <MoneyField
          label="Amount"
          size="lg"
          value={form.amount}
          onChange={(text) => set("amount", text)}
          error={error}
          placeholder="45000"
          preview={(amount) => <>Saves {amount} as confirmed revenue.</>}
          previewKind="confirmed"
        />
        <DealTypeSelect value={form.dealType} onChange={(type) => set("dealType", type)} />
        <TextArea label="Note (optional)" rows={2} value={form.note} onChange={(event) => set("note", event.target.value)} placeholder="2 reels + 3 stories, paid via UPI" />
      </form>
    </Sheet>
  );
}
