"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { dealRevenueMinor, type DealDto, type RenewalDto } from "@dealdock/core";
import { Copy } from "lucide-react";
import { dealWith } from "../lib/deals";
import { formatDate } from "../lib/format";
import { errorMessage } from "../lib/snapshot";
import { appStore, useMoneyContext } from "../lib/use-demo";
import { SaveError, useLast } from "./sheet-parts";
import { Button, buttonClasses } from "./ui/button";
import { TextArea } from "./ui/field";
import { Skeleton } from "./ui/feedback";
import { MoneyValue } from "./ui/money-value";
import { Avatar } from "./ui/sender";
import { Sheet } from "./ui/sheet";
import { toastAction } from "./ui/toast";

/** A deal's pitch opens in its conversation and is drafted there once (?pitch=); without one it is text to copy. */
export const pitchHref = (deal: Pick<DealDto, "id" | "threadId">) => `/thread/${encodeURIComponent(deal.threadId!)}?pitch=${encodeURIComponent(deal.id)}`;

/**
 * Today: one quiet row per brand worth pitching again, with "Draft a pitch"
 * and "Not now". Nothing is sent from here: the pitch is a draft to approve,
 * or text to copy when the deal has no conversation.
 */
export function RenewalRow({ renewal, creator, onCopy }: { renewal: RenewalDto; creator?: string | null; onCopy: () => void }) {
  const { deal, festive } = renewal;
  const { locale, timezone } = useMoneyContext();
  const [busy, setBusy] = useState(false);
  const who = dealWith(deal);
  const notNow = async () => {
    setBusy(true);
    await toastAction(() => appStore.handleRenewal(deal.id, "not_now"), { success: `Okay. ${who} comes back here only after another paid deal.`, fallback: "That didn't save. Try again." });
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <Avatar handle={deal.counterpartyHandle} name={deal.counterpartyName} size={44} />
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-[15px] font-semibold leading-5 text-ink">Pitch <bdi>{who}</bdi> again</p>
        <p className="mt-0.5 text-caption text-ink-2">
          {creator && <span className="font-medium">@{creator} · </span>}
          Paid <MoneyValue minor={dealRevenueMinor(deal)} mode="exact" className="font-semibold text-ink-2" />{deal.paidAt && <> on {formatDate(deal.paidAt, locale, timezone, { day: "numeric", month: "short" })}</>}
          {festive && <> · festive budgets are being set now</>}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 gap-1.5">
        {deal.threadId
          ? <Link href={pitchHref(deal)} aria-label={`Draft a pitch to ${who}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>Draft a pitch</Link>
          : <Button size="sm" variant="secondary" aria-label={`Draft a pitch to ${who}`} onClick={onCopy}>Draft a pitch</Button>}
        <Button size="sm" variant="ghost" loading={busy} loadingLabel="Saving…" aria-label={`Not now: ${who}`} onClick={() => void notNow()}>Not now</Button>
      </div>
    </div>
  );
}

/**
 * A pitch for a paid deal agreed outside DealDock: there's no conversation to
 * send it from, so DealDock writes it in the creator's voice to copy into
 * Instagram or an email. Copying counts as pitching them.
 */
export function CopyPitchSheet({ deal, onClose }: { deal: DealDto | null; onClose: () => void }) {
  const shown = useLast(deal);
  const [text, setText] = useState("");
  const [state, setState] = useState<"writing" | "ready" | "failed">("writing");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!deal) return;
    let live = true;
    setState("writing");
    setError(null);
    appStore.draftForDeal(deal.id).then(
      (body) => { if (live) { setText(body); setState("ready"); } },
      (failure) => { if (live) { setError(errorMessage(failure, "DealDock couldn't write a pitch right now. Try again.")); setState("failed"); } },
    );
    return () => { live = false; };
  }, [deal]);

  const copy = async () => {
    if (!deal) return;
    if (!navigator.clipboard) { setError("Couldn't copy it. Select the text and copy it yourself."); return; }
    setBusy(true);
    try {
      await navigator.clipboard.writeText(text.trim());
    } catch {
      setBusy(false);
      setError("Couldn't copy it. Select the text and copy it yourself.");
      return;
    }
    const saved = await toastAction(() => appStore.handleRenewal(deal.id, "copied"), { success: "Copied. Send it from Instagram or your email.", fallback: "Copied, but DealDock couldn't take it off Today. Use Not now." });
    setBusy(false);
    if (saved) onClose();
  };

  return (
    <Sheet
      open={deal !== null}
      onClose={onClose}
      title={shown ? `Pitch ${dealWith(shown)} again` : "Pitch again"}
      description="Agreed outside DealDock, so there's no conversation to send it from. Check it, then copy it and send it yourself."
      placement="center"
      footer={<Button variant="primary" size="lg" fullWidth icon={Copy} disabled={state !== "ready" || !text.trim()} loading={busy} loadingLabel="Copying…" onClick={() => void copy()}>Copy the pitch</Button>}
    >
      <div className="flex flex-col gap-3">
        {state === "writing" ? (
          <div role="status" className="flex flex-col gap-2"><span className="sr-only">Writing it in your voice…</span><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-3/5" /></div>
        ) : state === "ready" ? (
          <TextArea label="Your pitch" rows={6} value={text} onChange={(event) => setText(event.target.value)} helper="Written in your voice from this deal. Nothing is sent." />
        ) : null}
        <SaveError message={error} />
      </div>
    </Sheet>
  );
}
