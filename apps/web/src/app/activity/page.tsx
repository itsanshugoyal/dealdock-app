"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { editRatio, isAuditAction, type AuditAction, type AuditRow } from "@dealdock/core";
import { ArrowRight, ChevronDown, ScrollText } from "lucide-react";
import { dayKey, dayLabel, formatTime } from "../../lib/format";
import { useMinuteClock } from "../../lib/keyboard";
import { appStore, useApp, useAudit } from "../../lib/use-demo";
import { LargeTitle, Logo } from "../../components/kit";
import { cx } from "../../components/ui/cx";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui/feedback";
import { Select } from "../../components/ui/field";
import { Chip } from "../../components/ui/selection";
import { Avatar } from "../../components/ui/sender";

type Kind = "reply" | "sale" | "sorting" | "studio" | "settings";
const FILTERS: Array<{ value: Kind | "all"; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "reply", label: "Replies" },
  { value: "sale", label: "Sales" },
  { value: "sorting", label: "Sorting" },
  { value: "studio", label: "Voice & offers" },
  { value: "settings", label: "Settings & team" },
];

type Described = { kind: Kind; text: (handle: ReactNode) => ReactNode };

/**
 * A sentence for every action the backend writes (AUDIT_ACTIONS in
 * @dealdock/core): the Record type fails the build when an action has no words.
 */
const ACTIONS: Record<AuditAction, Described> = {
  "message.sent": { kind: "reply", text: (handle) => <>sent a reply to {handle}</> },
  "classification.reviewed": { kind: "sorting", text: (handle) => <>sorted a message{handle ? <> from {handle}</> : null}</> },
  "thread.state_changed": { kind: "sorting", text: (handle) => <>moved the conversation{handle ? <> with {handle}</> : null}</> },
  "nudge.dismissed": { kind: "sorting", text: (handle) => <>skipped a follow-up{handle ? <> for {handle}</> : null}</> },
  "ledger.created": { kind: "sale", text: (handle) => <>recorded a sale from {handle}</> },
  "ledger.updated": { kind: "sale", text: (handle) => <>edited a sale{handle ? <> from {handle}</> : null}</> },
  "ledger.deleted": { kind: "sale", text: (handle) => <>deleted a sale{handle ? <> from {handle}</> : null}</> },
  "offer.created": { kind: "studio", text: () => "added an offer" },
  "offer.updated": { kind: "studio", text: () => "edited an offer" },
  "offer.deleted": { kind: "studio", text: () => "deleted an offer" },
  "voice.consent_granted": { kind: "studio", text: () => "turned on voice learning" },
  "voice.consent_revoked": { kind: "studio", text: () => "turned off voice learning" },
  "voice.learning_paused": { kind: "studio", text: () => "paused voice learning" },
  "voice.learning_resumed": { kind: "studio", text: () => "resumed voice learning" },
  "voice.style_overridden": { kind: "studio", text: () => "adjusted the writing style" },
  "voice.sample_excluded": { kind: "studio", text: () => "left a reply out of Your voice" },
  "voice.sample_included": { kind: "studio", text: () => "put a reply back into Your voice" },
  "voice.rule_created": { kind: "studio", text: () => "added a rule to Your voice" },
  "voice.rule_updated": { kind: "studio", text: () => "edited a rule in Your voice" },
  "voice.rule_pinned": { kind: "studio", text: () => "pinned a rule in Your voice" },
  "voice.rule_muted": { kind: "studio", text: () => "turned off a rule in Your voice" },
  "voice.rule_deleted": { kind: "studio", text: () => "deleted a rule from Your voice" },
  "voice.clone_created": { kind: "studio", text: () => "recorded a speaking voice" },
  "voice.clone_failed": { kind: "studio", text: () => "recorded a speaking voice, but it couldn't be created" },
  "voice.clone_revoked": { kind: "studio", text: () => "deleted the speaking voice" },
  "voice.disclosure_enabled": { kind: "studio", text: () => "turned on the AI label for voice notes" },
  "voice.disclosure_disabled": { kind: "studio", text: () => "turned off the AI label for voice notes" },
  "organization.created": { kind: "settings", text: () => "set up the workspace" },
  "onboarding.profile_saved": { kind: "settings", text: () => "set up the business profile" },
  "settings.region_changed": { kind: "settings", text: () => "changed region settings" },
  "settings.goal_changed": { kind: "settings", text: () => "changed the monthly goal" },
  "settings.ignore_list_changed": { kind: "settings", text: () => "updated people to skip" },
  "settings.voice_enabled": { kind: "settings", text: () => "turned on drafts in your voice" },
  "settings.voice_disabled": { kind: "settings", text: () => "turned off drafts in your voice" },
  "seat.invited": { kind: "settings", text: () => "invited someone to the team" },
  "seat.removed": { kind: "settings", text: () => "removed someone from the team" },
  "ig.disconnected": { kind: "settings", text: () => "disconnected Instagram" },
  "billing.cancel_requested": { kind: "settings", text: () => "cancelled the plan" },
  "account.deletion_requested": { kind: "settings", text: () => "scheduled account deletion" },
  "account.deletion_cancelled": { kind: "settings", text: () => "cancelled account deletion" },
  "nudge.due": { kind: "sorting", text: (handle) => <>flagged a follow-up as due{handle ? <> for {handle}</> : null}</> },
  "digest.weekly_sent": { kind: "settings", text: () => "sent the weekly summary" },
};

/** Words for the row; an action this screen doesn't know yet (a newer API) still reads as plain words. */
function describe(row: AuditRow): Described {
  if (isAuditAction(row.action)) return ACTIONS[row.action];
  return { kind: "settings", text: () => row.action.replace(/[._]/g, " ") };
}

/** Share of the draft that changed (core editRatio, the measure behind voice match); at least 1% when anything changed. */
function changedPct(row: AuditRow): number | null {
  if (row.editDistance === null || !row.originalDraft || !row.finalText) return null;
  if (row.originalDraft === row.finalText) return 0;
  return Math.max(1, Math.round(editRatio(row.originalDraft, row.finalText) * 100));
}

/** Activity: who sent what and changed what. Creators see everything done on their account. */
export default function ActivityPage() {
  const audit = useAudit(200);
  const { money, timezone } = useApp();
  const now = useMinuteClock();
  const locale = money.locale ?? "en-IN";
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [actor, setActor] = useState("");
  const rows = useMemo(() => audit.data ?? [], [audit.data]);
  const actors = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) if (row.actor) map.set(row.actor.seatId, row.actor.name ?? "Someone on your team");
    return [...map.entries()];
  }, [rows]);
  const visible = rows.filter((row) => (filter === "all" || describe(row).kind === filter) && (!actor || row.actor?.seatId === actor));

  const days: Array<{ key: string; label: string; rows: AuditRow[] }> = [];
  for (const row of visible) {
    const at = Date.parse(row.at);
    const key = dayKey(at, timezone);
    const last = days[days.length - 1];
    if (last?.key === key) last.rows.push(row);
    else days.push({ key, label: dayLabel(at, now, locale, timezone), rows: [row] });
  }

  return (
    <div className="mx-auto w-full max-w-[860px] pb-16">
      <LargeTitle eyebrow="Settings" title="Activity" subtitle="Every reply that went out and who approved it, plus every change to sales, voice and settings." />
      <div className="px-4 md:px-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="dd-scroll-x -mx-1 flex min-w-0 gap-2 px-1 pb-1" role="group" aria-label="Show">
            {FILTERS.map((item) => <Chip key={item.value} pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</Chip>)}
          </div>
          {actors.length > 1 && (
            <Select label="Person" hideLabel value={actor} onChange={(event) => setActor(event.target.value)} className="w-full shrink-0 md:w-44">
              <option value="">Everyone</option>
              {actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          )}
        </div>

        <div className="mt-5">
          {audit.status === "error" && !audit.data ? (
            <ErrorState thing="activity" reason={audit.error} onRetry={() => void appStore.loadAudit(200)} />
          ) : !audit.data ? (
            <div className="flex flex-col gap-3">{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-[72px] rounded-[20px]" />)}</div>
          ) : visible.length === 0 ? (
            <EmptyState icon={ScrollText} title={rows.length ? "Nothing matches" : "No activity yet"} description={rows.length ? "Try another filter." : "Replies, sales and changes show up here as they happen."} />
          ) : (
            <div className="flex flex-col gap-6">
              {days.map((day) => (
                <section key={day.key} aria-label={day.label}>
                  <h2 className="mb-2 px-1 text-label font-semibold text-ink-3">{day.label}</h2>
                  <ol className="overflow-hidden rounded-[20px] bg-surface shadow-card">
                    {day.rows.map((row, index) => <ActivityRow key={row.id} row={row} first={index === 0} locale={locale} timezone={timezone} />)}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ row, first, locale, timezone }: { row: AuditRow; first: boolean; locale: string; timezone: string }) {
  const [open, setOpen] = useState(false);
  const { text } = describe(row);
  const name = row.actor?.name ?? (row.actor ? "Someone on your team" : "DealDock");
  const handle = row.handle ? <bdi className="font-semibold text-ink">@{row.handle}</bdi> : null;
  // An edit distance per row is real work; measure once, not on every expand.
  const pct = useMemo(() => (row.action === "message.sent" ? changedPct(row) : null), [row]);
  const canCompare = row.action === "message.sent" && row.originalDraft && row.finalText && row.originalDraft !== row.finalText;

  return (
    <li className={cx("px-4 py-3 md:px-5", !first && "border-t border-hairline")}>
      <div className="flex items-start gap-3">
        {row.actor ? <Avatar handle={row.actor.name ?? row.actor.seatId} name={row.actor.name} size={36} /> : <Logo size={36} />}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-5 text-ink-2">
            <span className="font-semibold text-ink">{name}</span> {text(handle)}
            <span className="text-ink-3"> · {formatTime(row.at, locale, timezone)}</span>
          </p>
          {row.action === "message.sent" && (
            <p className="mt-0.5 text-caption text-ink-3">
              {pct === null ? "Written by hand" : pct === 0 ? "Sent exactly as drafted" : `Changed ${pct}% of the draft`}
              {row.asVoice && " · as a voice note"}
              {row.actor?.role && row.actor.role !== "creator" && ` · approved by a ${row.actor.role}`}
            </p>
          )}
          {(canCompare || row.threadId) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {canCompare && (
                <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1 text-label font-semibold text-brand">
                  {open ? "Hide changes" : "See what changed"}
                  <ChevronDown aria-hidden size={15} className={cx("transition-transform", open && "rotate-180")} />
                </button>
              )}
              {row.threadId && (
                <Link href={`/thread/${row.threadId}`} className="inline-flex items-center gap-1 text-label font-semibold text-ink-2 hover:text-ink">
                  Open conversation <ArrowRight aria-hidden size={14} />
                </Link>
              )}
            </div>
          )}
          {open && canCompare && (
            <div className="dd-rise mt-3 grid gap-2 sm:grid-cols-2">
              <div className="rounded-2xl bg-inset p-3">
                <p className="text-micro uppercase text-ink-3">Draft</p>
                <p className="mt-1 whitespace-pre-wrap text-[14px] leading-5 text-ink-2">{row.originalDraft}</p>
              </div>
              <div className="rounded-2xl bg-brand-tint p-3">
                <p className="text-micro uppercase text-recovered">Sent</p>
                <p className="mt-1 whitespace-pre-wrap text-[14px] leading-5 text-ink">{row.finalText}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
