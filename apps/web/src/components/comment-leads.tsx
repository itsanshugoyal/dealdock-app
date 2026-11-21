"use client";

import Link from "next/link";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowRight, Check, ChevronDown, ExternalLink, MessageCircle, Plus, RefreshCw, Settings2, X } from "lucide-react";
import { normalizeCommentKeywords, type CommentLeadDto } from "@dealdock/core";
import { commentLeadsLine, isExpiredLead, isOpenLead, leadsInScope, replyTimeLeft } from "../lib/comment-leads";
import { atHandle, pluralize, textLang } from "../lib/format";
import { useMinuteClock } from "../lib/keyboard";
import { errorMessage } from "../lib/snapshot";
import { runUndoable, usePendingAction } from "../lib/undo";
import { appStore, useCan, useCommentLeads, useSettings } from "../lib/use-demo";
import { SendingBanner } from "./conversation";
import { Group, SlideToSend, VoiceProvenance } from "./kit";
import { Button, buttonClasses } from "./ui/button";
import { cx } from "./ui/cx";
import { EmptyState, ErrorState, Skeleton } from "./ui/feedback";
import { Select, TextField } from "./ui/field";
import { Avatar } from "./ui/sender";
import { toast, toastAction } from "./ui/toast";

/**
 * Inbox → Comments: people who commented one of a creator's keywords, each
 * with the one private reply Instagram allows, drafted in their voice. One
 * lead is open at a time; its reply goes only when a person sends it, with
 * the same undo window as every send.
 */
export function CommentLeadsPanel({ account, query = "" }: { account: string | null; query?: string }) {
  const slice = useCommentLeads();
  const settings = useSettings();
  const clock = useMinuteClock();
  const now = clock || Date.now();
  const canSend = useCan("send") !== false;
  // null: the first open lead (soonest to close); "": none; else the lead the person opened.
  const [opened, setOpened] = useState<string | null>(null);
  // Skipped leads leave at once; Undo (lib/undo) brings them back before the skip is saved.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [clearing, setClearing] = useState(false);

  if (slice.status === "error" && !slice.data) {
    return <ErrorState thing="your comments" reason={slice.error} onRetry={() => void appStore.loadCommentLeads()} className="mt-4" />;
  }
  if (!slice.data) {
    return <div className="space-y-2 px-4 pt-4">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-16 rounded-[20px]" />)}</div>;
  }

  const view = slice.data;
  const accounts = settings.data?.accounts ?? [];
  const roster = settings.data?.tier === "roster" && accounts.length > 1;
  const creatorOf = (lead: CommentLeadDto) => (roster && !account ? accounts.find((item) => item.id === lead.igAccountId)?.handle ?? null : null);
  const needle = query.toLowerCase();
  const leads = leadsInScope(view, account).filter((lead) => !needle || [lead.commenterHandle, lead.text].some((field) => field.toLowerCase().includes(needle)));
  const open =leads.filter((lead) => isOpenLead(lead, now) && !skipped.has(lead.id)).sort((a, b) => Date.parse(a.replyBy) - Date.parse(b.replyBy));
  const sent = leads.filter((lead) => lead.status === "sent");
  const expired = leads.filter((lead) => isExpiredLead(lead, now));
  const keywords = [...new Set((account ? view.keywords[account] ?? [] : Object.values(view.keywords).flat()))];
  // The soonest to close is open by default, and the next one once it's answered: one clear next step.
  const current = opened === "" ? null : open.find((lead) => lead.id === opened)?.id ?? open[0]?.id ?? null;

  const skip = (lead: CommentLeadDto) => {
    const hide = (hidden: boolean) => setSkipped((ids) => {
      const next = new Set(ids);
      if (hidden) next.add(lead.id); else next.delete(lead.id);
      return next;
    });
    hide(true);
    const pending = runUndoable({ message: `Skipped ${atHandle(lead.commenterHandle)}.`, commit: () => appStore.skipCommentLead(lead.id), onUndo: () => hide(false) });
    void pending.outcome.then((outcome) => {
      if (outcome.status !== "failed") return;
      hide(false);
      toast(errorMessage(outcome.error, "Couldn't skip it. Try again."), { tone: "error" });
    });
  };
  const clear = async () => {
    setClearing(true);
    await toastAction(() => appStore.clearExpiredCommentLeads(account ?? undefined), { success: `Cleared ${expired.length} ${pluralize(expired.length, "comment")} too late to answer.`, fallback: "Couldn't clear them. Try again." });
    setClearing(false);
  };

  return (
    <div className="pb-2">
      <div className="px-4 pt-3 md:px-5">
        <p className="text-label text-ink-2">
          Private replies to people who commented {keywordsText(keywords)}. Nothing sends until you approve it.
        </p>
        <details className="group">
          <summary className="dd-summary inline-flex min-h-11 items-center gap-1 text-label font-semibold text-ink-3 hover:text-ink-2">
            How private replies work<ChevronDown aria-hidden size={15} className="transition-transform group-open:rotate-180" />
          </summary>
          <ul className="list-disc space-y-1 pb-2 pl-5 text-[14px] leading-5 text-ink-2">
            <li>Instagram allows one private reply per comment, within 7 days of it.</li>
            <li>They&apos;ll see it in their messages (or message requests if they don&apos;t follow you). If they reply, the conversation appears in your inbox.</li>
            <li><Link href="/settings#comment-leads" className="font-semibold text-ink underline decoration-separator underline-offset-2">Change your keywords</Link></li>
          </ul>
        </details>
      </div>

      {leads.length === 0 && needle ? (
        <p className="mx-4 mt-4 text-body text-ink-2 md:mx-5">No comments match &ldquo;{query}&rdquo;.</p>
      ) : leads.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          as="h3"
          title="No keyword comments yet."
          description={keywords.length ? `When someone comments ${keywordsText(keywords)} on a post, they show up here with a reply drafted.` : "Add a keyword in Settings, like PRICE. DealDock drafts a private reply for each person who comments it."}
          action={keywords.length ? undefined : <Link href="/settings#comment-leads" className={buttonClasses({ variant: "secondary", size: "sm" })}><Settings2 aria-hidden size={16} />Add keywords</Link>}
        />
      ) : (
        <>
          {open.length > 0 ? (
            <section aria-label="To answer">
              <ul className="mx-2 mt-2 overflow-hidden rounded-[20px] bg-surface shadow-card">
                {open.map((lead, index) => (
                  <li key={lead.id} className={cx(index > 0 && "border-t border-hairline")}>
                    <LeadRow lead={lead} now={now} creator={creatorOf(lead)} expanded={lead.id === current} onToggle={() => setOpened(lead.id === current ? "" : lead.id)} />
                    {lead.id === current && (
                      <LeadReply key={`${lead.id}:${lead.draftBody ?? ""}`} lead={lead} canSend={canSend} onSkip={() => skip(lead)} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="mx-4 mt-3 text-body text-ink-2 md:mx-5">Every comment has its answer.</p>
          )}

          {sent.length > 0 && (
            <details className="group mt-3">
              <summary className="dd-summary mx-4 flex min-h-11 items-center justify-between text-micro uppercase text-ink-3 md:mx-5">
                <span>Sent <span className="normal-case tracking-normal">{sent.length}</span></span>
                <ChevronDown aria-hidden size={15} className="transition-transform group-open:rotate-180" />
              </summary>
              <ul className="mx-2 overflow-hidden rounded-[20px] bg-surface shadow-card">
                {sent.map((lead, index) => (
                  <li key={lead.id} className={cx("px-4 py-3", index > 0 && "border-t border-hairline")}>
                    <LeadSummary lead={lead} creator={creatorOf(lead)} trailing={<span className="inline-flex shrink-0 items-center gap-1 text-caption font-semibold text-ink-2"><Check aria-hidden size={14} />Sent</span>} />
                    {lead.draftBody && <p lang={textLang(lead.draftBody)} className="mt-2 rounded-2xl bg-inset px-3 py-2 text-[14px] leading-5 text-ink-2">{lead.draftBody}</p>}
                  </li>
                ))}
              </ul>
              <p className="mx-4 mt-2 text-caption text-ink-3 md:mx-5">If they reply, the conversation appears in your inbox.</p>
            </details>
          )}

          {expired.length > 0 && (
            <section aria-labelledby="comments-too-late" className="mt-3">
              <div className="mx-4 flex min-h-11 items-center justify-between gap-3 md:mx-5">
                <h3 id="comments-too-late" className="text-micro uppercase text-ink-3">Too late to reply privately</h3>
                {canSend && <Button variant="ghost" size="sm" loading={clearing} loadingLabel="Clearing…" onClick={() => void clear()}>Clear</Button>}
              </div>
              {/* Greyed as a flat well with grey faces; the text keeps its AA contrast. */}
              <ul className="mx-2 overflow-hidden rounded-[20px] bg-inset">
                {expired.map((lead, index) => (
                  <li key={lead.id} className={cx("px-4 py-3 [&_[aria-hidden]]:grayscale", index > 0 && "border-t border-hairline")}>
                    <LeadSummary lead={lead} creator={creatorOf(lead)} trailing={null} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const KEYWORD_ERRORS: Record<string, string> = {
  too_many_keywords: "Keep it to 10 keywords. Remove one first.",
  keyword_too_long: "Keep each keyword to 30 characters.",
  keyword_needs_a_word: "A keyword needs a letter, number or emoji.",
};

/**
 * Settings → Comment leads: each creator's keywords (on Roster, the creator
 * is chosen first). Hidden where the API says comment leads aren't on.
 */
export function CommentKeywordsSection() {
  const slice = useCommentLeads();
  const settings = useSettings().data;
  const canManage = useCan("manage_settings") !== false;
  const [scope, setScope] = useState("");
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!settings || (slice.data && !slice.data.available)) return null;

  const accounts = settings.accounts;
  const roster = settings.tier === "roster" && accounts.length > 1;
  const account = accounts.find((item) => item.id === scope) ?? accounts[0] ?? null;
  const keywords = account ? (slice.data?.keywords[account.id] ?? []) : [];
  const save = async (next: string[], done: string) => {
    if (!account) return false;
    setBusy(true);
    setError(null);
    try {
      await appStore.setCommentKeywords(next, account.id);
      toast(done, { tone: "success" });
      return true;
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't save the keywords. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const result = normalizeCommentKeywords([...keywords, word]);
    if (!result.ok) { setError(KEYWORD_ERRORS[result.error] ?? "Check that keyword."); return; }
    const added = result.keywords[keywords.length];
    if (!added) { setError(word.trim() ? `${word.trim()} is already a keyword.` : "Type a word people comment, like PRICE."); return; }
    if (await save(result.keywords, `Comments with ${added} now get a private reply drafted.`)) setWord("");
  };

  return (
    <Group id="comment-leads" title="Comment leads" description="When someone comments one of these words on your post, DealDock drafts a private reply for you to approve.">
      {slice.status === "error" && !slice.data ? (
        <ErrorState thing="your comment keywords" reason={slice.error} onRetry={() => void appStore.loadCommentLeads()} />
      ) : !slice.data ? <div className="p-4"><Skeleton className="h-12" /></div> : !account ? (
        <p className="px-4 py-4 text-body text-ink-2 md:px-5">Connect Instagram first: keywords belong to a creator&apos;s posts.</p>
      ) : (
        <>
          {roster && (
            <div className="border-b border-hairline px-4 pb-3 pt-3 md:px-5">
              <Select label="Keywords for" value={account.id} onChange={(event) => { setScope(event.target.value); setError(null); }}>
                {accounts.map((item) => <option key={item.id} value={item.id}>@{item.handle}</option>)}
              </Select>
            </div>
          )}
          <div className="px-4 py-4 md:px-5">
            {keywords.length > 0 ? (
              <ul aria-label={`Keywords for @${account.handle}`} className="mb-4 flex flex-wrap gap-2">
                {keywords.map((item) => (
                  <li key={item} className="inline-flex h-9 items-center gap-1 rounded-full bg-inset pl-3 pr-1 text-[14px] font-semibold text-ink">
                    {item}
                    {canManage && (
                      <button type="button" aria-label={`Remove the keyword ${item}`} disabled={busy} onClick={() => void save(keywords.filter((entry) => entry !== item), `${item} removed. Comments that use it stay as they are.`)} className="dd-press flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:bg-fill hover:text-ink disabled:opacity-60">
                        <X aria-hidden size={15} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="mb-4 text-body text-ink-2">No keywords yet.</p>}
            {canManage ? (
              <form className="flex items-start gap-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
                <TextField label="Keyword" hideLabel placeholder="PRICE" value={word} maxLength={60} autoCapitalize="none" autoCorrect="off" onChange={(event) => { setWord(event.target.value); setError(null); }} error={error} helper={error ? undefined : "A whole word or phrase, any case. Up to 10."} className="flex-1" />
                <Button type="submit" variant="secondary" icon={Plus} loading={busy} loadingLabel="Saving…">Add</Button>
              </form>
            ) : <p className="text-caption text-ink-3">Only the creator can change keywords.</p>}
          </div>
          <div className="border-t border-hairline bg-inset/50 px-4 py-3 text-caption text-ink-2 md:px-5">
            Instagram allows one private reply per comment, within 7 days. Replies wait in Inbox › Comments and never send on their own.
          </div>
        </>
      )}
    </Group>
  );
}

/** Today's line: "4 people commented PRICE", opening Inbox → Comments. Nothing when no comment waits for a reply. */
export function CommentLeadsToday() {
  const slice = useCommentLeads();
  const clock = useMinuteClock();
  if (!slice.data?.available) return null;
  const line = commentLeadsLine(slice.data.leads.filter((lead) => isOpenLead(lead, clock || Date.now())));
  if (!line) return null;
  return (
    <Link href="/inbox?view=comments" className="dd-press flex items-center gap-4 rounded-[22px] bg-surface p-4 shadow-card hover:bg-[color-mix(in_oklab,var(--dd-surface)_92%,var(--dd-info))]">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-info-tint text-info"><MessageCircle aria-hidden size={22} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-ink">{line}</span>
        <span className="block text-[14px] text-ink-2">A private reply is drafted for each. Nothing sends until you approve it.</span>
      </span>
      <ArrowRight aria-hidden size={18} className="shrink-0 text-ink-3" />
    </Link>
  );
}

/** "PRICE", "PRICE or LINK", "PRICE, LINK or SHOP"; "your keywords" when there are none or many. */
function keywordsText(keywords: string[]): string {
  if (keywords.length === 0 || keywords.length > 3) return "your keywords";
  return keywords.length === 1 ? keywords[0]! : `${keywords.slice(0, -1).join(", ")} or ${keywords.at(-1)}`;
}

function LeadSummary({ lead, creator, trailing }: { lead: CommentLeadDto; creator: string | null; trailing: ReactNode }) {
  // Spans only: it also sits inside the row's button.
  return (
    <span className="flex items-start gap-3">
      <Avatar handle={lead.commenterHandle} size={40} />
      <span className="block min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">{atHandle(lead.commenterHandle)}</span>
          {trailing}
        </span>
        <span lang={textLang(lead.text)} className="line-clamp-2 break-words text-[14px] leading-5 text-ink-2">&ldquo;{lead.text}&rdquo;</span>
        {creator && <span className="block text-caption text-ink-3">On @{creator}&apos;s post</span>}
      </span>
    </span>
  );
}

function LeadRow({ lead, now, creator, expanded, onToggle }: { lead: CommentLeadDto; now: number; creator: string | null; expanded: boolean; onToggle: () => void }) {
  const left = replyTimeLeft(lead, now);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={`comment-lead-${lead.id}`}
      onClick={onToggle}
      data-comment-lead={lead.id}
      className={cx("dd-row-press block w-full px-4 py-3 text-left hover:bg-[color-mix(in_oklab,var(--dd-inset)_60%,transparent)]", expanded && "bg-[color-mix(in_oklab,var(--dd-inset)_45%,transparent)]")}
    >
      <LeadSummary lead={lead} creator={creator} trailing={<span className={cx("shrink-0 text-caption", left.urgent ? "font-semibold text-danger" : "text-ink-3")}>{left.text}</span>} />
    </button>
  );
}

/** The open lead: its draft to edit, then send privately (with undo) or skip. */
function LeadReply({ lead, canSend, onSkip }: { lead: CommentLeadDto; canSend: boolean; onSkip: () => void }) {
  const [text, setText] = useState(lead.draftBody ?? "");
  const [phase, setPhase] = useState<"editing" | "sending">(lead.status === "sending" ? "sending" : "editing");
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [sendId, setSendId] = useState<string | null>(null);
  const pendingSend = usePendingAction(sendId);
  const recipient = atHandle(lead.commenterHandle);
  const fieldId = `comment-reply-${lead.id}`;

  const approve = () => {
    const finalText = text.trim();
    if (!finalText || phase !== "editing" || !canSend) return;
    setPhase("sending");
    setError(null);
    const pending = runUndoable({
      kind: "send",
      toast: false,
      message: `Sending to ${recipient}`,
      commit: () => appStore.sendCommentLead(lead.id, finalText),
      onUndo: () => setPhase("editing"),
    });
    setSendId(pending.id);
    void pending.outcome.then((outcome) => {
      setSendId(null);
      if (outcome.status === "committed") toast(`Private reply sent to ${recipient}.`, { tone: "success" });
      else {
        setPhase("editing");
        if (outcome.status === "failed") setError(errorMessage(outcome.error, "Instagram didn't confirm this reply. Try again: it can't go twice."));
        else if (outcome.status === "cancelled") setError(outcome.reason === "offline" ? "You went offline, so nothing was sent. Your reply is still here." : "Not sent. Your reply is still here.");
      }
    });
  };
  const redraft = async () => {
    setDrafting(true);
    setError(null);
    try {
      await appStore.redraftCommentLead(lead.id);
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't draft it again. Try again."));
    } finally {
      setDrafting(false);
    }
  };
  // ⌘↵ sends this reply only: handled here, so no other composer's shortcut sees it.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    approve();
  };

  return (
    <div id={`comment-lead-${lead.id}`} className="flex flex-col gap-3 px-4 pb-4">
      {lead.mediaUrl && (
        <a href={lead.mediaUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 w-fit items-center gap-1 text-label font-semibold text-ink-2 hover:text-ink">
          View the post<ExternalLink aria-hidden size={14} /><span className="sr-only"> (opens Instagram)</span>
        </a>
      )}
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={fieldId} className="text-label font-semibold text-ink">Private reply to {recipient}</label>
        {lead.draftBody && <VoiceProvenance />}
      </div>
      <textarea
        id={fieldId}
        value={text}
        disabled={phase !== "editing" || !canSend}
        placeholder={lead.draftBody ? undefined : "Write your reply"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        lang={textLang(text)}
        rows={3}
        maxLength={1000}
        className={cx(
          "dd-bubble-draft text-message block min-h-[92px] w-full resize-none px-4 py-3 text-ink outline-none [field-sizing:content] max-h-[40dvh]",
          "focus-visible:shadow-[0_0_0_2px_var(--dd-brand),0_0_0_6px_color-mix(in_oklab,var(--dd-brand)_18%,transparent)]",
          phase === "sending" && "opacity-60",
        )}
      />
      {lead.missingFacts.length > 0 && (
        <div className="rounded-2xl bg-waiting-tint px-4 py-3">
          <p className="text-label font-semibold text-waiting">Missing facts</p>
          <p className="mt-1 text-[14px] text-ink">Confirm these before sending: {lead.missingFacts.join(", ")}. You can send only one reply to this comment.</p>
          <Link href="/offers" className="mt-1 inline-flex min-h-11 items-center text-label font-semibold text-brand">Review your offers</Link>
        </div>
      )}
      {error && <p role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-[14px] text-danger">{error}</p>}
      {phase === "sending" ? (
        <SendingBanner action={pendingSend} recipient={recipient} />
      ) : canSend ? (
        <>
          <SlideToSend onConfirm={approve} disabled={!text.trim()} recipient={recipient} action="Send privately" label="Slide to send privately" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={onSkip}>Skip</Button>
            <Button variant="ghost" size="sm" icon={RefreshCw} loading={drafting} loadingLabel="Drafting…" onClick={() => void redraft()}>{lead.draftBody ? "Draft again" : "Draft it"}</Button>
          </div>
        </>
      ) : (
        <p className="text-caption text-ink-3">Your seat can read comments but not reply to them.</p>
      )}
    </div>
  );
}
