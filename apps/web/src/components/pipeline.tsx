"use client";

import Link from "next/link";
import { useState } from "react";
import { LEAD_PROVIDER_NAME, LEAD_STAGES, formatEventAmount, pipelineStage, stageCounts, type LeadEventDto, type LeadStage } from "@dealdock/core";
import { HandCoins } from "lucide-react";
import { formatDate, pluralize } from "../lib/format";
import { errorMessage } from "../lib/snapshot";
import { appStore, useMoneyContext, type DemoThread } from "../lib/use-demo";
import { Button } from "./ui/button";
import { cx } from "./ui/cx";
import { Segmented } from "./ui/selection";
import { toast, toastAction } from "./ui/toast";

/** The coach pipeline in creator words. */
export const STAGE_TEXT: Record<LeadStage, string> = { lead: "Lead", qualified: "Qualified", booked: "Booked", paid: "Paid" };

/** A conversation's stage on its inbox row: a quiet word, money-coloured only once they paid. */
export function StageChip({ stage }: { stage: LeadStage }) {
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[12px] font-semibold", stage === "paid" ? "bg-brand-tint text-recovered" : "bg-inset text-ink-2")}>
      <span className="sr-only">Stage: </span>{STAGE_TEXT[stage]}
    </span>
  );
}

/**
 * Where a coaching or course conversation stands, set by hand in the
 * conversation. Any stage can be chosen; a booking or payment tool that
 * reports back only ever moves it forward.
 */
export function StageControl({ thread }: { thread: Pick<DemoThread, "id" | "topLabel" | "leadStage"> }) {
  const current = pipelineStage(thread);
  const [pending, setPending] = useState<LeadStage | null>(null);
  if (!current) return null;
  const change = async (stage: LeadStage) => {
    if (stage === (pending ?? current)) return;
    setPending(stage);
    try {
      await appStore.setLeadStage(thread.id, stage);
    } catch (failure) {
      toast(errorMessage(failure, "The stage didn't change. Try again."), { tone: "error" });
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
      <span aria-hidden className="text-caption text-ink-3">Stage</span>
      <Segmented label="Stage" value={pending ?? current} options={LEAD_STAGES.map((stage) => ({ value: stage, label: STAGE_TEXT[stage] }))} onChange={(stage) => void change(stage)} />
    </div>
  );
}

/**
 * Today: how many coaching and course conversations stand at each stage, each
 * opening the inbox at that stage. Only the conversations still open or
 * waiting count: recording the sale closes one, so it leaves the pipeline.
 */
export function PipelineSummary({ threads }: { threads: readonly DemoThread[] }) {
  const inPipeline = threads.filter((thread) => thread.routedTo === "inbox" && thread.state !== "closed" && pipelineStage(thread) !== null);
  if (inPipeline.length === 0) return null;
  const counts = stageCounts(inPipeline);
  return (
    <section aria-labelledby="pipeline-title" className="rounded-[22px] bg-surface p-5 shadow-card md:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="pipeline-title" className="text-heading text-ink">Coaching and courses</h2>
        <span className="text-caption text-ink-3">{inPipeline.length} in progress</span>
      </div>
      <ol className="mt-4 grid grid-cols-4 gap-2">
        {LEAD_STAGES.map((stage) => (
          <li key={stage} className="min-w-0">
            <Link
              href={`/inbox?stage=${stage}`}
              aria-label={`${STAGE_TEXT[stage]}: ${counts[stage]} ${pluralize(counts[stage], "conversation")}`}
              className="dd-press flex min-h-[68px] flex-col items-center justify-center rounded-2xl bg-inset px-1 py-2.5 hover:bg-fill"
            >
              <span className={cx("text-[20px] font-semibold leading-7 tabular-nums", counts[stage] ? "text-ink" : "text-ink-3")}>{counts[stage]}</span>
              <span className="truncate text-caption text-ink-2">{STAGE_TEXT[stage]}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Paid ₹4,999 through Razorpay" in the payment's own currency. */
export function paidWords(event: Pick<LeadEventDto, "amountMinor" | "currencyCode" | "provider">, locale: string): string {
  const amount = event.amountMinor !== null && event.currencyCode ? ` ${formatEventAmount(event.amountMinor, event.currencyCode, locale)}` : "";
  return event.provider === "other" ? `Paid${amount}, reported by your automation` : `Paid${amount} through ${LEAD_PROVIDER_NAME[event.provider]}`;
}

/** In the conversation: a payment a tool reported, with one next step (record the sale) and a way to let it go. */
export function PaymentBanner({ payment, onRecord }: { payment: LeadEventDto; onRecord: () => void }) {
  const { locale, timezone } = useMoneyContext();
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    setBusy(true);
    await toastAction(() => appStore.dismissLeadEvent(payment.id), { success: "Dismissed. It won't ask to be recorded again.", fallback: "That didn't save. Try again." });
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-brand-tint p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand"><HandCoins aria-hidden size={20} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-label font-semibold text-recovered">{paidWords(payment, locale)}</span>
        <span className="block truncate text-[14px] text-ink-2">{[payment.payerName, formatDate(payment.occurredAt, locale, timezone, { day: "numeric", month: "short" })].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="money" onClick={onRecord}>Record the sale</Button>
        <Button size="sm" variant="ghost" loading={busy} loadingLabel="Dismissing…" onClick={() => void dismiss()}>Dismiss</Button>
      </span>
    </div>
  );
}
