"use client";

import Link from "next/link";
import { useState } from "react";
import { resultsDue, usageReminderDue, type DealDto } from "@dealdock/core";
import { ChartNoAxesCombined, ChevronRight, ShieldCheck } from "lucide-react";
import { resultsReminderText, usageReminderText } from "../lib/deals";
import { appStore, useMoneyContext } from "../lib/use-demo";
import { Group } from "./kit";
import { ProofSheet, UsageNoteSheet } from "./deals";
import { Button, buttonClasses } from "./ui/button";
import { Avatar } from "./ui/sender";
import { toast } from "./ui/toast";

/**
 * Today's "Rights and results": a deal's usage rights ending (from two weeks
 * before until a week after, until the creator deals with it) and posts whose
 * results are due (a week after posting, a day for stories). One row per deal,
 * each with one next step; the rules live in @dealdock/core.
 */
export function RightsAndResults({ deals, now, creatorOf }: { deals: readonly DealDto[]; now: number; creatorOf: (igAccountId: string) => string | null | undefined }) {
  const { locale, timezone } = useMoneyContext();
  const [proofing, setProofing] = useState<string | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const usage = deals.filter((deal) => usageReminderDue(deal, now));
  const results = deals.flatMap((deal) => {
    const due = resultsDue(deal, now);
    return due.length ? [{ deal, due }] : [];
  });
  const count = usage.length + results.length;

  const handle = async (deal: DealDto, handled: boolean) => {
    setBusy(deal.id);
    try {
      await appStore.setUsageHandled(deal.id, handled);
      if (handled) toast("Done. Today won't remind you about these usage rights again.", { tone: "success", action: { label: "Undo", onClick: () => void handle(deal, false) } });
    } catch {
      toast("That didn't save. Try again.", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {count > 0 && (
        <Group id="rights" title={<>Rights and results <span className="ml-1 text-ink-3">{count}</span></>}>
          <ul className="divide-y divide-hairline">
            {usage.map((deal) => {
              const creator = creatorOf(deal.igAccountId);
              const text = usageReminderText(deal, now, locale, timezone);
              return (
                <li key={`usage-${deal.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <span className="flex min-w-0 flex-1 basis-[16rem] items-center gap-3">
                    <span className="relative shrink-0">
                      <Avatar handle={deal.counterpartyHandle} name={deal.counterpartyName} size={44} />
                      <span aria-hidden className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-surface text-waiting shadow-card"><ShieldCheck size={13} /></span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold leading-5 text-ink"><bdi>{text}</bdi></span>
                      <span className="block text-caption text-ink-3">{creator ? <>@{creator} · </> : null}Renew them or ask them to stop.</span>
                    </span>
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {deal.threadId ? (
                      <Link href={`/thread/${encodeURIComponent(deal.threadId)}?usage=${encodeURIComponent(deal.id)}`} aria-label={`Draft renewal: ${text}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>Draft renewal</Link>
                    ) : (
                      <Button size="sm" variant="secondary" aria-label={`Draft renewal: ${text}`} onClick={() => setNoting(deal.id)}>Draft renewal</Button>
                    )}
                    <Button size="sm" variant="ghost" aria-label={`Done: ${text}`} loading={busy === deal.id} loadingLabel="Saving…" onClick={() => void handle(deal, true)}>Done</Button>
                  </span>
                </li>
              );
            })}
            {results.map(({ deal, due }) => {
              const creator = creatorOf(deal.igAccountId);
              return (
                <li key={`results-${deal.id}`}>
                  <button type="button" onClick={() => setProofing(deal.id)} className="dd-row-press flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[color-mix(in_oklab,var(--dd-inset)_60%,transparent)]">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-inset text-ink-2"><ChartNoAxesCombined aria-hidden size={20} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold leading-5 text-ink"><bdi>{resultsReminderText(deal, due)}</bdi></span>
                      <span className="block text-caption text-ink-3">{creator ? <>@{creator} · </> : null}Type them from the post&apos;s insights. They go on the invoice.</span>
                    </span>
                    <ChevronRight aria-hidden size={16} className="shrink-0 text-ink-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Group>
      )}
      {/* The sheets show the deal as it is now. */}
      <ProofSheet deal={deals.find((deal) => deal.id === proofing) ?? null} onClose={() => setProofing(null)} />
      <UsageNoteSheet deal={deals.find((deal) => deal.id === noting) ?? null} onClose={() => setNoting(null)} />
    </>
  );
}
